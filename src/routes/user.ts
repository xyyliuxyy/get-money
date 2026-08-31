import express, { type Request, type Response, type Router } from 'express';
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Auth } from '../auth.js';
import type { AppConfig, RateLimitConfig, Sub2ApiClient } from '../types.js';
import type { DatabaseStore } from '../db.js';
import {
  cancelOrder,
  createOrder,
  getUserOrder,
  listUserOrders,
  submitPaymentProof,
  UserOrderError,
} from '../services/orders.js';

export interface UserRouterOptions {
  config: AppConfig;
  store: DatabaseStore;
  auth: Auth;
  sub2api: Sub2ApiClient;
}

const MAX_USER_ORDER_LIST_LIMIT = 100;
const MAX_USER_ORDER_LIST_OFFSET = Number.MAX_SAFE_INTEGER;

function requestIpKey(request: Request): string {
  return ipKeyGenerator(request.ip ?? '0.0.0.0');
}

function createIpRateLimit(config: RateLimitConfig): RateLimitRequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
    keyGenerator: requestIpKey,
  });
}

function createSessionRateLimit(config: RateLimitConfig): RateLimitRequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
    keyGenerator: (request) => {
      if (request.userSession !== undefined) return `session:${request.userSession.tokenHash}`;
      return `ip:${requestIpKey(request)}`;
    },
  });
}

function parseUserOrderListInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UserOrderError(400, `Invalid ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new UserOrderError(400, `Invalid ${name}`);
  }
  return parsed;
}

function optionsFromArgs(
  optionsOrConfig: UserRouterOptions | AppConfig,
  store?: DatabaseStore,
  auth?: Auth,
  sub2api?: Sub2ApiClient,
): UserRouterOptions {
  if ('config' in optionsOrConfig) return optionsOrConfig;
  if (!store || !auth || !sub2api) throw new Error('缺少用户路由依赖');
  return { config: optionsOrConfig, store, auth, sub2api };
}

function sessionContext(request: Request, options: UserRouterOptions) {
  const session = request.userSession ?? options.auth.getUserSession(request);
  if (!session || session.userId === null) throw new UserOrderError(401, '未授权');
  return { config: options.config, store: options.store, session };
}

function sendError(response: Response, error: unknown): void {
  if (error instanceof UserOrderError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  const status = typeof error === 'object' && error !== null && 'status' in error
    && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status : 500;
  if (status === 401 || (error instanceof Error && /unauthorized|未授权/i.test(error.message))) {
    response.status(401).json({ error: '身份验证失败' });
  }
  else if (status >= 400 && status < 500) response.status(status).json({ error: '请求无效' });
  else response.status(502).json({ error: '上游服务暂不可用' });
}

export function createUserRouter(
  optionsOrConfig: UserRouterOptions | AppConfig,
  store?: DatabaseStore,
  auth?: Auth,
  sub2api?: Sub2ApiClient,
): Router {
  const options = optionsFromArgs(optionsOrConfig, store, auth, sub2api);
  const router = express.Router();
  const userAuthRateLimit = createIpRateLimit(options.config.rateLimits.userAuth);
  const orderCreateRateLimit = createSessionRateLimit(options.config.rateLimits.orderCreate);
  const orderSubmitRateLimit = createSessionRateLimit(options.config.rateLimits.orderSubmit);

  router.get('/pay', (request, response, next) => {
    const token = typeof request.query.token === 'string' ? request.query.token : null;
    if (token !== null && token.length > 0) {
      userAuthRateLimit(request, response, next);
      return;
    }
    next();
  }, async (request, response) => {
    const token = typeof request.query.token === 'string' ? request.query.token : null;
    if (token !== null && token.length > 0) {
      try {
        const profile = await options.sub2api.verifyUserToken(token);
        options.auth.createUserSession(response, profile);
        response.redirect(302, '/pay');
      } catch (error) {
        sendError(response, error);
      }
      return;
    }
    if (!options.auth.getUserSession(request)) {
      response.status(401).json({ error: '未授权' });
      return;
    }
    response.status(200).send('支付页面');
  });

  router.get('/api/orders', options.auth.requireUser, (request, response) => {
    try {
      const context = sessionContext(request, options);
      const limit = parseUserOrderListInteger(request.query.limit, 'limit', 1, MAX_USER_ORDER_LIST_LIMIT);
      const offset = parseUserOrderListInteger(request.query.offset, 'offset', 0, MAX_USER_ORDER_LIST_OFFSET);
      response.json({ orders: listUserOrders({ ...context, limit, offset }) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/api/orders', options.auth.requireUser, options.auth.requireCsrfAndOrigin, orderCreateRateLimit, (request, response) => {
    try {
      const context = sessionContext(request, options);
      const order = createOrder({ ...context, amountCny: request.body?.amount_cny });
      response.status(201).json(order);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/api/orders/:orderNo/submit', options.auth.requireUser, options.auth.requireCsrfAndOrigin, orderSubmitRateLimit, (request, response) => {
    try {
      const context = sessionContext(request, options);
      const order = submitPaymentProof({
        ...context,
        orderNo: String(request.params.orderNo),
        tradeNo: request.body?.trade_no,
        note: request.body?.note,
      });
      response.json(order);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/api/orders/:orderNo/cancel', options.auth.requireUser, options.auth.requireCsrfAndOrigin, (request, response) => {
    try {
      const context = sessionContext(request, options);
      const order = cancelOrder({ ...context, orderNo: String(request.params.orderNo) });
      response.json(order);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/api/orders/:orderNo', options.auth.requireUser, (request, response) => {
    try {
      const context = sessionContext(request, options);
      response.json(getUserOrder({ ...context, orderNo: String(request.params.orderNo) }));
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
