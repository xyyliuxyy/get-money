import type { Request, RequestHandler, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig, VerifiedProfile } from './types.js';
import type { DatabaseStore, Session } from './db.js';

declare global {
  namespace Express {
    interface Request {
      userSession?: Session;
      adminSession?: Session;
    }
  }
}

export const USER_SESSION_COOKIE = 'user_session';
export const ADMIN_SESSION_COOKIE = 'admin_session';

type CookieRequest = Request & {
  signedCookies?: Record<string, string | false | undefined>;
  userSession?: Session;
  adminSession?: Session;
};

export interface Auth {
  createUserSession(response: Response, profile: VerifiedProfile): Session;
  createAdminSession(response: Response, username: string): Session;
  clearUserSession(response: Response): void;
  clearAdminSession(response: Response): void;
  requireUser: RequestHandler;
  requireAdmin: RequestHandler;
  requireCsrfAndOrigin: RequestHandler;
  getUserSession(request: Request): Session | null;
  getAdminSession(request: Request): Session | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieToken(request: CookieRequest, name: string): string | null {
  const signed = request.signedCookies?.[name];
  if (typeof signed === 'string' && signed.length > 0) return signed;
  return null;
}

function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionNow(): string {
  return new Date().toISOString();
}

function sessionExpiry(now: Date, ttlHours: number): string {
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
}

function cookieOptions(config: Pick<AppConfig, 'nodeEnv' | 'sessionTtlHours'>) {
  return {
    signed: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.nodeEnv === 'production',
    maxAge: config.sessionTtlHours * 60 * 60 * 1000,
    path: '/',
  };
}

export function createAuth(
  config: Pick<AppConfig, 'baseUrl' | 'sessionSecret' | 'sessionTtlHours' | 'nodeEnv'>,
  store: DatabaseStore,
): Auth {
  const makeSession = (
    response: Response,
    actorType: 'user' | 'admin',
    profile: VerifiedProfile | undefined,
    usernameSnapshot?: string,
  ): Session => {
    const now = new Date();
    const rawToken = randomBytes(32).toString('base64url');
    const csrfSecret = randomBytes(32).toString('base64url');
    const createdAt = now.toISOString();
    const expiresAt = sessionExpiry(now, config.sessionTtlHours);
    const session = store.createSession({
      tokenHash: hashToken(rawToken),
      actorType,
      userId: profile?.id ?? null,
      usernameSnapshot: profile?.username ?? usernameSnapshot ?? null,
      emailSnapshot: profile?.email ?? null,
      csrfSecret,
      createdAt,
      expiresAt,
    });
    // Express signs cookies with req.secret (normally installed by cookie-parser).
    const request = (response as Response & { req?: { secret?: string } }).req;
    if (request && request.secret === undefined) request.secret = config.sessionSecret;
    response.cookie(actorType === 'user' ? USER_SESSION_COOKIE : ADMIN_SESSION_COOKIE, rawToken, cookieOptions(config));
    return session;
  };

  const readSession = (request: Request, actorType: 'user' | 'admin'): Session | null => {
    const token = cookieToken(request as CookieRequest, actorType === 'user' ? USER_SESSION_COOKIE : ADMIN_SESSION_COOKIE);
    if (token === null) return null;
    return store.getSession(hashToken(token), sessionNow());
  };

  const requireActor = (actorType: 'user' | 'admin'): RequestHandler => (request, response, next) => {
    const session = readSession(request, actorType);
    if (session === null || session.actorType !== actorType || (actorType === 'user' && session.userId === null)) {
      response.sendStatus(401);
      return;
    }
    const typedRequest = request as CookieRequest;
    if (actorType === 'user') typedRequest.userSession = session;
    else typedRequest.adminSession = session;
    next();
  };

  const requireCsrfAndOrigin: RequestHandler = (request, response, next) => {
    if (request.get('Origin') !== config.baseUrl) {
      response.sendStatus(403);
      return;
    }
    const typedRequest = request as CookieRequest;
    const session = typedRequest.userSession ?? typedRequest.adminSession
      ?? readSession(request, 'user') ?? readSession(request, 'admin');
    const csrf = request.get('X-CSRF-Token');
    if (session === null || csrf === undefined || !secureEquals(csrf, session.csrfSecret)) {
      response.sendStatus(403);
      return;
    }
    next();
  };

  const clear = (response: Response, name: string): void => {
    response.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', path: '/' });
  };

  return {
    createUserSession: (response, profile) => makeSession(response, 'user', profile),
    createAdminSession: (response, username) => makeSession(response, 'admin', undefined, username),
    clearUserSession: (response) => clear(response, USER_SESSION_COOKIE),
    clearAdminSession: (response) => clear(response, ADMIN_SESSION_COOKIE),
    requireUser: requireActor('user'),
    requireAdmin: requireActor('admin'),
    requireCsrfAndOrigin,
    getUserSession: (request) => readSession(request, 'user'),
    getAdminSession: (request) => readSession(request, 'admin'),
  };
}

// Convenience adapters for code that prefers named middleware factories.
export function requireUser(auth: Auth): RequestHandler { return auth.requireUser; }
export function requireAdmin(auth: Auth): RequestHandler { return auth.requireAdmin; }
export function requireCsrfAndOrigin(auth: Auth): RequestHandler { return auth.requireCsrfAndOrigin; }
