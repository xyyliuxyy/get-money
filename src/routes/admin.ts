import express, { type Request, type Response, type Router } from 'express';
import bcrypt from 'bcryptjs';
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Auth } from '../auth.js';
import type { DatabaseStore, Order } from '../db.js';
import { approveOrder, AdminReviewError, rejectOrder, retryOrder } from '../services/recharge.js';
import { approveEasyPayOrder, retryEasyPayNotification } from '../services/easypay-notify.js';
import type { AppConfig, RateLimitConfig, Sub2ApiClient } from '../types.js';
import type { OrderStatus } from '../types.js';

export interface AdminRouterOptions {
  config: AppConfig;
  store: DatabaseStore;
  auth: Auth;
  sub2api: Sub2ApiClient;
}

const ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'awaiting_payment', 'pending_review', 'processing', 'approved', 'rejected', 'recharge_failed', 'expired',
]);
const MAX_SEARCH_LENGTH = 128;

function requestIp(request: Request): string {
  return ipKeyGenerator(request.ip ?? '0.0.0.0');
}

function auditLogin(options: AdminRouterOptions, request: Request, action: string): void {
  options.store.writeAuditLog({
    adminName: options.config.adminUsername,
    action,
    ip: requestIp(request),
    userAgent: request.get('User-Agent') ?? null,
    detail: null,
    createdAt: new Date().toISOString(),
  });
}

function createLoginRateLimit(options: AdminRouterOptions, config: RateLimitConfig): RateLimitRequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: requestIp,
    handler: (request, response) => {
      auditLogin(options, request, 'login_rate_limited');
      response.status(429).json({ error: '登录尝试过多，请稍后再试' });
    },
  });
}

function parseSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AdminReviewError(400, '搜索词无效');
  const search = value.trim();
  if (search.length > MAX_SEARCH_LENGTH) throw new AdminReviewError(400, '搜索词过长');
  return search;
}

function parseStatuses(value: unknown): OrderStatus[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const statuses = raw.flatMap((entry) => typeof entry === 'string' ? entry.split(',') : []);
  if (statuses.length === 0 || statuses.some((status) => !ORDER_STATUSES.has(status as OrderStatus))) {
    throw new AdminReviewError(400, '订单状态无效');
  }
  return statuses as OrderStatus[];
}

function publicOrder(order: Order) {
  return {
    order_no: order.orderNo,
    user_id: order.userId,
    username: order.usernameSnapshot,
    email: order.emailSnapshot,
    amount_fen: order.amountFen,
    balance_value: order.balanceValue,
    payment_method: order.paymentMethod,
    trade_no: order.tradeNo,
    payment_note: order.paymentNote,
    paid_at: order.paidAt,
    status: order.status,
    admin_note: order.adminNote,
    rejection_reason: order.rejectionReason,
    recharge_attempts: order.rechargeAttempts,
    last_recharge_error: order.lastRechargeError,
    created_at: order.createdAt,
    submitted_at: order.submittedAt,
    processing_at: order.processingAt,
    reviewed_at: order.reviewedAt,
    approved_at: order.approvedAt,
    rejected_at: order.rejectedAt,
  };
}

function optionsFromArgs(
  optionsOrConfig: AdminRouterOptions | AppConfig,
  store?: DatabaseStore,
  auth?: Auth,
  sub2api?: Sub2ApiClient,
): AdminRouterOptions {
  if ('config' in optionsOrConfig) return optionsOrConfig;
  if (!store || !auth || !sub2api) throw new Error('缺少管理员路由依赖');
  return { config: optionsOrConfig, store, auth, sub2api };
}

function adminContext(request: Request, options: AdminRouterOptions) {
  const session = request.adminSession ?? options.auth.getAdminSession(request);
  if (session === null || session === undefined) throw new AdminReviewError(401, '未授权');
  return {
    store: options.store,
    adminName: session.usernameSnapshot ?? options.config.adminUsername,
    ip: requestIp(request),
    userAgent: request.get('User-Agent') ?? null,
  };
}

function sendError(response: Response, error: unknown): void {
  if (error instanceof AdminReviewError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  response.status(500).json({ error: '管理员操作失败' });
}

export function createAdminRouter(
  optionsOrConfig: AdminRouterOptions | AppConfig,
  store?: DatabaseStore,
  auth?: Auth,
  sub2api?: Sub2ApiClient,
): Router {
  const options = optionsFromArgs(optionsOrConfig, store, auth, sub2api);
  const router = express.Router();
  const loginRateLimit = createLoginRateLimit(options, options.config.rateLimits.adminLogin);

  router.post('/api/admin/login', loginRateLimit, async (request, response) => {
    const username = request.body?.username;
    const password = request.body?.password;
    const passwordMatches = typeof password === 'string'
      ? await bcrypt.compare(password, options.config.adminPasswordHash)
      : false;
    if (username !== options.config.adminUsername || !passwordMatches) {
      auditLogin(options, request, 'login_failure');
      response.status(401).json({ error: '用户名或密码错误' });
      return;
    }
    const session = options.auth.createAdminSession(response, options.config.adminUsername);
    auditLogin(options, request, 'login_success');
    response.status(200).json({ csrf: session.csrfSecret });
  });

  router.post('/api/admin/logout', options.auth.requireAdmin, options.auth.requireCsrfAndOrigin, (_request, response) => {
    options.auth.clearAdminSession(response);
    response.sendStatus(204);
  });

  router.get('/api/admin/orders', options.auth.requireAdmin, (request, response) => {
    try {
      const statuses = parseStatuses(request.query.status ?? request.query.statuses);
      const search = parseSearch(request.query.search);
      response.json({ orders: options.store.listAdminOrders({ statuses, search }).map(publicOrder) });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/api/admin/orders/:orderNo', options.auth.requireAdmin, (request, response) => {
    const order = options.store.findByOrderNo(String(request.params.orderNo));
    if (order === null) {
      response.status(404).json({ error: '订单不存在' });
      return;
    }
    response.json(publicOrder(order));
  });

  router.post('/api/admin/orders/:orderNo/reject', options.auth.requireAdmin, options.auth.requireCsrfAndOrigin, (request, response) => {
    try {
      response.json(publicOrder(rejectOrder({
        ...adminContext(request, options),
        orderNo: String(request.params.orderNo),
        reason: request.body?.reason,
        note: request.body?.note,
      })));
    } catch (error) {
      sendError(response, error);
    }
  });

  const recharge = (action: 'approve' | 'retry') => async (request: Request, response: Response) => {
    try {
      const existing = options.store.findByOrderNo(String(request.params.orderNo));
      if (existing?.paymentMethod === 'easypay_alipay') {
        const order = action === 'approve'
          ? await approveEasyPayOrder({ config: options.config, store: options.store, orderNo: existing.orderNo })
          : await retryEasyPayNotification({ config: options.config, store: options.store, orderNo: existing.orderNo });
        response.json(publicOrder(order));
        return;
      }
      const input = {
        ...adminContext(request, options),
        sub2api: options.sub2api,
        orderNo: String(request.params.orderNo),
        processingStaleMinutes: options.config.processingStaleMinutes,
      };
      const order = action === 'approve' ? await approveOrder(input) : await retryOrder(input);
      response.json(publicOrder(order));
    } catch (error) {
      sendError(response, error);
    }
  };

  router.post('/api/admin/orders/:orderNo/approve', options.auth.requireAdmin, options.auth.requireCsrfAndOrigin, recharge('approve'));
  router.post('/api/admin/orders/:orderNo/retry', options.auth.requireAdmin, options.auth.requireCsrfAndOrigin, recharge('retry'));

  return router;
}
