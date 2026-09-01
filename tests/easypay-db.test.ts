import { describe, expect, it } from 'vitest';
import { createDatabaseStore } from '../src/db.js';

describe('EasyPay order persistence', () => {
  it('stores and updates external order metadata', () => {
    const store = createDatabaseStore(':memory:');
    const order = store.createOrder({
      orderNo: 'LOCAL-EASY-1',
      userId: 0,
      amountFen: 2000,
      balanceValue: '20',
      paymentMethod: 'easypay_alipay',
      status: 'awaiting_payment',
      rechargeCode: 'easy_LOCAL-EASY-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-02T00:00:00.000Z',
      externalOrderNo: 'SUB-1',
      notifyUrl: 'https://sub2api.example.test/notify',
      returnUrl: 'https://sub2api.example.test/return',
    });

    expect(store.findByExternalOrderNo('SUB-1')).toMatchObject({
      orderNo: order.orderNo,
      externalOrderNo: 'SUB-1',
      callbackAttempts: 0,
    });
    expect(store.markEasyPayPaid(order.orderNo, 'ALIPAY-1', '2026-09-01T00:01:00.000Z')).toMatchObject({
      status: 'approved',
      externalTradeNo: 'ALIPAY-1',
    });
    expect(store.recordEasyPayCallbackAttempt(order.orderNo, 'sent')).toMatchObject({ callbackAttempts: 1, callbackStatus: 'sent' });
    store.close();
  });

  it('rejects duplicate external order numbers', () => {
    const store = createDatabaseStore(':memory:');
    const base = {
      userId: 0, amountFen: 2000, balanceValue: '20', paymentMethod: 'easypay_alipay' as const,
      status: 'awaiting_payment' as const, createdAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-02T00:00:00.000Z',
      externalOrderNo: 'SUB-DUP', notifyUrl: 'https://example.test/notify',
    };
    store.createOrder({ ...base, orderNo: 'LOCAL-1', rechargeCode: 'easy_1' });
    expect(() => store.createOrder({ ...base, orderNo: 'LOCAL-2', rechargeCode: 'easy_2' })).toThrow();
    store.close();
  });
});
