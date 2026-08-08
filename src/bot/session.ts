import type { Context } from 'telegraf';

/** State mesin Conversation Flow (Motion Control generation). */
export type ConversationState = 'idle' | 'waiting_image' | 'waiting_video' | 'running';

/** State per-chat untuk bot (disimpan di memori oleh middleware session telegraf). */
export interface BotSession {
  // ===== Generation Flow State =====
  /** Conversation state — track di mana user berada dalam flow. */
  conversationState?: ConversationState;

  /** Model Motion Control pilihan user: 'v1' | 'v2' | 'v3'. */
  modelVersion?: 'v1' | 'v2' | 'v3';

  // ===== Private API Key =====
  /** Private API key yang disimpan user untuk generate pribadi. */
  privateApiKey?: string;

  /** Flag: apakah user dalam mode private API key. */
  usingPrivateMode?: boolean;

  // ===== File Uploads =====
  /** file_id gambar dari Telegram. */
  imageFileId?: string;
  imageName?: string;

  /** file_id video referensi dari Telegram. */
  videoFileId?: string;
  videoName?: string;

  // ===== Job Tracking =====
  /** Task ID terakhir yang dijalankan (dari RunningHub). */
  lastTaskId?: string;

  /** Task ID yang sedang di-lock (token terkunci untuk job ini). */
  lockedTaskId?: string;

  // ===== Deprecated Fields (kept for backward compatibility, but not used) =====
  /** @deprecated - Tidak lagi digunakan. Bot hanya gunakan server API key. */
  apiKey?: string;

  /** @deprecated - Tidak lagi digunakan. Bot tidak punya pilihan instance. */
  instanceType?: string;

  /** @deprecated - Tidak lagi digunakan. Diganti dengan model pilihan user. */
  model?: string;

  /** @deprecated - Tidak lagi digunakan. */
  prompt?: string;

  /** @deprecated - Tidak lagi digunakan. */
  seed?: number;

  /** @deprecated - Tidak lagi digunakan. */
  videoDurationSeconds?: number;

  // ===== TOP UP KREDIT =====
  /** Topup amount (Rp) yang dipilih user. */
  topupAmountRp?: number;

  /** Topup credit amount yang akan diberikan. */
  topupCreditAmount?: number;
}

/** Konteks bot dengan session yang dijamin ada. */
export interface BotCtx extends Context {
  session: BotSession;
}
