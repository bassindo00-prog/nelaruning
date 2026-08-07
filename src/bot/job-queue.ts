/**
 * Job Queue Manager — menjalankan job secara truly async (non-blocking).
 * Setiap chat punya isolated queue, job lain tidak memblokir chat lain.
 * Polling untuk multiple tasks berjalan paralel di background.
 */

import type { BotCtx } from './session.js';
import db from '../database/index.js';

export interface QueuedJob {
  id: string;
  chatId: number;
  execute: () => Promise<void>;
  label: string;
}

class JobQueueManager {
  private queues = new Map<number, QueuedJob[]>();
  private active = new Set<number>();

  /**
   * Queue job untuk chat tertentu (fire-and-forget).
   * Return immediately — jangan await di handler untuk non-blocking behavior.
   * Kalau tidak ada job active di chat ini, langsung mulai processing async.
   */
  async enqueue(ctx: BotCtx, job: QueuedJob): Promise<void> {
    const chatId = ctx.chat!.id;
    const queue = this.queues.get(chatId) ?? [];
    queue.push(job);
    this.queues.set(chatId, queue);

    // Kalau sudah ada job active di chat ini, tunggu di queue
    if (this.active.has(chatId)) {
      console.log(`[${chatId}] Job queued (${queue.length} in queue)`);
      return;
    }

    // Tidak ada active job — mulai processing (async, non-blocking)
    // Use setImmediate untuk mencegah blocking handler
    setImmediate(() => {
      this.processQueue(chatId).catch((err) => {
        console.error(`[${chatId}] Queue error:`, err instanceof Error ? err.message : err);
      });
    });
    
    console.log(`[${chatId}] Job enqueued - processing started in background`);
  }

  /** Proses queue secara sequential per chat (paralel across chats). */
  private async processQueue(chatId: number): Promise<void> {
    const queue = this.queues.get(chatId);
    if (!queue || queue.length === 0) return;

    const job = queue.shift()!;
    this.active.add(chatId);
    console.log(`[${chatId}] Task started: ${job.label}`);

    // Persist ke DB — status 'running' supaya resume polling bisa lanjut setelah restart.
    db.updateJobStatus(job.id, 'running').catch(() => {});
    console.log(`[${chatId}] [JOB:${job.id}] Status → RUNNING (persisted)`);

    try {
      await job.execute();
      console.log(`[${chatId}] Task completed: ${job.label}`);
    } catch (err) {
      console.error(`[${chatId}] Task error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.active.delete(chatId);
      this.queues.set(chatId, queue.filter((j) => j !== undefined));
      
      // Proses job berikutnya (kalau ada di queue)
      if (queue.length > 0) {
        console.log(`[${chatId}] Processing next task in queue`);
        setImmediate(() => this.processQueue(chatId).catch(console.error));
      }
    }
  }

  isBusy(chatId: number): boolean {
    return this.active.has(chatId);
  }

  getQueueLength(chatId: number): number {
    return this.queues.get(chatId)?.length ?? 0;
  }
}

export const jobQueue = new JobQueueManager();
