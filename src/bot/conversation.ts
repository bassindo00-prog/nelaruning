import { Markup, Telegraf } from 'telegraf';
import type { AppConfig } from '../config.js';
import { RunningHubClient } from '../runninghub/client.js';
import { DEFAULT_PROMPT } from '../runninghub/workflow.js';
import { runMotionControl, type RunProgress } from '../runninghub/workflow.js';
import { downloadTelegramFile } from '../utils/telegram.js';
import { formatElapsed, truncate } from '../utils/wait.js';
import type { BotCtx, ConversationState } from './session.js';
import { jobQueue } from './job-queue.js';
import db from '../database/index.js';

const LINE = '━'.repeat(20);
const BAR_TOTAL = 13;
/** Estimasi durasi generasi (ms) untuk progress bar saat API tidak memberi % progres. */
const GEN_ESTIMATE_MS = 150_000;

/** Format ms → HH:MM:SS. */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** Bar progres: ████████░░░░░ 64%. */
function progressBar(pct: number): string {
  const p = Math.min(100, Math.max(0, pct));
  const filled = Math.round((p / 100) * BAR_TOTAL);
  return '█'.repeat(filled) + '░'.repeat(BAR_TOTAL - filled);
}

/** Petunjuk langkah saat ini untuk pesan "belum giliran". */
function hintFor(state: ConversationState): string {
  switch (state) {
    case 'waiting_image':
      return 'kirim gambar utama 📷';
    case 'waiting_video':
      return 'kirim video referensi 🎥';
    case 'running':
      return 'tunggu proses selesai ⏳';
    default:
      return 'ketik /start';
  }
}

/**
 * Jalankan job Kling Motion Control dengan tampilan status bertahap
 * pada SATU pesan yang sama (editMessageText):
 * Upload → Sending request → Job ID → Polling (elapsed time + progress bar) → Complete → Kirim video.
 * 
 * FULLY ASYNC: Semua operasi berjalan di background, tidak memblokir handler.
 */
async function runKlingJob(
  ctx: BotCtx,
  config: AppConfig,
  client: RunningHubClient,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const s = ctx.session;
  
  console.log(`[${chatId}] Request received - Start Kling job`);
  
  if (!s.imageFileId || !s.videoFileId) {
    console.log(`[${chatId}] Input incomplete`);
    await ctx.reply('⚠️ Input belum lengkap (butuh gambar + video referensi). Ketik /start untuk mulai ulang.');
    return;
  }

  s.conversationState = 'running';
  const startTime = Date.now();
  let anchor: { message_id: number } | undefined;
  let runningSince: number | undefined;
  let jobId: string | undefined;

  /** Edit pesan progres yang sama; fallback kirim pesan baru bila edit gagal.
   * Non-blocking: gunakan Promise.race dengan timeout untuk mencegah hanging.
   */
  const update = async (text: string): Promise<void> => {
    try {
      // Timeout 10 detik untuk update message - jangan block lebih lama
      await Promise.race([
        (async () => {
          if (!anchor) {
            const sent = await ctx.reply(text);
            anchor = { message_id: sent.message_id };
          } else {
            await ctx.telegram.editMessageText(ctx.chat!.id, anchor.message_id, undefined, text);
          }
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Update timeout')), 10000)),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/not modified|timeout/i.test(msg)) return; // teks sama atau timeout — abaikan
      try {
        // Fallback: kirim pesan baru jika edit gagal
        const sent = await ctx.reply(text).catch(() => undefined);
        if (sent) anchor = { message_id: sent.message_id };
      } catch {
        /* abaikan - jangan block */
      }
    }
  };

  try {
    // 0) Pre-flight: cek saldo akun (gratis) — hindari retry 5 menit percuma
    try {
      console.log(`[${chatId}] Checking account balance`);
      const acc = await client.checkAccount(s.apiKey ?? config.runningHub.apiKey);
      const coins = Number(acc.remainCoins) || 0;
      const money = Number(acc.remainMoney) || 0;
      if (coins <= 0 && money <= 0) {
        console.log(`[${chatId}] Failed - Insufficient balance`);
        await ctx.reply(
          '⚠️ *Saldo koin akun ini 0* dan tidak ada saldo wallet.\n\nTask tidak akan bisa jalan. Solusi:\n• Isi saldo di dashboard RunningHub, ATAU\n• Pakai API key akun lain: `/apikey <key>`',
          { parse_mode: 'Markdown' },
        );
        return;
      }
    } catch {
      /* kalau cek gagal, lanjut saja — biar create task yang putuskan */
    }

    // 1) Unduh & upload file
    console.log(`[${chatId}] Downloading image and video from Telegram`);
    await update(`${LINE}\n📤 Uploading files...\n${LINE}`);
    const image = await downloadTelegramFile(
      ctx.telegram,
      s.imageFileId,
      config.telegramBotToken,
    );
    let video: { buffer: Buffer; name: string } | undefined;
    if (s.videoFileId) {
      video = await downloadTelegramFile(ctx.telegram, s.videoFileId, config.telegramBotToken);
    }

    // 2) Kirim request ke RunningHub
    console.log(`[${chatId}] Sending request to RunningHub`);
    await update(`${LINE}\n🚀 Sending request to RunningHub...\n${LINE}`);

    const result = await runMotionControl(client, {
      imageBuffer: image.buffer,
      imageName: image.name,
      videoBuffer: video?.buffer,
      videoName: video?.name,
      prompt: s.prompt ?? DEFAULT_PROMPT,
      seed: s.seed,
      workflowId: config.runningHub.workflowId,
      instanceType: s.instanceType ?? config.instanceType,
      apiKey: s.apiKey ?? config.runningHub.apiKey,
      videoDurationSeconds: s.videoDurationSeconds,
      retainSeconds: config.retainSeconds,
      mapping: config.runningHub.mapping,
      pollIntervalMs: config.pollIntervalMs,
      timeoutMs: config.timeoutMs,
      onProgress: async (p: RunProgress) => {
        const elapsed = Date.now() - startTime;

        if (p.stage === 'create' && p.step === 'retry') {
          console.log(`[${chatId}] Retrying task creation`);
          await update(
            `${LINE}\n🚀 Sending request to RunningHub...\n\n🔄 ${p.message ?? 'Antrian penuh, mencoba lagi…'}\n${LINE}`,
          );
          return;
        }

        if (p.stage === 'create' && p.step === 'started') {
          console.log(`[${chatId}] Task created - ID: ${p.taskId}`);
          // Persist job ke DB — resume polling setelah restart tetap jalan.
          if (p.taskId && !jobId) {
            jobId = `kling_${chatId}_${Date.now()}`;
            try {
              await db.createJob(jobId, chatId, 'v1', 0, s.imageFileId ?? '', s.videoFileId);
              await db.updateJobTaskId(jobId, p.taskId);
              await db.updateJobStatus(jobId, 'running');
              if (anchor) await db.updateJobTelegramMessageId(jobId, anchor.message_id);
              console.log(`[${chatId}] [JOB:${jobId}] Task dibuat — taskId=${p.taskId} (persisted)`);
            } catch (err) {
              console.error(`[${chatId}] Gagal persist job: ${err instanceof Error ? err.message : err}`);
            }
          }
          await update(`${LINE}\n✅ Job berhasil dibuat\n\nJob ID:\n${p.taskId}\n\n⏳ Estimasi waktu: 7-15 menit\n${LINE}`);
          return;
        }

        if (p.stage === 'poll') {
          if (p.status === 'SUCCESS') {
            console.log(`[${chatId}] Task completed successfully`);
            await update(
              `${LINE}\n✅ Generation Complete\n\nElapsed Time:\n${fmtClock(elapsed)}\n\n⬇️ Downloading result...\n${LINE}`,
            );
            return;
          }
          if (p.status === 'FAILED') {
            console.log(`[${chatId}] Task failed at RunningHub`);
            return; // workflow akan throw — ditangani catch di bawah
          }

          if (p.status === 'RUNNING' && runningSince === undefined) runningSince = Date.now();
          console.log(`[${chatId}] Polling - Status: ${p.status} | Elapsed: ${fmtClock(elapsed)}`);
          const statusText =
            p.status === 'QUEUED'
              ? '📋 Queued...'
              : p.status === 'RUNNING'
                ? '⚙️ Processing...'
                : p.status;
          // Pakai progres dari API bila ada; jika tidak, estimasi dari waktu berjalan.
          const pct = p.progress ??
            (p.status === 'QUEUED'
              ? 5
              : runningSince
                ? Math.min(95, Math.round(((Date.now() - runningSince) / GEN_ESTIMATE_MS) * 95))
                : 5);
          await update(
            `${LINE}\n🎬 Kling Motion Control\n\n⏳ Estimasi waktu: 7-15 menit\n\n${statusText}\n\n⏱️ Elapsed Time:\n${fmtClock(elapsed)}\n\n📊 Progress:\n${progressBar(pct)} ${pct}%\n${LINE}`,
          );
          return;
        }

        if (p.stage === 'output') {
          console.log(`[${chatId}] Downloading result from RunningHub`);
        }
      },
    });

    // 3) Kirim video hasil ke Telegram
    console.log(`[${chatId}] Sending result video to Telegram`);
    await update(`${LINE}\n📤 Sending result to Telegram...\n${LINE}`);
    s.lastTaskId = result.taskId;
    await ctx.replyWithVideo(
      { source: result.videoBuffer, filename: `motion_${result.taskId}.mp4` },
      {
        caption: `✅ *Selesai dalam ${formatElapsed(result.elapsedMs)}* 🎉\nTask: \`${result.taskId}\``,
        parse_mode: 'Markdown',
      },
    );
    console.log(`[${chatId}] Success - Task completed`);
    if (jobId) {
      await db.updateJobStatus(jobId, 'delivered', undefined, result.videoUrl).catch(() => {});
      console.log(`[${chatId}] [JOB:${jobId}] Status → DELIVERED (task ${result.taskId})`);
    }
    await update(
      `${LINE}\n✅ Generation Complete\n\nElapsed Time:\n${fmtClock(result.elapsedMs)}\n\nVideo terkirim ke Telegram 🎉\n${LINE}`,
    ).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${chatId}] Failed - Error: ${message}`);
    await update(`${LINE}\n❌ Generation Failed\n\n${message}\n${LINE}`).catch(() => {});
    await ctx
      .reply(`❌ *Gagal:* ${message}\n\nKetik /start untuk mencoba lagi.`, { parse_mode: 'Markdown' })
      .catch(() => {});
  } finally {
    s.conversationState = 'idle';
  }
}

/**
 * Daftarkan Conversation Flow (mode Kling Motion Control):
 * tombol di /start + state machine untuk foto/video/teks.
 *
 * Interceptor didaftarkan SEBELUM handler lama dan memanggil next()
 * saat state 'idle' — sehingga fitur lama tetap berfungsi.
 */
export function registerConversationFlow(
  bot: Telegraf<BotCtx>,
  config: AppConfig,
  client: RunningHubClient,
): void {
  // ===== Tombol mode di menu /start =====
  bot.action('mode:kling', async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] Action: mode:kling clicked`);
    await ctx.answerCbQuery().catch(() => {});
    if (jobQueue.isBusy(chatId)) {
      console.log(`[${chatId}] Job already running, request blocked`);
      await ctx.reply('⏳ Proses sedang berjalan — tunggu sampai selesai ya.');
      return;
    }
    ctx.session.conversationState = 'waiting_image';
    console.log(`[${chatId}] Conversation started - waiting for image`);
    await ctx.reply('📷 Silakan kirim gambar utama.');
  });

  // ===== Interceptor foto =====
  bot.on('photo', async (ctx, next) => {
    const chatId = ctx.chat!.id;
    const state = ctx.session.conversationState ?? 'idle';
    console.log(`[${chatId}] Photo received - State: ${state}`);
    
    if (state === 'idle') return next(); // fitur lama

    if (state !== 'waiting_image') {
      console.log(`[${chatId}] Photo rejected - not expecting image at this state`);
      await ctx.reply(`⚠️ Belum giliran gambar. Sekarang: ${hintFor(state)}`);
      return;
    }
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    ctx.session.imageFileId = photo.file_id;
    ctx.session.imageName = `photo_${ctx.message.message_id}.jpg`;
    ctx.session.conversationState = 'waiting_video';
    console.log(`[${chatId}] Image stored - waiting for video`);
    await ctx.reply('✅ Gambar diterima.\n\n🎥 Silakan kirim video referensi.');
  });

  // ===== Interceptor video referensi =====
  // Video referensi diterima — tampilkan tombol Run (tunggu user klik)
  bot.on('video', async (ctx, next) => {
    const chatId = ctx.chat!.id;
    const state = ctx.session.conversationState ?? 'idle';
    console.log(`[${chatId}] Video received - State: ${state}`);
    
    if (state === 'idle') return next(); // fitur lama

    if (state !== 'waiting_video') {
      console.log(`[${chatId}] Video rejected - not expecting video at this state`);
      await ctx.reply(`⚠️ Belum giliran video. Sekarang: ${hintFor(state)}`);
      return;
    }
    const video = ctx.message.video;
    ctx.session.videoFileId = video.file_id;
    ctx.session.videoName = video.file_name ?? `video_${ctx.message.message_id}.mp4`;
    // Durasi output mengikuti durasi video referensi (cap 30 dtk, min 1 dtk)
    if (video.duration) {
      ctx.session.videoDurationSeconds = Math.max(1, Math.min(30, Math.round(video.duration)));
    }
    console.log(`[${chatId}] Video stored - ready for Run button`);
    await ctx.reply('✅ Video referensi diterima.', {
      reply_markup: {
        inline_keyboard: [[Markup.button.callback('▶️ Run', 'kling:run')]],
      },
    });
  });

  // ===== Interceptor teks (prompt / /skip) =====
  bot.on('text', async (ctx, next) => {
    const chatId = ctx.chat!.id;
    const state = ctx.session.conversationState ?? 'idle';
    const text = ctx.message.text.trim();
    
    console.log(`[${chatId}] Text received: ${truncate(text, 50)} - State: ${state}`);
    
    if (state === 'idle') return next(); // fitur lama

    if (state === 'running') {
      console.log(`[${chatId}] Text rejected - job already running`);
      await ctx.reply('⏳ Proses sedang berjalan — tunggu sampai selesai ya.');
      return;
    }

    // Deteksi API key terkirim polos (32 hex) — state apa pun
    if (/^[a-f0-9]{32}$/i.test(text)) {
      console.log(`[${chatId}] API key detected`);
      await ctx.reply(
        `🔑 Kelihatannya ini *API key RunningHub*.\n\nKalau mau dipakai buat biaya akunmu, tekan tombol di bawah — nggak usah ketik ulang.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            Markup.button.callback('🔑 Pakai key ini', `apikey:use:${text}`),
          ]),
        },
      );
      return;
    }

    if (state === 'waiting_video') {
      // Prompt opsional diketik SEBELUM video — disimpan, tetap tunggu video
      ctx.session.prompt = text;
      console.log(`[${chatId}] Prompt stored - waiting for video`);
      await ctx.reply(
        `✍️ Prompt disimpan: *"${truncate(text, 60)}"*\n🎥 Sekarang kirim video referensi.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    if (text.startsWith('/')) {
      if (text === '/skip' || text.startsWith('/skip ')) {
        ctx.session.prompt = undefined;
        console.log(`[${chatId}] Prompt skipped by user`);
        await ctx.reply('⏭️ Prompt dilewati. Menjalankan job…');
        
        // Enqueue job sebagai background task (non-blocking)
        // Fire and forget - immediately return to handler
        jobQueue.enqueue(ctx, {
          id: `kling_${Date.now()}`,
          chatId,
          label: `Kling Motion Control (skip prompt)`,
          execute: () => runKlingJob(ctx, config, client),
        }).catch((err) => console.error(`[${chatId}] Enqueue error:`, err));
      } else {
        return next(); // perintah lain (/reset, /seed, …) → handler lama
      }
      return;
    }

    ctx.session.prompt = text;
    console.log(`[${chatId}] Prompt received and stored`);
    await ctx.reply(`✍️ Prompt disimpan: *"${truncate(text, 60)}"*\n🚀 Menjalankan job…`, {
      parse_mode: 'Markdown',
    });
    
    // Enqueue job sebagai background task (non-blocking)
    // Fire and forget - immediately return to handler
    jobQueue.enqueue(ctx, {
      id: `kling_${Date.now()}`,
      chatId,
      label: `Kling Motion Control (with prompt)`,
      execute: () => runKlingJob(ctx, config, client),
    }).catch((err) => console.error(`[${chatId}] Enqueue error:`, err));
  });

  // ===== Tombol "▶️ Run" untuk Kling mode =====
  bot.action('kling:run', async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] Action: Run button clicked`);
    
    await ctx.answerCbQuery().catch(() => {});
    const s = ctx.session;
    if (!s.imageFileId || !s.videoFileId) {
      console.log(`[${chatId}] Run rejected - input incomplete`);
      await ctx.reply('⚠️ Input belum lengkap (butuh gambar + video referensi).');
      return;
    }
    if (jobQueue.isBusy(chatId)) {
      console.log(`[${chatId}] Run rejected - job already running`);
      await ctx.reply('⏳ Proses sedang berjalan — tunggu sampai selesai ya.');
      return;
    }
    s.conversationState = 'running';
    console.log(`[${chatId}] Run started - showing loading message`);
    
    // HAPUS BUTTON — edit pesan lama untuk remove inline keyboard
    try {
      // Coba hapus inline keyboard dari pesan lama
      await ctx.telegram.editMessageReplyMarkup(ctx.chat!.id, ctx.callbackQuery!.message!.message_id, undefined, { inline_keyboard: [] });
      console.log(`[${chatId}] Button removed from previous message`);
    } catch (err) {
      // Kalau gagal, kirim pesan baru saja
      console.log(`[${chatId}] Could not remove button: ${err instanceof Error ? err.message : err}`);
    }
    
    await ctx.reply('⏳ *Estimasi waktu: 7-15 menit*\n\n🎬 Proses sedang berjalan...\n\n⏱️ Menghitung waktu...', {
      parse_mode: 'Markdown',
    });
    
    // Enqueue job sebagai background task (non-blocking)
    // Fire and forget - immediately return to handler
    jobQueue.enqueue(ctx, {
      id: `kling_${Date.now()}`,
      chatId,
      label: `Kling Motion Control (manual run)`,
      execute: () => runKlingJob(ctx, config, client),
    }).catch((err) => console.error(`[${chatId}] Enqueue error:`, err));
  });
}
