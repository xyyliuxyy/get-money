import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Decimal } from 'decimal.js';
import { createAuth } from '../src/auth.js';
import { createDatabaseStore, type DatabaseStore } from '../src/db.js';
import { createApp } from '../src/server.js';
import type { AppConfig, Sub2ApiClient } from '../src/types.js';

const stores: DatabaseStore[] = [];
const temporaryDirectories: string[] = [];

function makeConfig(qrPath: string, userAuthMax = 10): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    baseUrl: 'http://localhost:3000',
    sub2apiBaseUrl: 'https://sub2api.example.test',
    sub2apiAdminApiKey: 'not-used',
    sessionSecret: 'test-session-secret-that-is-long-enough',
    sessionTtlHours: 24,
    adminUsername: 'admin',
    adminPasswordHash: 'not-used',
    databasePath: ':memory:',
    alipayQrImage: qrPath,
    rechargeAmountsFen: [1000, 5000],
    balancePerCny: new Decimal('1'),
    orderExpireHours: 24,
    processingStaleMinutes: 15,
    trustProxyHops: 1,
    rateLimits: {
      userAuth: { windowMs: 60_000, max: userAuthMax },
      orderCreate: { windowMs: 60_000, max: 10 },
      orderSubmit: { windowMs: 60_000, max: 10 },
      adminLogin: { windowMs: 60_000, max: 5 },
    },
  };
}

function setup(userAuthMax = 10) {
  const directory = mkdtempSync(join(tmpdir(), 'manual-pay-page-'));
  temporaryDirectories.push(directory);
  const qrPath = join(directory, 'alipay-qr.png');
  writeFileSync(qrPath, Buffer.from('not-a-real-png'));

  const config = makeConfig(qrPath, userAuthMax);
  const store = createDatabaseStore(':memory:');
  stores.push(store);
  const auth = createAuth(config, store);
  const sub2api: Sub2ApiClient = {
    async verifyUserToken(token) {
      if (token === 'top-secret') return { id: 7, username: 'alice', email: 'alice@example.test' };
      if (token === 'second-secret') return { id: 8, username: 'bob', email: 'bob@example.test' };
      throw new Error('Unauthorized');
    },
    async createAndRedeem() {
      return undefined;
    },
  };
  return { app: createApp({ config, store, auth, sub2api }), config };
}

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe('server-rendered user pages', () => {
  it('redirects a verified token to a clean pay URL and never echoes it', async () => {
    const { app } = setup();

    const response = await request(app).get('/pay?user_id=99&token=top-secret').expect(302);

    expect(response.headers.location).toBe('/pay');
    expect(response.text).not.toContain('top-secret');
  });

  it('serves the configured QR image only to authenticated pay users', async () => {
    const { app } = setup();
    const authenticatedAgent = request.agent(app);

    await request(app).get('/assets/alipay-qr.png').expect(404);
    await authenticatedAgent.get('/pay?token=top-secret').expect(302);
    await authenticatedAgent.get('/pay').expect(/Alipay/);
    await authenticatedAgent.get('/assets/alipay-qr.png')
      .expect('Content-Type', /image\/png/)
      .expect(200);
  });

  it('renders a session-scoped order history and keeps csrf material out of URLs', async () => {
    const { app } = setup();
    const authenticatedAgent = request.agent(app);

    await authenticatedAgent.get('/pay?token=top-secret').expect(302);
    const response = await authenticatedAgent.get('/orders').expect(200);

    expect(response.text).toContain('订单记录');
    expect(response.text).toContain('csrf-token');
    expect(response.text).not.toMatch(/csrf[^>]*=["'][^"']+\?/i);
  });

  it('uses distinct forwarded clients when one proxy hop is configured', async () => {
    const { app } = setup(1);

    await request(app).get('/pay?token=top-secret').set('X-Forwarded-For', '198.51.100.10').expect(302);
    await request(app).get('/pay?token=second-secret').set('X-Forwarded-For', '198.51.100.11').expect(302);
    await request(app).get('/pay?token=top-secret').set('X-Forwarded-For', '198.51.100.10').expect(429);
  });
});
