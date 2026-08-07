import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DB_DIR, 'bot.json');

/**
 * Database schema untuk token management & user tracking.
 * Menggunakan JSON file dengan async read/write untuk simplicity.
 */

export interface User {
  chatId: number;
  userId: number;
  username?: string;
  createdAt: number;
  lastActivityAt: number;
}

export interface TokenBalance {
  chatId: number;
  balance: number; // total token available
  lockedTokens: number; // tokens yang sedang di-lock (job running)
  totalEarned: number; // total token dari purchase + reward
  totalSpent: number; // total token yang sudah dikonsumsi (permanent)
  updatedAt: number;
}

export interface Payment {
  id: string; // uuid atau timestamp
  chatId: number;
  packageId: string; // '25k' | '30k' | '50k' | '100k'
  amount: number; // IDR amount
  tokens: number; // tokens diberikan
  status: 'pending' | 'success' | 'failed'; // pembayaran status
  createdAt: number;
  completedAt?: number;
  paymentMethod?: 'qris' | 'transfer'; // nanti bisa ditambah
}

export interface TokenHistory {
  id: string;
  chatId: number;
  type: 'deduct' | 'refund' | 'earn' | 'lock' | 'unlock'; // operasi
  tokens: number;
  jobId?: string; // referensi ke job kalau ada
  reason?: string; // deskripsi
  createdAt: number;
}

export interface Job {
  id: string; // id internal bot (mis. task_6493313218_123)
  chatId: number;
  modelVersion: 'v1' | 'v2' | 'v3'; // motion control version
  tokenCost: number; // berapa token dipakai
  imageFileId: string;
  videoFileId?: string;
  /** Status job: queued → running → success/failed → delivered. */
  status: 'queued' | 'locked' | 'running' | 'success' | 'failed' | 'delivered';
  /** Task ID asli dari RunningHub (19 digit) — diisi saat create task sukses. */
  taskId?: string;
  /** Message ID pesan progres di Telegram (untuk editMessageText saat resume). */
  telegramMessageId?: number;
  errorMessage?: string;
  resultUrl?: string;
  startedAt: number;
  completedAt?: number;
}

export interface Database {
  users: { [chatId: string]: User };
  tokenBalances: { [chatId: string]: TokenBalance };
  payments: Payment[];
  tokenHistory: TokenHistory[];
  jobs: { [jobId: string]: Job };
}

/** Initialize database dengan default values */
async function initDb(): Promise<Database> {
  return {
    users: {},
    tokenBalances: {},
    payments: [],
    tokenHistory: [],
    jobs: {},
  };
}

/** Ensure DB directory exists */
async function ensureDbDir(): Promise<void> {
  try {
    await fs.mkdir(DB_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

/** Read database dari file */
async function readDb(): Promise<Database> {
  await ensureDbDir();
  try {
    const content = await fs.readFile(DB_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    // File tidak ada atau error parsing, return default
    return initDb();
  }
}

/** Write database ke file (atomic write dengan temp file) */
async function writeDb(db: Database): Promise<void> {
  await ensureDbDir();
  const tempFile = `${DB_FILE}.tmp`;
  try {
    // Write to temp file first
    await fs.writeFile(tempFile, JSON.stringify(db, null, 2), 'utf-8');
    // Atomic move
    await fs.rename(tempFile, DB_FILE);
  } catch (err) {
    // Try to cleanup temp file
    try {
      await fs.unlink(tempFile);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Database API — simpel read/write operations
 */

export const db = {
  async getUser(chatId: number): Promise<User | null> {
    const database = await readDb();
    return database.users[String(chatId)] || null;
  },

  async createOrUpdateUser(
    chatId: number,
    userId: number,
    username?: string,
  ): Promise<User> {
    const database = await readDb();
    const user: User = {
      chatId,
      userId,
      username,
      createdAt: database.users[String(chatId)]?.createdAt || Date.now(),
      lastActivityAt: Date.now(),
    };
    database.users[String(chatId)] = user;
    await writeDb(database);
    return user;
  },

  async getTokenBalance(chatId: number): Promise<TokenBalance | null> {
    const database = await readDb();
    return database.tokenBalances[String(chatId)] || null;
  },

  async initTokenBalance(chatId: number, initialTokens: number = 0): Promise<TokenBalance> {
    const database = await readDb();
    const key = String(chatId);
    if (!database.tokenBalances[key]) {
      database.tokenBalances[key] = {
        chatId,
        balance: initialTokens,
        lockedTokens: 0,
        totalEarned: initialTokens,
        totalSpent: 0,
        updatedAt: Date.now(),
      };
      await writeDb(database);
    }
    return database.tokenBalances[key]!;
  },

  async lockTokens(chatId: number, tokens: number): Promise<TokenBalance | null> {
    const database = await readDb();
    const key = String(chatId);
    const balance = database.tokenBalances[key];
    if (!balance) return null;

    if (balance.balance < tokens) {
      return null; // insufficient balance
    }

    balance.balance -= tokens;
    balance.lockedTokens += tokens;
    balance.updatedAt = Date.now();
    database.tokenBalances[key] = balance;
    await writeDb(database);

    // Log ke token history
    await db.addTokenHistory(chatId, 'lock', tokens, undefined, `Lock ${tokens} token untuk job`);

    return balance;
  },

  async unlockTokens(chatId: number, tokens: number): Promise<TokenBalance | null> {
    const database = await readDb();
    const key = String(chatId);
    const balance = database.tokenBalances[key];
    if (!balance) return null;

    balance.lockedTokens -= tokens;
    balance.balance += tokens;
    balance.updatedAt = Date.now();
    database.tokenBalances[key] = balance;
    await writeDb(database);

    // Log ke token history
    await db.addTokenHistory(chatId, 'unlock', tokens, undefined, `Unlock ${tokens} token (refund)`);

    return balance;
  },

  async deductTokens(chatId: number, tokens: number, jobId?: string): Promise<TokenBalance | null> {
    const database = await readDb();
    const key = String(chatId);
    const balance = database.tokenBalances[key];
    if (!balance) return null;

    balance.lockedTokens -= tokens;
    balance.totalSpent += tokens;
    balance.updatedAt = Date.now();
    database.tokenBalances[key] = balance;
    await writeDb(database);

    // Log ke token history
    await db.addTokenHistory(chatId, 'deduct', tokens, jobId, `Deduct untuk job`);

    return balance;
  },

  async addTokens(
    chatId: number,
    tokens: number,
    reason: string = 'purchase',
  ): Promise<TokenBalance | null> {
    const database = await readDb();
    const key = String(chatId);
    let balance = database.tokenBalances[key];

    if (!balance) {
      balance = {
        chatId,
        balance: tokens,
        lockedTokens: 0,
        totalEarned: tokens,
        totalSpent: 0,
        updatedAt: Date.now(),
      };
    } else {
      balance.balance += tokens;
      balance.totalEarned += tokens;
      balance.updatedAt = Date.now();
    }

    database.tokenBalances[key] = balance;
    await writeDb(database);

    // Log ke token history
    await db.addTokenHistory(chatId, 'earn', tokens, undefined, reason);

    return balance;
  },

  async addTokenHistory(
    chatId: number,
    type: 'deduct' | 'refund' | 'earn' | 'lock' | 'unlock',
    tokens: number,
    jobId?: string,
    reason?: string,
  ): Promise<TokenHistory> {
    const database = await readDb();
    const history: TokenHistory = {
      id: `${chatId}_${Date.now()}_${Math.random()}`,
      chatId,
      type,
      tokens,
      jobId,
      reason,
      createdAt: Date.now(),
    };
    database.tokenHistory.push(history);
    await writeDb(database);
    return history;
  },

  async createPayment(
    chatId: number,
    packageId: string,
    amount: number,
    tokens: number,
  ): Promise<Payment> {
    const database = await readDb();
    const payment: Payment = {
      id: `pay_${chatId}_${Date.now()}`,
      chatId,
      packageId,
      amount,
      tokens,
      status: 'pending',
      createdAt: Date.now(),
    };
    database.payments.push(payment);
    await writeDb(database);
    return payment;
  },

  async completePayment(paymentId: string): Promise<Payment | null> {
    const database = await readDb();
    const payment = database.payments.find((p) => p.id === paymentId);
    if (!payment) return null;

    payment.status = 'success';
    payment.completedAt = Date.now();
    await writeDb(database);

    // Add tokens to user
    await db.addTokens(payment.chatId, payment.tokens, `Payment ${payment.packageId}`);

    return payment;
  },

  async createJob(
    jobId: string,
    chatId: number,
    modelVersion: 'v1' | 'v2' | 'v3',
    tokenCost: number,
    imageFileId: string,
    videoFileId?: string,
  ): Promise<Job> {
    const database = await readDb();
    const job: Job = {
      id: jobId,
      chatId,
      modelVersion,
      tokenCost,
      imageFileId,
      videoFileId,
      status: 'queued',
      startedAt: Date.now(),
    };
    database.jobs[jobId] = job;
    await writeDb(database);
    return job;
  },

  async updateJobStatus(
    jobId: string,
    status: 'queued' | 'locked' | 'running' | 'success' | 'failed' | 'delivered',
    errorMessage?: string,
    resultUrl?: string,
  ): Promise<Job | null> {
    const database = await readDb();
    const job = database.jobs[jobId];
    if (!job) return null;

    job.status = status;
    job.errorMessage = errorMessage;
    job.resultUrl = resultUrl;
    if (status !== 'locked' && !job.completedAt) {
      job.completedAt = Date.now();
    }
    database.jobs[jobId] = job;
    await writeDb(database);
    return job;
  },

  /** Simpan task ID asli RunningHub ke job (dipanggil saat create task sukses). */
  async updateJobTaskId(jobId: string, taskId: string): Promise<Job | null> {
    const database = await readDb();
    const job = database.jobs[jobId];
    if (!job) return null;
    job.taskId = taskId;
    await writeDb(database);
    return job;
  },

  /** Simpan message ID pesan progres untuk resume editMessageText. */
  async updateJobTelegramMessageId(jobId: string, messageId: number): Promise<Job | null> {
    const database = await readDb();
    const job = database.jobs[jobId];
    if (!job) return null;
    job.telegramMessageId = messageId;
    await writeDb(database);
    return job;
  },

  /** Ambil semua job dengan status tertentu (mis. 'running' untuk resume, 'success' untuk /sync). */
  async getJobsByStatus(
    status: 'queued' | 'locked' | 'running' | 'success' | 'failed' | 'delivered',
  ): Promise<Job[]> {
    const database = await readDb();
    return Object.values(database.jobs)
      .filter((j) => j.status === status)
      .sort((a, b) => a.startedAt - b.startedAt);
  },

  async getJob(jobId: string): Promise<Job | null> {
    const database = await readDb();
    return database.jobs[jobId] || null;
  },

  async getJobsByChat(chatId: number): Promise<Job[]> {
    const database = await readDb();
    return Object.values(database.jobs).filter((j) => j.chatId === chatId);
  },

  async getTokenHistoryByChat(chatId: number, limit: number = 100): Promise<TokenHistory[]> {
    const database = await readDb();
    return database.tokenHistory
      .filter((h) => h.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },
};

export default db;
