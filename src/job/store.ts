/**
 * Persistent Job Store - JSON-based storage untuk all jobs
 * Tracks complete job lifecycle dari creation -> delivery
 */

import fs from 'fs-extra';
import path from 'path';

export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'DELIVERED' | 'FAILED';

export interface StoredJob {
  // Primary identifiers
  id: string; // Local job ID (task_chatId_timestamp)
  chatId: number; // Telegram chat ID
  runningHubTaskId?: string; // RunningHub task ID (set setelah create workflow)

  // Tracking
  modelVersion: 'v1' | 'v2' | 'v3';
  tokenCost: number;
  status: JobStatus;

  // Telegram
  messageId?: number; // Progress message ID (untuk edit)

  // Result
  resultUrl?: string; // Video URL dari RunningHub
  videoBuffer?: string; // Video binary (base64 encoded jika perlu cache)

  // Timing
  createdAt: number;
  startedAt?: number;
  completedAt?: number;

  // Error tracking
  errorMessage?: string;
  deliveryAttempts?: number;

  // Metadata
  imageFileId?: string;
  videoFileId?: string;
}

const JOBS_DIR = path.join(process.cwd(), 'data', 'jobs');
const JOBS_FILE = path.join(JOBS_DIR, 'jobs.json');

export class JobStore {
  private jobs: Map<string, StoredJob> = new Map();

  async initialize(): Promise<void> {
    await fs.ensureDir(JOBS_DIR);

    if (await fs.pathExists(JOBS_FILE)) {
      const data = await fs.readJSON(JOBS_FILE);
      if (Array.isArray(data)) {
        for (const job of data) {
          this.jobs.set(job.id, job);
        }
        console.log(`[JobStore] Loaded ${this.jobs.size} jobs from disk`);
      }
    } else {
      console.log('[JobStore] No existing jobs file, starting fresh');
    }
  }

  /**
   * Create new job
   */
  async create(job: Omit<StoredJob, 'createdAt' | 'status'>): Promise<StoredJob> {
    const stored: StoredJob = {
      ...job,
      status: 'QUEUED',
      createdAt: Date.now(),
      deliveryAttempts: 0,
    };

    this.jobs.set(job.id, stored);
    await this.save();

    console.log(
      `[JobStore] Created job ${job.id} (chat ${job.chatId}, model ${job.modelVersion})`,
    );
    return stored;
  }

  /**
   * Update job status + optional fields
   */
  async updateStatus(
    jobId: string,
    status: JobStatus,
    updates?: Partial<StoredJob>,
  ): Promise<StoredJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    job.status = status;
    if (updates) {
      Object.assign(job, updates);
    }
    if (status === 'RUNNING' && !job.startedAt) {
      job.startedAt = Date.now();
    }
    if ((status === 'SUCCESS' || status === 'FAILED' || status === 'DELIVERED') && !job.completedAt) {
      job.completedAt = Date.now();
    }

    this.jobs.set(jobId, job);
    await this.save();

    console.log(`[JobStore] Updated job ${jobId} status -> ${status}`);
    return job;
  }

  /**
   * Get job by ID
   */
  getById(jobId: string): StoredJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get all jobs by status
   */
  getByStatus(status: JobStatus): StoredJob[] {
    return Array.from(this.jobs.values()).filter((j) => j.status === status);
  }

  /**
   * Get all RUNNING jobs (untuk resume on startup)
   */
  getRunningJobs(): StoredJob[] {
    return this.getByStatus('RUNNING');
  }

  /**
   * Get all SUCCESS jobs yang belum DELIVERED (untuk /sync)
   */
  getUndeliveredSuccess(): StoredJob[] {
    return Array.from(this.jobs.values()).filter(
      (j) => j.status === 'SUCCESS' && j.resultUrl,
    );
  }

  /**
   * Get all jobs for a chat
   */
  getByChatId(chatId: number): StoredJob[] {
    return Array.from(this.jobs.values()).filter((j) => j.chatId === chatId);
  }

  /**
   * Find job by RunningHub task ID
   */
  getByRunningHubTaskId(taskId: string): StoredJob | undefined {
    return Array.from(this.jobs.values()).find((j) => j.runningHubTaskId === taskId);
  }

  /**
   * Delete job (cleanup after successful delivery)
   */
  async delete(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    await this.save();
    console.log(`[JobStore] Deleted job ${jobId}`);
  }

  /**
   * Get all jobs
   */
  getAll(): StoredJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Save to disk
   */
  private async save(): Promise<void> {
    const data = Array.from(this.jobs.values());
    await fs.writeJSON(JOBS_FILE, data, { spaces: 2 });
  }

  /**
   * Cleanup: Remove jobs older than X days
   */
  async cleanup(ageHours: number = 48): Promise<void> {
    const cutoff = Date.now() - ageHours * 3600 * 1000;
    let removed = 0;

    for (const [jobId, job] of this.jobs) {
      if (job.status === 'DELIVERED' && job.completedAt && job.completedAt < cutoff) {
        this.jobs.delete(jobId);
        removed += 1;
      }
    }

    if (removed > 0) {
      await this.save();
      console.log(`[JobStore] Cleaned up ${removed} old jobs`);
    }
  }
}

// Singleton instance
export const jobStore = new JobStore();
