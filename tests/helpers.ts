import { beforeEach } from 'vitest';

const testEnvironment: NodeJS.ProcessEnv = {
  BASE_URL: 'http://localhost:3000',
  SUB2API_BASE_URL: 'https://sub2api.example.test',
  SUB2API_ADMIN_API_KEY: 'test-admin-api-key',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough',
  SESSION_TTL_HOURS: '24',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD_HASH: '$2b$10$test-password-hash',
  DATABASE_PATH: ':memory:',
  ALIPAY_QR_IMAGE: '/assets/alipay-qr.png',
  BALANCE_PER_CNY: '1',
  ORDER_EXPIRE_HOURS: '24',
  PROCESSING_STALE_MINUTES: '15',
  USER_AUTH_RATE_LIMIT_WINDOW_MS: '900000',
  USER_AUTH_RATE_LIMIT_MAX: '10',
  ORDER_CREATE_RATE_LIMIT_WINDOW_MS: '60000',
  ORDER_CREATE_RATE_LIMIT_MAX: '10',
  ORDER_SUBMIT_RATE_LIMIT_WINDOW_MS: '60000',
  ORDER_SUBMIT_RATE_LIMIT_MAX: '10',
  ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: '900000',
  ADMIN_LOGIN_RATE_LIMIT_MAX: '5',
};

function resetTestEnvironment(): void {
  Object.assign(process.env, testEnvironment);
}

resetTestEnvironment();
beforeEach(resetTestEnvironment);
