import type { Decimal } from 'decimal.js';

export type OrderStatus =
  | 'awaiting_payment' | 'pending_review' | 'processing'
  | 'approved' | 'rejected' | 'recharge_failed' | 'expired';

export interface VerifiedProfile { id: number; username?: string; email?: string; }

export interface Sub2ApiClient {
  verifyUserToken(token: string): Promise<VerifiedProfile>;
  createAndRedeem(input: {
    code: string; userId: number; value: string; notes: string; idempotencyKey: string;
  }): Promise<void>;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  baseUrl: string;
  sub2apiBaseUrl: string;
  sub2apiAdminApiKey: string;
  sessionSecret: string;
  sessionTtlHours: number;
  adminUsername: string;
  adminPasswordHash: string;
  databasePath: string;
  alipayQrImage: string;
  rechargeAmountsFen: number[];
  balancePerCny: Decimal;
  orderExpireHours: number;
  processingStaleMinutes: number;
  rateLimits: {
    userAuth: RateLimitConfig;
    orderCreate: RateLimitConfig;
    orderSubmit: RateLimitConfig;
    adminLogin: RateLimitConfig;
  };
}
