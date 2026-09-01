import { buildEasyPaySign } from '../easypay.js';
import type { DatabaseStore, Order } from '../db.js';
import type { AppConfig } from '../types.js';

export class EasyPayCallbackError extends Error {
  constructor(readonly status = 502, message = 'EasyPay callback failed') {
    super(message);
    this.name = 'EasyPayCallbackError';
  }
}

type FetchLike = typeof fetch;

function callbackParams(config: AppConfig, order: Order) {
  const easyPay = config.easyPay;
  if (!easyPay?.enabled || !order.externalOrderNo || !order.notifyUrl) throw new EasyPayCallbackError(409, 'EasyPay order metadata missing');
  const params = {
    pid: easyPay.pid,
    trade_no: order.orderNo,
    out_trade_no: order.externalOrderNo,
    type: 'alipay',
    name: 'Recharge',
    money: (order.amountFen / 100).toFixed(2),
    trade_status: 'SUCCESS',
  };
  return { params, url: order.notifyUrl, key: easyPay.key };
}

async function sendCallback(input: { config: AppConfig; store: DatabaseStore; order: Order; fetchImpl: FetchLike }): Promise<Order> {
  const { params, url, key } = callbackParams(input.config, input.order);
  const payload = new URLSearchParams({ ...params, sign: buildEasyPaySign(params, key), sign_type: 'MD5' });
  let response: Response;
  try {
    response = await input.fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain' }, body: payload.toString() });
  } catch {
    input.store.recordEasyPayCallbackAttempt(input.order.orderNo, 'failed');
    throw new EasyPayCallbackError();
  }
  const text = await response.text().catch(() => '');
  const status = response.ok && text.trim().toLowerCase() === 'success' ? 'sent' : 'failed';
  const updated = input.store.recordEasyPayCallbackAttempt(input.order.orderNo, status);
  if (status !== 'sent') throw new EasyPayCallbackError(response.status || 502);
  if (updated === null) throw new EasyPayCallbackError(409, 'EasyPay order disappeared');
  return updated;
}

export async function approveEasyPayOrder(input: {
  config: AppConfig;
  store: DatabaseStore;
  orderNo: string;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<Order> {
  const order = input.store.findByOrderNo(input.orderNo);
  if (order === null) throw new EasyPayCallbackError(404, 'Order not found');
  if (order.paymentMethod !== 'easypay_alipay' || order.status !== 'pending_review') throw new EasyPayCallbackError(409, 'Order state does not allow approval');
  const approved = input.store.markEasyPayPaid(order.orderNo, order.externalTradeNo ?? order.orderNo, (input.now ?? new Date()).toISOString());
  if (approved === null) throw new EasyPayCallbackError(409, 'Order state does not allow approval');
  return sendCallback({ config: input.config, store: input.store, order: approved, fetchImpl: input.fetchImpl ?? fetch });
}

export async function retryEasyPayNotification(input: {
  config: AppConfig;
  store: DatabaseStore;
  orderNo: string;
  fetchImpl?: FetchLike;
}): Promise<Order> {
  const order = input.store.findByOrderNo(input.orderNo);
  if (order === null) throw new EasyPayCallbackError(404, 'Order not found');
  if (order.paymentMethod !== 'easypay_alipay' || order.status !== 'approved' || order.callbackStatus === 'sent') {
    throw new EasyPayCallbackError(409, 'Order state does not allow callback retry');
  }
  return sendCallback({ config: input.config, store: input.store, order, fetchImpl: input.fetchImpl ?? fetch });
}
