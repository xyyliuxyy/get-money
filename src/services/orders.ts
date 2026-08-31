import { randomBytes } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { AppConfig } from '../types.js';
import type { DatabaseStore, Order, Session } from '../db.js';

export const ACTIVE_ORDER_STATUSES = [
  'awaiting_payment', 'pending_review', 'processing', 'recharge_failed',
] as const;

export class UserOrderError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'UserOrderError';
    this.status = status;
  }
}

export interface UserOrderContext {
  store: DatabaseStore;
  config: AppConfig;
  session: Session;
}

export interface CreateOrderInput extends UserOrderContext {
  amountCny: unknown;
  now?: Date;
}

export interface SubmitPaymentProofInput extends UserOrderContext {
  orderNo: string;
  tradeNo: unknown;
  note?: unknown;
  paidAt?: Date;
}

export interface CancelOrderInput extends UserOrderContext {
  orderNo: string;
  now?: Date;
}

export interface UserOrderListInput extends UserOrderContext {
  limit?: number;
  offset?: number;
  now?: Date;
}

export interface PublicOrder {
  order_no: string;
  amount_fen: number;
  amount_cny: string;
  balance_value: string;
  payment_method: string;
  trade_no: string | null;
  paid_at: string | null;
  status: Order['status'];
  created_at: string;
  submitted_at: string | null;
  expires_at: string;
  rejection_reason: string | null;
}

export function createOrderNo(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `S2P${date}${randomBytes(4).toString('hex').toUpperCase()}`;
}

function asAmountFen(value: unknown, configured: number[]): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new UserOrderError(400, '充值金额无效');
  }
  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch {
    throw new UserOrderError(400, '充值金额无效');
  }
  const fen = decimal.mul(100);
  if (!fen.isFinite() || !fen.isInteger()) {
    throw new UserOrderError(400, '充值金额无效');
  }
  const amountFen = fen.toNumber();
  if (!Number.isSafeInteger(amountFen)) throw new UserOrderError(400, '充值金额无效');
  if (!configured.includes(amountFen)) {
    throw new UserOrderError(400, '充值金额不在可选范围内');
  }
  return amountFen;
}

function isoNow(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function publicOrder(order: Order): PublicOrder {
  return {
    order_no: order.orderNo,
    amount_fen: order.amountFen,
    amount_cny: new Decimal(order.amountFen).div(100).toFixed(2),
    balance_value: order.balanceValue,
    payment_method: order.paymentMethod,
    trade_no: order.tradeNo,
    paid_at: order.paidAt,
    status: order.status,
    created_at: order.createdAt,
    submitted_at: order.submittedAt,
    expires_at: order.expiresAt,
    rejection_reason: order.rejectionReason,
  };
}

function requireUser(context: UserOrderContext): number {
  if (context.session.actorType !== 'user' || context.session.userId === null) {
    throw new UserOrderError(401, '未授权');
  }
  return context.session.userId;
}

export function createOrder(input: CreateOrderInput): PublicOrder {
  const userId = requireUser(input);
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const amountFen = asAmountFen(input.amountCny, input.config.rechargeAmountsFen);
  const expiresAt = new Date(now.getTime() + input.config.orderExpireHours * 60 * 60 * 1000).toISOString();
  const order = input.store.transaction(() => {
    input.store.expireAwaitingPayment(createdAt);
    if (input.store.countActiveOrders(userId) >= 3) {
      throw new UserOrderError(409, '进行中的订单已达到上限');
    }
    const orderNo = createOrderNo(now);
    return input.store.createOrder({
      orderNo,
      userId,
      usernameSnapshot: input.session.usernameSnapshot,
      emailSnapshot: input.session.emailSnapshot,
      amountFen,
      balanceValue: new Decimal(amountFen).div(100).mul(input.config.balancePerCny).toFixed(),
      paymentMethod: 'alipay_manual',
      status: 'awaiting_payment',
      rechargeCode: `manual_${randomBytes(16).toString('hex')}`,
      createdAt,
      expiresAt,
    });
  });
  return publicOrder(order);
}

export function submitPaymentProof(input: SubmitPaymentProofInput): PublicOrder {
  const userId = requireUser(input);
  if (typeof input.tradeNo !== 'string') throw new UserOrderError(400, '交易单号无效');
  const tradeNo = input.tradeNo.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(tradeNo)) {
    throw new UserOrderError(400, '交易单号无效');
  }
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 500)) {
    throw new UserOrderError(400, '备注长度无效');
  }
  const now = isoNow(input.paidAt);
  input.store.expireAwaitingPayment(now);
  const existing = input.store.findOrderForUser(input.orderNo, userId);
  if (existing === null) throw new UserOrderError(404, '订单不存在');
  if (existing.status !== 'awaiting_payment') throw new UserOrderError(409, '订单状态不允许提交凭证');
  try {
    const updated = input.store.submitTransaction(input.orderNo, userId, tradeNo, now, now);
    if (updated === null) throw new UserOrderError(409, '订单状态不允许提交凭证');
    return publicOrder(updated);
  } catch (error) {
    if (error instanceof UserOrderError) throw error;
    if (String(error).toLowerCase().includes('unique') || String(error).toLowerCase().includes('constraint')) {
      throw new UserOrderError(409, '交易单号已被使用');
    }
    throw error;
  }
}

export function cancelOrder(input: CancelOrderInput): PublicOrder {
  const userId = requireUser(input);
  const now = isoNow(input.now);
  input.store.expireAwaitingPayment(now);
  const existing = input.store.findOrderForUser(input.orderNo, userId);
  if (existing === null) throw new UserOrderError(404, '订单不存在');
  if (existing.status !== 'awaiting_payment') throw new UserOrderError(409, '订单状态不允许取消');
  const updated = input.store.cancelOrder(input.orderNo, userId, now);
  if (updated === null) throw new UserOrderError(409, '订单状态不允许取消');
  return publicOrder(updated);
}

export function getUserOrder(input: UserOrderContext & { orderNo: string; now?: Date }): PublicOrder {
  const userId = requireUser(input);
  input.store.expireAwaitingPayment(isoNow(input.now));
  const order = input.store.findOrderForUser(input.orderNo, userId);
  if (order === null) throw new UserOrderError(404, '订单不存在');
  return publicOrder(order);
}

export function listUserOrders(input: UserOrderListInput): PublicOrder[] {
  const userId = requireUser(input);
  input.store.expireAwaitingPayment(isoNow(input.now));
  return input.store.listUserOrders(userId, { limit: input.limit, offset: input.offset }).map(publicOrder);
}
