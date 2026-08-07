/**
 * Token System Module
 * Manages token packages, pricing, and user balance operations
 */

/**
 * Motion Control Models dengan token cost
 */
export const MOTION_CONTROL_MODELS = {
  v1: {
    id: 'v1',
    label: '🎬 Motion Control V1',
    tokenCost: 700,
    description: 'Standard motion generation',
  },
  v2: {
    id: 'v2',
    label: '🎬 Motion Control V2',
    tokenCost: 900,
    description: 'Enhanced motion generation',
  },
  v3: {
    id: 'v3',
    label: '🎬 Motion Control V3',
    tokenCost: 1000,
    description: 'Premium motion generation',
  },
} as const;

/**
 * Token packages untuk pembelian
 * Format: Rp{amount} = {tokens} token
 */
export const TOKEN_PACKAGES = [
  {
    id: '25k',
    label: 'Rp25.000',
    amount: 25000, // IDR
    tokens: 20000,
    discount: 0,
  },
  {
    id: '30k',
    label: 'Rp30.000',
    amount: 30000,
    tokens: 27000,
    discount: 10, // 10% lebih banyak token
  },
  {
    id: '50k',
    label: 'Rp50.000',
    amount: 50000,
    tokens: 48000,
    discount: 4, // sedikit discount
  },
  {
    id: '100k',
    label: 'Rp100.000',
    amount: 100000,
    tokens: 100000,
    discount: 0,
  },
] as const;

/**
 * Get token cost untuk model tertentu
 */
export function getModelTokenCost(modelVersion: 'v1' | 'v2' | 'v3'): number {
  return MOTION_CONTROL_MODELS[modelVersion].tokenCost;
}

/**
 * Get model info
 */
export function getModelInfo(modelVersion: 'v1' | 'v2' | 'v3') {
  return MOTION_CONTROL_MODELS[modelVersion];
}

/**
 * Get package info by ID
 */
export function getPackageInfo(packageId: string) {
  return TOKEN_PACKAGES.find((p) => p.id === packageId);
}

/**
 * Format token number dengan separators
 */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('id-ID');
}

/**
 * Format IDR amount
 */
export function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(amount);
}

/**
 * Statistics untuk token usage
 */
export interface TokenStats {
  balance: number;
  locked: number;
  available: number;
  totalEarned: number;
  totalSpent: number;
  totalGenerated: number;
  totalFailed: number;
}

/**
 * Validation rules untuk token operations
 */
export const TokenValidation = {
  /**
   * Validate apakah user punya cukup token
   */
  hasEnoughTokens(balance: number, cost: number): boolean {
    return balance >= cost;
  },

  /**
   * Validate minimum video duration
   */
  isValidVideoDuration(seconds: number): boolean {
    return seconds >= 30 && seconds <= 300; // 30 detik - 5 menit
  },

  /**
   * Calculate retry delay (exponential backoff)
   */
  getRetryDelay(attemptNumber: number): number {
    return Math.min(1000 * Math.pow(2, attemptNumber), 30000); // max 30 secs
  },

  /**
   * Get job timeout based on model
   */
  getJobTimeout(modelVersion: 'v1' | 'v2' | 'v3'): number {
    // All models timeout after same duration
    // (user dapat loading indikator sementara itu)
    return 30 * 60 * 1000; // 30 minutes
  },
};

/**
 * Error messages yang ramah (tanpa technical jargon)
 */
export const ErrorMessages = {
  INSUFFICIENT_TOKENS: (needed: number, have: number) =>
    `❌ Saldo token tidak cukup.\n\nDibutuhkan: ${formatTokens(needed)} token\nSaldo Anda: ${formatTokens(have)} token\n\nSilakan beli token terlebih dahulu.`,

  INVALID_VIDEO_DURATION: () =>
    `❌ Durasi video referensi harus minimal 30 detik.\n\nSilakan kirim video yang lebih panjang.`,

  GENERATION_FAILED: () =>
    `❌ Proses generate gagal. Token Anda telah dikembalikan.\n\nSilakan coba beberapa saat lagi.`,

  NO_FILE_SELECTED: () => `❌ File belum dipilih. Silakan coba lagi.`,

  INVALID_MODEL: () => `❌ Model tidak valid. Silakan pilih dari menu.`,

  GENERATION_TIMEOUT: () =>
    `⏱️ Proses generate memakan waktu lebih lama dari biasanya.\n\nToken Anda telah dikembalikan. Silakan coba lagi nanti.`,

  JOB_ALREADY_RUNNING: () => `⏳ Job sedang berjalan. Tunggu selesai dulu ya.`,

  OPERATION_CANCELLED: () => `🚫 Operasi dibatalkan.`,
};

/**
 * Success messages
 */
export const SuccessMessages = {
  TOKEN_PURCHASED: (tokens: number, total: number) =>
    `✅ Berhasil membeli ${formatTokens(tokens)} token!\n\nTotal saldo Anda: ${formatTokens(total)} token`,

  GENERATION_STARTED: (model: string, cost: number) =>
    `🚀 Mulai generate ${model}\n\n⏳ Mohon tunggu sekitar 7–15 menit\nSilakan ngopi dulu ☕ 😄\n\nToken yang dipakai: ${formatTokens(cost)}`,

  GENERATION_COMPLETED: (model: string, elapsed: string) =>
    `✅ Generate ${model} selesai!\n\n⏱️ Waktu: ${elapsed}`,

  TOKEN_REFUNDED: (tokens: number) =>
    `✅ Token dikembalikan: ${formatTokens(tokens)} token`,
};

/**
 * Loading status messages (tanpa mention RunningHub/technical terms)
 */
export const LoadingStatus = {
  PREPARING: () => `⏳ Menyiapkan file…`,
  UPLOADING: () => `📤 Mengunggah asset…`,
  PROCESSING: () => `🎬 Memproses motion…`,
  RENDERING: () => `✨ Rendering video…`,
  FINALIZING: () => `📦 Menyelesaikan…`,
  COMPLETED: () => `🎉 Selesai!`,
};

/**
 * Format elapsed time
 */
export function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
