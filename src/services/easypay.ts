import { randomBytes } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { DatabaseStore, Order } from '../db.js';
import { buildEasyPaySign, verifyEasyPaySign } from '../easypay.js';
import type { AppConfig } from '../types.js';

export class EasyPayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'EasyPayError';
  }
}

export interface EasyPayCreateParams {
  pid?: string;
  type?: string;
  out_trade_no?: string;
  notify_url?: string;
  return_url?: string;
  name?: string;
  money?: string;
  param?: string;
  sign?: string;
  sign_type?: string;
}

export interface EasyPayCreateResponse {
  code: 1;
  msg: 'success';
  trade_no: string;
  qrcode: string;
}

export interface EasyPayQueryResponse {
  code: 1;
  trade_status: 'WAITING' | 'SUCCESS' | 'FAILED';
  trade_no: string;
  out_trade_no: string;
  money: string;
}

function easyPayConfig(config: AppConfig) {
  const value = config.easyPay;
  if (!value?.enabled) throw new EasyPayError(503, 'EasyPay disabled');
  return value;
}

function required(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string') throw new EasyPayError(400, `Invalid ${name}`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new EasyPayError(400, `Invalid ${name}`);
  return trimmed;
}

function amountFen(value: string): number {
  try {
    const decimal = new Decimal(value);
    const fen = decimal.mul(100).toNumber();
    if (!decimal.isFinite() || !decimal.isInteger() || !Number.isSafeInteger(fen) || fen <= 0) throw new Error();
    return fen;
  } catch {
    throw new EasyPayError(400, 'Invalid amount');
  }
}

function signedParams(params: EasyPayCreateParams): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') output[key] = value;
  }
  return output;
}

function orderMoney(order: Order): string {
  return new Decimal(order.amountFen).div(100).toFixed(2);
}

export function createEasyPayOrder(input: {
  config: AppConfig;
  store: DatabaseStore;
  params: EasyPayCreateParams;
  now?: Date;
}): EasyPayCreateResponse {
  const easyPay = easyPayConfig(input.config);
  const params = input.params;
  const pid = required(params.pid, 'pid', 64);
  const outTradeNo = required(params.out_trade_no, 'out_trade_no', 128);
  const money = required(params.money, 'money', 32);
  const notifyUrl = required(params.notify_url, 'notify_url', 2048);
  const returnUrl = typeof params.return_url === 'string' ? params.return_url.trim().slice(0, 2048) : null;
  if (pid !== easyPay.pid) throw new EasyPayError(401, 'Invalid pid');
  if (params.type !== undefined && params.type !== 'alipay') throw new EasyPayError(400, 'Invalid type');
  if (!verifyEasyPaySign(signedParams(params), required(params.sign, 'sign', 64), easyPay.key)) {
    throw new EasyPayError(401, 'Invalid sign');
  }

  const fen = amountFen(money);
  if (!input.config.rechargeAmountsFen.includes(fen)) throw new EasyPayError(400, 'Invalid amount');
  const existing = input.store.findByExternalOrderNo(outTradeNo);
  if (existing !== null) {
    if (existing.amountFen !== fen || existing.notifyUrl !== notifyUrl) throw new EasyPayError(409, 'Order conflict');
    return { code: 1, msg: 'success', trade_no: existing.orderNo, qrcode: easyPay.qrContent };
  }

  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + input.config.orderExpireHours * 60 * 60 * 1000).toISOString();
  const orderNo = `EP${Date.now().toString(36).toUpperCase()}${randomBytes(6).toString('hex').toUpperCase()}`;
  const balanceValue = new Decimal(fen).div(100).mul(input.config.balancePerCny).toString();
  const order = input.store.createOrder({
    orderNo,
    userId: 0,
    amountFen: fen,
    balanceValue,
    paymentMethod: 'easypay_alipay',
    status: 'awaiting_payment',
    rechargeCode: `easy_${outTradeNo}`,
    createdAt,
    expiresAt,
    externalOrderNo: outTradeNo,
    notifyUrl,
    returnUrl,
  });
  return { code: 1, msg: 'success', trade_no: order.orderNo, qrcode: easyPay.qrContent };
}

export function queryEasyPayOrder(input: {
  config: AppConfig;
  store: DatabaseStore;
  params: { pid?: string; key?: string; out_trade_no?: string };
}): EasyPayQueryResponse {
  const easyPay = easyPayConfig(input.config);
  if (input.params.pid !== easyPay.pid || input.params.key !== easyPay.key) throw new EasyPayError(401, 'Invalid credentials');
  const outTradeNo = required(input.params.out_trade_no, 'out_trade_no', 128);
  const order = input.store.findByExternalOrderNo(outTradeNo);
  if (order === null) throw new EasyPayError(404, 'Order not found');
  const tradeStatus = order.status === 'approved' ? 'SUCCESS' : ['rejected', 'expired', 'recharge_failed'].includes(order.status) ? 'FAILED' : 'WAITING';
  return { code: 1, trade_status: tradeStatus, trade_no: order.externalTradeNo ?? order.orderNo, out_trade_no: outTradeNo, money: orderMoney(order) };
}

export { buildEasyPaySign };
