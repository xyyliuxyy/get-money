import express, { type Request, type Router } from 'express';
import type { DatabaseStore } from '../db.js';
import { EasyPayError, createEasyPayOrder, queryEasyPayOrder } from '../services/easypay.js';
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

  return router;
}
