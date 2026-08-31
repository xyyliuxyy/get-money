import type { DatabaseStore, Order, RechargeClaim } from '../db.js';
import { sanitizeMessage } from '../logger.js';
import { AdminCredentialError } from '../sub2api.js';
import type { Sub2ApiClient } from '../types.js';

const MAX_REVIEW_TEXT_LENGTH = 500;
const STALE_RECHARGE_ERROR = 'Previous recharge attempt became stale; retry required.';
const ADMIN_API_KEY_HINT = 'Sub2API 管理员 Admin API Key 被拒绝，请检查 SUB2API_ADMIN_API_KEY 配置。';

export class AdminReviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AdminReviewError';
  }
}

export interface AdminActionContext {
  store: DatabaseStore;
  adminName: string;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}

export interface RechargeInput extends AdminActionContext {
  sub2api: Sub2ApiClient;
  orderNo: string;
  processingStaleMinutes: number;
}

export interface RejectOrderInput extends AdminActionContext {
  orderNo: string;
  reason: unknown;
  note?: unknown;
}

type RechargeAction = 'approve' | 'retry';

function isoNow(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function actionDetail(error: unknown): string {
  const status = upstreamStatus(error);
  if (status === 401 || status === 403 || error instanceof AdminCredentialError) {
    return ADMIN_API_KEY_HINT;
  }
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeMessage(message, MAX_REVIEW_TEXT_LENGTH);
}

function upstreamStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  if (typeof candidate.status === 'number') return candidate.status;
  return undefined;
}

function boundedRequiredText(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new AdminReviewError(400, `${name} 无效`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REVIEW_TEXT_LENGTH) {
    throw new AdminReviewError(400, `${name} 无效`);
  }
  return trimmed;
}

function boundedOptionalText(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return boundedRequiredText(value, name);
}

function ensureOrderStatus(order: Order | null, expected: Order['status']): Order {
  if (order === null) throw new AdminReviewError(404, '订单不存在');
  if (order.status !== expected) throw new AdminReviewError(409, '订单状态不允许此操作');
  return order;
}

function auditInput(
  context: AdminActionContext,
  action: string,
  orderNo: string,
  oldStatus: Order['status'],
  newStatus: Order['status'],
  detail: string | null,
  createdAt: string,
) {
  return {
    adminName: context.adminName,
    action,
    orderNo,
    oldStatus,
    newStatus,
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
    detail,
    createdAt,
  };
}

function staleBefore(now: Date, processingStaleMinutes: number): string {
  if (!Number.isSafeInteger(processingStaleMinutes) || processingStaleMinutes <= 0) {
    throw new Error('Invalid processing stale minutes');
  }
  return new Date(now.getTime() - processingStaleMinutes * 60 * 1000).toISOString();
}

function rechargeClaim(order: Order): RechargeClaim {
  if (order.processingAt === null) throw new Error('Claimed recharge is missing processing time');
  return { rechargeAttempts: order.rechargeAttempts, processingAt: order.processingAt };
}

function releaseStaleRecharge(input: RechargeInput, now: Date): void {
  const releasedAt = now.toISOString();
  input.store.transaction(() => {
    const released = input.store.releaseStaleRecharge(
      input.orderNo,
      staleBefore(now, input.processingStaleMinutes),
      STALE_RECHARGE_ERROR,
    );
    if (released === null) return;
    input.store.writeAuditLog(auditInput(
      input,
      'retry_stale_recovery',
      released.orderNo,
      'processing',
      released.status,
      STALE_RECHARGE_ERROR,
      releasedAt,
    ));
  });
}

function ownershipLost(input: RechargeInput, action: RechargeAction, claim: RechargeClaim, completedAt: string): never {
  input.store.writeAuditLog(auditInput(
    input,
    `${action}_superseded`,
    input.orderNo,
    'processing',
    'processing',
    `Recharge attempt ${claim.rechargeAttempts} was superseded by a newer claim.`,
    completedAt,
  ));
  throw new AdminReviewError(409, '充值请求已被新的重试接管');
}

export function rejectOrder(input: RejectOrderInput): Order {
  const reason = boundedRequiredText(input.reason, '拒绝原因');
  const note = boundedOptionalText(input.note, '管理员备注');
  const reviewedAt = isoNow(input.now);

  return input.store.transaction(() => {
    const before = ensureOrderStatus(input.store.findByOrderNo(input.orderNo), 'pending_review');
    const rejected = input.store.rejectOrder(input.orderNo, reason, note, reviewedAt);
    if (rejected === null) throw new AdminReviewError(409, '订单状态不允许此操作');
    input.store.writeAuditLog(auditInput(input, 'reject', rejected.orderNo, before.status, rejected.status, reason, reviewedAt));
    return rejected;
  });
}

async function rechargeOrder(input: RechargeInput, action: RechargeAction): Promise<Order> {
  const now = input.now ?? new Date();
  const processingAt = now.toISOString();

  if (action === 'retry') {
    releaseStaleRecharge(input, now);
  }

  ensureOrderStatus(input.store.findByOrderNo(input.orderNo), action === 'approve' ? 'pending_review' : 'recharge_failed');
  const claimed = input.store.claimRecharge(input.orderNo, processingAt);
  if (claimed === null) throw new AdminReviewError(409, '订单状态不允许此操作');
  const claim = rechargeClaim(claimed);

  try {
    await input.sub2api.createAndRedeem({
      code: claimed.rechargeCode,
      userId: claimed.userId,
      value: claimed.balanceValue,
      notes: `manual alipay recharge ${claimed.orderNo}`,
      idempotencyKey: `manual-pay-${claimed.orderNo}-${claimed.rechargeAttempts}`,
    });
  } catch (error) {
    const detail = actionDetail(error);
    const completedAt = isoNow();
    const failed = input.store.transaction(() => {
      const order = input.store.finishRecharge(claimed.orderNo, 'recharge_failed', completedAt, detail, claim);
      if (order === null) return null;
      input.store.writeAuditLog(auditInput(input, `${action}_failed`, order.orderNo, 'processing', order.status, detail, completedAt));
      return order;
    });
    if (failed === null) ownershipLost(input, action, claim, completedAt);
    throw new AdminReviewError(502, detail);
  }

  const approved = input.store.transaction(() => {
    const completedAt = isoNow();
    const order = input.store.finishRecharge(claimed.orderNo, 'approved', completedAt, null, claim);
    if (order === null) return { completedAt, order: null };
    input.store.writeAuditLog(auditInput(input, action, order.orderNo, 'processing', order.status, null, completedAt));
    return { completedAt, order };
  });
  if (approved.order === null) ownershipLost(input, action, claim, approved.completedAt);
  return approved.order;
}

export async function approveOrder(input: RechargeInput): Promise<Order> {
  return rechargeOrder(input, 'approve');
}

export async function retryOrder(input: RechargeInput): Promise<Order> {
  return rechargeOrder(input, 'retry');
}
