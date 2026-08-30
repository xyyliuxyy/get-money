# Manual Pay Design

## Goal

Build an independent Node.js service that lets a verified Sub2API user create
a fixed-amount personal Alipay recharge order, submit a payment transaction
number, and receive a balance recharge only after an administrator manually
verifies receipt.

The service must not modify the Sub2API database, automate Alipay payment
verification, or expose the Sub2API Admin API key to a browser.

## Architecture

The application is a single TypeScript/Express service. It serves EJS pages
and JSON APIs, persists its state in SQLite through `better-sqlite3`, and
uses the Sub2API HTTP APIs only from server-side code.

The source is split by responsibility:

- `config` parses and validates environment configuration.
- `db` applies SQLite migrations and exposes prepared, transactional queries.
- `sub2api` validates an incoming user token against the profile API and calls
  the Admin API for recharge.
- `auth` creates and validates user and administrator sessions.
- `services/orders` owns validation, state transitions, and order creation.
- `services/recharge` owns the compare-and-swap processing claim and final
  recharge outcome.
- user and admin route modules enforce authorization and render their pages.

No browser code holds a Sub2API token after the initial redirect, an Admin API
key, or a user ID used as an authority decision.

## Authentication

`GET /pay` accepts the short-lived `token` query value sent by Sub2API. The
server calls `GET /api/v1/user/profile` with that token, ignores the query
`user_id`, saves the returned ID and display snapshots in a local persistent
session, and redirects to the clean `/pay` URL. Tokens are neither persisted
nor logged.

Subsequent user APIs require the local session cookie. Session cookies are
HttpOnly, Secure in production, SameSite=Lax, signed, and expire according to
`SESSION_TTL_HOURS`.

Administrators log in with a configured username and bcrypt password hash.
They receive a separate local session. Every state-changing request validates
the Origin header, a CSRF token, and the authenticated session. Login, order
creation, and payment-proof submission have route-specific rate limits.

## Data Model

SQLite migrations create these tables:

- `sessions`: opaque session ID, actor type, Sub2API user ID when applicable,
  user display snapshots, CSRF secret, creation time, and expiry time.
- `orders`: unique public order number, immutable user ID and snapshots,
  `amount_fen`, Decimal-string balance value, generic `payment_method`,
  unique transaction number, status, administrator notes, unique recharge
  code, retry metadata, timestamps, and expiry time.
- `admin_audit_logs`: administrator, action, order number, prior and next
  status, request IP, user agent, sanitized detail, and timestamp.

Allowed statuses are `awaiting_payment`, `pending_review`, `processing`,
`approved`, `rejected`, `recharge_failed`, and `expired`.

Amounts accepted from users must be in `RECHARGE_AMOUNTS`; their CNY value is
stored as integer fen. The exact balance value is calculated with Decimal
arithmetic and stored as a string, so no decision depends on floating-point
math.

## Order Lifecycle

1. A verified user creates an `awaiting_payment` order from an allowed amount.
   The service generates an unpredictable `S2P...` order number and records
   `payment_method = alipay_manual`.
2. The page shows the configured QR image and the order amount. The user
   submits a bounded, normalized transaction number. A unique constraint and
   the state check transition the order to `pending_review`.
3. An administrator manually verifies the Alipay payment. Rejecting the order
   transitions it to `rejected`, records the reason, and never calls Sub2API.
4. Approving or retrying atomically claims a permitted row by changing it to
   `processing`. Only `pending_review` and `recharge_failed` can be claimed.
   A second concurrent request cannot claim the same row.
5. The server calls `POST /api/v1/admin/redeem-codes/create-and-redeem` with
   `code = manual_<order_no>`, the immutable original user ID, and an
   `Idempotency-Key` that includes the next retry attempt number.
6. A successful response, including Sub2API's documented same-code/same-user
   idempotent success, transitions the row to `approved`. A timeout or other
   API failure records a sanitized error and transitions it to
   `recharge_failed`. The original order, code, transaction number, and user
   remain unchanged for a later retry.

`awaiting_payment` orders past `ORDER_EXPIRE_HOURS` are marked `expired` as a
read-time cleanup. Orders in `pending_review` are never auto-expired.

## Pages And APIs

User pages:

- `/pay`: account identity, fixed amount controls, the active order's QR code,
  transaction-number form, and manual-review notice.
- `/orders`: the current user's order history and status labels.

User APIs:

- `GET /api/me`
- `POST /api/orders`
- `GET /api/orders`
- `GET /api/orders/:order_no`
- `POST /api/orders/:order_no/submit`
- `POST /api/orders/:order_no/cancel`

Administrator pages:

- `/admin/login`
- `/admin`: filterable and searchable pending-review/recharge-failed order
  table with explicit approve, reject, and retry actions.

Administrator APIs:

- `POST /api/admin/login`
- `POST /api/admin/logout`
- `GET /api/admin/orders`
- `GET /api/admin/orders/:order_no`
- `POST /api/admin/orders/:order_no/approve`
- `POST /api/admin/orders/:order_no/reject`
- `POST /api/admin/orders/:order_no/retry`

`GET /health` reports the application and SQLite health for Docker.

## Error Handling And Logging

Invalid user credentials return an unauthenticated result and never create an
order. Validation failures return field-specific 400 responses. Unique
transaction-number conflicts return 409. Unauthorized resource lookups return
404 to avoid leaking other users' orders. Invalid state transitions return
409.

Sub2API 401 and 403 recharge responses result in `recharge_failed` and a
clear administrator-facing instruction to verify the Admin API key. Other
external failures are sanitized before storage and logging. Application logs
allow order number, user ID, status, CNY amount, and upstream HTTP status but
redact tokens, authorization headers, API keys, passwords, and session
secrets.

## User Interface

The user experience is a compact operational payment view, not a merchant
checkout impersonation. It displays the current account, fixed amounts, an
order reference, the personal Alipay QR image, transaction-number entry, and
the clear statement that a human will check payment before recharge.

The administrator experience prioritizes scanning and repeated review: a
filterable table with order, user, amount, balance value, transaction number,
submission time, status, and direct actions. Approval requires a confirmation
dialog that repeats the amount and user to receive credit. Order details poll
every 15 seconds; no WebSocket is used.

## Verification

Vitest and Supertest cover the service behavior with a temporary SQLite
database and a mocked Sub2API client:

- The verified profile identity overrides a manipulated query user ID.
- Invalid profile tokens cannot create orders.
- Amount whitelisting, pending-order caps, cross-user isolation, and unique
  transaction numbers are enforced.
- Unauthenticated administrators cannot access protected APIs.
- Rejected and approved orders cannot be charged, and rejection makes no
  Sub2API request.
- Simultaneous approval requests yield one recharge call and one success.
- Success, timeout, retry success, documented idempotent success, and 401/403
  upstream responses produce the correct durable status and message.

Docker runs the service as a non-root production Node process with `./data`
mounted at `/app/data`. The repository supplies `.env.example`, a Dockerfile,
a Compose file, Nginx and Caddy reverse-proxy examples, and an operations
README covering passwords, QR setup, HTTPS, Sub2API setup, backups, upgrades,
and failure recovery.
