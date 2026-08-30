# Manual Pay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Docker-deployable, secure manual Alipay recharge service for verified Sub2API users.

**Architecture:** A single Express application renders EJS pages and exposes JSON APIs. SQLite stores opaque sessions, immutable orders, and audit logs. An explicit Sub2API client is the sole server-side integration boundary.

**Tech Stack:** Node.js 20, TypeScript, Express, EJS, SQLite with better-sqlite3, Zod, Decimal.js, bcryptjs, Vitest, Supertest, Docker.

## Global Constraints

- Do not read or modify the Sub2API database.
- Use `POST /api/v1/admin/redeem-codes/create-and-redeem` with server-only `x-api-key` and `Idempotency-Key` headers.
- Use `GET /api/v1/user/profile` to derive the real user ID. Never trust query `user_id`.
- Keep JWTs, API keys, password hashes, and session secrets out of logs, pages, URLs after initialization, and Git.
- Store CNY as integer fen and balance values as Decimal strings.
- Make `order_no`, `trade_no`, and `recharge_code` unique in SQLite.
- Atomically claim `pending_review` or `recharge_failed` into `processing` before any recharge request.
- Keep the same recharge code for retries and create a new idempotency key for every attempt.
- Do not automate Alipay verification, scrape Alipay, infer payment from a screenshot, or make browser-to-Sub2API Admin API calls.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/config.ts` | Validated environment configuration. |
| `src/db.ts` | SQLite migrations, prepared queries, and transactions. |
| `src/types.ts` | Shared status, order, profile, and upstream types. |
| `src/logger.ts` | Redacted structured logging. |
| `src/sub2api.ts` | Profile verification and Admin API client. |
| `src/auth.ts` | Opaque sessions, signed cookies, authentication, CSRF, and origin checks. |
| `src/services/orders.ts` | Amount validation, expiry, order creation, proof submission, cancellation. |
| `src/services/recharge.ts` | Approval claim, recharge, rejection, retry, and audit logging. |
| `src/routes/user.ts` | User JSON endpoints. |
| `src/routes/admin.ts` | Admin JSON endpoints and login. |
| `src/server.ts` | Express composition, pages, middleware, static assets, health endpoint. |
| `views/*.ejs`, `public/*` | Server-rendered responsive user and admin interfaces. |
| `migrations/001_initial.sql` | SQLite schema and indexes. |
| `tests/*` | Temporary-SQLite integration tests with a fake Sub2API client. |
| `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md` | Deployment and operating instructions. |

### Task 1: Bootstrap The TypeScript Application

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/types.ts`, `src/config.ts`, `tests/bootstrap.test.ts`, `tests/helpers.ts`

**Interfaces:**
- Produces `npm run dev`, `npm run build`, `npm test`, and `npm run test:coverage`.
- Produces `OrderStatus`, `VerifiedProfile`, `Sub2ApiClient`, and `AppConfig` used by later tasks.

- [ ] **Step 1: Write the failing configuration test**

```ts
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('configuration bootstrap', () => {
  it('parses fixed recharge amounts into integer fen', () => {
    const config = parseConfig({ ...process.env, RECHARGE_AMOUNTS: '10,20,50' });
    expect(config.rechargeAmountsFen).toEqual([1000, 2000, 5000]);
  });
});
```

- [ ] **Step 2: Run it to verify the red state**

Run: `npm test -- bootstrap.test.ts`

Expected: FAIL because `src/config.ts` is absent.

- [ ] **Step 3: Add tooling, dependencies, types, and sample configuration**

Create an ESM `package.json` constrained to Node 20. Add `bcryptjs`, `better-sqlite3`, `cookie-parser`, `decimal.js`, `dotenv`, `ejs`, `express`, `express-rate-limit`, and `zod` as production dependencies. Add TypeScript, tsx, Vitest, Supertest, and type packages as development dependencies.

Use this `tsconfig.json` core configuration:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

Define these exact types in `src/types.ts`:

```ts
export type OrderStatus =
  | 'awaiting_payment' | 'pending_review' | 'processing'
  | 'approved' | 'rejected' | 'recharge_failed' | 'expired';

export interface VerifiedProfile { id: number; username?: string; email?: string; }

export interface Sub2ApiClient {
  verifyUserToken(token: string): Promise<VerifiedProfile>;
  createAndRedeem(input: {
    code: string; userId: number; value: string; notes: string; idempotencyKey: string;
  }): Promise<void>;
}
```

Put all required variables in `.env.example`, including `SUB2API_BASE_URL`, `SUB2API_ADMIN_API_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD_HASH`, `DATABASE_PATH`, `ALIPAY_QR_IMAGE`, `PROCESSING_STALE_MINUTES`, and rate-limit settings. Use placeholder values only.

- [ ] **Step 4: Implement minimal validated configuration**

Export `parseConfig(env: NodeJS.ProcessEnv)` from `src/config.ts`. Use Zod to validate required configuration, parse distinct whole-CNY values to integer fen, and parse a positive Decimal `BALANCE_PER_CNY`.

```ts
const amounts = env.RECHARGE_AMOUNTS.split(',').map((value) => {
  const cny = new Decimal(value.trim());
  if (!cny.isInteger() || cny.lte(0)) throw new Error('Invalid recharge amount');
  return cny.mul(100).toNumber();
});
```

- [ ] **Step 5: Verify the green state**

Run: `npm test -- bootstrap.test.ts && npm run build`

Expected: PASS and a clean TypeScript build.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src/types.ts src/config.ts tests/bootstrap.test.ts tests/helpers.ts
git commit -m "chore: bootstrap manual pay service"
```

### Task 2: Create SQLite Schema And Data Store

**Files:**
- Create: `migrations/001_initial.sql`, `src/db.ts`, `tests/db.test.ts`

**Interfaces:**
- Consumes: `OrderStatus` from `src/types.ts`.
- Produces `DatabaseStore` methods `createSession`, `getSession`, `createOrder`, `findOrderForUser`, `submitTransaction`, `claimRecharge`, `finishRecharge`, `rejectOrder`, `listAdminOrders`, and `writeAuditLog`.

- [ ] **Step 1: Write failing persistence tests**

```ts
it('rejects a transaction number assigned to another order', () => {
  store.createOrder(orderA);
  store.createOrder(orderB);
  store.submitTransaction(orderA.orderNo, 7, '20260830ABCDE', null, null);
  expect(() => store.submitTransaction(orderB.orderNo, 8, '20260830ABCDE', null, null))
    .toThrow(/UNIQUE constraint failed: orders.trade_no/);
});

it('allows exactly one recharge claim', () => {
  store.createOrder(pendingOrder);
  expect(store.claimRecharge(pendingOrder.orderNo, now)).toBeTruthy();
  expect(store.claimRecharge(pendingOrder.orderNo, now)).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify the red state**

Run: `npm test -- db.test.ts`

Expected: FAIL because `createDatabaseStore` is not exported.

- [ ] **Step 3: Create the migration**

Create `orders` with the following required fields and constraints:

```sql
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  username_snapshot TEXT,
  email_snapshot TEXT,
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  balance_value TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  trade_no TEXT UNIQUE,
  paid_at TEXT,
  status TEXT NOT NULL,
  admin_note TEXT,
  rejection_reason TEXT,
  recharge_code TEXT NOT NULL UNIQUE,
  recharge_attempts INTEGER NOT NULL DEFAULT 0,
  last_recharge_error TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  processing_at TEXT,
  reviewed_at TEXT,
  approved_at TEXT,
  rejected_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_orders_user_status ON orders(user_id, status);
CREATE INDEX idx_orders_status_created ON orders(status, created_at DESC);
```

Also create `sessions` with a hashed opaque token primary key, actor type, optional Sub2API snapshots, CSRF secret, and expiry. Create `admin_audit_logs` with admin name, action, order number, old/new statuses, IP, user agent, sanitized detail, and timestamp.

- [ ] **Step 4: Implement prepared, conditional store queries**

Open SQLite with foreign keys, WAL, and a busy timeout. Apply migrations under a transaction. `claimRecharge` must be a conditional update, increment attempts, then return the newly claimed row:

```ts
const claim = db.prepare(`
  UPDATE orders
  SET status = 'processing', processing_at = ?, recharge_attempts = recharge_attempts + 1
  WHERE order_no = ? AND status IN ('pending_review', 'recharge_failed')
`);
if (claim.run(now, orderNo).changes !== 1) return null;
return findByOrderNo.get(orderNo) as Order;
```

`finishRecharge` may update only an order still in `processing`; it must never change user, amount, transaction number, or recharge code.

- [ ] **Step 5: Verify the green state**

Run: `npm test -- db.test.ts`

Expected: PASS. The test demonstrates both unique trade numbers and single-claim behavior.

- [ ] **Step 6: Commit**

```bash
git add migrations/001_initial.sql src/db.ts tests/db.test.ts
git commit -m "feat: add sqlite order persistence"
```

### Task 3: Add Safe Logging, Sub2API Client, And Local Sessions

**Files:**
- Create: `src/logger.ts`, `src/sub2api.ts`, `src/auth.ts`, `tests/sub2api.test.ts`, `tests/auth.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, `DatabaseStore`, `VerifiedProfile`, and `Sub2ApiClient`.
- Produces `createSub2ApiClient`, `createAuth`, `requireUser`, `requireAdmin`, `requireCsrfAndOrigin`, and `sanitizeForLog`.

- [ ] **Step 1: Write failing client and session tests**

```ts
it('sends a server-only key and idempotency key to create-and-redeem', async () => {
  await client.createAndRedeem({ code: 'manual_S2P1', userId: 9, value: '50', notes: 'test', idempotencyKey: 'manual-pay-S2P1-1' });
  expect(fetch).toHaveBeenCalledWith(
    'https://sub.example/api/v1/admin/redeem-codes/create-and-redeem',
    expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'admin-secret', 'Idempotency-Key': 'manual-pay-S2P1-1' }) }),
  );
});

it('redacts sensitive keys before logging', () => {
  expect(sanitizeForLog({ token: 'jwt', authorization: 'Bearer jwt', order_no: 'S2P1' }))
    .toEqual({ token: '[REDACTED]', authorization: '[REDACTED]', order_no: 'S2P1' });
});
```

- [ ] **Step 2: Run the tests to verify the red state**

Run: `npm test -- sub2api.test.ts auth.test.ts`

Expected: FAIL because these modules do not exist.

- [ ] **Step 3: Implement upstream calls and recursive redaction**

`verifyUserToken` must call `/api/v1/user/profile` with `Authorization: Bearer <token>` and map only profile fields. It throws `UnauthorizedError` on 401/403. `createAndRedeem` POSTs the documented body and headers. A 2xx response succeeds; a 401/403 throws `AdminCredentialError`; every other error is an `UpstreamError` containing only HTTP status and a bounded, redacted message.

Use a recursive `sanitizeForLog` function that replaces values of case-insensitive keys matching `token`, `authorization`, `x-api-key`, `password`, `secret`, or `key` with `[REDACTED]` before writing logs.

- [ ] **Step 4: Implement opaque sessions and mutation guards**

Generate a 32-byte random session token, persist only its SHA-256 hash, and set the raw value as a signed cookie. Include a random CSRF secret in the session record. `requireUser` and `requireAdmin` require an unexpired matching actor session. Mutation routes require `X-CSRF-Token` and an Origin equal to `BASE_URL`.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- sub2api.test.ts auth.test.ts && npm run build`

Expected: PASS, with no secret in captured logs or returned error detail.

```bash
git add src/logger.ts src/sub2api.ts src/auth.ts tests/sub2api.test.ts tests/auth.test.ts
git commit -m "feat: add secure upstream client and sessions"
```

### Task 4: Implement User Authentication And Order APIs

**Files:**
- Create: `src/services/orders.ts`, `src/routes/user.ts`, `tests/user-orders.test.ts`
- Modify: `src/db.ts`

**Interfaces:**
- Consumes: `DatabaseStore`, `AppConfig`, authenticated user session data, and `Decimal`.
- Produces `createOrder`, `submitPaymentProof`, `cancelOrder`, `getUserOrder`, `listUserOrders`, and `createUserRouter`.

- [ ] **Step 1: Write failing user order integration tests**

Use a fake Sub2API profile client and test the HTTP interface:

```ts
it('uses the profile ID instead of a manipulated query user_id', async () => {
  const agent = request.agent(app);
  await agent.get('/pay?user_id=999&token=valid-user-7').expect(302);
  const response = await agent.post('/api/orders').set(csrfHeaders(agent)).send({ amount_cny: 50 }).expect(201);
  expect(response.body.user_id).toBeUndefined();
  expect(store.findByOrderNo(response.body.order_no)?.userId).toBe(7);
});

it.each([1, 50.5, 999])('rejects amount %s outside the whitelist', async (amount_cny) => {
  await authenticatedAgent.post('/api/orders').set(csrfHeaders(authenticatedAgent)).send({ amount_cny }).expect(400);
});

it('returns 409 when the same trade number is submitted twice', async () => {
  await submitOrderForUser(7, firstOrder, '20260830ABC');
  await submitOrderForUser(8, secondOrder, '20260830ABC').expect(409);
});
```

Also cover invalid token (401), the three-active-order limit (409), cross-user order lookup (404), state-protected proof submission, and cancellation only from `awaiting_payment`.

- [ ] **Step 2: Run the user order suite to verify the red state**

Run: `npm test -- user-orders.test.ts`

Expected: FAIL because `/pay` and `/api/orders` are absent.

- [ ] **Step 3: Implement order validation and lifecycle**

Generate a public order number with the UTC date and random bytes:

```ts
export function createOrderNo(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `S2P${date}${randomBytes(4).toString('hex').toUpperCase()}`;
}
```

Accept only configured `amount_fen` values. Count `awaiting_payment`, `pending_review`, `processing`, and `recharge_failed` against the user limit. Calculate the immutable balance value exactly:

```ts
const balanceValue = new Decimal(amountFen).div(100).mul(config.balancePerCny).toFixed();
```

Expire only overdue `awaiting_payment` orders. Normalize transaction numbers with `trim()`, require `^[A-Za-z0-9_-]{8,128}$`, and bound optional note length at 500 characters.

- [ ] **Step 4: Implement the initialization and user API routes**

`GET /pay?token=...` verifies the token, creates the local user session from the returned profile, then returns a 302 to `/pay`. It ignores the query `user_id` entirely. Rendering and APIs without a session receive a controlled authentication error.

Mount authenticated handlers as follows:

```ts
router.post('/api/orders', requireUser, requireCsrfAndOrigin, createOrderHandler);
router.post('/api/orders/:orderNo/submit', requireUser, requireCsrfAndOrigin, submitHandler);
router.post('/api/orders/:orderNo/cancel', requireUser, requireCsrfAndOrigin, cancelHandler);
router.get('/api/orders/:orderNo', requireUser, getOwnedOrderHandler);
```

User JSON must not expose user IDs, session material, CSRF values, or upstream details.

- [ ] **Step 5: Verify the green state**

Run: `npm test -- user-orders.test.ts`

Expected: PASS. Assert captured logs never contain `valid-user-7` or a bearer token.

- [ ] **Step 6: Commit**

```bash
git add src/services/orders.ts src/routes/user.ts src/db.ts tests/user-orders.test.ts
git commit -m "feat: add authenticated user order flow"
```

### Task 5: Implement Administrator Review And Recharge

**Files:**
- Create: `src/services/recharge.ts`, `src/routes/admin.ts`, `tests/admin-recharge.test.ts`
- Modify: `src/db.ts`

**Interfaces:**
- Consumes: `DatabaseStore`, `Sub2ApiClient`, and administrator session identity.
- Produces `approveOrder`, `rejectOrder`, `retryOrder`, and `createAdminRouter`.

- [ ] **Step 1: Write failing administrator tests**

```ts
it('allows only one of two concurrent approvals to recharge', async () => {
  const [first, second] = await Promise.all([
    admin.post(`/api/admin/orders/${orderNo}/approve`).set(csrf).send({}),
    admin.post(`/api/admin/orders/${orderNo}/approve`).set(csrf).send({}),
  ]);
  expect([first.status, second.status].sort()).toEqual([200, 409]);
  expect(fakeSub2Api.redeemCalls).toHaveLength(1);
  expect(store.findByOrderNo(orderNo)?.status).toBe('approved');
});

it('keeps code and increments idempotency attempt on retry', async () => {
  fakeSub2Api.failOnce(new Error('timeout'));
  await approvePending(orderNo).expect(502);
  await retryFailed(orderNo).expect(200);
  expect(fakeSub2Api.redeemCalls.map((call) => call.code)).toEqual([`manual_${orderNo}`, `manual_${orderNo}`]);
  expect(fakeSub2Api.redeemCalls.map((call) => call.idempotencyKey)).toEqual([`manual-pay-${orderNo}-1`, `manual-pay-${orderNo}-2`]);
});
```

Cover unauthenticated admin access (401), wrong password and login rate limit (401/429), rejected-order approval (409 without an upstream call), second approval (409), timeout (`recharge_failed`), idempotent success (`approved`), and upstream 401/403 with the Admin API key-check operator message.

- [ ] **Step 2: Run the recharge tests to verify the red state**

Run: `npm test -- admin-recharge.test.ts`

Expected: FAIL because the routes and service are absent.

- [ ] **Step 3: Implement login, search, and rejection**

Use `bcrypt.compare` against the configured hash. Log successful and unsuccessful administrator login attempts without credentials. Apply an IP-keyed `express-rate-limit` limiter of five attempts per 15 minutes. Search must bound the term to 128 characters and pass it as a parameterized `LIKE` across order number, user ID text, email snapshot, and transaction number.

Rejection may transition only a `pending_review` order to `rejected`; it records reason, administrator note, and audit log inside one transaction and has no reference to `Sub2ApiClient`.

- [ ] **Step 4: Implement idempotent approval and retry**

Call `store.claimRecharge` before the external request. Return HTTP 409 with no upstream call when it returns null. Build the upstream request only from the claimed row:

```ts
await sub2api.createAndRedeem({
  code: claimed.rechargeCode,
  userId: claimed.userId,
  value: claimed.balanceValue,
  notes: `manual alipay recharge ${claimed.orderNo}`,
  idempotencyKey: `manual-pay-${claimed.orderNo}-${claimed.rechargeAttempts}`,
});
```

On success, atomically mark `approved` and write an `approve` or `retry` audit row. On failure, atomically mark `recharge_failed`, write a bounded sanitized error, and audit it. A stale `processing` order after a restart is released only after `PROCESSING_STALE_MINUTES`; retrying it remains safe because the recharge code is unchanged.

- [ ] **Step 5: Verify the green state**

Run: `npm test -- admin-recharge.test.ts`

Expected: PASS, with exactly one upstream call in the concurrent case.

- [ ] **Step 6: Commit**

```bash
git add src/services/recharge.ts src/routes/admin.ts src/db.ts tests/admin-recharge.test.ts
git commit -m "feat: add audited idempotent recharge approval"
```

### Task 6: Build The Server-Rendered User Interface

**Files:**
- Create: `src/server.ts`, `views/layout.ejs`, `views/pay.ejs`, `views/orders.ejs`
- Create: `public/app.css`, `public/pay.js`, `tests/pages.test.ts`

**Interfaces:**
- Consumes: user and administrator routers, auth middleware, and the configured QR path.
- Produces `createApp(dependencies)` for both production startup and Supertest.

- [ ] **Step 1: Write failing page tests**

```ts
it('redirects a verified token to a clean pay URL and never echoes it', async () => {
  const response = await request(app).get('/pay?user_id=99&token=top-secret').expect(302);
  expect(response.headers.location).toBe('/pay');
  expect(response.text).not.toContain('top-secret');
});

it('serves the configured QR image only to authenticated pay users', async () => {
  await request(app).get('/assets/alipay-qr.png').expect(404);
  await authenticatedAgent.get('/pay').expect(/Alipay/);
});
```

- [ ] **Step 2: Run page tests to verify the red state**

Run: `npm test -- pages.test.ts`

Expected: FAIL because `createApp` is absent.

- [ ] **Step 3: Compose Express and page routes**

Configure EJS, `express.urlencoded`, `express.json({ limit: '32kb' })`, cookie parsing, redacted errors, static assets, user routes, administrator routes, and `GET /health`. The error handler maps validation/auth/conflict errors to controlled JSON or pages and never returns a stack.

Serve the QR only through an authenticated handler using `ALIPAY_QR_IMAGE` and `image/png`; never mount the data directory as a static directory.

- [ ] **Step 4: Implement the responsive payment and history pages**

Use a constrained operational layout with accessible labels, native controls, stable table overflow, and no checkout impersonation. The payment page shows identity, fixed amount controls, current order, QR image, transaction form, and human-review warning. The history page lists only the session user's records. Add the CSRF value as `<meta name="csrf-token">`, never in a URL.

`public/pay.js` uses same-origin credentials and `X-CSRF-Token`; it displays controlled errors and polls an active order every 15 seconds. It must not use local storage for any credential or user identity.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- pages.test.ts && npm run build`

Expected: PASS and fixture HTML excludes incoming JWT values.

```bash
git add src/server.ts views public tests/pages.test.ts
git commit -m "feat: add manual recharge user interface"
```

### Task 7: Build The Administrator Interface And Security Tests

**Files:**
- Create: `views/admin-login.ejs`, `views/admin-orders.ejs`, `public/admin.js`, `tests/security.test.ts`
- Modify: `src/server.ts`, `public/app.css`

**Interfaces:**
- Consumes: `createApp` and the administrator router.
- Produces administrator login and review pages backed by the API from Task 5.

- [ ] **Step 1: Write failing page-flow and CSRF tests**

```ts
it('rejects an admin mutation with an invalid origin before it can recharge', async () => {
  await admin.post(`/api/admin/orders/${orderNo}/approve`)
    .set('Origin', 'https://attacker.example')
    .set('X-CSRF-Token', csrf)
    .expect(403);
  expect(fakeSub2Api.redeemCalls).toHaveLength(0);
});

it('renders an approval confirmation with the amount and recipient', async () => {
  const page = await authenticatedAdmin.get('/admin').expect(200);
  expect(page.text).toContain('Confirm receipt and recharge');
  expect(page.text).toContain('Verify the Alipay payment before approving');
});
```

- [ ] **Step 2: Run security tests to verify the red state**

Run: `npm test -- security.test.ts`

Expected: FAIL because administrator pages are absent.

- [ ] **Step 3: Implement administrator views**

Render a login page for unauthenticated `/admin` requests and a review table for authenticated requests. Default to `pending_review` and `recharge_failed`; support order, user ID, email, and transaction-number search plus status filtering. Display amount, balance value, transaction number, status, timestamps, and actions.

Use a native `<dialog>` confirmation before approval. It must repeat the CNY amount and recipient. Make rejection reason bounded and required in the UI. Render retry only for `recharge_failed` rows.

- [ ] **Step 4: Implement browser-side mutation behavior**

`public/admin.js` uses same-origin credentials and the meta CSRF value. Login, approve, reject, retry, and logout all use POST. Destructive actions are not links or GET requests. No response, view model, script, or HTML may contain the Sub2API Admin API key.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- security.test.ts && npm test && npm run build`

Expected: PASS. Confirm origin rejection, missing authentication, bad CSRF, and single-call concurrency behavior remain covered.

```bash
git add views/admin-login.ejs views/admin-orders.ejs public/admin.js public/app.css src/server.ts tests/security.test.ts
git commit -m "feat: add secure admin review interface"
```

### Task 8: Containerize, Document, And Verify

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `README.md`
- Create: `deploy/nginx.conf.example`, `deploy/Caddyfile.example`, `data/.gitkeep`, `tests/deployment.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `npm run build`, `npm start`, `.env`, and the `data` bind mount.
- Produces a reproducible production deployment and complete operator documentation.

- [ ] **Step 1: Write failing deployment artifact tests**

```ts
it('documents the required data mount and healthcheck', () => {
  const compose = readFileSync('docker-compose.yml', 'utf8');
  expect(compose).toContain('./data:/app/data');
  expect(compose).toContain('/health');
});

it('keeps runtime secrets out of the image context', () => {
  expect(readFileSync('.gitignore', 'utf8')).toContain('.env');
  expect(readFileSync('.dockerignore', 'utf8')).toContain('.env');
});
```

- [ ] **Step 2: Run deployment tests to verify the red state**

Run: `npm test -- deployment.test.ts`

Expected: FAIL because Docker and deployment files are absent.

- [ ] **Step 3: Add production Docker artifacts**

Use a multi-stage `node:20-bookworm-slim` Dockerfile. Build native dependencies in the build stage, compile TypeScript, copy production dependencies and `dist`, then run as a non-root user. `.dockerignore` excludes `.env`, `.git`, `data/*.sqlite`, QR images, coverage, test artifacts, and `node_modules`.

Compose loads `.env`, maps only `127.0.0.1:3000:3000` by default, mounts `./data:/app/data`, sets `restart: unless-stopped`, and defines this health check:

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
  interval: 30s
  timeout: 5s
  retries: 3
```

- [ ] **Step 4: Write operator documentation**

The README must document: purpose, architecture, every environment variable, bcrypt hash generation, placement of `data/alipay-qr.png`, Docker startup, Nginx and Caddy TLS proxy examples, `purchase_subscription_url` setup, Admin API key configuration, verified-user testing, mocked recharge testing, SQLite backups using `.backup`, upgrade procedure, `recharge_failed` recovery, and security warnings. State that production HTTPS is required for secure cookies and QR replacement requires no code change.

- [ ] **Step 5: Verify artifacts and container build**

Run: `npm test && npm run build && docker compose config && docker build -t manual-pay:local .`

Expected: tests and TypeScript build pass, Compose renders, and Docker builds without copying `.env` or data secrets.

- [ ] **Step 6: Smoke-test the container**

Run: `docker compose up -d --build`

Run: `curl --fail http://127.0.0.1:3000/health`

Run: `docker compose down`

Expected: health returns JSON with `ok` and Compose stops cleanly.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml README.md deploy data/.gitkeep .gitignore tests/deployment.test.ts
git commit -m "docs: add manual pay deployment guide"
```

## Plan Self-Review

- **Spec coverage:** Tasks 1-5 cover identity, persistence, status transitions, unique keys, auditing, rate limits, Sub2API integration, errors, retry, and concurrency. Tasks 6-7 provide the payment and administrator workflows. Task 8 supplies deployment, reverse proxies, health checks, and operations documentation.
- **Placeholder scan:** Every task names the exact files, interfaces, state changes, test cases, commands, and expected result. No deferred requirement remains.
- **Interface consistency:** The store creates immutable orders and atomic claims; only `recharge.ts` calls `createAndRedeem`; routes call services rather than SQL; `createApp` composes all routers and templates.
