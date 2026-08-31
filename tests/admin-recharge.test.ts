import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import request, { type SuperAgentTest } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { createAuth } from '../src/auth.js';
import { createDatabaseStore, type DatabaseStore, type NewOrder } from '../src/db.js';
import { createAdminRouter } from '../src/routes/admin.js';
import { AdminReviewError, approveOrder, retryOrder } from '../src/services/recharge.js';
import type { AppConfig, Sub2ApiClient } from '../src/types.js';

const now = '2026-08-31T12:00:00.000Z';

class FakeSub2Api implements Sub2ApiClient {
  readonly redeemCalls: Array<{ code: string; userId: number; value: string; notes: string; idempotencyKey: string }> = [];
  private readonly failures: Error[] = [];

  async verifyUserToken(): Promise<never> {
    throw new Error('not implemented for admin tests');
  }

  failOnce(error: Error): void {
    this.failures.push(error);
  }

  async createAndRedeem(input: { code: string; userId: number; value: string; notes: string; idempotencyKey: string }): Promise<void> {
    this.redeemCalls.push(input);
    const failure = this.failures.shift();
    if (failure) throw failure;
  }
}

function createDeferredSub2Api(): {
  client: Sub2ApiClient;
  entered: Promise<void>;
  complete(): void;
} {
  let enteredResolve!: () => void;
  let complete!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const completion = new Promise<void>((resolve) => { complete = resolve; });
  return {
    client: {
      async verifyUserToken(): Promise<never> {
        throw new Error('not implemented for admin tests');
      },
      async createAndRedeem(): Promise<void> {
        enteredResolve();
        await completion;
      },
    },
    entered,
    complete,
  };
}

function makeConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    baseUrl: 'http://localhost:3000',
    sub2apiBaseUrl: 'https://sub2api.example.test',
    sub2apiAdminApiKey: 'test-admin-api-key',
    sessionSecret: 'test-session-secret-that-is-long-enough',
    sessionTtlHours: 24,
    adminUsername: 'admin',
    adminPasswordHash: bcrypt.hashSync('correct horse battery staple', 4),
    databasePath: ':memory:',
    alipayQrImage: '/assets/alipay-qr.png',
    rechargeAmountsFen: [5000],
    balancePerCny: new Decimal(1),
    orderExpireHours: 24,
    processingStaleMinutes: 15,
    rateLimits: {
      userAuth: { windowMs: 900000, max: 10 },
      orderCreate: { windowMs: 60000, max: 10 },
      orderSubmit: { windowMs: 60000, max: 10 },
      adminLogin: { windowMs: 900000, max: 5 },
    },
  };
}

function createOrder(store: DatabaseStore, orderNo: string, status: NewOrder['status'] = 'pending_review') {
  return store.createOrder({
    orderNo,
    userId: 7,
    usernameSnapshot: 'alice',
    emailSnapshot: 'alice@example.test',
    amountFen: 5000,
    balanceValue: '50',
    paymentMethod: 'alipay_manual',
    status,
    rechargeCode: `manual_${orderNo}`,
    createdAt: now,
    expiresAt: '2026-09-01T12:00:00.000Z',
  });
}

function csrfHeaders(csrf: string) {
  return { Origin: 'http://localhost:3000', 'X-CSRF-Token': csrf };
}

describe('administrator review and recharge API', () => {
  const stores: DatabaseStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  async function setup(): Promise<{
    agent: SuperAgentTest;
    config: AppConfig;
    store: DatabaseStore;
    fakeSub2Api: FakeSub2Api;
    login(): Promise<string>;
  }> {
    const config = makeConfig();
    const store = createDatabaseStore(':memory:');
    stores.push(store);
    const auth = createAuth(config, store);
    const fakeSub2Api = new FakeSub2Api();
    const app = express();
    app.use(express.json());
    app.use(cookieParser(config.sessionSecret));
    app.use(createAdminRouter({ config, store, auth, sub2api: fakeSub2Api }));
    const agent = request.agent(app);

    return {
      agent,
      config,
      store,
      fakeSub2Api,
      async login() {
        const response = await agent.post('/api/admin/login')
          .send({ username: config.adminUsername, password: 'correct horse battery staple' })
          .expect(200);
        return response.body.csrf;
      },
    };
  }

  it('requires an authenticated administrator for order search', async () => {
    const { agent } = await setup();

    await agent.get('/api/admin/orders').expect(401);
  });

  it('rejects a wrong password and rate limits repeated login attempts', async () => {
    const { agent, config } = await setup();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await agent.post('/api/admin/login').send({ username: config.adminUsername, password: 'wrong' }).expect(401);
    }
    await agent.post('/api/admin/login').send({ username: config.adminUsername, password: 'wrong' }).expect(429);
  });

  it('clears an authenticated administrator session on logout', async () => {
    const { agent, login } = await setup();
    const csrf = await login();

    await agent.post('/api/admin/logout').set(csrfHeaders(csrf)).send({}).expect(204);
    await agent.get('/api/admin/orders').expect(401);
  });

  it('searches order number, user ID, email, and transaction number', async () => {
    const { agent, store, login } = await setup();
    createOrder(store, 'S2P20260831SEARCH', 'awaiting_payment');
    store.submitTransaction('S2P20260831SEARCH', 7, 'TRADE-SEARCH-1', now, now);
    await login();

    for (const term of ['SEARCH', '7', 'alice@example.test', 'TRADE-SEARCH-1']) {
      const response = await agent.get('/api/admin/orders').query({ search: term }).expect(200);
      expect(response.body.orders.map((order: { order_no: string }) => order.order_no)).toEqual(['S2P20260831SEARCH']);
    }
  });

  it('rejects a pending order without calling Sub2API', async () => {
    const { agent, store, fakeSub2Api, login } = await setup();
    const orderNo = 'S2P20260831REJECT';
    createOrder(store, orderNo);
    const csrf = await login();

    await agent.post(`/api/admin/orders/${orderNo}/reject`)
      .set(csrfHeaders(csrf))
      .send({ reason: 'payment not found', note: 'bank feed checked' })
      .expect(200);

    expect(fakeSub2Api.redeemCalls).toHaveLength(0);
    expect(store.findByOrderNo(orderNo)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'payment not found',
      adminNote: 'bank feed checked',
    });
  });

  it('allows only one of two concurrent approvals to recharge', async () => {
    const { agent, store, fakeSub2Api, login } = await setup();
    const orderNo = 'S2P20260831CONCURRENT';
    createOrder(store, orderNo);
    const csrf = await login();

    const [first, second] = await Promise.all([
      agent.post(`/api/admin/orders/${orderNo}/approve`).set(csrfHeaders(csrf)).send({}),
      agent.post(`/api/admin/orders/${orderNo}/approve`).set(csrfHeaders(csrf)).send({}),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(fakeSub2Api.redeemCalls).toHaveLength(1);
    expect(store.findByOrderNo(orderNo)?.status).toBe('approved');
  });

  it('does not recharge rejected or approved orders', async () => {
    const { agent, store, fakeSub2Api, login } = await setup();
    const rejectedOrderNo = 'S2P20260831REJECTED';
    const approvedOrderNo = 'S2P20260831APPROVED';
    createOrder(store, rejectedOrderNo, 'rejected');
    createOrder(store, approvedOrderNo, 'approved');
    const csrf = await login();

    await agent.post(`/api/admin/orders/${rejectedOrderNo}/approve`).set(csrfHeaders(csrf)).send({}).expect(409);
    await agent.post(`/api/admin/orders/${approvedOrderNo}/approve`).set(csrfHeaders(csrf)).send({}).expect(409);
    expect(fakeSub2Api.redeemCalls).toHaveLength(0);
  });

  it('marks a timeout recharge failed and uses a new idempotency attempt on retry', async () => {
    const { agent, store, fakeSub2Api, login } = await setup();
    const orderNo = 'S2P20260831RETRY';
    createOrder(store, orderNo);
    const csrf = await login();
    fakeSub2Api.failOnce(new Error('timeout'));

    await agent.post(`/api/admin/orders/${orderNo}/approve`).set(csrfHeaders(csrf)).send({}).expect(502);
    expect(store.findByOrderNo(orderNo)?.status).toBe('recharge_failed');
    await agent.post(`/api/admin/orders/${orderNo}/retry`).set(csrfHeaders(csrf)).send({}).expect(200);

    expect(fakeSub2Api.redeemCalls.map((call) => call.code)).toEqual([`manual_${orderNo}`, `manual_${orderNo}`]);
    expect(fakeSub2Api.redeemCalls.map((call) => call.idempotencyKey))
      .toEqual([`manual-pay-${orderNo}-1`, `manual-pay-${orderNo}-2`]);
    expect(store.findByOrderNo(orderNo)?.status).toBe('approved');
  });

  it('releases a processing order only after the configured stale interval', async () => {
    const { store, fakeSub2Api } = await setup();
    const orderNo = 'S2P20260831STALE';
    createOrder(store, orderNo);
    store.claimRecharge(orderNo, '2026-08-31T12:00:00.000Z');
    const baseInput = {
      store,
      sub2api: fakeSub2Api,
      adminName: 'admin',
      orderNo,
      processingStaleMinutes: 15,
    };

    await expect(retryOrder({ ...baseInput, now: new Date('2026-08-31T12:14:59.999Z') }))
      .rejects.toMatchObject<Partial<AdminReviewError>>({ status: 409 });
    expect(fakeSub2Api.redeemCalls).toHaveLength(0);

    await retryOrder({ ...baseInput, now: new Date('2026-08-31T12:15:00.000Z') });
    expect(fakeSub2Api.redeemCalls).toEqual([expect.objectContaining({
      code: `manual_${orderNo}`,
      idempotencyKey: `manual-pay-${orderNo}-2`,
    })]);
  });

  it('does not let a stale attempt complete a newer recharge claim', async () => {
    const { store } = await setup();
    const orderNo = 'S2P20260831OWNERSHIP';
    createOrder(store, orderNo);
    const firstUpstream = createDeferredSub2Api();
    const retryUpstream = createDeferredSub2Api();
    const baseInput = { store, adminName: 'admin', orderNo, processingStaleMinutes: 15 };
    const first = approveOrder({
      ...baseInput,
      sub2api: firstUpstream.client,
      now: new Date('2026-08-31T12:00:00.000Z'),
    });
    await firstUpstream.entered;

    const retry = retryOrder({
      ...baseInput,
      sub2api: retryUpstream.client,
      now: new Date('2026-08-31T12:15:00.000Z'),
    });
    await retryUpstream.entered;

    firstUpstream.complete();
    await expect(first).rejects.toMatchObject<Partial<AdminReviewError>>({ status: 409 });
    expect(store.findByOrderNo(orderNo)).toMatchObject({ status: 'processing', rechargeAttempts: 2 });

    retryUpstream.complete();
    await expect(retry).resolves.toMatchObject({ status: 'approved', rechargeAttempts: 2 });
  });

  it('marks 401 and 403 upstream errors as failed with an Admin API key hint', async () => {
    const { agent, store, fakeSub2Api, login } = await setup();
    const csrf = await login();

    for (const [index, status] of [401, 403].entries()) {
      const orderNo = `S2P20260831KEY${index}`;
      createOrder(store, orderNo);
      const error = Object.assign(new Error(`upstream ${status}`), { status });
      fakeSub2Api.failOnce(error);

      const response = await agent.post(`/api/admin/orders/${orderNo}/approve`).set(csrfHeaders(csrf)).send({}).expect(502);
      expect(response.body.error).toContain('Admin API');
      expect(response.body.error).toContain('API Key');
      expect(store.findByOrderNo(orderNo)).toMatchObject({ status: 'recharge_failed' });
    }
  });
});
