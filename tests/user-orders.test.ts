import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { createDatabaseStore, type DatabaseStore } from '../src/db.js';
import { createAuth } from '../src/auth.js';
import { createUserRouter } from '../src/routes/user.js';
import type { AppConfig, Sub2ApiClient } from '../src/types.js';

const config: AppConfig = {
  nodeEnv: 'test', port: 3000, baseUrl: 'http://localhost:3000',
  sub2apiBaseUrl: 'https://sub2api.example.test', sub2apiAdminApiKey: 'not-used',
  sessionSecret: 'test-session-secret-that-is-long-enough', sessionTtlHours: 24,
  adminUsername: 'admin', adminPasswordHash: 'hash', databasePath: ':memory:',
  alipayQrImage: '/assets/alipay-qr.png', rechargeAmountsFen: [1000, 5000, 50000],
  balancePerCny: new Decimal('1.5'), orderExpireHours: 24, processingStaleMinutes: 15,
  rateLimits: { userAuth: { windowMs: 900000, max: 10 }, orderCreate: { windowMs: 60000, max: 10 }, orderSubmit: { windowMs: 60000, max: 10 }, adminLogin: { windowMs: 900000, max: 5 } },
};

function setup() {
  const store = createDatabaseStore(':memory:');
  const auth = createAuth(config, store);
  const profiles = new Map<string, { id: number; username: string; email: string }>([
    ['valid-user-7', { id: 7, username: 'alice', email: 'alice@example.test' }],
    ['valid-user-8', { id: 8, username: 'bob', email: 'bob@example.test' }],
  ]);
  const sub2api: Sub2ApiClient = {
    verifyUserToken: async (token) => {
      const profile = profiles.get(token);
      if (!profile) throw new Error('Unauthorized');
      return profile;
    },
    createAndRedeem: async () => undefined,
  };
  const app = express();
  app.use(express.json());
  app.use(cookieParser(config.sessionSecret));
  app.get('/test-csrf', auth.requireUser, (req, res) => res.json({ csrf: req.userSession?.csrfSecret }));
  app.use(createUserRouter({ config, store, auth, sub2api }));
  return { app, store };
}

async function login(agent: request.SuperAgentTest, token: string) {
  const response = await agent.get(`/pay?token=${token}&user_id=999`).expect(302);
  expect(response.headers.location).toBe('/pay');
  const session = response.headers['set-cookie']?.[0];
  expect(session).toBeTruthy();
  return response;
}

async function csrfFor(agent: request.SuperAgentTest): Promise<string> {
  return (await agent.get('/test-csrf').expect(200)).body.csrf;
}

function csrfHeaders(agent: request.SuperAgentTest, csrf: string) {
  return agent.set('Origin', config.baseUrl).set('X-CSRF-Token', csrf);
}

describe('authenticated user order flow', () => {
  const stores: DatabaseStore[] = [];
  afterEach(() => stores.splice(0).forEach((store) => store.close()));

  it('uses the verified profile ID instead of query user_id and hides user_id', async () => {
    const { app, store } = setup(); stores.push(store);
    const agent = request.agent(app);
    await login(agent, 'valid-user-7');
    const csrf = await csrfFor(agent);
    const response = await csrfHeaders(agent, csrf).post('/api/orders').send({ amount_cny: 50 }).expect(201);
    expect(response.body.user_id).toBeUndefined();
    expect(response.body.order_no).toMatch(/^S2P\d{8}[A-F0-9]{8}$/);
    expect(store.findByOrderNo(response.body.order_no)?.userId).toBe(7);
  });

  it('rejects invalid amounts and unauthenticated requests', async () => {
    const { app, store } = setup(); stores.push(store);
    await request(app).post('/api/orders').expect(401);
    const agent = request.agent(app); await login(agent, 'valid-user-7');
    const csrf = await csrfFor(agent);
    for (const amount_cny of [1, 50.5, 999]) {
      await csrfHeaders(agent, csrf).post('/api/orders').send({ amount_cny }).expect(400);
    }
  });

  it('enforces three active orders, ownership, lifecycle state, and trade uniqueness', async () => {
    const { app, store } = setup(); stores.push(store);
    const alice = request.agent(app); await login(alice, 'valid-user-7');
    const csrf = await csrfFor(alice);
    const orders = [] as string[];
    for (let i = 0; i < 3; i += 1) {
      const result = await csrfHeaders(alice, csrf).post('/api/orders').send({ amount_cny: 10 }).expect(201);
      orders.push(result.body.order_no);
    }
    await csrfHeaders(alice, csrf).post('/api/orders').send({ amount_cny: 10 }).expect(409);
    await alice.get(`/api/orders/${orders[0]}`).expect(200);

    const bob = request.agent(app); await login(bob, 'valid-user-8');
    await bob.get(`/api/orders/${orders[0]}`).expect(404);
    const bobCsrf = await csrfFor(bob);
    await csrfHeaders(bob, bobCsrf).post(`/api/orders/${orders[0]}/submit`).send({ trade_no: '20260830ABCDEF12' }).expect(404);
    await csrfHeaders(bob, bobCsrf).post(`/api/orders/${orders[0]}/submit`).send({ trade_no: 'bad' }).expect(404);
    await csrfHeaders(alice, csrf).post(`/api/orders/${orders[0]}/submit`).send({ trade_no: '20260830ABCDEF12' }).expect(200);
    await csrfHeaders(alice, csrf).post(`/api/orders/${orders[0]}/submit`).send({ trade_no: '20260830ABCDEF13' }).expect(409);
    await csrfHeaders(alice, csrf).post(`/api/orders/${orders[1]}/cancel`).expect(200);
    await csrfHeaders(alice, csrf).post(`/api/orders/${orders[1]}/cancel`).expect(409);
    expect(store.findByOrderNo(orders[0])?.status).toBe('pending_review');
  });

  it('persists submitted payment notes for the owner without cross-user disclosure', async () => {
    const { app, store } = setup(); stores.push(store);
    const alice = request.agent(app); await login(alice, 'valid-user-7');
    const aliceCsrf = await csrfFor(alice);
    const created = await csrfHeaders(alice, aliceCsrf)
      .post('/api/orders').send({ amount_cny: 10 }).expect(201);
    const orderNo = created.body.order_no as string;

    const submitted = await csrfHeaders(alice, aliceCsrf)
      .post(`/api/orders/${orderNo}/submit`)
      .send({ trade_no: '20260830NOTE1234', note: 'Paid from my personal account' })
      .expect(200);
    expect(submitted.body.payment_note).toBe('Paid from my personal account');

    const retrieved = await alice.get(`/api/orders/${orderNo}`).expect(200);
    expect(retrieved.body.payment_note).toBe('Paid from my personal account');
    expect(store.findByOrderNo(orderNo)?.paymentNote).toBe('Paid from my personal account');

    const bob = request.agent(app); await login(bob, 'valid-user-8');
    await bob.get(`/api/orders/${orderNo}`).expect(404);
  });

  it('rejects invalid tokens and mutation requests without exact origin/csrf', async () => {
    const { app, store } = setup(); stores.push(store);
    await request(app).get('/pay?token=invalid').expect(401);
    const agent = request.agent(app); await login(agent, 'valid-user-7');
    const csrf = await csrfFor(agent);
    await agent.post('/api/orders').send({ amount_cny: 10 }).expect(403);
    await agent.post('/api/orders').set('Origin', config.baseUrl).set('X-CSRF-Token', 'wrong').send({ amount_cny: 10 }).expect(403);
    expect(csrf).toBeTruthy();
  });
});
