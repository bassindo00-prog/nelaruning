/**
 * Job Manager - High-level coordination untuk job lifecycle
 * Handles: create, poll, deliver, retry
 */

import type { AppConfig } from '../config.js';
import type { Telegraf } from 'telegraf';
import type { BotCtx } from '../bot/session.js';
import { jobStore, type StoredJob } from './store.js';
import { runMotionControl, type RunOptions } from '../runninghub/workflow.js';
import { RunningHubClient } from '../runninghub/client.js';
import tokenManager from '../token/manager.js';
import db from '../database/index.js';
import { sleep } from '../utils/wait.js';

export interface JobManagerCreateOpts {
  chatId: number;
  modelVersion: 'v1' | 'v2' | 'v3';
  tokenCost: number;
  imageFileId: string;
  videoFileId?: string;
  imageFileName: string;
  videoFileName?: string;
  prompt?: string;
  seed?: number;
  videoDurationSeconds?: number;
}

/**
 * Create job + lock tokens
 */
export async function createJob(opts: JobManagerCreateOpts): Promise<StoredJob> {
  const jobId = `task_${opts.chatId}_${Date.now()}`;

  const job = await jobStore.create({
    id: jobId,
    chatId: opts.chatId,
    modelVersion: opts.modelVersion,
    tokenCost: opts.tokenCost,
    imageFileId: opts.imageFileId,
    videoFileId: opts.videoFileId,
  });

  // Lock tokens
  const lockResult = await tokenManager.lockTokensForJob(opts.chatId, jobId, opts.modelVersion);
  if (!lockResult.success) {
    await jobStore.updateStatus(jobId, 'FAILED', {
      errorMessage: lockResult.error ?? 'Failed to lock tokens',
    });
    throw new Error(lockResult.error ?? 'Failed to lock tokens');
  }

  console.log(
    `[JobManager] Created job ${jobId}: chat ${opts.chatId}, model ${opts.modelVersion}, tokens locked`,
  );
  return job;
}

/**
 * Execute workflow + poll + handle delivery
 * Returns true if successfully delivered, false if failed
 */
export async function executeAndDeliver(
  job: StoredJob,
  ctx: BotCtx,
  client: RunningHubClient,
  runOpts: RunOptions,
  messageId: number,
): Promise<boolean> {
  const { chatId, id: jobId, modelVersion } = job;

  try {
    // Update status -> RUNNING
    await jobStore.updateStatus(jobId, 'RUNNING', { messageId });

    console.log(
      `[JobManager] Starting execution for job ${jobId} (chat ${chatId}), messageId=${messageId}`,
    );

    // Execute workflow (includes polling)
    let result;
    try {
      result = await runMotionControl(client, runOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[JobManager] Workflow failed for job ${jobId}: ${msg}`);

      // Refund tokens on workflow error
      await tokenManager.refundTokensForFailure(chatId, jobId);
      await jobStore.updateStatus(jobId, 'FAILED', { errorMessage: msg });

      // Notify user
      try {
        await ctx.reply(
          `❌ Proses generate gagal.\n\nToken Anda telah dikembalikan.\n\nError: ${msg.slice(0, 100)}`,
          { parse_mode: 'Markdown' },
        );
      } catch {
        /* ignore */
      }

      return false;
    }

    // SUCCESS - deduct tokens
    console.log(`[JobManager] Workflow succeeded for job ${jobId}, taskId=${result.taskId}`);
    await tokenManager.deductTokensForSuccess(chatId, jobId);
    await jobStore.updateStatus(jobId, 'SUCCESS', {
      runningHubTaskId: result.taskId,
      resultUrl: result.videoUrl,
    });
    await db.updateJobStatus(jobId, 'success', undefined, result.videoUrl);

    // Now deliver to Telegram
    console.log(`[JobManager] Delivering video for job ${jobId} to Telegram...`);
    const delivered = await deliverToTelegram(job, ctx, result.videoBuffer);

    if (delivered) {
      console.log(`[JobManager] Video delivered successfully for job ${jobId}`);
      return true;
    } else {
      console.error(`[JobManager] Failed to deliver video for job ${jobId}`);
      return false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[JobManager] Unhandled error in executeAndDeliver for job ${jobId}: ${msg}`);

    // Try to refund if still locked
    const currentJob = jobStore.getById(jobId);
    if (currentJob && currentJob.status === 'RUNNING') {
      await tokenManager.refundTokensForFailure(chatId, jobId);
      await jobStore.updateStatus(jobId, 'FAILED', { errorMessage: msg });
    }

    return false;
  }
}

/**
 * Deliver video to Telegram + update final message
 * Used when user is active (has context)
 */
export async function deliverToTelegram(
  job: StoredJob,
  ctx: BotCtx,
  videoBuffer?: Buffer,
): Promise<boolean> {
  const { id: jobId, chatId, messageId } = job;
  const maxAttempts = 3;

  // If no buffer provided, try to fetch from resultUrl
  let buffer = videoBuffer;
  if (!buffer && job.resultUrl) {
    try {
      const r = await fetch(job.resultUrl);
      if (r.ok) {
        buffer = Buffer.from(await r.arrayBuffer());
      }
    } catch (err) {
      console.error(`Failed to fetch video from ${job.resultUrl}: ${err}`);
      return false;
    }
  }

  if (!buffer) {
    console.error(`No video buffer for job ${jobId}`);
    return false;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `[JobManager] Delivery attempt ${attempt}/${maxAttempts} for job ${jobId}, msgId=${messageId}`,
      );

      // Send video
      const elapsed = job.completedAt && job.startedAt ? job.completedAt - job.startedAt : 0;
      const elapsedStr = formatElapsed(elapsed);

      await ctx.replyWithVideo(
        { source: buffer, filename: `motion_${job.runningHubTaskId}.mp4` },
        {
          caption: `🟢 Motion Control\n✅ Status: Selesai\n🎬 Video berhasil dikirim\n⏱️ Total waktu: ${elapsedStr}\n\nTerima kasih telah menggunakan NADIN AI.`,
          parse_mode: 'Markdown',
        },
      );

      // Edit progress message to final state
      if (messageId) {
        try {
          await ctx.telegram.editMessageText(
            chatId,
            messageId,
            undefined,
            `🟢 Motion Control\n\n██████████ 100%\n\n⏱️ ${elapsedStr}\n\n✅ Video berhasil dikirim!`,
          );
        } catch (err) {
          console.warn(`[JobManager] Could not edit message ${messageId}: ${err}`);
        }
      }

      // Mark as delivered
      await jobStore.updateStatus(jobId, 'DELIVERED');

      console.log(`[JobManager] Successfully delivered job ${jobId}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[JobManager] Delivery attempt ${attempt} failed for job ${jobId}: ${msg}`);

      if (attempt < maxAttempts) {
        const backoff = 5000 * attempt; // 5s, 10s, 15s
        console.log(`[JobManager] Retrying in ${backoff}ms...`);
        await sleep(backoff);
      }
    }
  }

  console.error(
    `[JobManager] Delivery failed for job ${jobId} after ${maxAttempts} attempts`,
  );
  return false;
}

/**
 * Resume job - continue polling from where it left off
 * Used at bot startup to resume RUNNING jobs
 */
export async function resumeJob(
  job: StoredJob,
  bot: Telegraf<BotCtx>,
  config: AppConfig,
  client: RunningHubClient,
): Promise<void> {
  if (!job.runningHubTaskId) {
    console.warn(`[JobManager] Cannot resume job ${job.id} - no RunningHub taskId`);
    await jobStore.updateStatus(job.id, 'FAILED', {
      errorMessage: 'Missing RunningHub taskId for resume',
    });
    return;
  }

  console.log(`[JobManager] Resuming job ${job.id}, taskId=${job.runningHubTaskId}`);

  try {
    // Poll until completion
    const taskId = job.runningHubTaskId;
    const pollIntervalMs = config.pollIntervalMs || 5000;
    const timeoutMs = config.timeoutMs || 1_800_000; // 30 min
    const deadline = Date.now() + timeoutMs;

    let pollCount = 0;

    while (Date.now() < deadline) {
      pollCount += 1;

      try {
        const resp = await client.query(taskId);

        // Send progress update to user
        if (job.messageId) {
          try {
            const elapsed = Date.now() - (job.startedAt || Date.now());
            const elapsed_str = formatElapsed(elapsed);
            const progressText = `🟣 Motion Control......\n\n⏳ ${elapsed_str}\n\n📊 ${resp.status || 'Processing'}\n\n📍 Mohon tunggu, hasil akan dikirim otomatis.....`;
            await bot.telegram.editMessageText(job.chatId, job.messageId, undefined, progressText).catch(() => {});
          } catch {
            /* ignore */
          }
        }

        if (resp.status === 'SUCCESS') {
          console.log(`[JobManager] Job ${job.id} resumed and completed`);

          // Pick best video
          const video = await pickBestVideo(resp.results || []);
          if (!video?.url) {
            throw new Error('No video in results');
          }

          // Download
          const videoBuffer = await fetch(video.url).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer().then((b) => Buffer.from(b));
          });

          // Try to deliver
          const elapsed = Date.now() - (job.startedAt || Date.now());
          const delivered = await deliverVideoBuffer(
            job,
            bot,
            videoBuffer,
            elapsed,
          );

          if (delivered) {
            await jobStore.updateStatus(job.id, 'DELIVERED', { resultUrl: video.url });
          } else {
            // Keep as SUCCESS for /sync to pickup
            await jobStore.updateStatus(job.id, 'SUCCESS', { resultUrl: video.url });
          }
          return;
        }

        if (resp.status === 'FAILED') {
          const msg = resp.errorMessage || 'Task failed on server';
          await jobStore.updateStatus(job.id, 'FAILED', { errorMessage: msg });
          console.error(`[JobManager] Job ${job.id} failed: ${msg}`);
          
          try {
            await bot.telegram.sendMessage(job.chatId, `❌ Task gagal: ${msg.slice(0, 100)}`);
          } catch {
            /* ignore */
          }
          return;
        }

        // Still running, continue
        await sleep(pollIntervalMs);
      } catch (err) {
        console.error(`[JobManager] Error polling job ${job.id}: ${err}`);
        await sleep(pollIntervalMs);
      }
    }

    // Timeout
    console.warn(`[JobManager] Job ${job.id} timeout after ${Math.round(timeoutMs / 60000)}m`);
    await jobStore.updateStatus(job.id, 'FAILED', {
      errorMessage: `Timeout after ${Math.round(timeoutMs / 60000)} minutes`,
    });

    try {
      await bot.telegram.sendMessage(
        job.chatId,
        `⏱️ Task ${job.runningHubTaskId} masih jalan tapi timeout 30 menit. Ketik /sync untuk cek hasil.`,
      );
    } catch {
      /* ignore */
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[JobManager] Error resuming job ${job.id}: ${msg}`);
    await jobStore.updateStatus(job.id, 'FAILED', { errorMessage: msg });
  }
}

// Helper: deliver video buffer to telegram
async function deliverVideoBuffer(
  job: StoredJob,
  bot: Telegraf<BotCtx>,
  videoBuffer: Buffer,
  elapsedMs: number,
): Promise<boolean> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const elapsedStr = formatElapsed(elapsedMs);

      await bot.telegram.sendVideo(
        job.chatId,
        { source: videoBuffer, filename: `motion_${job.runningHubTaskId}.mp4` },
        {
          caption: `🟢 Motion Control\n✅ Status: Selesai\n🎬 Video berhasil dikirim\n⏱️ Total waktu: ${elapsedStr}\n\nTerima kasih telah menggunakan NADIN AI.`,
          parse_mode: 'Markdown',
        },
      );

      // Update progress message
      if (job.messageId) {
        try {
          await bot.telegram.editMessageText(
            job.chatId,
            job.messageId,
            undefined,
            `🟢 Motion Control\n\n██████████ 100%\n\n⏱️ ${elapsedStr}\n\n✅ Video berhasil dikirim!`,
          );
        } catch (err) {
          console.warn(`Could not edit message ${job.messageId}: ${err}`);
        }
      }

      return true;
    } catch (err) {
      console.error(`Delivery attempt ${attempt}/${maxAttempts} failed: ${err}`);
      if (attempt < maxAttempts) {
        await sleep(5000 * attempt);
      }
    }
  }

  return false;
}

// Helper: pick best video from results
async function pickBestVideo(results: any[]): Promise<any | undefined> {
  const isVideoUrl = (u: string) => /\.(mp4|mov|webm|avi|mkv)(\?|$)/i.test(u);
  const candidates = results.filter((r) => typeof r.url === 'string' && isVideoUrl(r.url));

  if (candidates.length === 0) return results.find((r) => typeof r.url === 'string');
  if (candidates.length === 1) return candidates[0];

  return candidates[0];
}

// Helper: format elapsed time
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
