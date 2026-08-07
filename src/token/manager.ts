/**
 * Token Manager
 * Handles token balance operations with database integration
 */

import db from '../database/index.js';
import type { TokenBalance } from '../database/index.js';
import { getModelTokenCost, TokenValidation, ErrorMessages } from './system.js';

export interface TokenCheckResult {
  success: boolean;
  balance?: TokenBalance;
  error?: string;
}

export interface TokenLockResult {
  success: boolean;
  taskId?: string;
  error?: string;
}

export interface TokenRefundResult {
  success: boolean;
  newBalance?: number;
  error?: string;
}

/**
 * Manager untuk token operations
 */
export const tokenManager = {
  /**
   * Initialize user token balance jika belum ada
   */
  async initializeUser(chatId: number, initialTokens: number = 0): Promise<TokenBalance> {
    let balance = await db.getTokenBalance(chatId);
    if (!balance) {
      balance = await db.initTokenBalance(chatId, initialTokens);
    }
    return balance;
  },

  /**
   * Check apakah user punya cukup token untuk model
   */
  async checkTokenBalance(
    chatId: number,
    modelVersion: 'v1' | 'v2' | 'v3',
  ): Promise<TokenCheckResult> {
    const balance = await db.getTokenBalance(chatId);
    if (!balance) {
      // Buat balance baru dengan 0 token
      await db.initTokenBalance(chatId, 0);
      return {
        success: false,
        error: ErrorMessages.INSUFFICIENT_TOKENS(
          getModelTokenCost(modelVersion),
          0,
        ),
      };
    }

    const tokenCost = getModelTokenCost(modelVersion);
    if (!TokenValidation.hasEnoughTokens(balance.balance, tokenCost)) {
      return {
        success: false,
        balance,
        error: ErrorMessages.INSUFFICIENT_TOKENS(tokenCost, balance.balance),
      };
    }

    return {
      success: true,
      balance,
    };
  },

  /**
   * Lock tokens untuk job (deduct dari balance, track di locked)
   * Returns: result dengan taskId untuk tracking
   */
  async lockTokensForJob(
    chatId: number,
    taskId: string,
    modelVersion: 'v1' | 'v2' | 'v3',
  ): Promise<TokenLockResult> {
    const tokenCost = getModelTokenCost(modelVersion);
    const check = await this.checkTokenBalance(chatId, modelVersion);

    if (!check.success) {
      return {
        success: false,
        error: check.error,
      };
    }

    // Lock tokens (deduct dari balance, add ke locked)
    const result = await db.lockTokens(chatId, tokenCost);
    if (!result) {
      return {
        success: false,
        error: 'Gagal mengunci token. Silakan coba lagi.',
      };
    }

    // Create job record dengan status 'locked'
    await db.createJob(taskId, chatId, modelVersion, tokenCost, '', undefined);

    console.log(`[${chatId}] Token locked: ${tokenCost} untuk task ${taskId}`);

    return {
      success: true,
      taskId,
    };
  },

  /**
   * Confirm token deduction setelah job berhasil
   * Mengubah dari locked → permanently deducted
   */
  async deductTokensForSuccess(chatId: number, taskId: string): Promise<TokenRefundResult> {
    const job = await db.getJob(taskId);
    if (!job) {
      return {
        success: false,
        error: 'Job tidak ditemukan',
      };
    }

    // Deduct tokens permanently (dari locked count)
    const result = await db.deductTokens(chatId, job.tokenCost, taskId);
    if (!result) {
      return {
        success: false,
        error: 'Gagal mengurangi token',
      };
    }

    console.log(`[${chatId}] Token deducted: ${job.tokenCost} untuk task ${taskId}`);

    return {
      success: true,
      newBalance: result.balance,
    };
  },

  /**
   * Refund tokens jika job gagal
   * Mengembalikan dari locked → balance
   */
  async refundTokensForFailure(chatId: number, taskId: string): Promise<TokenRefundResult> {
    const job = await db.getJob(taskId);
    if (!job) {
      return {
        success: false,
        error: 'Job tidak ditemukan',
      };
    }

    // Unlock tokens (return dari locked → balance)
    const result = await db.unlockTokens(chatId, job.tokenCost);
    if (!result) {
      return {
        success: false,
        error: 'Gagal mengembalikan token',
      };
    }

    // Add refund history entry
    await db.addTokenHistory(
      chatId,
      'refund',
      job.tokenCost,
      taskId,
      'Refund karena job gagal',
    );

    console.log(
      `[${chatId}] Token refunded: ${job.tokenCost} untuk task ${taskId}`,
    );

    return {
      success: true,
      newBalance: result.balance,
    };
  },

  /**
   * Get current token statistics untuk user
   */
  async getTokenStats(chatId: number) {
    const balance = await db.getTokenBalance(chatId);
    const jobs = await db.getJobsByChat(chatId);

    if (!balance) {
      return {
        balance: 0,
        locked: 0,
        available: 0,
        totalEarned: 0,
        totalSpent: 0,
        totalGenerated: 0,
        totalFailed: 0,
      };
    }

    const totalGenerated = jobs.filter((j) => j.status === 'success').length;
    const totalFailed = jobs.filter((j) => j.status === 'failed').length;

    return {
      balance: balance.balance,
      locked: balance.lockedTokens,
      available: balance.balance - balance.lockedTokens,
      totalEarned: balance.totalEarned,
      totalSpent: balance.totalSpent,
      totalGenerated,
      totalFailed,
    };
  },

  /**
   * Add tokens to user (e.g., purchase, reward)
   */
  async addTokens(chatId: number, tokens: number, reason: string): Promise<TokenBalance | null> {
    return db.addTokens(chatId, tokens, reason);
  },

  /**
   * Get token history untuk user
   */
  async getTokenHistory(chatId: number, limit: number = 20) {
    return db.getTokenHistoryByChat(chatId, limit);
  },

  /**
   * Format balance untuk display
   */
  formatBalance(balance: TokenBalance): string {
    return `Saldo: ${balance.balance.toLocaleString('id-ID')} token (Terkunci: ${balance.lockedTokens.toLocaleString('id-ID')})`;
  },
};

export default tokenManager;
