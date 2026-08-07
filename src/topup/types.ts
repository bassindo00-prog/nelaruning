export type TopupRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface TopupRequest {
  id: string;
  telegramId: number;
  username: string;
  name: string;
  amount: number; // Rp amount
  credit: number; // Credit amount
  status: TopupRequestStatus;
  createdAt: number;
  approvedAt?: number;
  approvedBy?: string;
}

export interface TopupPricingTier {
  amount: number; // Rp
  credit: number; // Credits
  label: string;
  callbackData: string;
}

export const TOPUP_PRICING_TIERS: TopupPricingTier[] = [
  {
    amount: 25000,
    credit: 20000,
    label: 'Rp25.000 = 20.000 token',
    callbackData: 'topup:select:25000',
  },
  {
    amount: 30000,
    credit: 27000,
    label: 'Rp30.000 = 27.000 token',
    callbackData: 'topup:select:30000',
  },
  {
    amount: 50000,
    credit: 48000,
    label: 'Rp50.000 = 48.000 token',
    callbackData: 'topup:select:50000',
  },
  {
    amount: 100000,
    credit: 100000,
    label: 'Rp100.000 = 100.000 token',
    callbackData: 'topup:select:100000',
  },
];
