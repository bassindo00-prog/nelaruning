import { RunningHubClient } from './client.js';
import type { NodeInfo, TaskResultV2 } from './types.js';
import { sleep } from '../utils/wait.js';

export interface RunProgress {
  stage: 'upload' | 'create' | 'poll' | 'output' | 'done';
  step?: string;
  message?: string;
  taskId?: string;
  attempt?: number;
  backoffMs?: number;
  status?: string;
  /** Persentase progres (0–100) bila API menyediakannya — default: diestimasi klien. */
  progress?: number;
}

export interface RunResult {
  taskId: string;
  videoUrl: string;
  videoBuffer: Buffer;
  elapsedMs: number;
}

export interface RunOptions {
  imageBuffer: Buffer;
  imageName: string;
  /** Video referensi (opsional) — node video di workflow. */
  videoBuffer?: Buffer;
  videoName?: string;
  prompt: string;
  seed?: number;
  workflowId: string;
  instanceType?: string;
  retainSeconds?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Profil mapping node: `wananimate` | `scail` | `aiapp`. Default `wananimate`. */
  mapping?: string;
  /** Override API key RunningHub (key milik user). Fallback: key bawaan bot. */
  apiKey?: string;
  /** Durasi output (detik) — override frame_load_cap workflow (node 36 @24fps). */
  videoDurationSeconds?: number;
  onProgress?: (p: RunProgress) => void;
  /** Chat ID untuk audit logging */
  chatId?: number;
}

/** Prompt default bawaan (dipakai bila user tidak beri prompt) — detail agar hasil natural. */
export const DEFAULT_PROMPT =
  'orang dewasa, pakaian realistis, ekspresi wajah natural, gerakan halus, lighting natural, detail tinggi';

/**
 * Profil mapping node — menyesuaikan override nodeInfoList dengan struktur
 * workflow yang dipakai. ID node tergantung template workflow / AI App.
 */
export interface NodeMapping {
  image: { nodeId: string; fieldName: string };
  video?: { nodeId: string; fieldName: string };
  prompt: { nodeId: string; fieldName: string };
  /** Seed nodes — array untuk workflow multi-sampler (WanAnimate 3 KSampler). */
  seeds: string[];
  /** Seed tunggal — untuk workflow 1 sampler (Wan 2.2 Motion Control). */
  seed?: { nodeId: string; fieldName: string };
  /** Video duration param — node ID & field name untuk set durasi output. */
  videoDuration?: { nodeId: string; fieldName: string };
  /** Frame rate param (opsional) — untuk workflow yang expose fps. */
  fps?: { nodeId: string; fieldName: string };
}

export const NODE_MAPPINGS: Record<string, NodeMapping> = {
  // Workflow ComfyUI WanAnimate (1998198427450269697) — 3 segmen KSampler
  wananimate: {
    image: { nodeId: '16', fieldName: 'image' },
    video: { nodeId: '29', fieldName: 'video' },
    prompt: { nodeId: '9', fieldName: 'text' },
    seeds: ['64', '77', '100'],
    // Durasi output = frame_load_cap (node 36) ÷ 24 fps. 243 frame = ~10 dtk.
    // Set via field `value` (INTConstant). node 85 (SimpleMath a/3) mengikuti otomatis.
    videoDuration: { nodeId: '36', fieldName: 'value' },
  },
  // Workflow ComfyUI Wan 2.1 SCAIL (2000311901097783298)
  scail: {
    image: { nodeId: '106', fieldName: 'image' },
    video: { nodeId: '130', fieldName: 'video' },
    prompt: { nodeId: '16', fieldName: 'positive_prompt' },
    seeds: ['348'],
  },
  // AI App resmi (run/ai-app) — WanAnimate versi template
  aiapp: {
    image: { nodeId: '106', fieldName: 'image' },
    video: { nodeId: '130', fieldName: 'video' },
    prompt: { nodeId: '373', fieldName: 'text' },
    seeds: [],
  },
  // Workflow Wan 2.2 Motion Control (7bots) — 14B fp8, 720p, pose transfer
  wan22: {
    image: { nodeId: '391', fieldName: 'image' },
    video: { nodeId: '392', fieldName: 'video' },
    prompt: { nodeId: '336', fieldName: 'positive_prompt' },
    seeds: [],
    seed: { nodeId: '335', fieldName: 'seed' },
    // Durasi (Int node, detik langsung) + fps (Int node)
    videoDuration: { nodeId: '341', fieldName: 'value' },
    fps: { nodeId: '349', fieldName: 'value' },
  },
  // Quick Creation WAN 2.2 fp8 (SaaS, run/ai-app — bayar wallet, tidak pakai nodeInfoList)
  wan22qc: {
    image: { nodeId: '106', fieldName: 'image' },
    video: { nodeId: '130', fieldName: 'video' },
    prompt: { nodeId: '373', fieldName: 'text' },
    seeds: [],
  },
  // Workflow Cina (大头娃娃工作流-Aiwood.json) — SD3 + WanAnimate hybrid, local private
  aiwood: {
    image: { nodeId: '16', fieldName: 'image' },
    video: { nodeId: '29', fieldName: 'video' },
    prompt: { nodeId: '10', fieldName: 'text' },
    seeds: ['64', '77', '100'],
    // Durasi output: frame_load_cap (node 36) = detik × 24 fps
    videoDuration: { nodeId: '36', fieldName: 'value' },
  },
};

/** Kode error transient — aman di-retry dengan backoff. */
const RETRYABLE_CODES = new Set([
  'TASK_QUEUE_MAXED', // batas konkurensi instance shared tercapai
  'TASK_INSTANCE_MAXED', // instance khusus habis
  'QUEUE_MAXED',
  'SERVER_BUSY',
  'SYSTEM_BUSY',
  '421', // api queue limit reached (v2)
  '429',
  'TIMEOUT',
]);

const CREATE_BACKOFFS = [30_000, 60_000, 90_000, 120_000];
const MAX_CREATE_ATTEMPTS = 5;

/** Ambil kode error (TASK_QUEUE_MAXED, 421, …) dari pesan API. */
function extractErrorCode(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/[A-Z][A-Z0-9_]{3,40}|\b(421|429|5\d\d)\b/);
  return m ? m[0] : null;
}

function isRetryable(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (code && RETRYABLE_CODES.has(code)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  // Error jaringan / TLS / server sibuk — sifatnya sementara, aman di-retry
  if (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EPIPE|socket hang up|SSL routines|bad record mac|EC340000|tls_get_more_records|unknown error|未知错误/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: number }).status;
    if (status === 429 || (status !== undefined && status >= 500)) return true;
  }
  return false;
}

/**
 * Kode error saat CREATE task yang AMAN di-retry — server MENOLAK task,
 * jadi dipastikan task TIDAK dibuat di server (tidak ada risiko duplikat).
 */
const SAFE_CREATE_RETRY_CODES = new Set([
  'TASK_QUEUE_MAXED',
  'TASK_INSTANCE_MAXED',
  'QUEUE_MAXED',
  'SERVER_BUSY',
  'SYSTEM_BUSY',
  '421',
  '429',
]);

/**
 * Retry create task HANYA bila server menolak (task pasti tidak dibuat).
 * TIMEOUT / error jaringan (ECONNRESET, socket hang up, dst) TIDAK di-retry —
 * task MUNGKIN sudah dibuat server, retry akan bikin task dobel (boros koin).
 */
function isSafeCreateRetry(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (code && SAFE_CREATE_RETRY_CODES.has(code)) return true;
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: number }).status;
    // 429 rate-limit: server menolak request, task tidak dibuat → aman retry
    if (status === 429) return true;
  }
  return false;
}

/** Cek ukuran file via HEAD request (fallback null bila gagal). */
async function probeSize(url: string): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(timer);
    const len = r.headers.get('content-length');
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

/**
 * Pilih hasil video yang paling mungkin animasi final.
 * Workflow WanAnimate mengeluarkan banyak video (pose/skeleton preview, segmen,
 * audio) — preview/skeleton selalu jauh LEBIH KECIL dari animasi final.
 * Strategi: probe ukuran semua kandidat (HEAD) lalu pilih yang terbesar.
 */
export async function pickBestVideo(
  list: TaskResultV2[],
): Promise<TaskResultV2 | undefined> {
  const isVideoUrl = (u: string) => /\.(mp4|mov|webm|avi|mkv)(\?|$)/i.test(u);
  const candidates = list.filter(
    (r) => typeof r.url === 'string' && isVideoUrl(r.url),
  );
  if (candidates.length === 0) return list.find((r) => typeof r.url === 'string');
  if (candidates.length === 1) return candidates[0];

  const withSize = await Promise.all(
    candidates.map(async (r) => ({ r, size: await probeSize(r.url!) })),
  );
  const sized = withSize.filter(
    (x): x is { r: TaskResultV2; size: number } => x.size !== null,
  );
  if (sized.length === 0) return candidates[0]; // fallback: kandidat pertama
  sized.sort((a, b) => b.size - a.size);
  return sized[0].r;
}

/**
 * Upload dengan retry otomatis — gangguan jaringan/TLS (SSL reset, ECONNRESET,
 * socket hang up) & server error bersifat sementara; retry 3× dengan backoff.
 */
async function uploadWithRetry(
  client: RunningHubClient,
  buffer: Buffer,
  name: string,
  onProgress: (p: RunProgress) => void,
  apiKey?: string,
): Promise<string> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await client.upload(buffer, name, apiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetryable(err) || attempt >= 3) throw err;
      const backoffMs = 3000 * attempt;
      onProgress({
        stage: 'upload',
        attempt,
        backoffMs,
        message: `Gangguan jaringan — coba lagi dalam ${Math.round(backoffMs / 1000)}s (${attempt}/3)…`,
      });
      await sleep(backoffMs);
    }
  }
}

export async function runMotionControl(
  client: RunningHubClient,
  opts: RunOptions,
): Promise<RunResult> {
  const { onProgress = () => {} } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();
  const startTime = Date.now();

  // AUDIT: log start
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[AUDIT] runMotionControl() started [callId=${callId}] [workflowId=${opts.workflowId}]`);

  // 1) Upload input — POST {BASE}/media/upload/binary (dengan retry jaringan)
  onProgress({ stage: 'upload', step: 'image', message: 'Mengunggah gambar…' });
  const imageFileName = await uploadWithRetry(client, opts.imageBuffer, opts.imageName, onProgress, opts.apiKey);

  let videoFileName: string | undefined;
  if (opts.videoBuffer && opts.videoName) {
    onProgress({ stage: 'upload', step: 'video', message: 'Mengunggah video referensi…' });
    videoFileName = await uploadWithRetry(client, opts.videoBuffer, opts.videoName, onProgress, opts.apiKey);
  }

  // 2) Susun nodeInfoList — override parameter workflow sesuai profil mapping
  const mapping: NodeMapping = NODE_MAPPINGS[opts.mapping ?? 'wananimate'] ?? NODE_MAPPINGS.wananimate;
  const nodeInfoList: NodeInfo[] = [
    { nodeId: mapping.image.nodeId, fieldName: mapping.image.fieldName, fieldValue: imageFileName },
  ];
  if (videoFileName && mapping.video) {
    nodeInfoList.push({
      nodeId: mapping.video.nodeId,
      fieldName: mapping.video.fieldName,
      fieldValue: videoFileName,
    });
  }
  nodeInfoList.push({
    nodeId: mapping.prompt.nodeId,
    fieldName: mapping.prompt.fieldName,
    fieldValue: opts.prompt,
  });
  if (opts.seed !== undefined) {
    if (mapping.seed) {
      // Seed tunggal — workflow Wan 2.2 Motion Control
      nodeInfoList.push({ nodeId: mapping.seed.nodeId, fieldName: mapping.seed.fieldName, fieldValue: opts.seed });
    }
    for (const samplerId of mapping.seeds) {
      nodeInfoList.push({ nodeId: samplerId, fieldName: 'seed', fieldValue: opts.seed });
    }
  }
  // Durasi output — override nilai detik langsung (Wan 2.2) atau frame (WanAnimate).
  if (opts.videoDurationSeconds !== undefined && mapping.videoDuration) {
    if (mapping.fps && mapping.fps.nodeId) {
      // Wan 2.2 Motion Control: durasi & fps berupa Int node, dikirim detik & fps langsung
      nodeInfoList.push({
        nodeId: mapping.videoDuration.nodeId,
        fieldName: mapping.videoDuration.fieldName,
        fieldValue: Math.max(1, Math.min(30, opts.videoDurationSeconds)),
      });
    } else {
      // WanAnimate: frame_load_cap = detik × 24 fps (node 85 a/3 auto-ikuti)
      const frames = Math.max(24, Math.min(60 * 24, Math.round(opts.videoDurationSeconds * 24)));
      nodeInfoList.push({
        nodeId: mapping.videoDuration.nodeId,
        fieldName: mapping.videoDuration.fieldName,
        fieldValue: frames,
      });
    }
  }

  // 3) Run workflow — POST {BASE}/run/workflow/{workflowId}, retry saat antrian penuh
  let taskId: string;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      // AUDIT: log each attempt
      console.log(`[AUDIT] [callId=${callId}] runWorkflow attempt #${attempt}/${MAX_CREATE_ATTEMPTS}`);
      
      const created = await client.runWorkflow({
        workflowId: opts.workflowId,
        nodeInfoList,
        retainSeconds: opts.retainSeconds,
        instanceType: opts.instanceType,
        apiKey: opts.apiKey,
        chatId: opts.chatId,
        requestNumber: attempt,
      });
      taskId = created.taskId;
      
      console.log(`[AUDIT] [callId=${callId}] runWorkflow succeeded on attempt #${attempt}, taskId=${taskId}`);
      break;
    } catch (err) {
      const retryable = isSafeCreateRetry(err);
      const message = err instanceof Error ? err.message : String(err);
      if (!retryable || attempt >= MAX_CREATE_ATTEMPTS || remaining() <= 0) {
        // Koneksi putus/timeout saat create — task MUNGKIN sudah dibuat server.
        // Berhenti & beri tahu user, jangan retry (bikin task dobel / boros koin).
        if (!retryable && /TIMEOUT|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|SSL/i.test(message)) {
          throw new Error(
            `${message} — koneksi terputus saat membuat task. Task MUNGKIN sudah dibuat di server. Cek Task List di dashboard RunningHub (hapus duplikat bila ada), lalu coba lagi.`,
          );
        }
        throw new Error(`${message}${retryable ? ` (setelah ${attempt} percobaan)` : ''}`);
      }
      const backoffMs = CREATE_BACKOFFS[attempt - 1] ?? 120_000;
      const errCode = extractErrorCode(err) ?? '';
      onProgress({
        stage: 'create',
        step: 'retry',
        attempt,
        backoffMs,
        message: `Server sibuk${errCode ? ` (${errCode})` : ''} — coba lagi dalam ${Math.round(backoffMs / 1000)}s (percobaan ${attempt}/${MAX_CREATE_ATTEMPTS})…`,
      });
      await sleep(Math.min(backoffMs, remaining()));
    }
  }
  onProgress({ stage: 'create', step: 'started', taskId, message: `Task ${taskId} dimulai` });

  // 4) Poll status — POST {BASE}/query tiap 5 detik sampai SUCCESS / FAILED / timeout
  let lastStatus: string | null = null;
  let errorMessage = '';
  let pollCount = 0;
  let results: TaskResultV2[] = [];
  while (remaining() > 0) {
    pollCount += 1;
    let resp;
    try {
      resp = await client.query(taskId, opts.apiKey);
    } catch (err) {
      onProgress({
        stage: 'poll',
        message: `Pengecekan status error (${err instanceof Error ? err.message : '?'}) — coba lagi…`,
      });
      await sleep(Math.min(pollIntervalMs, remaining()));
      continue;
    }

    lastStatus = resp.status;
    if (resp.errorMessage) errorMessage = resp.errorMessage;
    onProgress({
      stage: 'poll',
      status: resp.status,
      attempt: pollCount,
      message: `Status: ${resp.status}`,
    });

    if (resp.status === 'SUCCESS') {
      results = Array.isArray(resp.results) ? resp.results : [];
      break;
    }
    if (resp.status === 'FAILED') {
      const fr = resp.failedReason;
      const crash = fr && typeof fr === 'object' && 'exception_message' in fr
        ? String((fr as { exception_message?: unknown }).exception_message)
        : '';
      let reason = crash || resp.errorMessage || 'task gagal di sisi server';
      if (/OOM/i.test(reason)) {
        reason += ' — workflow terlalu berat untuk instance ini. Coba workflow yang lebih ringan, atau set RUNNINGHUB_INSTANCE_TYPE=plus (48G) di .env.';
      }
      throw new Error(`Task gagal di sisi server: ${reason}`);
    }
    await sleep(Math.min(pollIntervalMs, remaining()));
  }

  if (lastStatus !== 'SUCCESS') {
    throw new Error(`Timeout setelah ${Math.round(timeoutMs / 1000)}s menunggu task ${taskId}`);
  }

  // 5) Ambil video dari results[].url & unduh
  onProgress({ stage: 'output', message: 'Mengecek hasil…' });
  const video = await pickBestVideo(results);
  if (!video?.url) {
    throw new Error(`Tidak ada output video untuk task ${taskId}`);
  }

  onProgress({ stage: 'output', message: 'Mengunduh video hasil…' });
  let videoBuffer: Buffer;
  try {
    videoBuffer = await client.downloadBuffer(video.url);
    console.log(`[AUDIT] [callId=${callId}] Video downloaded: size=${videoBuffer.length} bytes`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AUDIT] [callId=${callId}] Video download failed: ${msg}`);
    throw new Error(`Gagal mengunduh video dari ${video.url}: ${msg}`);
  }

  onProgress({ stage: 'done', message: 'Selesai' });
  console.log(`[AUDIT] runMotionControl() completed [callId=${callId}] [taskId=${taskId}]`);
  
  return {
    taskId,
    videoUrl: video.url,
    videoBuffer,
    elapsedMs: Date.now() - startTime,
  };
}
