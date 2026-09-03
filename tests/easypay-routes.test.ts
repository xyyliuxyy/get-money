import express from 'express';
import request from 'supertest';
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { createDatabaseStore } from '../src/db.js';
import { buildEasyPaySign } from '../src/easypay.js';
import { createEasyPayRouter } from '../src/routes/easypay.js';
import type { AppConfig } from '../src/types.js';

const config: AppConfig = {
  nodeEnv: 'test', port: 3000, baseUrl: 'http://localhost:3000', sub2apiBaseUrl: 'https://sub2api.test',
  sub2apiAdminApiKey: 'unused', sessionSecret: 'test-session-secret-that-is-long-enough', sessionTtlHours: 24,
  adminUsername: 'admin', adminPasswordHash: 'unused', databasePath: ':memory:', alipayQrImage: '/tmp/qr.png',
  rechargeAmountsFen: [1000, 2000], balancePerCny: new Decimal('1'), orderExpireHours: 24, processingStaleMinutes: 15,
  trustProxyHops: 0, rateLimits: { userAuth: { windowMs: 1, max: 1 }, orderCreate: { windowMs: 1, max: 1 }, orderSubmit: { windowMs: 1, max: 1 }, adminLogin: { windowMs: 1, max: 1 } },
  easyPay: { enabled: true, pid: '10001', key: 'shared', qrContent: 'https://qr.alipay.com/example-content' },
};

function appFor(overrides: Partial<AppConfig['easyPay']> = {}) {
  const store = createDatabaseStore(':memory:');
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(createEasyPayRouter({ config: { ...config, easyPay: { ...config.easyPay!, ...overrides } }, store }));
  return { app, store };
}

function createBody() {
  const params = { pid: '10001', type: 'alipay', out_trade_no: 'SUB-ROUTE-1', notify_url: 'https://sub2api.test/notify', return_url: 'https://sub2api.test/return', name: 'Recharge', money: '20.00', param: '' };
  return { ...params, sign: buildEasyPaySign(params, 'shared'), sign_type: 'MD5' };
}

describe('EasyPay routes', () => {
  it('creates and queries an order without a user session', async () => {
    const { app, store } = appFor();
    const created = await request(app).post('/mapi.php').type('form').send(createBody()).expect(200);
    expect(created.body).toMatchObject({ code: 1, qrcode: 'https://qr.alipay.com/example-content' });
    const queried = await request(app).post('/api.php').type('form').send({ act: 'order', pid: '10001', key: 'shared', out_trade_no: 'SUB-ROUTE-1' }).expect(200);
    expect(queried.body.trade_status).toBe('WAITING');
    store.close();
  });

  it('returns protocol errors when disabled', async () => {
    const { app, store } = appFor({ enabled: false });
    const response = await request(app).post('/mapi.php').type('form').send(createBody()).expect(503);
    expect(response.body).toMatchObject({ code: 0 });
    store.close();
  });

  it('accepts a signed payment notification and forwards success', async () => {
    const { app, store } = appFor();
    const created = await request(app).post('/mapi.php').type('form').send(createBody()).expect(200);
    const params = { pid: '10001', out_trade_no: 'SUB-ROUTE-1', trade_no: 'ALIPAY-ROUTE-1', money: '20.00', trade_status: 'SUCCESS' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('success', { status: 200 })));
    const notified = await request(app).post('/notify.php').type('form').send({ ...params, sign: buildEasyPaySign(params, 'shared'), sign_type: 'MD5' }).expect(200);
    expect(notified.text).toBe('success');
    expect(store.findByExternalOrderNo('SUB-ROUTE-1')).toMatchObject({ status: 'approved', externalTradeNo: 'ALIPAY-ROUTE-1' });
    expect(created.body.trade_no).toBeTruthy();
    vi.unstubAllGlobals();
    store.close();
  });
});
