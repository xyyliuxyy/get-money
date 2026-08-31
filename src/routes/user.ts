import express, { type Request, type Response, type Router } from 'express';
import type { Auth } from '../auth.js';
import type { AppConfig, Sub2ApiClient } from '../types.js';
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
  if (status === 401) response.status(401).json({ error: '身份验证失败' });
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

  router.get('/pay', async (request, response) => {
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
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);
      response.json({ orders: listUserOrders({ ...context, limit, offset }) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/api/orders', options.auth.requireUser, options.auth.requireCsrfAndOrigin, (request, response) => {
    try {
      const context = sessionContext(request, options);
      const order = createOrder({ ...context, amountCny: request.body?.amount_cny });
      response.status(201).json(order);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/api/orders/:orderNo/submit', options.auth.requireUser, options.auth.requireCsrfAndOrigin, (request, response) => {
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
