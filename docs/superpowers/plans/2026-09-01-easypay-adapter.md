# EasyPay Compatibility Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a signed EasyPay-compatible payment adapter while preserving the existing manual Alipay recharge flow.

**Architecture:** Keep the current session-based `/pay` flow and `alipay_manual` recharge path unchanged. Add an isolated EasyPay router and service layer that creates `easypay_alipay` orders, exposes `/mapi.php`, `/api.php`, and `/notify.php`, and lets admin approval notify Sub2API instead of redeeming directly. Use a migration to add external-order and callback fields, with idempotent writes and callback retries.

**Tech Stack:** TypeScript, Express 5, better-sqlite3, Decimal.js, Zod, Vitest, Supertest.

## Global Constraints

- Do not expose `SUB2API_ADMIN_API_KEY`, `SESSION_SECRET`, or `EASYPAY_KEY` to browsers, responses, or logs.
- Existing `alipay_manual` behavior and tests must remain compatible.
- EasyPay requests must validate PID, shared-key signature, amount, and bounded input lengths.
- EasyPay confirmation remains manual; no Alipay scraping or browser automation.
- Every production behavior change starts with a failing test.

---

### Task 1: EasyPay configuration and signing utilities

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Create: `src/easypay.ts`
- Test: `tests/easypay-signing.test.ts`

**Interfaces:**
- Produce `EasyPayConfig` with `pid`, `key`, `qrUrl`, and `enabled` fields.
- Produce `buildEasyPaySign(params: Record<string, string>, key: string): string` and `verifyEasyPaySign(...)`.
- Extend `AppConfig` with `easyPay` and parse `EASYPAY_ENABLED`, `EASYPAY_PID`, `EASYPAY_KEY`, and `EASYPAY_QR_CONTENT`.

- [ ] **Step 1: Write the failing tests** for deterministic parameter sorting, exclusion of `sign`/`sign_type`, empty-value exclusion, constant-time verification, and config parsing.
- [ ] **Step 2: Run `npm test -- tests/easypay-signing.test.ts`** and confirm failure because the utility/config fields do not exist.
- [ ] **Step 3: Implement the minimal signer and Zod config additions.** Use UTF-8 byte sorting and `crypto.timingSafeEqual` for signature comparison; reject malformed signatures without throwing from the HTTP layer.
- [ ] **Step 4: Run the focused test and `npm run build`**; expect PASS and a clean TypeScript build.
- [ ] **Step 5: Commit** with `git add src/types.ts src/config.ts src/easypay.ts .env.example tests/easypay-signing.test.ts && git commit -m "feat: add easypay configuration and signing"`.

### Task 2: Persist EasyPay order metadata and callback state

**Files:**
- Create: `migrations/003_add_easypay_fields.sql`
- Modify: `src/db.ts`
- Modify: `src/types.ts`
- Test: `tests/easypay-db.test.ts`

**Interfaces:**
- Extend `Order` with `externalOrderNo`, `notifyUrl`, `returnUrl`, `externalTradeNo`, `callbackStatus`, and `callbackAttempts`.
- Extend `NewOrder` with optional EasyPay fields.
- Add `findByExternalOrderNo`, `markEasyPayPaid`, and `recordEasyPayCallbackAttempt` to `DatabaseStore`.

- [ ] **Step 1: Write failing migration/store tests** covering migration application, unique external order numbers, round-trip mapping, paid-state transition, and callback-attempt increments.
- [ ] **Step 2: Run `npm test -- tests/easypay-db.test.ts`** and verify failures identify missing schema/API.
- [ ] **Step 3: Add migration 003 and prepared statements.** Keep existing `trade_no` semantics for manual user-submitted transaction numbers; EasyPay uses `external_trade_no`.
- [ ] **Step 4: Run focused DB tests plus `npm test -- tests/db.test.ts`** and confirm both pass.
- [ ] **Step 5: Commit** with `git add migrations/003_add_easypay_fields.sql src/db.ts src/types.ts tests/easypay-db.test.ts && git commit -m "feat: persist easypay order metadata"`.

### Task 3: Implement EasyPay create and query services

**Files:**
- Create: `src/services/easypay.ts`
- Test: `tests/easypay-service.test.ts`

**Interfaces:**
- `createEasyPayOrder(input: CreateEasyPayOrderInput): EasyPayCreateResponse`.
- `queryEasyPayOrder(input: QueryEasyPayOrderInput): EasyPayQueryResponse`.
- Both functions depend on `DatabaseStore`, `AppConfig`, and the current clock.

- [ ] **Step 1: Write failing service tests** for valid creation, amount rejection, signature rejection, duplicate `out_trade_no` idempotency, and status mapping (`WAITING`, `SUCCESS`, `FAILED`).
- [ ] **Step 2: Run `npm test -- tests/easypay-service.test.ts`** and verify expected failures.
- [ ] **Step 3: Implement bounded parsing, configured amount checks in fen, `easypay_alipay` order creation, and QR response generation from `easyPay.qrUrl`.
- [ ] **Step 4: Run the focused tests and refactor only after green.**
- [ ] **Step 5: Commit** with `git add src/services/easypay.ts tests/easypay-service.test.ts && git commit -m "feat: add easypay order services"`.

### Task 4: Add EasyPay HTTP routes and public QR handling

**Files:**
- Create: `src/routes/easypay.ts`
- Modify: `src/server.ts`
- Test: `tests/easypay-routes.test.ts`

**Interfaces:**
- Export `createEasyPayRouter(options: { config: AppConfig; store: DatabaseStore }): Router`.
- Routes return EasyPay-compatible JSON and never create a local user/admin session.

- [ ] **Step 1: Write failing Supertest cases** for `POST /mapi.php`, `POST /api.php`, disabled-mode rejection, malformed form/body handling, and absolute QR response.
- [ ] **Step 2: Run the route test and confirm 404/500 failures before the router is mounted.
- [ ] **Step 3: Mount the router before the authenticated user routes.** Use `express.urlencoded` and JSON parsing already configured by `server.ts`; normalize string fields and return protocol-safe error JSON.
- [ ] **Step 4: Add a controlled public QR route only when EasyPay is enabled, then run focused route tests and existing page tests.
- [ ] **Step 5: Commit** with `git add src/routes/easypay.ts src/server.ts tests/easypay-routes.test.ts && git commit -m "feat: expose easypay create and query endpoints"`.

### Task 5: Notify Sub2API after EasyPay approval

**Files:**
- Modify: `src/types.ts`
- Create: `src/services/easypay-notify.ts`
- Modify: `src/routes/admin.ts`
- Test: `tests/easypay-notify.test.ts`
- Test: `tests/admin-recharge.test.ts`

**Interfaces:**
- Extend `Sub2ApiClient` with `notifyPayment(input: { notifyUrl: string; tradeNo: string; outTradeNo: string; amountCny: string; }): Promise<void>` only if the callback transport is kept in the client abstraction; otherwise inject a `fetch`-based notifier into the service.
- Produce `approveEasyPayOrder` and `retryEasyPayNotification` with the same compare-and-swap semantics as existing recharge actions.

- [ ] **Step 1: Write failing tests** proving EasyPay approval sends one signed callback, repeated approval is rejected, callback failure is retryable, and `alipay_manual` still calls `createAndRedeem`.
- [ ] **Step 2: Run focused tests and confirm failures before branching admin behavior.
- [ ] **Step 3: Implement notification payload/signature, bounded timeout handling, callback-attempt persistence, and `payment_method` branching in the admin router/service.
- [ ] **Step 4: Run `npm test -- tests/easypay-notify.test.ts tests/admin-recharge.test.ts` and then the full suite.
- [ ] **Step 5: Commit** with `git add src/types.ts src/services/easypay-notify.ts src/routes/admin.ts tests/easypay-notify.test.ts tests/admin-recharge.test.ts && git commit -m "feat: notify sub2api for easypay approvals"`.

### Task 6: Documentation, deployment config, and full verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT_zh-CN.md`
- Test: `tests/config.test.ts` or the existing config/bootstrap coverage file

- [ ] **Step 1: Add failing config/bootstrap assertions** for the new environment variables and disabled-by-default behavior.
- [ ] **Step 2: Implement documentation and example values** including EasyPay PID/key, QR URL, reverse-proxy path requirements, and the manual-confirmation limitation.
- [ ] **Step 3: Run `npm test`, `npm run build`, `docker compose config`, and `git diff --check`.
- [ ] **Step 4: Review that no secret appears in browser assets, rendered HTML, logs, or test snapshots.
- [ ] **Step 5: Commit** only the implementation documentation/config changes; preserve unrelated working-tree edits.

## Self-review

- Spec coverage: configuration/signing (Task 1), persistence (Task 2), create/query behavior (Task 3), HTTP exposure and QR access (Task 4), admin callback/idempotency (Task 5), and deployment/testing documentation (Task 6) are all covered.
- Placeholder scan: no TBD/TODO implementation steps; each task names files, interfaces, tests, and commands.
- Type consistency: `EasyPayConfig`, `DatabaseStore` additions, service inputs/outputs, and router options are defined before consumers.
