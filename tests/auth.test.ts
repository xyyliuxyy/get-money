import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createDatabaseStore } from '../src/db.js';
import { createAuth } from '../src/auth.js';

const config = {
  baseUrl: 'http://localhost:3000',
  sessionSecret: 'test-session-secret-that-is-long-enough',
  sessionTtlHours: 24,
  nodeEnv: 'test',
} as any;

describe('local sessions and request guards', () => {
  it('creates an opaque user session and enforces csrf and origin on mutations', async () => {
    const store = createDatabaseStore(':memory:');
    const auth = createAuth(config, store);
    const app = express();
    app.use(cookieParser(config.sessionSecret));
    app.get('/start', (_req, res) => {
      const session = auth.createUserSession(res, { id: 7, username: 'alice', email: 'a@example.test' });
      res.json({ csrf: session.csrfSecret });
    });
    app.post('/mutate', auth.requireUser, auth.requireCsrfAndOrigin, (_req, res) => res.sendStatus(204));

    const agent = request.agent(app);
    const started = await agent.get('/start').expect(200);
    const csrf = started.body.csrf;
    expect(started.headers['set-cookie'][0]).not.toContain('alice');
    await agent.post('/mutate').set('Origin', config.baseUrl).set('X-CSRF-Token', csrf).expect(204);
    await agent.post('/mutate').set('Origin', 'https://attacker.example').set('X-CSRF-Token', csrf).expect(403);
    await agent.post('/mutate').set('Origin', config.baseUrl).expect(403);
    store.close();
  });

  it('requires the matching actor type for user and admin middleware', async () => {
    const store = createDatabaseStore(':memory:');
    const auth = createAuth(config, store);
    const app = express();
    app.use(cookieParser(config.sessionSecret));
    app.get('/admin-start', (_req, res) => { auth.createAdminSession(res, 'admin'); res.sendStatus(204); });
    app.get('/user', auth.requireUser, (_req, res) => res.sendStatus(204));
    app.get('/admin', auth.requireAdmin, (_req, res) => res.sendStatus(204));
    const agent = request.agent(app);
    await agent.get('/admin-start').expect(204);
    await agent.get('/user').expect(401);
    await agent.get('/admin').expect(204);
    store.close();
  });
});
