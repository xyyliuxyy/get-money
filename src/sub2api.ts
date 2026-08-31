import type { AppConfig, Sub2ApiClient, VerifiedProfile } from './types.js';
import { sanitizeForLog, sanitizeMessage } from './logger.js';

export class UnauthorizedError extends Error {
  readonly status = 401;

  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export class AdminCredentialError extends Error {
  readonly status = 502;
  readonly statusCode = 502;

  constructor() {
    super('Sub2API administrator credentials were rejected');
    this.name = 'AdminCredentialError';
  }
}

export class UpstreamError extends Error {
  readonly statusCode: number;
  readonly status: number;

  constructor(statusCode: number, message: string) {
    super(`Sub2API upstream error (${statusCode}): ${sanitizeMessage(message)}`);
    this.name = 'UpstreamError';
    this.statusCode = statusCode;
    this.status = statusCode;
  }
}

type FetchLike = typeof fetch;

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/+$/, '')}/`).toString();
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed: unknown = JSON.parse(text);
      return JSON.stringify(sanitizeForLog(parsed));
    } catch {
      return sanitizeMessage(text.slice(0, 2000));
    }
  } catch {
    return 'unreadable upstream response';
  }
}

function profileFromPayload(payload: unknown): VerifiedProfile {
  const candidate = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const nested = candidate.data && typeof candidate.data === 'object'
    ? candidate.data as Record<string, unknown>
    : candidate.profile && typeof candidate.profile === 'object'
      ? candidate.profile as Record<string, unknown>
      : candidate;
  const id = typeof nested.id === 'number' ? nested.id : Number(nested.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new UpstreamError(200, 'invalid profile response');
  }
  const profile: VerifiedProfile = { id };
  if (typeof nested.username === 'string') profile.username = nested.username;
  if (typeof nested.email === 'string') profile.email = nested.email;
  return profile;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new UpstreamError(response.status, 'invalid JSON response');
  }
}

export function createSub2ApiClient(
  config: Pick<AppConfig, 'sub2apiBaseUrl' | 'sub2apiAdminApiKey'>,
  fetchImpl: FetchLike = fetch,
): Sub2ApiClient {
  const baseUrl = config.sub2apiBaseUrl;
  const adminApiKey = config.sub2apiAdminApiKey;

  const request = async (url: string, init: RequestInit, kind: 'user' | 'admin'): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      throw new UpstreamError(0, 'network request failed');
    }
    if (response.status >= 200 && response.status < 300) return response;
    if (kind === 'user' && (response.status === 401 || response.status === 403)) {
      throw new UnauthorizedError();
    }
    if (kind === 'admin' && (response.status === 401 || response.status === 403)) {
      throw new AdminCredentialError();
    }
    throw new UpstreamError(response.status, await responseMessage(response));
  };

  return {
    async verifyUserToken(token) {
      const response = await request(endpoint(baseUrl, '/api/v1/user/profile'), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      }, 'user');
      return profileFromPayload(await parseJson(response));
    },

    async createAndRedeem(input) {
      await request(endpoint(baseUrl, '/api/v1/admin/redeem-codes/create-and-redeem'), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': adminApiKey,
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          code: input.code,
          user_id: input.userId,
          value: input.value,
          notes: input.notes,
        }),
      }, 'admin');
    },
  };
}
