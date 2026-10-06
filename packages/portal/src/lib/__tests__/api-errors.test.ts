// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, getApiErrorCode, getApiErrorFieldDetails } from '../api';

function res(status: number, json: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

describe('portal getApiErrorCode', () => {
  it('returns the string code', () => {
    expect(getApiErrorCode(new ApiError(409, { code: 'EMAIL_TAKEN' }))).toBe('EMAIL_TAKEN');
  });

  it.each([
    ['a plain Error', new Error('x')],
    ['a null body', new ApiError(500, null)],
    ['an array body', new ApiError(400, [])],
    ['a numeric code', new ApiError(400, { code: 1 })],
  ])('returns null for %s', (_label, err) => {
    expect(getApiErrorCode(err)).toBeNull();
  });
});

describe('portal getApiErrorFieldDetails', () => {
  it('keeps only string messages', () => {
    const err = new ApiError(400, { details: { phone: 'Invalid', age: 4 } });
    expect(getApiErrorFieldDetails(err)).toEqual({ phone: 'Invalid' });
  });

  it.each([
    ['a non-ApiError', new Error('x')],
    ['a string body', new ApiError(400, 'bad')],
    ['no details', new ApiError(400, { code: 'X' })],
    ['array details', new ApiError(400, { details: [] })],
  ])('returns an empty object for %s', (_label, err) => {
    expect(getApiErrorFieldDetails(err)).toEqual({});
  });
});

describe('portal api refresh and action logging', () => {
  let api: typeof import('../api').api;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'location', {
      value: { href: '/dashboard', pathname: '/dashboard' },
      writable: true,
      configurable: true,
    });
    api = (await import('../api')).api;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function urls(): string[] {
    return fetchMock.mock.calls.map((c) => String(c[0]));
  }

  it('retries the request after a successful refresh', async () => {
    fetchMock
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(200, { ok: 1 }));

    await expect(api.get('/v1/portal/sessions')).resolves.toEqual({ ok: 1 });
    expect(urls()[1]).toMatch(/\/v1\/portal\/auth\/refresh$/);
    expect(window.location.href).toBe('/dashboard');
  });

  it('redirects with a reason when the refresh request throws', async () => {
    fetchMock.mockResolvedValueOnce(res(401)).mockRejectedValueOnce(new TypeError('offline'));

    await expect(api.get('/v1/portal/sessions')).rejects.toMatchObject({ status: 401 });
    expect(window.location.href).toBe('/login?reason=session_expired');
  });

  it('logs a mutation with masked secrets and a singular resource name', async () => {
    fetchMock.mockResolvedValue(res(200));

    await api.post('/v1/portal/payment-methods?x=1', { token: 'tok', label: 'Visa' });

    await vi.waitFor(() => {
      expect(urls().some((u) => u.endsWith('/v1/portal/access-logs'))).toBe(true);
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/v1/portal/access-logs'));
    const body = JSON.parse((call?.[1] as RequestInit).body as string) as unknown;
    expect(body).toEqual({
      action: 'payment_method.create',
      metadata: { path: '/v1/portal/payment-methods?x=1', body: { token: '***', label: 'Visa' } },
    });
  });

  it('does not log guest calls, skipped paths or a bare portal path', async () => {
    fetchMock.mockResolvedValue(res(200));

    await api.post('/v1/portal/guest/start', { a: 1 });
    await api.post('/v1/portal/access-logs', { action: 'login' });
    await api.post('/v1/portal/auth/login', { email: 'e', password: 'p' });
    await api.post('/v1/portal/', {});
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
