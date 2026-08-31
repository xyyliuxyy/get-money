import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSub2ApiClient, AdminCredentialError, UnauthorizedError, UpstreamError } from '../src/sub2api.js';
import { sanitizeForLog } from '../src/logger.js';

const config = {
  sub2apiBaseUrl: 'https://sub.example',
  sub2apiAdminApiKey: 'admin-secret',
} as any;

afterEach(() => vi.restoreAllMocks());

describe('Sub2API client', () => {
  it('sends a server-only key and idempotency key to create-and-redeem', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const client = createSub2ApiClient(config, fetchMock);

    await client.createAndRedeem({
      code: 'manual_S2P1',
      userId: 9,
      value: '50',
      notes: 'test',
      idempotencyKey: 'manual-pay-S2P1-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://sub.example/api/v1/admin/redeem-codes/create-and-redeem',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'admin-secret',
          'Idempotency-Key': 'manual-pay-S2P1-1',
        }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      code: 'manual_S2P1',
      user_id: 9,
      value: '50',
      notes: 'test',
    });
  });

  it('verifies a user token and maps only profile fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 9, username: 'alice', email: 'a@example.test', token: 'leak' }), { status: 200 }));
    const client = createSub2ApiClient(config, fetchMock);
    await expect(client.verifyUserToken('jwt')).resolves.toEqual({ id: 9, username: 'alice', email: 'a@example.test' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://sub.example/api/v1/user/profile');
    expect(fetchMock.mock.calls[0][1].headers).toEqual(expect.objectContaining({ Authorization: 'Bearer jwt' }));
  });

  it('maps upstream authentication and other errors to safe error classes', async () => {
    const unauthorized = vi.fn().mockResolvedValue(new Response('Bearer secret', { status: 401 }));
    await expect(createSub2ApiClient(config, unauthorized).verifyUserToken('jwt')).rejects.toBeInstanceOf(UnauthorizedError);

    const adminUnauthorized = vi.fn().mockResolvedValue(new Response('api-key=secret', { status: 403 }));
    await expect(createSub2ApiClient(config, adminUnauthorized).createAndRedeem({ code: 'c', userId: 1, value: '1', notes: '', idempotencyKey: 'i' })).rejects.toBeInstanceOf(AdminCredentialError);

    const failed = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: 'secret', message: 'x'.repeat(1000) }), { status: 500 }));
    await expect(createSub2ApiClient(config, failed).verifyUserToken('jwt')).rejects.toSatisfy((error: unknown) => error instanceof UpstreamError && !String(error).includes('secret') && String(error).length < 400);
  });
});

describe('log sanitization', () => {
  it('redacts sensitive keys before logging', () => {
    expect(sanitizeForLog({ token: 'jwt', authorization: 'Bearer jwt', order_no: 'S2P1' }))
      .toEqual({ token: '[REDACTED]', authorization: '[REDACTED]', order_no: 'S2P1' });
  });

  it('redacts sensitive keys recursively in arrays', () => {
    expect(sanitizeForLog({ nested: [{ password: 'p' }, { key: 'k' }], ok: true }))
      .toEqual({ nested: [{ password: '[REDACTED]' }, { key: '[REDACTED]' }], ok: true });
  });
});
