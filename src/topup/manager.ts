import * as fs from 'fs';
import * as path from 'path';
import { TopupRequest, TopupRequestStatus, TOPUP_PRICING_TIERS } from './types.js';

const DB_PATH = path.join(process.cwd(), 'data', 'bot.json');

export class TopupRequestManager {
  private static instance: TopupRequestManager;

  private constructor() {}

  static getInstance(): TopupRequestManager {
    if (!TopupRequestManager.instance) {
      TopupRequestManager.instance = new TopupRequestManager();
    }
    return TopupRequestManager.instance;
  }

  private readDb(): any {
    try {
      const data = fs.readFileSync(DB_PATH, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Error reading database:', error);
      return { topup_requests: [] };
    }
  }

  private writeDb(data: any): void {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Error writing database:', error);
    }
  }

  create(
    telegramId: number,
    username: string,
    name: string,
    amountRp: number
  ): TopupRequest {
    const db = this.readDb();
    if (!db.topup_requests) {
      db.topup_requests = [];
    }

    // Find pricing tier
    const tier = TOPUP_PRICING_TIERS.find((t: typeof TOPUP_PRICING_TIERS[0]) => t.amount === amountRp);
    if (!tier) {
      throw new Error(`Invalid topup amount: ${amountRp}`);
    }

    const request: TopupRequest = {
      id: `topup_${telegramId}_${Date.now()}`,
      telegramId,
      username,
      name,
      amount: amountRp,
      credit: tier.credit,
      status: 'PENDING',
      createdAt: Date.now(),
    };

    db.topup_requests.push(request);
    this.writeDb(db);
    return request;
  }

  getAll(): TopupRequest[] {
    const db = this.readDb();
    return db.topup_requests || [];
  }

  getById(id: string): TopupRequest | undefined {
    const requests = this.getAll();
    return requests.find((r) => r.id === id);
  }

  getByTelegramId(telegramId: number): TopupRequest[] {
    const requests = this.getAll();
    return requests.filter((r) => r.telegramId === telegramId);
  }

  getByStatus(status: TopupRequestStatus): TopupRequest[] {
    const requests = this.getAll();
    return requests.filter((r) => r.status === status);
  }

  getLatest(limit: number = 10): TopupRequest[] {
    const requests = this.getAll();
    return requests.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  updateStatus(
    id: string,
    status: TopupRequestStatus,
    approvedBy?: string
  ): TopupRequest | undefined {
    const db = this.readDb();
    const request = db.topup_requests.find((r: TopupRequest) => r.id === id);

    if (!request) {
      return undefined;
    }

    request.status = status;
    if (status === 'APPROVED') {
      request.approvedAt = Date.now();
      request.approvedBy = approvedBy || 'admin';
    }

    this.writeDb(db);
    return request;
  }
}

export const topupManager = TopupRequestManager.getInstance();
