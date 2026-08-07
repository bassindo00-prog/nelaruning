import axios, { AxiosInstance } from 'axios';
import type {
  ApiResponse,
  NodeInfo,
  TaskResponseV2,
  UploadData,
} from './types.js';

/**
 * Client TypeScript untuk RunningHub API — OpenAPI v2.
 *
 * Endpoint utama (semua relatif ke RUNNINGHUB_BASE_URL dari .env, TIDAK hardcode):
 *   POST {BASE}/media/upload/binary     → upload gambar/video (multipart)
 *   POST {BASE}/run/workflow/{id}       → jalankan workflow, dapat taskId
 *   POST {BASE}/query                   → polling status + hasil
 * Auth: header `Authorization: Bearer <apiKey>` (bukan body).
 *
 * Endpoint akun & struktur workflow masih di root (v1) — dipisah rootHttp.
 */
export class RunningHubClient {
  private http: AxiosInstance;
  private rootHttp: AxiosInstance;
  private apiKey: string;
  baseUrl: string;
  /** Path endpoint run: `run/workflow` (ComfyUI) atau `run/ai-app` (AI App). */
  runPath: string;

  constructor({
    apiKey,
    baseUrl,
    rootBaseUrl,
    runPath = 'run/workflow',
  }: {
    apiKey: string;
    baseUrl: string;
    rootBaseUrl: string;
    runPath?: string;
  }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.runPath = runPath;
    const common = {
      timeout: 120_000,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    };
    this.http = axios.create({ baseURL: baseUrl, ...common });
    this.rootHttp = axios.create({ baseURL: rootBaseUrl, ...common });
  }

  /** Periksa code respons v1 (root); kembalikan `data` bila sukses. */
  private unwrap<T>(response: { data: ApiResponse<T> }, context: string): T {
    const body = response.data;
    if (body.code !== 0) {
      throw new Error(`${context}: ${body.msg ?? 'gagal'} (code ${body.code})`);
    }
    return body.data;
  }

  /** Cek kredensial akun + saldo koin (endpoint root v1 — gratis). */
  async checkAccount(
    apiKey?: string,
  ): Promise<{ remainCoins?: number; remainMoney?: number | null; apiType?: string }> {
    const r = await this.rootHttp.post<
      ApiResponse<{ remainCoins?: number; remainMoney?: number | null; apiType?: string }>
    >('/uc/openapi/accountStatus', { apikey: apiKey ?? this.apiKey });
    return this.unwrap(r, 'Cek akun');
  }

  /** Ambil struktur workflow (endpoint root v1 — gratis, tidak memakai koin). */
  async getWorkflowJson(workflowId: string): Promise<unknown> {
    const r = await this.rootHttp.post<ApiResponse>('/api/openapi/getJsonApiFormat', {
      apiKey: this.apiKey,
      workflowId,
    });
    const data = this.unwrap(r, 'Ambil workflow JSON');
    const prompt = (data as { prompt?: string })?.prompt;
    return typeof prompt === 'string' ? JSON.parse(prompt) : data;
  }

  /** Ambil detail AI App (endpoint root — gratis) untuk validasi id + lihat input nodes. */
  async getAiAppInfo(
    appId: string,
  ): Promise<{ inputNodes?: { nodeId: string; nodeName: string; fieldName: string }[] }> {
    type AiAppInfo = { inputNodes?: { nodeId: string; nodeName: string; fieldName: string }[] };
    const r = await this.rootHttp.post<ApiResponse<AiAppInfo>>('/api/webapp/simple/detail', {
      webappId: appId,
    });
    return this.unwrap<AiAppInfo>(r, 'Ambil detail AI App');
  }

  /**
   * Upload file (gambar/video) → nama file di server RunningHub.
   * POST {BASE}/media/upload/binary — multipart, auth Bearer.
   */
  async upload(buffer: Buffer, filename: string, apiKey?: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);

    const r = await this.http.post<ApiResponse<UploadData>>(
      '/media/upload/binary',
      form,
      {
        timeout: 300_000,
        headers: { Authorization: `Bearer ${apiKey ?? this.apiKey}` },
      },
    );
    const body = r.data;
    if (body.code !== 0 || !body.data?.fileName) {
      throw new Error(`Upload file: ${body.msg ?? 'gagal'} (code ${body.code})`);
    }
    return body.data.fileName;
  }

  /**
   * Jalankan workflow.
   * POST {BASE}/run/workflow/{workflowId} — body JSON tanpa apiKey (Bearer di header).
   * @returns taskId dari respons.
   */
  async runWorkflow(opts: {
    workflowId: string;
    nodeInfoList: NodeInfo[];
    retainSeconds?: number;
    instanceType?: string;
    /** Override API key (key milik user, bukan default bot). */
    apiKey?: string;
    /** Optional: user/chat ID untuk audit logging. */
    chatId?: number;
    /** Optional: request sequence number. */
    requestNumber?: number;
  }): Promise<{ taskId: string; status: string }> {
    const body: Record<string, unknown> = {
      nodeInfoList: opts.nodeInfoList,
    };
    // retainSeconds hanya valid 10–180 detik (dokumen OpenAPI v2, khusus Enterprise Shared key)
    const rs = opts.retainSeconds;
    if (rs !== undefined && rs >= 10 && rs <= 180) body.retainSeconds = rs;
    if (opts.instanceType) body.instanceType = opts.instanceType;

    // AUDIT LOGGING — sebelum request dikirim
    const timestamp = new Date().toISOString();
    const chatId = opts.chatId ?? 'unknown';
    const requestNum = opts.requestNumber ?? 0;
    const endpoint = `/${this.runPath}/${opts.workflowId}`;
    console.log(
      `[AUDIT] [${timestamp}] [chatId=${chatId}] [req#${requestNum}] runWorkflow() called`,
      `endpoint=${endpoint}`,
      `nodeCount=${opts.nodeInfoList.length}`,
    );

    const r = await this.http.post<TaskResponseV2>(
      endpoint,
      body,
      { headers: { Authorization: `Bearer ${opts.apiKey ?? this.apiKey}` } },
    );
    const resp = r.data;
    
    // AUDIT LOGGING — setelah response diterima
    console.log(
      `[AUDIT] [${timestamp}] [chatId=${chatId}] [req#${requestNum}] runWorkflow() response received`,
      `taskId=${resp.taskId ?? 'null'}`,
      `status=${resp.status ?? 'null'}`,
    );

    if (!resp.taskId || resp.errorCode) {
      throw new Error(
        `Gagal menjalankan workflow: ${resp.errorMessage || resp.errorCode || 'taskId kosong'}`,
      );
    }
    return { taskId: resp.taskId, status: resp.status };
  }

  /**
   * Polling status task.
   * POST {BASE}/query — body { taskId }.
   * Mengembalikan respons lengkap (status, errorMessage, results, failedReason).
   */
  async query(taskId: string, apiKey?: string): Promise<TaskResponseV2> {
    const r = await this.http.post<TaskResponseV2>(
      '/query',
      { taskId },
      { headers: { Authorization: `Bearer ${apiKey ?? this.apiKey}` } },
    );
    const resp = r.data;
    // taskId kosong + errorCode → request tidak valid (bukan status task)
    if (!resp.taskId && resp.errorCode) {
      throw new Error(`Query task: ${resp.errorMessage || resp.errorCode}`);
    }
    return resp;
  }

  /** Unduh file dari URL (mis. video hasil dari server) dengan timeout. */
  async downloadBuffer(url: string, timeoutMs: number = 300_000): Promise<Buffer> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const r = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return Buffer.from(r.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timeout') || msg.includes('aborted')) {
        throw new Error(`Download timeout setelah ${timeoutMs/1000}s dari URL: ${url}`);
      }
      throw err;
    }
  }
}
