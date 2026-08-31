import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { createAuth, type Auth } from './auth.js';
import { parseConfig } from './config.js';
import { createDatabaseStore, type DatabaseStore, type Session } from './db.js';
import { createAdminRouter } from './routes/admin.js';
import { createUserRouter } from './routes/user.js';
import { ACTIVE_ORDER_STATUSES, listUserOrders, type PublicOrder } from './services/orders.js';
import { createSub2ApiClient } from './sub2api.js';
import type { AppConfig, Sub2ApiClient } from './types.js';

export interface AppDependencies {
  config: AppConfig;
  store: DatabaseStore;
  auth: Auth;
  sub2api: Sub2ApiClient;
}

interface PageLocals {
  title: string;
  pageTemplate: 'pay' | 'orders';
  user: Session;
  csrfToken: string;
  orders: PublicOrder[];
  activeOrder: PublicOrder | null;
  rechargeAmountsFen: number[];
}

function isActiveOrder(order: PublicOrder): boolean {
  return (ACTIVE_ORDER_STATUSES as readonly string[]).includes(order.status);
}

function sessionForPage(request: Request, dependencies: AppDependencies): Session | null {
  const session = request.userSession ?? dependencies.auth.getUserSession(request);
  if (session === null || session.userId === null) return null;
  return session;
}

function pageLocals(request: Request, dependencies: AppDependencies, pageTemplate: PageLocals['pageTemplate']): PageLocals | null {
  const user = sessionForPage(request, dependencies);
  if (user === null) return null;
  const orders = listUserOrders({ config: dependencies.config, store: dependencies.store, session: user });
  return {
    title: pageTemplate === 'pay' ? '人工充值' : '订单记录',
    pageTemplate,
    user,
    csrfToken: user.csrfSecret,
    orders,
    activeOrder: orders.find(isActiveOrder) ?? null,
    rechargeAmountsFen: dependencies.config.rechargeAmountsFen,
  };
}

function renderUserPage(
  request: Request,
  response: Response,
  dependencies: AppDependencies,
  pageTemplate: PageLocals['pageTemplate'],
): void {
  const locals = pageLocals(request, dependencies, pageTemplate);
  if (locals === null) {
    response.status(401).json({ error: '未授权' });
    return;
  }
  response.status(200).render('layout', locals);
}

function privateQrHandler(dependencies: AppDependencies) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const session = sessionForPage(request, dependencies);
    if (session === null) {
      response.sendStatus(404);
      return;
    }
    request.userSession = session;
    response.type('image/png').sendFile(resolve(dependencies.config.alipayQrImage), (error) => {
      if (error && !response.headersSent) next(error);
    });
  };
}

function controlledError(status: number): string {
  if (status === 401) return '请先完成身份验证。';
  if (status === 403) return '此请求未获允许。';
  if (status === 404) return '未找到请求的内容。';
  if (status === 409) return '当前状态不允许此操作。';
  if (status >= 400 && status < 500) return '请求无效。';
  return '服务暂时不可用，请稍后重试。';
}

function errorStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600) return status;
  }
  return 500;
}

export function createApp(dependencies: AppDependencies) {
  const app = express();
  const publicDirectory = resolve(process.cwd(), 'public');

  app.disable('x-powered-by');
  app.set('views', resolve(process.cwd(), 'views'));
  app.set('view engine', 'ejs');
  // This value is an explicit proxy depth, never an unconditional forwarded-header trust.
  app.set('trust proxy', dependencies.config.trustProxyHops);

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser(dependencies.config.sessionSecret));

  app.get('/health', (_request, response) => response.json({ ok: true }));
  app.get('/assets/alipay-qr.png', privateQrHandler(dependencies));
  app.use('/assets', express.static(publicDirectory, { fallthrough: true }));

  app.use(createUserRouter({
    ...dependencies,
    renderPay: (request, response) => renderUserPage(request, response, dependencies, 'pay'),
  }));
  app.get('/orders', dependencies.auth.requireUser, (request, response) => {
    renderUserPage(request, response, dependencies, 'orders');
  });
  app.get('/admin/login', (_request, response) => response.render('admin-login', { title: '管理员登录' }));
  app.get('/admin', (request, response) => {
    const session = request.adminSession ?? dependencies.auth.getAdminSession(request);
    if (session === null || session === undefined) {
      response.redirect(302, '/admin/login');
      return;
    }
    response.render('admin-orders', { title: '充值审核', csrfToken: session.csrfSecret });
  });
  app.use(createAdminRouter(dependencies));

  app.use((request, response) => {
    if (request.path.startsWith('/api/')) {
      response.status(404).json({ error: controlledError(404) });
      return;
    }
    response.status(404).type('html').send('<!doctype html><title>未找到内容</title><p>未找到请求的内容。</p>');
  });
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) return;
    const status = errorStatus(error);
    const message = controlledError(status);
    if (request.path.startsWith('/api/')) {
      response.status(status).json({ error: message });
      return;
    }
    response.status(status).type('html').send(`<!doctype html><title>请求未完成</title><p>${message}</p>`);
  });

  return app;
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  const config = parseConfig(process.env);
  const store = createDatabaseStore(config.databasePath);
  const auth = createAuth(config, store);
  const sub2api = createSub2ApiClient(config);
  const app = createApp({ config, store, auth, sub2api });
  const server = app.listen(config.port, () => {
    console.info(`Manual pay service listening on port ${config.port}`);
  });

  const close = () => server.close(() => store.close());
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
