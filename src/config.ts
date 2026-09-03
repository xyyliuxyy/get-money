import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { AppConfig, RateLimitConfig } from './types.js';
import type { EasyPayConfig } from './easypay.js';

const positiveInteger = z.coerce.number().int().positive();
const nonNegativeInteger = z.coerce.number().int().nonnegative();

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInteger.default(3000),
  BASE_URL: z.string().url(),
  SUB2API_BASE_URL: z.string().url(),
  SUB2API_ADMIN_API_KEY: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: positiveInteger,
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD_HASH: z.string().min(1),
  DATABASE_PATH: z.string().min(1),
  ALIPAY_QR_IMAGE: z.string().min(1),
  RECHARGE_AMOUNTS: z.string().min(1),
  BALANCE_PER_CNY: z.string().min(1),
  ORDER_EXPIRE_HOURS: positiveInteger,
  PROCESSING_STALE_MINUTES: positiveInteger,
  TRUST_PROXY_HOPS: nonNegativeInteger.default(0),
  USER_AUTH_RATE_LIMIT_WINDOW_MS: positiveInteger,
  USER_AUTH_RATE_LIMIT_MAX: positiveInteger,
  ORDER_CREATE_RATE_LIMIT_WINDOW_MS: positiveInteger,
  ORDER_CREATE_RATE_LIMIT_MAX: positiveInteger,
  ORDER_SUBMIT_RATE_LIMIT_WINDOW_MS: positiveInteger,
  ORDER_SUBMIT_RATE_LIMIT_MAX: positiveInteger,
  ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: positiveInteger,
  ADMIN_LOGIN_RATE_LIMIT_MAX: positiveInteger,
  EASYPAY_ENABLED: z.enum(['true', 'false']).default('false'),
  EASYPAY_PID: z.string().default(''),
  EASYPAY_KEY: z.string().default(''),
  EASYPAY_QR_CONTENT: z.string().default(''),
});

function parseRechargeAmounts(rechargeAmounts: string): number[] {
  const amounts = rechargeAmounts.split(',').map((value) => {
    try {
      const cny = new Decimal(value.trim());
      const fen = cny.mul(100).toNumber();
      if (!cny.isFinite() || !cny.isInteger() || cny.lte(0) || !Number.isSafeInteger(fen)) {
        throw new Error('Invalid recharge amount');
      }
      return fen;
    } catch {
      throw new Error('Invalid recharge amount');
    }
  });

  if (new Set(amounts).size !== amounts.length) {
    throw new Error('Recharge amounts must be distinct');
  }

  return amounts;
}

function parseBalancePerCny(value: string): Decimal {
  try {
    const balancePerCny = new Decimal(value);
    if (!balancePerCny.isFinite() || balancePerCny.lte(0)) {
      throw new Error('Invalid BALANCE_PER_CNY');
    }
    return balancePerCny;
  } catch {
    throw new Error('Invalid BALANCE_PER_CNY');
  }
}

function rateLimit(windowMs: number, max: number): RateLimitConfig {
  return { windowMs, max };
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = environmentSchema.parse(env);
  const easyPay: EasyPayConfig = {
    enabled: parsed.EASYPAY_ENABLED === 'true',
    pid: parsed.EASYPAY_PID,
    key: parsed.EASYPAY_KEY,
    qrContent: parsed.EASYPAY_QR_CONTENT,
  };
  if (easyPay.enabled && (!easyPay.pid || !easyPay.key || !easyPay.qrContent)) {
    throw new Error('EasyPay requires EASYPAY_PID, EASYPAY_KEY, and EASYPAY_QR_CONTENT');
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    baseUrl: parsed.BASE_URL,
    sub2apiBaseUrl: parsed.SUB2API_BASE_URL,
    sub2apiAdminApiKey: parsed.SUB2API_ADMIN_API_KEY,
    sessionSecret: parsed.SESSION_SECRET,
    sessionTtlHours: parsed.SESSION_TTL_HOURS,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPasswordHash: parsed.ADMIN_PASSWORD_HASH,
    databasePath: parsed.DATABASE_PATH,
    alipayQrImage: parsed.ALIPAY_QR_IMAGE,
    rechargeAmountsFen: parseRechargeAmounts(parsed.RECHARGE_AMOUNTS),
    balancePerCny: parseBalancePerCny(parsed.BALANCE_PER_CNY),
    orderExpireHours: parsed.ORDER_EXPIRE_HOURS,
    processingStaleMinutes: parsed.PROCESSING_STALE_MINUTES,
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    rateLimits: {
      userAuth: rateLimit(parsed.USER_AUTH_RATE_LIMIT_WINDOW_MS, parsed.USER_AUTH_RATE_LIMIT_MAX),
      orderCreate: rateLimit(parsed.ORDER_CREATE_RATE_LIMIT_WINDOW_MS, parsed.ORDER_CREATE_RATE_LIMIT_MAX),
      orderSubmit: rateLimit(parsed.ORDER_SUBMIT_RATE_LIMIT_WINDOW_MS, parsed.ORDER_SUBMIT_RATE_LIMIT_MAX),
      adminLogin: rateLimit(parsed.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS, parsed.ADMIN_LOGIN_RATE_LIMIT_MAX),
    },
    easyPay,
  };
}
