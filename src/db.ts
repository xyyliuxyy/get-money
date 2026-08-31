import Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OrderStatus } from './types.js';

export type ActorType = 'user' | 'admin';
export type RechargeOutcome = Extract<OrderStatus, 'approved' | 'recharge_failed'>;

const MAX_AUDIT_DETAIL_LENGTH = 500;
const SENSITIVE_AUDIT_DETAIL = /\b(?:access[_-]?token|api[_-]?key|token|authorization|x-api-key|password|secret)\b/i;

export interface Session {
  tokenHash: string;
  actorType: ActorType;
  userId: number | null;
  usernameSnapshot: string | null;
  emailSnapshot: string | null;
  csrfSecret: string;
  createdAt: string;
  expiresAt: string;
}

export interface NewSession {
  tokenHash: string;
  actorType: ActorType;
  userId?: number | null;
  usernameSnapshot?: string | null;
  emailSnapshot?: string | null;
  csrfSecret: string;
  createdAt: string;
  expiresAt: string;
}

export interface Order {
  id: number;
  orderNo: string;
  userId: number;
  usernameSnapshot: string | null;
  emailSnapshot: string | null;
  amountFen: number;
  balanceValue: string;
  paymentMethod: string;
  tradeNo: string | null;
  paidAt: string | null;
  status: OrderStatus;
  adminNote: string | null;
  rejectionReason: string | null;
  rechargeCode: string;
  rechargeAttempts: number;
  lastRechargeError: string | null;
  createdAt: string;
  submittedAt: string | null;
  processingAt: string | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  expiresAt: string;
}

export interface NewOrder {
  orderNo: string;
  userId: number;
  usernameSnapshot?: string | null;
  emailSnapshot?: string | null;
  amountFen: number;
  balanceValue: string;
  paymentMethod: string;
  status: OrderStatus;
  rechargeCode: string;
  createdAt: string;
  expiresAt: string;
}

export interface AdminOrderListOptions {
  statuses?: OrderStatus[];
  search?: string;
  limit?: number;
  offset?: number;
}

export interface UserOrderListOptions {
  limit?: number;
  offset?: number;
}

export interface NewAuditLog {
  adminName: string;
  action: string;
  orderNo?: string | null;
  oldStatus?: OrderStatus | null;
  newStatus?: OrderStatus | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: string | null;
  createdAt: string;
}

export interface AuditLog extends NewAuditLog {
  id: number;
}

export interface DatabaseStore {
  createSession(input: NewSession): Session;
  getSession(tokenHash: string, now: string): Session | null;
  createOrder(input: NewOrder): Order;
  findByOrderNo(orderNo: string): Order | null;
  findOrderForUser(orderNo: string, userId: number): Order | null;
  countActiveOrders(userId: number): number;
  expireAwaitingPayment(now: string): number;
  listUserOrders(userId: number, options?: UserOrderListOptions): Order[];
  cancelOrder(orderNo: string, userId: number, cancelledAt: string): Order | null;
  submitTransaction(
    orderNo: string,
    userId: number,
    tradeNo: string,
    paidAt: string | null,
    submittedAt: string | null,
  ): Order | null;
  claimRecharge(orderNo: string, processingAt: string): Order | null;
  finishRecharge(
    orderNo: string,
    outcome: RechargeOutcome,
    reviewedAt: string,
    lastRechargeError: string | null,
  ): Order | null;
  rejectOrder(
    orderNo: string,
    rejectionReason: string,
    adminNote: string | null,
    reviewedAt: string,
  ): Order | null;
  listAdminOrders(options?: AdminOrderListOptions): Order[];
  writeAuditLog(input: NewAuditLog): AuditLog;
  transaction<T>(operation: () => T): T;
  close(): void;
}

interface SessionRow {
  token_hash: string;
  actor_type: ActorType;
  user_id: number | null;
  username_snapshot: string | null;
  email_snapshot: string | null;
  csrf_secret: string;
  created_at: string;
  expires_at: string;
}

interface OrderRow {
  id: number;
  order_no: string;
  user_id: number;
  username_snapshot: string | null;
  email_snapshot: string | null;
  amount_fen: number;
  balance_value: string;
  payment_method: string;
  trade_no: string | null;
  paid_at: string | null;
  status: OrderStatus;
  admin_note: string | null;
  rejection_reason: string | null;
  recharge_code: string;
  recharge_attempts: number;
  last_recharge_error: string | null;
  created_at: string;
  submitted_at: string | null;
  processing_at: string | null;
  reviewed_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  expires_at: string;
}

interface AuditLogRow {
  id: number;
  admin_name: string;
  action: string;
  order_no: string | null;
  old_status: OrderStatus | null;
  new_status: OrderStatus | null;
  ip: string | null;
  user_agent: string | null;
  detail: string | null;
  created_at: string;
}

function mapSession(row: SessionRow): Session {
  return {
    tokenHash: row.token_hash,
    actorType: row.actor_type,
    userId: row.user_id,
    usernameSnapshot: row.username_snapshot,
    emailSnapshot: row.email_snapshot,
    csrfSecret: row.csrf_secret,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function mapOrder(row: OrderRow): Order {
  return {
    id: row.id,
    orderNo: row.order_no,
    userId: row.user_id,
    usernameSnapshot: row.username_snapshot,
    emailSnapshot: row.email_snapshot,
    amountFen: row.amount_fen,
    balanceValue: row.balance_value,
    paymentMethod: row.payment_method,
    tradeNo: row.trade_no,
    paidAt: row.paid_at,
    status: row.status,
    adminNote: row.admin_note,
    rejectionReason: row.rejection_reason,
    rechargeCode: row.recharge_code,
    rechargeAttempts: row.recharge_attempts,
    lastRechargeError: row.last_recharge_error,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    processingAt: row.processing_at,
    reviewedAt: row.reviewed_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    expiresAt: row.expires_at,
  };
}

function mapAuditLog(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    adminName: row.admin_name,
    action: row.action,
    orderNo: row.order_no,
    oldStatus: row.old_status,
    newStatus: row.new_status,
    ip: row.ip,
    userAgent: row.user_agent,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

function readInitialMigration(): string {
  return readFileSync(fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url)), 'utf8');
}

function optionalString(value: string | null | undefined): string | null {
  return value ?? null;
}

function validateAmountFen(amountFen: number): void {
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
    throw new Error('Invalid amount fen');
  }
}

function normalizeBalanceValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Invalid balance value');
  }

  try {
    const decimal = new Decimal(value);
    if (!decimal.isFinite()) {
      throw new Error('Invalid balance value');
    }
    return decimal.toString();
  } catch {
    throw new Error('Invalid balance value');
  }
}

function sanitizeAuditDetail(value: string | null | undefined): string | null {
  const detail = optionalString(value);
  if (detail === null) {
    return null;
  }
  if (SENSITIVE_AUDIT_DETAIL.test(detail)) {
    return '[REDACTED]';
  }
  return detail.slice(0, MAX_AUDIT_DETAIL_LENGTH);
}

export function createDatabaseStore(databasePath: string): DatabaseStore {
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.transaction(() => db.exec(readInitialMigration()))();

  const findSession = db.prepare(`
    SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?
  `);
  const findSessionByHash = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
  const findOrderByNo = db.prepare('SELECT * FROM orders WHERE order_no = ?');
  const findOrderByUser = db.prepare('SELECT * FROM orders WHERE order_no = ? AND user_id = ?');
  const findAuditLog = db.prepare('SELECT * FROM admin_audit_logs WHERE id = ?');

  const insertSession = db.prepare(`
    INSERT INTO sessions (
      token_hash, actor_type, user_id, username_snapshot, email_snapshot,
      csrf_secret, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      order_no, user_id, username_snapshot, email_snapshot, amount_fen,
      balance_value, payment_method, status, recharge_code, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const submitTransaction = db.prepare(`
    UPDATE orders
    SET trade_no = ?, paid_at = ?, submitted_at = ?, status = 'pending_review'
    WHERE order_no = ? AND user_id = ? AND status = 'awaiting_payment'
  `);
  const countActiveOrders = db.prepare(`
    SELECT COUNT(*) AS count FROM orders
    WHERE user_id = ? AND status IN ('awaiting_payment', 'pending_review', 'processing', 'recharge_failed')
  `);
  const expireAwaitingPayment = db.prepare(`
    UPDATE orders SET status = 'expired'
    WHERE status = 'awaiting_payment' AND expires_at <= ?
  `);
  const cancelOrder = db.prepare(`
    UPDATE orders SET status = 'expired'
    WHERE order_no = ? AND user_id = ? AND status = 'awaiting_payment'
  `);
  const claimRecharge = db.prepare(`
    UPDATE orders
    SET status = 'processing', processing_at = ?, recharge_attempts = recharge_attempts + 1
    WHERE order_no = ? AND status IN ('pending_review', 'recharge_failed')
  `);
  const finishRecharge = db.prepare(`
    UPDATE orders
    SET status = ?,
        reviewed_at = ?,
        approved_at = CASE WHEN ? = 'approved' THEN ? ELSE NULL END,
        last_recharge_error = CASE WHEN ? = 'recharge_failed' THEN ? ELSE NULL END
    WHERE order_no = ? AND status = 'processing'
  `);
  const rejectOrder = db.prepare(`
    UPDATE orders
    SET status = 'rejected', rejection_reason = ?, admin_note = ?, reviewed_at = ?, rejected_at = ?
    WHERE order_no = ? AND status = 'pending_review'
  `);
  const insertAuditLog = db.prepare(`
    INSERT INTO admin_audit_logs (
      admin_name, action, order_no, old_status, new_status, ip, user_agent, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    createSession(input) {
      insertSession.run(
        input.tokenHash,
        input.actorType,
        input.userId ?? null,
        optionalString(input.usernameSnapshot),
        optionalString(input.emailSnapshot),
        input.csrfSecret,
        input.createdAt,
        input.expiresAt,
      );
      return mapSession(findSessionByHash.get(input.tokenHash) as SessionRow);
    },

    getSession(tokenHash, now) {
      const row = findSession.get(tokenHash, now) as SessionRow | undefined;
      return row === undefined ? null : mapSession(row);
    },

    createOrder(input) {
      validateAmountFen(input.amountFen);
      const balanceValue = normalizeBalanceValue(input.balanceValue);
      insertOrder.run(
        input.orderNo,
        input.userId,
        optionalString(input.usernameSnapshot),
        optionalString(input.emailSnapshot),
        input.amountFen,
        balanceValue,
        input.paymentMethod,
        input.status,
        input.rechargeCode,
        input.createdAt,
        input.expiresAt,
      );
      return mapOrder(findOrderByNo.get(input.orderNo) as OrderRow);
    },

    findByOrderNo(orderNo) {
      const row = findOrderByNo.get(orderNo) as OrderRow | undefined;
      return row === undefined ? null : mapOrder(row);
    },

    findOrderForUser(orderNo, userId) {
      const row = findOrderByUser.get(orderNo, userId) as OrderRow | undefined;
      return row === undefined ? null : mapOrder(row);
    },

    countActiveOrders(userId) {
      const row = countActiveOrders.get(userId) as { count: number };
      return row.count;
    },

    expireAwaitingPayment(now) {
      return expireAwaitingPayment.run(now).changes;
    },

    listUserOrders(userId, options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
      const offset = Math.max(options.offset ?? 0, 0);
      const rows = db.prepare(`
        SELECT * FROM orders WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(userId, limit, offset) as OrderRow[];
      return rows.map(mapOrder);
    },

    cancelOrder(orderNo, userId, cancelledAt) {
      if (cancelOrder.run(orderNo, userId).changes !== 1) return null;
      return mapOrder(findOrderByNo.get(orderNo) as OrderRow);
    },

    submitTransaction(orderNo, userId, tradeNo, paidAt, submittedAt) {
      if (submitTransaction.run(tradeNo, paidAt, submittedAt, orderNo, userId).changes !== 1) {
        return null;
      }
      return mapOrder(findOrderByNo.get(orderNo) as OrderRow);
    },

    claimRecharge(orderNo, processingAt) {
      if (claimRecharge.run(processingAt, orderNo).changes !== 1) {
        return null;
      }
      return mapOrder(findOrderByNo.get(orderNo) as OrderRow);
    },

    finishRecharge(orderNo, outcome, reviewedAt, lastRechargeError) {
      if (finishRecharge.run(
        outcome,
        reviewedAt,
        outcome,
        reviewedAt,
        outcome,
        lastRechargeError,
        orderNo,
      ).changes !== 1) {
        return null;
      }
      return mapOrder(findOrderByNo.get(orderNo) as OrderRow);
    },

    rejectOrder(orderNo, rejectionReason, adminNote, reviewedAt) {
      if (rejectOrder.run(rejectionReason, adminNote, reviewedAt, reviewedAt, orderNo).changes !== 1) {
        return null;
      }
      return mapOrder(findOrderByNo.get(orderNo) as OrderRow);
    },

    listAdminOrders(options = {}) {
      const clauses: string[] = [];
      const parameters: Array<string | number> = [];

      if (options.statuses !== undefined && options.statuses.length > 0) {
        clauses.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
        parameters.push(...options.statuses);
      }
      if (options.search !== undefined && options.search !== '') {
        const pattern = `%${options.search}%`;
        clauses.push(`(
          order_no LIKE ? OR CAST(user_id AS TEXT) LIKE ? OR email_snapshot LIKE ? OR trade_no LIKE ?
        )`);
        parameters.push(pattern, pattern, pattern, pattern);
      }

      const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
      const offset = Math.max(options.offset ?? 0, 0);
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      const rows = db.prepare(`
        SELECT * FROM orders ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(...parameters, limit, offset) as OrderRow[];
      return rows.map(mapOrder);
    },

    writeAuditLog(input) {
      const result = insertAuditLog.run(
        input.adminName,
        input.action,
        optionalString(input.orderNo),
        optionalString(input.oldStatus),
        optionalString(input.newStatus),
        optionalString(input.ip),
        optionalString(input.userAgent),
        sanitizeAuditDetail(input.detail),
        input.createdAt,
      );
      return mapAuditLog(findAuditLog.get(result.lastInsertRowid) as AuditLogRow);
    },

    transaction(operation) {
      return db.transaction(operation)();
    },

    close() {
      db.close();
    },
  };
}
