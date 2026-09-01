import { describe, expect, it, vi } from 'vitest';
import { Decimal } from 'decimal.js';
import { createDatabaseStore } from '../src/db.js';
import { buildEasyPaySign } from '../src/easypay.js';
import { approveEasyPayOrder, retryEasyPayNotification } from '../src/services/easypay-notify.js';
import type { AppConfig } from '../src/types.js';

const config: AppConfig = {
  nodeEnv: 'test', port: 3000, baseUrl: 'http://localhost:3000', sub2apiBaseUrl: 'https://sub2api.test', sub2apiAdminApiKey: 'unused',
  sessionSecret: 'test-session-secret-that-is-long-enough', sessionTtlHours: 24, adminUsername: 'admin', adminPasswordHash: 'unused', databasePath: ':memory:', alipayQrImage: '/tmp/qr.png',
  rechargeAmountsFen: [2000], balancePerCny: new Decimal('1'), orderExpireHours: 24, processingStaleMinutes: 15, trustProxyHops: 0,
  rateLimits: { userAuth: { windowMs: 1, max: 1 }, orderCreate: { windowMs: 1, max: 1 }, orderSubmit: { windowMs: 1, max: 1 }, adminLogin: { windowMs: 1, max: 1 } },
  easyPay: { enabled: true, pid: '10001', key: 'shared', qrUrl: 'https://pay.test/qr.png' },
};

function seed() {
  const store = createDatabaseStore(':memory:');
  const order = store.createOrder({ orderNo: 'EP-ADMIN-1', userId: 0, amountFen: 2000, balanceValue: '20', paymentMethod: 'easypay_alipay', status: 'pending_review', rechargeCode: 'easy_EP-ADMIN-1', createdAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-02T00:00:00.000Z', externalOrderNo: 'SUB-ADMIN-1', notifyUrl: 'https://sub2api.test/notify' });
  return { store, order };
}

describe('EasyPay approval notification', () => {
  it('marks the order approved and sends a signed callback', async () => {
    const { store, order } = seed();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain('trade_status=SUCCESS');
      return new Response('success', { status: 200 });
    });
    const result = await approveEasyPayOrder({ config, store, orderNo: order.orderNo, fetchImpl, now: new Date('2026-09-01T00:01:00.000Z') });
    expect(result.status).toBe('approved');
    expect(store.findByOrderNo(order.orderNo)?.callbackStatus).toBe('sent');
    const params = { pid: '10001', trade_no: order.orderNo, out_trade_no: 'SUB-ADMIN-1', type: 'alipay', name: 'Recharge', money: '20.00', trade_status: 'SUCCESS' };
    expect(buildEasyPaySign(params, 'shared')).toBeTruthy();
    store.close();
  });

  it('keeps a retryable callback failure', async () => {
    const { store, order } = seed();
    const failedFetch = vi.fn(async () => new Response('error', { status: 500 }));
    await expect(approveEasyPayOrder({ config, store, orderNo: order.orderNo, fetchImpl: failedFetch })).rejects.toThrow(/callback/i);
    expect(store.findByOrderNo(order.orderNo)).toMatchObject({ status: 'approved', callbackStatus: 'failed', callbackAttempts: 1 });
    const retryFetch = vi.fn(async () => new Response('success', { status: 200 }));
    await retryEasyPayNotification({ config, store, orderNo: order.orderNo, fetchImpl: retryFetch });
    expect(store.findByOrderNo(order.orderNo)?.callbackStatus).toBe('sent');
    store.close();
  });
});
