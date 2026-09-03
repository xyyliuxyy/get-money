import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { createDatabaseStore } from '../src/db.js';
import { buildEasyPaySign } from '../src/easypay.js';
import { createEasyPayOrder, queryEasyPayOrder } from '../src/services/easypay.js';
import type { AppConfig } from '../src/types.js';

const config: AppConfig = {
  nodeEnv: 'test', port: 3000, baseUrl: 'http://localhost:3000', sub2apiBaseUrl: 'https://sub2api.test',
  sub2apiAdminApiKey: 'unused', sessionSecret: 'test-session-secret-that-is-long-enough', sessionTtlHours: 24,
  adminUsername: 'admin', adminPasswordHash: 'unused', databasePath: ':memory:', alipayQrImage: '/tmp/qr.png',
  rechargeAmountsFen: [1000, 2000], balancePerCny: new Decimal('1'), orderExpireHours: 24, processingStaleMinutes: 15,
  trustProxyHops: 0, rateLimits: { userAuth: { windowMs: 1, max: 1 }, orderCreate: { windowMs: 1, max: 1 }, orderSubmit: { windowMs: 1, max: 1 }, adminLogin: { windowMs: 1, max: 1 } },
  easyPay: {
    enabled: true,
    pid: '10001',
    key: 'shared',
    qrContent: 'https://qr.alipay.com/example-content',
    qrContentsByAmountFen: {
      1000: 'https://qr.alipay.com/ten',
      2000: 'https://qr.alipay.com/twenty',
    },
  },
};

function createParams(outTradeNo = 'SUB-ORDER-1', money = '20.00') {
  const params = { pid: '10001', type: 'alipay', out_trade_no: outTradeNo, notify_url: 'https://sub2api.test/notify', return_url: 'https://sub2api.test/return', name: 'Recharge', money, param: '' };
  return { ...params, sign: buildEasyPaySign(params, 'shared'), sign_type: 'MD5' };
}

describe('EasyPay order service', () => {
  it('creates an order and returns a QR URL', () => {
    const store = createDatabaseStore(':memory:');
    const result = createEasyPayOrder({ config, store, params: createParams() });
    expect(result).toMatchObject({ code: 1, trade_no: expect.any(String), qrcode: 'https://qr.alipay.com/twenty' });
    expect(store.findByExternalOrderNo('SUB-ORDER-1')).toMatchObject({ paymentMethod: 'easypay_alipay', amountFen: 2000 });
    store.close();
  });

  it('returns the QR code configured for the selected amount', () => {
    const store = createDatabaseStore(':memory:');
    const result = createEasyPayOrder({ config, store, params: createParams('SUB-ORDER-10', '10.00') });
    expect(result.qrcode).toBe('https://qr.alipay.com/ten');
    store.close();
  });

  it('rejects invalid signatures and amounts', () => {
    const store = createDatabaseStore(':memory:');
    expect(() => createEasyPayOrder({ config, store, params: { ...createParams(), sign: 'bad' } })).toThrowError(/sign/i);
    expect(() => createEasyPayOrder({ config, store, params: createParams('SUB-ORDER-2', '9.00') })).toThrowError(/amount/i);
    store.close();
  });

  it('returns the same order for duplicate requests and maps status', () => {
    const store = createDatabaseStore(':memory:');
    const params = createParams();
    const first = createEasyPayOrder({ config, store, params });
    const second = createEasyPayOrder({ config, store, params });
    expect(second.trade_no).toBe(first.trade_no);
    expect(queryEasyPayOrder({ config, store, params: { pid: '10001', key: 'shared', out_trade_no: 'SUB-ORDER-1' } })).toMatchObject({ trade_status: 'WAITING' });
    store.markEasyPayPaid(store.findByExternalOrderNo('SUB-ORDER-1')!.orderNo, 'ALIPAY-1', '2026-09-01T00:00:00.000Z');
    expect(queryEasyPayOrder({ config, store, params: { pid: '10001', key: 'shared', out_trade_no: 'SUB-ORDER-1' } })).toMatchObject({ trade_status: 'SUCCESS', trade_no: 'ALIPAY-1' });
    store.close();
  });
});
