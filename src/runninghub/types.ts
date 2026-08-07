/** Satu entry di nodeInfoList — override satu parameter node workflow. */
export interface NodeInfo {
  nodeId: string;
  fieldName: string;
  fieldValue: unknown;
}

/** Respons upload v2: POST {BASE}/media/upload/binary */
export interface UploadData {
  type: string;
  download_url: string;
  fileName: string;
  size?: string;
}

/** Bentuk respons API v1 (root): { code, msg, data }. */
export interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
  errorMessages?: unknown;
}

/**
 * Respons bersama untuk run workflow & query (v2).
 * `errorCode` kosong = sukses; `results` terisi saat SUCCESS.
 */
export interface TaskResponseV2 {
  taskId: string;
  status: string;
  errorCode: string;
  errorMessage: string;
  results: TaskResultV2[] | null;
  clientId?: string;
  promptTips?: string;
  failedReason?: FailedReason | Record<string, never>;
  usage?: unknown;
  parentTaskId?: string | null;
  taskUsageList?: unknown;
}

/** Satu hasil task di results[] — url file output. */
export interface TaskResultV2 {
  url: string;
  name?: string;
  type?: string;
  [key: string]: unknown;
}

export interface FailedReason {
  exception_type?: string;
  exception_message?: string;
  [key: string]: unknown;
}

export type TaskStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | (string & {});
