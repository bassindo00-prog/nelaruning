import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { createBot } from './bot/handlers.js';
import { resumePendingJobs } from './bot/delivery.js';
import { RunningHubClient } from './runninghub/client.js';
import { jobStore } from './job/store.js';
import { resumeJob } from './job/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = path.join(__dirname, '../data/bot.lock');

/**
 * Single-instance enforcement via lockfile + PID check.
 * Kalau instance lain masih hidup → exit. Lockfile stale (PID mati) → overwrite.
 */
async function acquireLock(): Promise<void> {
  let existing: { pid: number; startedAt: number } | null = null;
  try {
    existing = JSON.parse(await fs.readFile(LOCK_FILE, 'utf-8'));
  } catch {
    existing = null;
  }

  if (existing && existing.pid) {
    const alive = await isPidAlive(existing.pid);
    if (alive) {
      console.error(
        `❌ Instance bot lain masih berjalan (PID ${existing.pid}, sejak ${new Date(existing.startedAt).toLocaleString('id-ID')}).\n` +
          `   Hanya satu instance yang boleh polling. Matikan dulu, lalu start ulang.`,
      );
      process.exit(1);
    }
    console.log(`⚠️ Lockfile stale (PID ${existing.pid} sudah mati) — diambil alih.`);
  }

  await fs.writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf-8');
}

/** Cek apakah PID masih hidup (Windows & POSIX). */
async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = tidak ada proses; EPERM = hidup tapi tanpa akses.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function releaseLock(): Promise<void> {
  try {
    const lock = JSON.parse(await fs.readFile(LOCK_FILE, 'utf-8'));
    if (lock.pid === process.pid) await fs.unlink(LOCK_FILE);
  } catch {
    /* abaikan */
  }
}

async function main(): Promise<void> {
  // await acquireLock(); // TEMPORARILY DISABLED FOR TESTING

  const config = loadConfig();
  
  // Initialize persistent job store
  console.log('📦 Initializing job store...');
  await jobStore.initialize();
  
  const bot = createBot(config);

  // Verifikasi token dengan menghubungi API Telegram
  try {
    const me = await bot.telegram.getMe();
    console.log(`✅ Bot terhubung ke Telegram: @${me.username ?? '?'} (${me.first_name})`);
  } catch (err) {
    console.error(
      '❌ Gagal terhubung ke Telegram. Periksa TELEGRAM_BOT_TOKEN di .env',
      err instanceof Error ? `— ${err.message}` : '',
    );
    process.exit(1);
  }

  // Graceful shutdown
  const stop = (signal: string) => {
    console.log(`\n⏹️  ${signal} diterima, menghentikan bot…`);
    bot.stop(signal);
    releaseLock().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  // NOTE: jangan await bot.launch() — di telegraf 4.16.3 launch() await startPolling()
  // yang loop selamanya, jadi promise-nya tidak pernah resolve. Panggil tanpa await
  // supaya resume polling & log setelahnya tetap jalan.
  void bot.launch().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Polling berhenti: ${msg}`);
    process.exit(1);
  });
  console.log('🤖 Bot berjalan. Tekan Ctrl+C untuk berhenti.');

  // Resume polling jobs dengan persistent job store
  const resumeClient = new RunningHubClient({
    apiKey: config.runningHub.apiKey,
    baseUrl: config.runningHub.baseUrl,
    rootBaseUrl: config.runningHub.rootBaseUrl,
    runPath: config.runningHub.runPath,
  });
  
  // Resume RUNNING jobs from persistent store
  const runningJobs = jobStore.getByStatus('RUNNING');
  if (runningJobs.length > 0) {
    console.log(`🔁 Resuming ${runningJobs.length} running job(s)...`);
    for (const job of runningJobs) {
      // Don't await - spawn in background
      resumeJob(job, bot, config, resumeClient).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${job.chatId}] Resume job ${job.id} failed: ${msg}`);
      });
    }
  } else {
    console.log('✔️ Tidak ada job tersisa — siap menerima perintah.');
  }
}

main().catch(async (err) => {
  console.error('❌ Gagal menjalankan bot:', err instanceof Error ? err.message : err);
  console.error('   Periksa file .env — TELEGRAM_BOT_TOKEN harus token bot asli dari @BotFather.');
  await releaseLock();
  process.exit(1);
});
