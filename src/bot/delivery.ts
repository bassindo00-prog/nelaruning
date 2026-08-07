/**
 * Delivery & Resume — persistent job handling.
 *
 * - `deliverJobResult`: query task RunningHub → ambil video terbaik → kirim ke
 *   Telegram (retry max 3×) → status DELIVERED. TIDAK pernah membuat task baru.
 * - `resumePendingJobs`: dipanggil saat bot startup — lanjutkan polling semua
 *   job status 'running' yang tersisa di DB (tidak hilang walau bot restart).
 * - `syncUndeliveredJobs`: dipakai /sync — pulihkan task SUCCESS yang belum
 *   terkirim videonya.
 */

import { Telegraf } from 'telegraf';
import type { AppConfig } from '../config.js';
import { RunningHubClient } from '../runninghub/client.js';
import { pickBestVideo } from '../runninghub/workflow.js';
import db, { type Job } from '../database/index.js';
import tokenManager from '../token/manager.js';
import { formatElapsed, sleep } from '../utils/wait.js';
import type { BotCtx } from './session.js';

const POLL_INTERVAL_MS = 5000;
const MAX_DELIVERY_ATTEMPTS = 3;
const LOG = {
  created: (chatId: number, jobId: string, taskId: string) =>
    console.log(`[${chatId}] [JOB:${jobId}] Task dibuat — taskId=${taskId}`),
  polling: (chatId: number, jobId: string, taskId: string) =>
    console.log(`[${chatId}] [JOB:${jobId}] Polling dimulai — taskId=${taskId}`),
  success: (chatId: number, jobId: string, taskId: string) =>
    console.log(`[${chatId}] [JOB:${jobId}] Generate SUCCESS — taskId=${taskId}`),
  delivered: (chatId: number, jobId: string, taskId: string) =>
    console.log(`[${chatId}] [JOB:${jobId}] DELIVERED — video terkirim, taskId=${taskId}`),
  stop: (chatId: number, jobId: string, taskId: string, reason: string) =>
    console.log(`[${chatId}] [JOB:${jobId}] Polling berhenti — taskId=${taskId}, alasan: ${reason}`),
};

/** Update pesan progres via editMessageText (kirim pesan baru bila tak ada messageId). */
export async function updateProgressMessage(
  bot: Telegraf<BotCtx>,
  chatId: number,
  messageId: number | undefined,
  text: string,
): Promise<number | undefined> {
  if (messageId !== undefined) {
    try {
      await bot.telegram.editMessageText(chatId, messageId, undefined, text);
      return messageId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not modified/i.test(msg)) return messageId; // teks sama — abaikan
      // edit gagal (pesan lama terhapus dll) → fallback kirim baru
    }
  }
  try {
    const sent = await bot.telegram.sendMessage(chatId, text);
    return sent.message_id;
  } catch {
    return messageId;
  }
}

/** Format status task RH menjadi baris progres untuk pesan Telegram. */
function progressText(status: string | undefined, elapsedMs: number, taskId?: string): string {
  const clock = formatElapsed(elapsedMs);
  const statusLine =
    status === 'SUCCESS'
      ? '✅ Selesai!'
      : status === 'FAILED'
        ? '❌ Gagal'
        : status === 'RUNNING'
          ? '⚙️ Memproses...'
          : status === 'QUEUED'
            ? '📋 Dalam antrian...'
            : status ?? '...';
  return [
    '🟣 Motion Control......',
    '',
    `⏳ ${clock}`,
    `📊 ${statusLine}`,
    taskId ? `🆔 Task: \`${taskId}\`` : '',
    '',
    '📍 Mohon tunggu, hasil akan dikirim otomatis.....',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Kirim video hasil task ke Telegram dengan retry max 3×.
 * Tidak pernah membuat task RunningHub baru. Return true bila terkirim.
 */
async function sendVideoWithRetry(
  bot: Telegraf<BotCtx>,
  chatId: number,
  videoUrl: string,
  taskId: string,
  elapsedMs: number,
): Promise<boolean> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    try {
      console.log(
        `[${chatId}] [JOB] Delivery attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS} — unduh ${videoUrl}`,
      );
      const r = await fetch(videoUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status} saat unduh video`);
      const buf = Buffer.from(await r.arrayBuffer());
      await bot.telegram.sendVideo(
        chatId,
        { source: buf, filename: `motion_${taskId}.mp4` },
        {
          caption: `✅ *Selesai dalam ${formatElapsed(elapsedMs)}* 🎉\nTask: \`${taskId}\``,
          parse_mode: 'Markdown',
        },
      );
      return true;
    } catch (err) {
      lastErr = err;
      console.error(
        `[${chatId}] [JOB] Kirim video gagal (percobaan ${attempt}/${MAX_DELIVERY_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt < MAX_DELIVERY_ATTEMPTS) await sleep(3000 * attempt);
    }
  }
  console.error(
    `[${chatId}] [JOB] Gagal kirim video setelah ${MAX_DELIVERY_ATTEMPTS} percobaan: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
  return false;
}

/**
 * Query task → SUCCESS? → unduh & kirim video → status DELIVERED.
 * Return 'delivered' | 'pending' | 'failed' | 'no-task'.
 */
export async function deliverJobResult(
  bot: Telegraf<BotCtx>,
  job: Job,
  client: RunningHubClient,
): Promise<'delivered' | 'pending' | 'failed' | 'no-task'> {
  if (!job.taskId) {
    // Job lama (sebelum patch taskId) tanpa taskId — tapi punya URL hasil.
    // Langsung kirim dari URL tanpa query.
    if (job.resultUrl) {
      console.log(`[${job.chatId}] [JOB:${job.id}] Tanpa taskId — kirim langsung dari resultUrl`);
      const ok = await sendVideoWithRetry(
        bot,
        job.chatId,
        job.resultUrl,
        job.id,
        job.completedAt ? job.completedAt - job.startedAt : 0,
      );
      if (!ok) return 'pending';
      await db.updateJobStatus(job.id, 'delivered', undefined, job.resultUrl);
      LOG.delivered(job.chatId, job.id, job.id);
      return 'delivered';
    }
    return 'no-task';
  }

  let resp;
  try {
    resp = await client.query(job.taskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${job.chatId}] [JOB:${job.id}] Query error: ${msg}`);
    return 'pending';
  }

  if (resp.status === 'FAILED') {
    const fr = resp.failedReason;
    const crash =
      fr && typeof fr === 'object' && 'exception_message' in fr
        ? String((fr as { exception_message?: unknown }).exception_message)
        : '';
    const reason = crash || resp.errorMessage || 'task gagal di sisi server';
    console.error(`[${job.chatId}] [JOB:${job.id}] Task FAILED: ${reason}`);
    await db.updateJobStatus(job.id, 'failed', reason);
    await tokenManager.refundTokensForFailure(job.chatId, job.id).catch(() => {});
    await updateProgressMessage(bot, job.chatId, job.telegramMessageId, `❌ Task gagal: ${reason.slice(0, 120)}`).catch(
      () => {},
    );
    LOG.stop(job.chatId, job.id, job.taskId, 'FAILED');
    return 'failed';
  }

  if (resp.status !== 'SUCCESS') {
    // Masih QUEUED/RUNNING — caller yang mutuskan mau lanjut polling atau tidak.
    return 'pending';
  }

  LOG.success(job.chatId, job.id, job.taskId);
  const results = Array.isArray(resp.results) ? resp.results : [];
  const video = await pickBestVideo(results);
  if (!video?.url) {
    await db.updateJobStatus(job.id, 'failed', 'Tidak ada output video pada task SUCCESS');
    await tokenManager.refundTokensForFailure(job.chatId, job.id).catch(() => {});
    LOG.stop(job.chatId, job.id, job.taskId, 'no video output');
    return 'failed';
  }

  const elapsedMs = job.completedAt ? job.completedAt - job.startedAt : 0;
  await updateProgressMessage(bot, job.chatId, job.telegramMessageId, '⬇️ Mengunduh hasil...').catch(() => {});
  const ok = await sendVideoWithRetry(bot, job.chatId, video.url, job.taskId, elapsedMs);
  if (!ok) {
    // Video tidak terkirim — status tetap 'success' supaya /sync bisa ambil lagi.
    await db.updateJobStatus(job.id, 'success', undefined, video.url);
    LOG.stop(job.chatId, job.id, job.taskId, 'delivery gagal — siap diambil /sync');
    return 'pending';
  }

  await db.updateJobStatus(job.id, 'delivered', undefined, video.url);
  LOG.delivered(job.chatId, job.id, job.taskId);
  return 'delivered';
}

/** Polling loop mandiri sampai SUCCESS/FAILED/timeout. Tidak memblokir caller. */
export async function pollTaskUntilDone(
  bot: Telegraf<BotCtx>,
  job: Job,
  client: RunningHubClient,
  timeoutMs: number,
): Promise<void> {
  if (!job.taskId) return;
  LOG.polling(job.chatId, job.id, job.taskId);
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();

  while (Date.now() < deadline) {
    const outcome = await deliverJobResult(bot, job, client);
    if (outcome === 'delivered') return;
    if (outcome === 'failed') return;

    // masih pending — update progres & lanjut polling
    const elapsed = Date.now() - started;
    try {
      const resp = await client.query(job.taskId).catch(() => null);
      if (resp) {
        await updateProgressMessage(bot, job.chatId, job.telegramMessageId, progressText(resp.status, elapsed, job.taskId));
      }
    } catch {
      /* abaikan — polling tetap lanjut */
    }
    await sleep(POLL_INTERVAL_MS);
  }

  LOG.stop(job.chatId, job.id, job.taskId, 'timeout');
  await updateProgressMessage(
    bot,
    job.chatId,
    job.telegramMessageId,
    `⏱️ Waktu tunggu habis (${Math.round(timeoutMs / 60000)} menit). Task mungkin masih jalan di RunningHub — ketik /sync untuk mencoba mengambil hasilnya.`,
  ).catch(() => {});
}

/**
 * Resume polling — panggil saat bot startup.
 * Load semua job 'running' dari DB dan lanjutkan pollingnya (tidak hilang setelah restart).
 */
export async function resumePendingJobs(
  bot: Telegraf<BotCtx>,
  config: AppConfig,
  client: RunningHubClient,
): Promise<number> {
  const jobs = await db.getJobsByStatus('running');
  let resumed = 0;
  for (const job of jobs) {
    if (!job.taskId) {
      // Job yang belum sempat create task (upload/create tertunda) — tandai failed,
      // token dikembalikan, tidak bisa di-resume.
      console.log(`[${job.chatId}] [JOB:${job.id}] Tidak punya taskId — refund & mark failed`);
      await db.updateJobStatus(job.id, 'failed', 'Bot restart sebelum task dibuat');
      await tokenManager.refundTokensForFailure(job.chatId, job.id).catch(() => {});
      continue;
    }
    resumed += 1;
    pollTaskUntilDone(bot, job, client, config.timeoutMs).catch((err) =>
      console.error(`[${job.chatId}] [JOB:${job.id}] Resume polling error: ${err instanceof Error ? err.message : err}`),
    );
  }
  if (resumed > 0) console.log(`🔁 Resume polling ${resumed} job yang masih berjalan.`);
  return resumed;
}

/**
 * Sync undelivered jobs — dipakai /sync.
 * 1) Job status 'running' yang punya taskId → query → kalau SUCCESS, kirim.
 * 2) Job status 'success' (video pernah gagal kirim / belum terkirim) → kirim ulang.
 */
export async function syncUndeliveredJobs(
  bot: Telegraf<BotCtx>,
  ctx: BotCtx,
  client: RunningHubClient,
): Promise<{ delivered: number; pending: number; failed: number }> {
  const stats = { delivered: 0, pending: 0, failed: 0 };

  const runningJobs = (await db.getJobsByStatus('running')).filter((j) => j.taskId);
  const successJobs = await db.getJobsByStatus('success');

  const jobs = [...runningJobs, ...successJobs];
  if (jobs.length === 0) {
    await ctx.reply('🔄 Tidak ada task yang perlu disinkronkan. Semua job sudah beres.');
    return stats;
  }

  await ctx.reply(`🔄 Menyinkronkan ${jobs.length} task...`);

  for (const job of jobs) {
    const outcome = await deliverJobResult(bot, job, client);
    if (outcome === 'delivered') stats.delivered += 1;
    else if (outcome === 'failed') stats.failed += 1;
    else stats.pending += 1;
  }

  await ctx.reply(
    [
      '📦 *Hasil sinkronisasi:*',
      `✅ Terkirim: ${stats.delivered}`,
      `⏳ Masih berjalan / gagal kirim: ${stats.pending}`,
      `❌ Gagal: ${stats.failed}`,
    ].join('\n'),
    { parse_mode: 'Markdown' },
  );
  return stats;
}
