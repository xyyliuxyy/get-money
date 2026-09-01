import express, { type Request, type Router } from 'express';
import type { DatabaseStore } from '../db.js';
import { EasyPayError, createEasyPayOrder, queryEasyPayOrder } from '../services/easypay.js';
import { handleEasyPayNotification } from '../services/easypay-notify.js';
import { verifyEasyPaySign } from '../easypay.js';
import type { AppConfig } from '../types.js';

export interface EasyPayRouterOptions {
  config: AppConfig;
  store: DatabaseStore;
}

function protocolError(error: unknown): { status: number; body: { code: 0; msg: string } } {
  if (error instanceof EasyPayError) return { status: error.status, body: { code: 0, msg: error.message } };
  return { status: 500, body: { code: 0, msg: 'server error' } };
}

function body(request: Request): Record<string, unknown> {
  if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) return request.body as Record<string, unknown>;
  return {};
}

export function createEasyPayRouter(options: EasyPayRouterOptions): Router {
  const router = express.Router();

  router.post('/mapi.php', (request, response) => {
    try {
      response.status(200).json(createEasyPayOrder({ config: options.config, store: options.store, params: body(request) }));
    } catch (error) {
      const result = protocolError(error);
      response.status(result.status).json(result.body);
    }
  });

  router.post('/api.php', (request, response) => {
    try {
      response.status(200).json(queryEasyPayOrder({ config: options.config, store: options.store, params: body(request) as { pid?: string; key?: string; out_trade_no?: string } }));
    } catch (error) {
      const result = protocolError(error);
      response.status(result.status).json(result.body);
    }
  });

  router.post('/notify.php', async (request, response) => {
    try {
      const raw = body(request) as Record<string, unknown>;
      const pid = typeof raw.pid === 'string' ? raw.pid : '';
      const key = options.config.easyPay?.key ?? '';
      const sign = typeof raw.sign === 'string' ? raw.sign : '';
      const params: Record<string, string> = {};
      for (const [name, value] of Object.entries(raw)) if (typeof value === 'string') params[name] = value;
      if (!options.config.easyPay?.enabled || pid !== options.config.easyPay.pid || !verifyEasyPaySign(params, sign, key)) {
        response.status(401).send('fail');
        return;
      }
      if (raw.trade_status !== 'SUCCESS') {
        response.status(200).send('success');
        return;
      }
      const outTradeNo = typeof raw.out_trade_no === 'string' ? raw.out_trade_no : '';
      const tradeNo = typeof raw.trade_no === 'string' ? raw.trade_no : '';
      const order = options.store.findByExternalOrderNo(outTradeNo);
      if (order === null || order.paymentMethod !== 'easypay_alipay' || order.amountFen !== Math.round(Number(raw.money) * 100)) {
        response.status(400).send('fail');
        return;
      }
      await handleEasyPayNotification({ config: options.config, store: options.store, orderNo: order.orderNo, externalTradeNo: tradeNo });
      response.status(200).send('success');
    } catch (error) {
      const result = protocolError(error);
      response.status(result.status).send('fail');
    }
  });

  return router;
}
