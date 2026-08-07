import { Markup, Telegraf, session } from 'telegraf';
import type { AppConfig } from '../config.js';
import { RunningHubClient } from '../runninghub/client.js';
import { runMotionControl, type RunProgress, type RunOptions, DEFAULT_PROMPT } from '../runninghub/workflow.js';
import { downloadTelegramFile } from '../utils/telegram.js';
import { formatElapsed, truncate } from '../utils/wait.js';
import type { BotCtx } from './session.js';
import { registerConversationFlow } from './conversation.js';
import { jobQueue } from './job-queue.js';
import db from '../database/index.js';
import tokenManager from '../token/manager.js';
import { jobStore, type StoredJob } from '../job/store.js';
import { createJob, executeAndDeliver, deliverToTelegram } from '../job/manager.js';
import { MOTION_CONTROL_MODELS, TOKEN_PACKAGES, ErrorMessages, SuccessMessages, LoadingStatus, formatTokens, formatRupiah } from '../token/system.js';
import { topupManager } from '../topup/manager.js';
import { TOPUP_PRICING_TIERS } from '../topup/types.js';
import * as fs from 'fs';
import * as path from 'path';

const WELCOME = `🎬 Motion Control Generation\n\nPilih menu di bawah untuk mulai.`;

/** Model/workflow yang tersedia — hanya Kling Motion Control Pro dengan 1080p */
const MOTION_CONTROL_CONFIG = {
  v1: { label: '🎬 Kling Motion Control Pro', tokenCost: 1300, workflowId: process.env.RUNNINGHUB_WORKFLOW_ID || '1998198427450269697', mapping: 'aiwood', instanceType: undefined }, // V1 workflow ID dari .env dengan 1300 token cost per generate
};

/** Format ms → HH:MM:SS */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** Create progress bar with filled/empty blocks */
function createProgressBar(percentage: number): string {
  const barLength = 10;
  const filled = Math.round((percentage / 100) * barLength);
  const empty = barLength - filled;
  const filledBar = '█'.repeat(filled);
  const emptyBar = '░'.repeat(empty);
  return `${filledBar}${emptyBar} ${percentage}%`;
}

/** Format loading message with dynamic progress based on elapsed time */
function formatLoadingMessage(elapsed: string, elapsedMs: number): string {
  // Estimasi total waktu: 7-15 menit. Pakai 10 menit (600s) sebagai baseline
  // Progress: 5% pada queue, kemudian increment smooth hingga 95%
  const ESTIMATE_MS = 600_000; // 10 menit
  let percentage = 5 + Math.round((elapsedMs / ESTIMATE_MS) * 90);
  percentage = Math.max(5, Math.min(95, percentage)); // Cap antara 5-95%
  
  return `🟣 Motion Control......\n\n${createProgressBar(percentage)}\n\n⏳ ${elapsed}\n\n📍 Mohon tunggu 7 sampai 15 menit hasil akan dikirim otomatis.....`;
}

/**
 * Start job - create, lock tokens, execute with persistent tracking
 */
async function startJob(ctx: BotCtx, config: AppConfig, client: RunningHubClient): Promise<void> {
  const s = ctx.session;
  const chatId = ctx.chat!.id;

  if (jobQueue.isBusy(chatId)) {
    const queueLen = jobQueue.getQueueLength(chatId);
    await ctx.reply(`⏳ Masih ada job yang berjalan (${queueLen + 1} dalam queue). Tunggu selesai dulu ya.`);
    return;
  }

  if (!s.imageFileId) {
    await ctx.reply('⚠️ Input belum lengkap. Kirim: gambar.');
    return;
  }

  if (!s.modelVersion) {
    await ctx.reply('⚠️ Pilih model dulu via /model atau menu.');
    return;
  }

  const modelVersion = s.modelVersion as 'v1';
  const modelConfig = MOTION_CONTROL_CONFIG['v1'];

  // Immediate response
  const startMsg = await ctx.reply(`🚀 ${modelConfig.label}\n\n⏳ Menyiapkan file…`);
  const messageId = startMsg.message_id;

  // Enqueue to background
  await jobQueue.enqueue(ctx, {
    id: `job_${Date.now()}`,
    chatId,
    label: `Motion Control ${modelVersion} untuk chat ${chatId}`,
    execute: async () => {
      const jobStart = Date.now();
      let job: StoredJob | null = null;

      try {
        // 1) Create persistent job + lock tokens
        job = await createJob({
          chatId,
          modelVersion,
          tokenCost: modelConfig.tokenCost,
          imageFileId: s.imageFileId!,
          videoFileId: s.videoFileId,
          imageFileName: s.imageName || `image_${Date.now()}.jpg`,
          videoFileName: s.videoName,
          prompt: s.prompt,
          seed: s.seed,
          videoDurationSeconds: s.videoDurationSeconds,
        });

        console.log(`[${chatId}] Job created: ${job.id}`);

        // Update messageId for progress updates
        await jobStore.updateStatus(job.id, 'QUEUED', { messageId });

        // 2) Download files
        console.log(`[${chatId}] Downloading files for job ${job.id}...`);
        const image = await downloadTelegramFile(ctx.telegram, s.imageFileId!, config.telegramBotToken);

        let video: { buffer: Buffer; name: string } | undefined;
        if (s.videoFileId) {
          video = await downloadTelegramFile(ctx.telegram, s.videoFileId, config.telegramBotToken);
        }

        // 3) Build RunOptions for executeAndDeliver
        // instanceType dari config: "default" (24GB), "plus" (48GB), atau undefined (auto LITE)
        const runOpts: RunOptions = {
          imageBuffer: image.buffer,
          imageName: image.name,
          videoBuffer: video?.buffer,
          videoName: video?.name,
          prompt: s.prompt ?? DEFAULT_PROMPT,
          seed: s.seed,
          workflowId: modelConfig.workflowId,
          instanceType: modelConfig.instanceType ?? config.instanceType, // ← Use model-specific instanceType
          apiKey: config.runningHub.apiKey,
          videoDurationSeconds: s.videoDurationSeconds,
          retainSeconds: config.retainSeconds,
          mapping: modelConfig.mapping,
          pollIntervalMs: config.pollIntervalMs,
          timeoutMs: config.timeoutMs,
          chatId,
          onProgress: async (p: RunProgress) => {
            if (!messageId) return;

            const elapsedMs = Date.now() - jobStart;
            const elapsed = fmtClock(elapsedMs);
            let text = formatLoadingMessage(elapsed, elapsedMs);

            if (p.status === 'SUCCESS') {
              text = `🟣 Motion Control......\n\n██████████ 100%\n\n⏱️ ${elapsed}\n\n✅ Selesai! Video sedang dikirim...`;
            } else if (p.status === 'FAILED') {
              text = `❌ Status: GAGAL\n\n⏱️ ${elapsed}\n\nSilakan coba lagi.`;
            }

            try {
              await ctx.telegram.editMessageText(chatId, messageId, undefined, text);
            } catch (err) {
              console.warn(`[${chatId}] Could not edit message ${messageId}: ${err}`);
            }
          },
        };

        // 4) Execute + deliver
        console.log(`[${chatId}] Executing job ${job.id}...`);
        const delivered = await executeAndDeliver(job, ctx, client, runOpts, messageId);

        if (!delivered) {
          console.warn(`[${chatId}] Job ${job.id} failed to deliver - user can retry with /sync`);
        }

        // 5) Cleanup session
        s.imageFileId = undefined;
        s.imageName = undefined;
        s.videoFileId = undefined;
        s.videoName = undefined;
        s.conversationState = 'idle';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${chatId}] Job execution failed: ${msg}`);

        // Ensure job status updated
        if (job) {
          await jobStore.updateStatus(job.id, 'FAILED', { errorMessage: msg });
          await tokenManager.refundTokensForFailure(chatId, job.id);
        }

        try {
          await ctx.reply(`❌ Proses generate gagal.\n\nError: ${msg.slice(0, 100)}`, {
            parse_mode: 'Markdown',
          });
        } catch {
          /* ignore */
        }

        s.imageFileId = undefined;
        s.imageName = undefined;
        s.videoFileId = undefined;
        s.videoName = undefined;
        s.conversationState = 'idle';
      }
    },
  });
}

/** Edit pesan progres atau kirim baru */
async function editOrReply(ctx: BotCtx, progressMsgId: number | undefined, text: string) {
  try {
    if (progressMsgId !== undefined) {
      await ctx.telegram.editMessageText(ctx.chat!.id, progressMsgId, undefined, text);
    } else {
      await ctx.reply(text);
    }
  } catch {
    try {
      await ctx.reply(text);
    } catch {
      /* ignore */
    }
  }
}

/**
 * /sync command - deliver undelivered SUCCESS jobs
 */
async function syncUndeliveredJobs(bot: Telegraf<BotCtx>, ctx: BotCtx, client: RunningHubClient): Promise<void> {
  const chatId = ctx.chat!.id;
  
  // Get all undelivered SUCCESS jobs
  const allUndelivered = jobStore.getUndeliveredSuccess();
  
  // Filter to current chat only
  const undelivered = allUndelivered.filter(j => j.chatId === chatId);
  
  if (undelivered.length === 0) {
    await ctx.reply('✅ Tidak ada job yang pending delivery.');
    return;
  }

  await ctx.reply(`🔄 Syncing ${undelivered.length} job(s)...`);

  for (const job of undelivered) {
    try {
      console.log(`[${chatId}] /sync - processing job ${job.id} (status=${job.status})`);
      
      if (!job.resultUrl) {
        console.warn(`[${chatId}] Job ${job.id} has no resultUrl - skipping`);
        await ctx.reply(`⚠️ Job ${job.id}: no video URL available`);
        continue;
      }

      // Try to deliver
      const delivered = await deliverToTelegram(job, ctx);
      
      if (delivered) {
        console.log(`[${chatId}] /sync - job ${job.id} delivered successfully`);
        await jobStore.updateStatus(job.id, 'DELIVERED');
        await ctx.reply(`✅ Job ${job.id}: video delivered!`);
      } else {
        console.warn(`[${chatId}] /sync - job ${job.id} delivery failed (may retry later)`);
        await ctx.reply(`❌ Job ${job.id}: delivery failed - will retry later`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${chatId}] /sync - job ${job.id} error: ${msg}`);
      await ctx.reply(`❌ Job ${job.id}: ${msg.slice(0, 100)}`);
    }
  }

  await ctx.reply('✨ Sync complete!');
}

/** Create bot instance */
export function createBot(config: AppConfig): Telegraf<BotCtx> {
  const bot = new Telegraf<BotCtx>(config.telegramBotToken, {
    handlerTimeout: config.timeoutMs + 60_000,
  });

  // Error handler
  bot.catch((err, ctx) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${ctx.chat?.id}] Error: ${msg}`);
    ctx.reply(`❌ Error: ${msg.slice(0, 200)}`).catch(() => {});
  });

  // TEMP PROBE — hapus setelah debug selesai
  bot.use(async (ctx, next) => {
    console.log(`[PROBE] update=${ctx.update.update_id} type=${ctx.updateType ?? '?'} from=${ctx.from?.id ?? '?'}`);
    try {
      return await next();
    } catch (err) {
      console.error(`[PROBE] next() throw: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  });

  bot.use(session({ defaultSession: () => ({}) }));

  // Update command menu
  bot.telegram
    .setMyCommands([
      { command: 'start', description: 'Menu utama' },
      { command: 'help', description: 'Bantuan' },
      { command: 'run', description: 'Jalankan dengan file tersimpan' },
      { command: 'reset', description: 'Reset session' },
      { command: 'sync', description: 'Sync hasil task yang belum terkirim' },
    ])
    .catch((err) => console.error('Gagal set command:', err.message));

  const client = new RunningHubClient({
    apiKey: config.runningHub.apiKey,
    baseUrl: config.runningHub.baseUrl,
    rootBaseUrl: config.runningHub.rootBaseUrl,
    runPath: config.runningHub.runPath,
  });

  registerConversationFlow(bot, config, client);

  // ===== Main Menu =====
  bot.start(async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] /start command`);
    
    // Initialize user
    await db.createOrUpdateUser(chatId, ctx.from?.id || 0, ctx.from?.username);
    await tokenManager.initializeUser(chatId, 0);

    return ctx.reply(WELCOME, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('🎥 Generation Video', 'gen:start')],
          [Markup.button.callback('💳 Top Up Kredit', 'payment:topup')],
          [Markup.button.callback('🪙 Credit Token', 'credit:show'), Markup.button.callback('🆔 User ID', 'userid:show')],
        ],
      },
    });
  });

  bot.help(async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] /help command`);
    return ctx.reply(WELCOME, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('🎥 Generation Video', 'gen:start')],
          [Markup.button.callback('💳 Top Up Kredit', 'payment:topup')],
          [Markup.button.callback('🪙 Credit Token', 'credit:show'), Markup.button.callback('🆔 User ID', 'userid:show')],
        ],
      },
    });
  });

  // ===== Main Menu Callbacks =====

  // 🎥 Generation Video - langsung default ke V1 (Kling Motion Control Pro)
  bot.action('gen:start', async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] gen:start - auto-select V1`);
    await ctx.answerCbQuery();

    ctx.session.modelVersion = 'v1';
    const cfg = MOTION_CONTROL_CONFIG.v1;

    await ctx.editMessageText(
      `✅ ${cfg.label} dipilih\n\nToken cost: ${cfg.tokenCost.toLocaleString('id-ID')} token (1080p)\n\nSekarang kirim:\n1. 📸 Gambar\n2. 🎬 Video referensi (minimal 30 detik)\n3. Tekan ▶️ Jalankan`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('← Kembali ke Menu', 'menu:back')],
          ],
        },
      },
    ).catch(() => {});
  });

  // 💰 Beli Token - REMOVED (diganti dengan TOP UP KREDIT QRIS)
  // bot.action('payment:menu', async (ctx) => { ... });

  // 🪙 Credit Token
  bot.action('credit:show', async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] credit:show - display token stats`);
    await ctx.answerCbQuery();

    const stats = await tokenManager.getTokenStats(chatId);
    const balance = await db.getTokenBalance(chatId);

    const balanceText = balance
      ? `Saldo: ${formatTokens(balance.balance)} token\nTerkunci: ${formatTokens(balance.lockedTokens)} token`
      : 'Saldo: 0 token';

    await ctx.editMessageText(
      `🪙 **Credit Token**\n\n${balanceText}\n\n📊 Statistik:\n• Generate berhasil: ${stats.totalGenerated}\n• Generate gagal: ${stats.totalFailed}\n• Total terpakai: ${formatTokens(stats.totalSpent)} token`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('← Kembali', 'menu:back')],
          ],
        },
      },
    ).catch(() => {});
  });

  // 🆔 User ID
  bot.action('userid:show', async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] userid:show`);
    await ctx.answerCbQuery();

    const userId = ctx.from?.id || '?';
    const username = ctx.from?.username || 'N/A';

    await ctx.editMessageText(
      `🆔 **Your ID**\n\nTelegram ID: \`${userId}\`\nUsername: @${username}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('← Kembali', 'menu:back')],
          ],
        },
      },
    ).catch(() => {});
  });

  // Back button
  bot.action('menu:back', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(WELCOME, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('🎥 Generation Video', 'gen:start')],
          [Markup.button.callback('💳 Top Up Kredit', 'payment:topup')],
          [Markup.button.callback('🪙 Credit Token', 'credit:show'), Markup.button.callback('🆔 User ID', 'userid:show')],
        ],
      },
    }).catch(() => {});
  });

  // ===== Commands =====

  bot.command('run', (ctx) => startJob(ctx, config, client));

  bot.command('reset', async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] /reset command`);
    ctx.session.imageFileId = undefined;
    ctx.session.imageName = undefined;
    ctx.session.videoFileId = undefined;
    ctx.session.videoName = undefined;
    ctx.session.prompt = undefined;
    ctx.session.seed = undefined;
    ctx.session.conversationState = undefined;
    ctx.session.modelVersion = undefined;
    await ctx.reply('🧹 Session dibersihkan.');
  });

  // /model command - REMOVED (hanya ada V1 Kling Motion Control Pro sekarang)
  // bot.command('model', async (ctx) => { ... });

  // ===== /sync — pulihkan task SUCCESS yang belum terkirim videonya =====
  bot.command('sync', async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] /sync command`);
    try {
      await syncUndeliveredJobs(bot, ctx, client);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${chatId}] /sync error: ${msg}`);
      await ctx.reply(`❌ Sync gagal: ${msg.slice(0, 200)}`).catch(() => {});
    }
  });

  // ===== /notifyuser — Send admin notification to user (format: /notifyuser <userId> <message>) =====
  bot.command('notifyuser', async (ctx) => {
    const chatId = ctx.chat!.id;
    const cmdText = ctx.message.text || '';
    const parts = cmdText.split(' ').slice(1); // Skip command name
    
    if (parts.length < 2) {
      await ctx.reply('Usage: /notifyuser <userId> <message>');
      return;
    }

    const userId = Number(parts[0]);
    const message = parts.slice(1).join(' ');

    if (isNaN(userId)) {
      await ctx.reply('⚠️ User ID harus number');
      return;
    }

    try {
      await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
      await ctx.reply(`✅ Notifikasi terkirim ke user ${userId}`);
      console.log(`[ADMIN] Notif sent to user ${userId}: ${message.slice(0, 50)}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Gagal kirim notif: ${errMsg.slice(0, 100)}`);
      console.error(`[ADMIN] Failed to notify user ${userId}: ${errMsg}`);
    }
  });

  // ===== /addtoken — Add tokens + auto-notify user (format: /addtoken <userId> <amount> [reason]) =====
  bot.command('addtoken', async (ctx) => {
    const chatId = ctx.chat!.id;
    const cmdText = ctx.message.text || '';
    const parts = cmdText.split(' ').slice(1); // Skip command name
    
    if (parts.length < 2) {
      await ctx.reply('Usage: /addtoken <userId> <amount> [reason]');
      return;
    }

    const userId = Number(parts[0]);
    const amount = Number(parts[1]);
    const reason = parts.slice(2).join(' ') || 'Topup manual';

    if (isNaN(userId) || isNaN(amount) || amount <= 0) {
      await ctx.reply('⚠️ Invalid userId atau amount');
      return;
    }

    try {
      // Update database
      const botJsonPath = './data/bot.json';
      const botData = JSON.parse(require('fs').readFileSync(botJsonPath, 'utf-8'));

      // Update balance
      if (!botData.tokenBalances[userId]) {
        botData.tokenBalances[userId] = {
          chatId: userId,
          balance: 0,
          lockedTokens: 0,
          totalEarned: 0,
          totalSpent: 0,
          updatedAt: Date.now(),
        };
      }

      botData.tokenBalances[userId].balance += amount;
      botData.tokenBalances[userId].totalEarned += amount;
      botData.tokenBalances[userId].updatedAt = Date.now();

      // Add history entry
      const histEntry = {
        id: `${userId}_${Date.now()}_0.admin`,
        chatId: userId,
        type: 'earn',
        tokens: amount,
        reason,
        createdAt: Date.now(),
      };
      botData.tokenHistory.push(histEntry);

      // Save
      require('fs').writeFileSync(botJsonPath, JSON.stringify(botData, null, 2), 'utf-8');

      const newBalance = botData.tokenBalances[userId].balance;

      // Notify user
      try {
        await bot.telegram.sendMessage(
          userId,
          `💰 *Topup Berhasil!*\n\n✅ Saldo +${amount} token ditambahkan!\n\n💳 Total Saldo: *${newBalance} token*\n\n🎬 Siap generate video!`,
          { parse_mode: 'Markdown' }
        );
        console.log(`[ADMIN] Topup: user ${userId} +${amount} (new balance: ${newBalance}), notif sent`);
      } catch (notifErr) {
        console.warn(`[ADMIN] Topup success but notif failed: ${notifErr instanceof Error ? notifErr.message : notifErr}`);
      }

      await ctx.reply(`✅ Topup berhasil!\n\nUser: ${userId}\nAmount: +${amount}\nNew Balance: ${newBalance}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Gagal add token: ${errMsg.slice(0, 100)}`);
      console.error(`[ADMIN] /addtoken error: ${errMsg}`);
    }
  });

  // ===== File Inputs =====

  bot.on('photo', async (ctx) => {
    const chatId = ctx.chat!.id;
    if (jobQueue.isBusy(chatId)) {
      console.log(`[${chatId}] Photo received but job busy`);
      await ctx.reply('⏳ Masih memproses job sebelumnya…');
      return;
    }

    const photo = ctx.message.photo.at(-1);
    if (!photo) return;

    ctx.session.imageFileId = photo.file_id;
    ctx.session.imageName = `photo_${ctx.message.message_id}.jpg`;

    console.log(`[${chatId}] Image received`);
    // NO Run button here - wait for video
    await ctx.reply('🖼️ Gambar diterima.\n\n📹 Sekarang kirim video referensi (3-30 detik)');
  });

  bot.on('video', async (ctx) => {
    const chatId = ctx.chat!.id;
    if (jobQueue.isBusy(chatId)) {
      console.log(`[${chatId}] Video received but job busy`);
      await ctx.reply('⏳ Masih memproses job sebelumnya…');
      return;
    }

    const video = ctx.message.video;
    const duration = video.duration || 0;

    // Video referensi: minimal 3 detik, maksimal 30 detik
    if (duration < 3) {
      console.log(`[${chatId}] Video too short: ${duration}s`);
      await ctx.reply(`❌ Video terlalu pendek (${duration}s). Minimal 3 detik.`);
      return;
    }

    if (duration > 30) {
      console.log(`[${chatId}] Video too long: ${duration}s`);
      await ctx.reply(`❌ Video terlalu panjang (${duration}s). Maksimal 30 detik.`);
      return;
    }

    ctx.session.videoFileId = video.file_id;
    ctx.session.videoName = video.file_name ?? `video_${ctx.message.message_id}.mp4`;
    ctx.session.videoDurationSeconds = Math.round(duration);

    console.log(`[${chatId}] Video received: ${duration}s`);
    await ctx.reply(`🎬 Video diterima (${duration}s)\n\n✨ Siap untuk di-generate!`, {
      reply_markup: {
        inline_keyboard: [[Markup.button.callback('▶️ Jalankan', 'run_immediate')]],
      },
    });
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat!.id;
    const text = ctx.message.text.trim();

    if (text.startsWith('/')) return;

    if (jobQueue.isBusy(chatId)) {
      console.log(`[${chatId}] Text received but job busy`);
      await ctx.reply('⏳ Masih memproses…');
      return;
    }

    ctx.session.prompt = text;
    console.log(`[${chatId}] Prompt received: ${text.slice(0, 50)}`);
    await ctx.reply(`✍️ Prompt diterima: "${truncate(text, 60)}"`, {
      reply_markup: {
        inline_keyboard: [[Markup.button.callback('▶️ Jalankan', 'run_immediate')]],
      },
    });
  });

  // Run button
  bot.action('run_immediate', async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] run_immediate button`);
    await ctx.answerCbQuery();
    if (jobQueue.isBusy(chatId)) {
      await ctx.reply('⏳ Masih memproses…');
      return;
    }
    
    // HAPUS BUTTON — edit pesan lama untuk remove inline keyboard
    try {
      await ctx.telegram.editMessageReplyMarkup(
        chatId,
        ctx.callbackQuery!.message!.message_id,
        undefined,
        { inline_keyboard: [] }
      );
      console.log(`[${chatId}] Button removed from message`);
    } catch (err) {
      console.log(`[${chatId}] Could not remove button: ${err instanceof Error ? err.message : err}`);
    }
    
    await startJob(ctx, config, client);
  });

  // ===== TOP UP KREDIT SYSTEM =====

  // 💳 TOP UP KREDIT MENU
  bot.action('payment:topup', async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] TOP UP menu requested`);
    await ctx.answerCbQuery();

    const text = `━━━━━━━━━━━━━━━━━━\n💳 TOP UP KREDIT\n\nSilakan transfer menggunakan QRIS DANA berikut.\n\nPilih nominal:\n\n${TOPUP_PRICING_TIERS.map((t) => t.label).join('\n')}\n━━━━━━━━━━━━━━━━━━`;

    const keyboard = [
      ...TOPUP_PRICING_TIERS.map((tier) => [Markup.button.callback(tier.label, tier.callbackData)]),
      [Markup.button.callback('← Kembali', 'menu:back')],
    ];

    try {
      // Try to send QRIS image
      const qrisPath = config.qrisImagePath;
      const qrisFullPath = path.resolve(qrisPath);

      if (fs.existsSync(qrisFullPath)) {
        console.log(`[${chatId}] Sending QRIS image from ${qrisFullPath}`);
        await ctx.replyWithPhoto(
          { source: qrisFullPath },
          {
            caption: text,
            reply_markup: { inline_keyboard: keyboard },
          }
        );
      } else {
        console.warn(`[${chatId}] QRIS image not found at ${qrisFullPath}`);
        await ctx.reply(text, {
          reply_markup: { inline_keyboard: keyboard },
        });
      }
    } catch (err) {
      console.error(`[${chatId}] Error sending QRIS: ${err instanceof Error ? err.message : err}`);
      await ctx.reply(text, {
        reply_markup: { inline_keyboard: keyboard },
      });
    }
  });

  // Select topup amount
  bot.action(/^topup:select:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const amountRp = Number(ctx.match[1]);
    console.log(`[${chatId}] topup:select - amount=${amountRp}`);
    await ctx.answerCbQuery();

    const tier = TOPUP_PRICING_TIERS.find((t) => t.amount === amountRp);
    if (!tier) {
      await ctx.reply('❌ Nominal tidak valid');
      return;
    }

    // Store in session temporarily
    ctx.session.topupAmountRp = amountRp;
    ctx.session.topupCreditAmount = tier.credit;

    const text = `✅ Anda memilih:\n\n💰 Nominal: Rp${amountRp.toLocaleString('id-ID')}\n🎁 Kredit: ${tier.credit} Kredit\n\n👇 Setelah transfer, klik tombol di bawah:`;

    // Try to edit caption if photo, otherwise edit text
    try {
      await ctx.editMessageCaption(text, {
        reply_markup: {
          inline_keyboard: [[Markup.button.callback('✅ Saya Sudah Bayar', 'topup:confirm')]],
        },
      });
    } catch (err) {
      // If photo edit fails, try text edit or send new message
      try {
        await ctx.editMessageText(text, {
          reply_markup: {
            inline_keyboard: [[Markup.button.callback('✅ Saya Sudah Bayar', 'topup:confirm')]],
          },
        });
      } catch {
        // Last resort: send new message
        await ctx.reply(text, {
          reply_markup: {
            inline_keyboard: [[Markup.button.callback('✅ Saya Sudah Bayar', 'topup:confirm')]],
          },
        });
      }
    }
  });

  // Confirm payment - create PENDING request and notify admin
  bot.action('topup:confirm', async (ctx) => {
    const chatId = ctx.chat!.id;
    console.log(`[${chatId}] topup:confirm - create request`);
    await ctx.answerCbQuery();

    if (!ctx.session.topupAmountRp || !ctx.session.topupCreditAmount) {
      await ctx.reply('❌ Data topup tidak valid. Silakan ulangi dari awal.');
      ctx.session.topupAmountRp = undefined;
      ctx.session.topupCreditAmount = undefined;
      return;
    }

    try {
      // Create topup request
      const request = topupManager.create(
        chatId,
        ctx.from?.username || `user_${chatId}`,
        ctx.from?.first_name || `User${chatId}`,
        ctx.session.topupAmountRp
      );

      console.log(`[${chatId}] Topup request created: ${request.id}`);

      // Notify user
      await ctx.reply(`✅ Request diterima!\n\n🆔 Request ID: \`${request.id}\`\n\n⏳ Menunggu persetujuan admin...\n\nSilakan tunggu beberapa saat.`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[Markup.button.callback('← Kembali ke Menu', 'menu:back')]],
        },
      }).catch(() => {});

      // Notify admin
      const adminId = config.adminTelegramId;
      if (adminId > 0) {
        const adminText = `🔔 REQUEST TOP UP BARU\n\n👤 Nama: ${request.name}\n📛 Username: @${request.username}\n🆔 Telegram ID: \`${request.telegramId}\`\n💰 Nominal: Rp${request.amount.toLocaleString('id-ID')}\n🎁 Kredit: ${request.credit} Kredit\n🕒 Waktu: ${new Date(request.createdAt).toLocaleString('id-ID')}\n\nStatus: 🟡 Pending\n\n🆔 Request ID: \`${request.id}\``;

        try {
          await bot.telegram.sendMessage(adminId, adminText, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  Markup.button.callback('✅ Approve', `topup:approve:${request.id}`),
                  Markup.button.callback('❌ Reject', `topup:reject:${request.id}`),
                ],
              ],
            },
          });
          console.log(`[ADMIN] Topup notification sent for request ${request.id}`);
        } catch (err) {
          console.error(`[ADMIN] Failed to notify admin: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Clear session
      ctx.session.topupAmountRp = undefined;
      ctx.session.topupCreditAmount = undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${chatId}] topup:confirm error: ${msg}`);
      await ctx.reply(`❌ Gagal membuat request: ${msg}`).catch(() => {});
    }
  });

  // Admin: Approve topup
  bot.action(/^topup:approve:(.+)$/, async (ctx) => {
    const adminId = ctx.chat!.id;
    const requestId = ctx.match[1];

    console.log(`[ADMIN] approve request ${requestId}`);

    // Check admin
    if (adminId !== config.adminTelegramId) {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Hanya admin yang bisa approve');
      return;
    }

    await ctx.answerCbQuery();

    try {
      const request = topupManager.getById(requestId);
      if (!request) {
        await ctx.editMessageText('❌ Request tidak ditemukan').catch(() => {});
        return;
      }

      // Check if already processed
      if (request.status !== 'PENDING') {
        await ctx.editMessageText(`⚠️ Request sudah diproses.\n\nStatus: ${request.status}`).catch(() => {});
        return;
      }

      // Update request status
      topupManager.updateStatus(requestId, 'APPROVED', 'admin');

      // Add credits to user's tokenBalances
      const botJsonPath = path.resolve('./data/bot.json');
      const botData = JSON.parse(fs.readFileSync(botJsonPath, 'utf-8'));

      if (!botData.tokenBalances[request.telegramId]) {
        botData.tokenBalances[request.telegramId] = {
          chatId: request.telegramId,
          balance: 0,
          lockedTokens: 0,
          totalEarned: 0,
          totalSpent: 0,
          updatedAt: Date.now(),
        };
      }

      botData.tokenBalances[request.telegramId].balance += request.credit;
      botData.tokenBalances[request.telegramId].totalEarned += request.credit;
      botData.tokenBalances[request.telegramId].updatedAt = Date.now();

      // Add history entry
      const histEntry = {
        id: `${request.telegramId}_${Date.now()}_0.topup`,
        chatId: request.telegramId,
        type: 'earn',
        tokens: request.credit,
        reason: `Topup QRIS ${request.amount} (Request: ${requestId})`,
        createdAt: Date.now(),
      };
      botData.tokenHistory.push(histEntry);

      fs.writeFileSync(botJsonPath, JSON.stringify(botData, null, 2), 'utf-8');

      const newBalance = botData.tokenBalances[request.telegramId].balance;

      // Edit admin message to show APPROVED
      await ctx.editMessageText(
        `🔔 REQUEST TOP UP\n\n👤 Nama: ${request.name}\n📛 Username: @${request.username}\n🆔 Telegram ID: \`${request.telegramId}\`\n💰 Nominal: Rp${request.amount.toLocaleString('id-ID')}\n🎁 Kredit: ${request.credit} Kredit\n\n✅ APPROVED by admin`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});

      // Notify user
      const userText = `✅ TOP UP BERHASIL\n\n💰 Nominal: Rp${request.amount.toLocaleString('id-ID')}\n🎁 Kredit Masuk: ${request.credit} Kredit\n💳 Saldo Sekarang: ${newBalance} Kredit\n\nTerima kasih!`;

      try {
        await bot.telegram.sendMessage(request.telegramId, userText, {
          parse_mode: 'Markdown',
        });
        console.log(`[TOPUP] User ${request.telegramId} notified of approval`);
      } catch (err) {
        console.error(`[TOPUP] Failed to notify user: ${err instanceof Error ? err.message : err}`);
      }

      console.log(`[ADMIN] Topup ${requestId} approved - user ${request.telegramId} +${request.credit} credits`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ADMIN] topup:approve error: ${msg}`);
      await ctx.editMessageText(`❌ Error: ${msg.slice(0, 100)}`).catch(() => {});
    }
  });

  // Admin: Reject topup
  bot.action(/^topup:reject:(.+)$/, async (ctx) => {
    const adminId = ctx.chat!.id;
    const requestId = ctx.match[1];

    console.log(`[ADMIN] reject request ${requestId}`);

    // Check admin
    if (adminId !== config.adminTelegramId) {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Hanya admin yang bisa reject');
      return;
    }

    await ctx.answerCbQuery();

    try {
      const request = topupManager.getById(requestId);
      if (!request) {
        await ctx.editMessageText('❌ Request tidak ditemukan').catch(() => {});
        return;
      }

      // Check if already processed
      if (request.status !== 'PENDING') {
        await ctx.editMessageText(`⚠️ Request sudah diproses.\n\nStatus: ${request.status}`).catch(() => {});
        return;
      }

      // Update request status
      topupManager.updateStatus(requestId, 'REJECTED', 'admin');

      // Edit admin message
      await ctx.editMessageText(
        `🔔 REQUEST TOP UP\n\n👤 Nama: ${request.name}\n📛 Username: @${request.username}\n🆔 Telegram ID: \`${request.telegramId}\`\n💰 Nominal: Rp${request.amount.toLocaleString('id-ID')}\n🎁 Kredit: ${request.credit} Kredit\n\n❌ REJECTED by admin`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});

      // Notify user
      const userText = `❌ Top up ditolak.\n\nSilakan hubungi admin jika merasa ini kesalahan.`;

      try {
        await bot.telegram.sendMessage(request.telegramId, userText, {
          parse_mode: 'Markdown',
        });
        console.log(`[TOPUP] User ${request.telegramId} notified of rejection`);
      } catch (err) {
        console.error(`[TOPUP] Failed to notify user: ${err instanceof Error ? err.message : err}`);
      }

      console.log(`[ADMIN] Topup ${requestId} rejected`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ADMIN] topup:reject error: ${msg}`);
      await ctx.editMessageText(`❌ Error: ${msg.slice(0, 100)}`).catch(() => {});
    }
  });

  // /topup command - Admin view requests
  bot.command('topup', async (ctx) => {
    const adminId = ctx.chat!.id;
    console.log(`[${adminId}] /topup command`);

    // Check admin
    if (adminId !== config.adminTelegramId) {
      await ctx.reply('❌ Hanya admin yang bisa menggunakan command ini');
      return;
    }

    const allRequests = topupManager.getLatest(10);

    if (allRequests.length === 0) {
      await ctx.reply('📋 Tidak ada topup request');
      return;
    }

    let text = `📋 TOP UP REQUESTS (Latest 10)\n\n`;

    const byStatus = {
      PENDING: allRequests.filter((r) => r.status === 'PENDING'),
      APPROVED: allRequests.filter((r) => r.status === 'APPROVED'),
      REJECTED: allRequests.filter((r) => r.status === 'REJECTED'),
    };

    for (const [status, reqs] of Object.entries(byStatus)) {
      if (reqs.length === 0) continue;
      const statusEmoji = status === 'PENDING' ? '🟡' : status === 'APPROVED' ? '✅' : '❌';
      text += `${statusEmoji} ${status} (${reqs.length}):\n`;
      for (const req of reqs.slice(0, 3)) {
        text += `  • @${req.username}: Rp${req.amount.toLocaleString('id-ID')} → ${req.credit} kredit\n`;
      }
      text += '\n';
    }

    const keyboard = [
      [Markup.button.callback('🟡 Pending', 'topup:filter:PENDING')],
      [Markup.button.callback('✅ Approved', 'topup:filter:APPROVED')],
      [Markup.button.callback('❌ Rejected', 'topup:filter:REJECTED')],
    ];

    await ctx.reply(text, {
      reply_markup: { inline_keyboard: keyboard },
    });
  });

  // Filter topup requests
  bot.action(/^topup:filter:(PENDING|APPROVED|REJECTED)$/, async (ctx) => {
    const adminId = ctx.chat!.id;
    const status = ctx.match[1] as 'PENDING' | 'APPROVED' | 'REJECTED';

    console.log(`[ADMIN] topup:filter - ${status}`);

    if (adminId !== config.adminTelegramId) {
      await ctx.answerCbQuery();
      await ctx.reply('❌ Hanya admin yang bisa mengakses');
      return;
    }

    await ctx.answerCbQuery();

    const reqs = topupManager.getByStatus(status);

    if (reqs.length === 0) {
      await ctx.editMessageText(`📋 Tidak ada request dengan status ${status}`).catch(() => {});
      return;
    }

    let text = `📋 TOP UP REQUESTS - ${status}\n\n`;

    for (const req of reqs) {
      const time = new Date(req.createdAt).toLocaleString('id-ID');
      text += `━━━━━━━\n@${req.username}\n💰 Rp${req.amount.toLocaleString('id-ID')} → ${req.credit} kredit\n🕒 ${time}\n🆔 ${req.id}\n`;
    }

    await ctx.editMessageText(text, {
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('← Back', 'menu:back')],
        ],
      },
    }).catch(() => {});
  });

  return bot;
}
