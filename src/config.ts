import 'dotenv/config';

export interface RunningHubConfig {
  apiKey: string;
  baseUrl: string;
  /** Base root (tanpa /openapi/v2) — dipakai endpoint akun & getWorkflowJson yang tetap di v1. */
  rootBaseUrl: string;
  workflowId: string;
  /** Path endpoint run: `run/workflow` (ComfyUI) atau `run/ai-app` (AI App resmi). */
  runPath: string;
  /** Profil mapping node: `wananimate` | `scail` | `aiapp`. */
  mapping: string;
}

export interface AppConfig {
  telegramBotToken: string;
  runningHub: RunningHubConfig;
  pollIntervalMs: number;
  timeoutMs: number;
  retainSeconds: number;
  instanceType?: string;
  outputDir: string;
  adminTelegramId: number;
  qrisImagePath: string;
}

export const DEFAULT_WORKFLOW_ID = '2000311901097783298';
export const DEFAULT_BASE_URL = 'https://www.runninghub.ai';

/** True bila env var terisi dan bukan placeholder (`YOUR_...`). */
export function envIsSet(name: string): boolean {
  const v = process.env[name];
  return Boolean(v && v.trim() !== '' && !/^YOUR_/i.test(v.trim()));
}

/** Daftar env var wajib yang belum diisi. */
export function missingEnvVars(): string[] {
  const required = [
    'TELEGRAM_BOT_TOKEN',
    'RUNNINGHUB_API_KEY',
    'RUNNINGHUB_BASE_URL',
    'RUNNINGHUB_WORKFLOW_ID',
  ];
  return required.filter((name) => !envIsSet(name));
}

/** Baca & validasi konfigurasi dari .env. Lempar error bila ada yang kurang. */
export function loadConfig(): AppConfig {
  const missing = missingEnvVars();
  if (missing.length > 0) {
    throw new Error(
      `Environment variables belum diisi: ${missing.join(', ')}. Salin .env.example ke .env dan isi nilainya.`,
    );
  }
  const baseUrl = (process.env.RUNNINGHUB_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!.trim(),
    runningHub: {
      apiKey: process.env.RUNNINGHUB_API_KEY!.trim(),
      baseUrl,
      rootBaseUrl: baseUrl.replace(/\/openapi\/v2\/?$/, ''),
      workflowId: process.env.RUNNINGHUB_WORKFLOW_ID || DEFAULT_WORKFLOW_ID,
      runPath: process.env.RUNNINGHUB_RUN_PATH?.trim() || 'run/workflow',
      mapping: process.env.RUNNINGHUB_MAPPING?.trim() || 'wananimate',
    },
    pollIntervalMs: Number(process.env.RUNNINGHUB_POLL_INTERVAL || 5000),
    timeoutMs: Number(process.env.RUNNINGHUB_TIMEOUT || 1_800_000),
    retainSeconds: Number(process.env.RUNNINGHUB_RETAIN_SECONDS || 0),
    instanceType: process.env.RUNNINGHUB_INSTANCE_TYPE?.trim() || undefined,
    outputDir: process.env.OUTPUT_DIR?.trim() || 'downloads',
    adminTelegramId: Number(process.env.ADMIN_TELEGRAM_ID || 0),
    qrisImagePath: process.env.QRIS_IMAGE_PATH?.trim() || './qris.jpg',
  };
}
