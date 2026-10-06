// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { ApiError, getApiErrorCode, getApiErrorFieldDetails } from '../api';

function res(status: number, json: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

describe('getApiErrorCode', () => {
  it('returns the string code of an ApiError body', () => {
    expect(getApiErrorCode(new ApiError(409, { code: 'PROFILE_ID_IN_USE' }))).toBe(
      'PROFILE_ID_IN_USE',
    );
  });

  it.each([
    ['a plain Error', new Error('x')],
    ['a null body', new ApiError(500, null)],
    ['a string body', new ApiError(500, 'oops')],
    ['an array body', new ApiError(400, ['a'])],
    ['a non-string code', new ApiError(400, { code: 42 })],
    ['a body without code', new ApiError(400, { error: 'x' })],
  ])('returns null for %s', (_label, err) => {
    expect(getApiErrorCode(err)).toBeNull();
  });
});

describe('getApiErrorFieldDetails', () => {
  it('returns only string field messages', () => {
    const err = new ApiError(400, {
      code: 'VALIDATION_ERROR',
      details: { name: 'Required', count: 3, email: 'Invalid' },
    });
    expect(getApiErrorFieldDetails(err)).toEqual({ name: 'Required', email: 'Invalid' });
  });

  it.each([
    ['a non-ApiError', new TypeError('x')],
    ['a null body', new ApiError(400, null)],
    ['an array body', new ApiError(400, [])],
    ['missing details', new ApiError(400, { code: 'X' })],
    ['array details', new ApiError(400, { details: ['a'] })],
    ['string details', new ApiError(400, { details: 'bad' })],
  ])('returns an empty object for %s', (_label, err) => {
    expect(getApiErrorFieldDetails(err)).toEqual({});
  });
});

describe('api refresh and action logging', () => {
  let api: typeof import('../api').api;
  let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

  beforeEach(async () => {
    vi.resetModules();
    fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'location', {
      value: { href: '/', pathname: '/' },
      writable: true,
      configurable: true,
    });
    document.cookie = 'csms_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    api = (await import('../api')).api;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function calledUrls(): string[] {
    return fetchMock.mock.calls.map((c) => c[0]);
  }

  async function accessLogBody(): Promise<{ action: string; metadata: Record<string, unknown> }> {
    await vi.waitFor(() => {
      expect(calledUrls().some((u) => u.endsWith('/v1/access-logs'))).toBe(true);
    });
    const call = fetchMock.mock.calls.find((c) => c[0].endsWith('/v1/access-logs'));
    return JSON.parse((call?.[1] as RequestInit).body as string) as {
      action: string;
      metadata: Record<string, unknown>;
    };
  }

  it('refreshes once on 401 and retries the request', async () => {
    fetchMock
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(200, { id: 'x' }));

    await expect(api.get('/v1/stations')).resolves.toEqual({ id: 'x' });

    expect(calledUrls()).toEqual([
      expect.stringMatching(/\/v1\/stations$/),
      expect.stringMatching(/\/v1\/auth\/refresh$/),
      expect.stringMatching(/\/v1\/stations$/),
    ]);
    expect(window.location.href).toBe('/');
  });

  it('returns undefined for a 204 retry after refresh', async () => {
    fetchMock
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(204));

    await expect(api.get('/v1/stations')).resolves.toBeUndefined();
  });

  it('redirects to login when the retry after refresh still fails', async () => {
    fetchMock
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200))
      .mockResolvedValueOnce(res(401));

    const err = await api.get('/v1/stations').catch((e: unknown) => e);

    expect(err).toMatchObject({ name: 'ApiError', status: 401, body: null });
    expect(window.location.href).toBe('/login');
  });

  it('treats a refresh network error as a failed refresh', async () => {
    fetchMock.mockResolvedValueOnce(res(401)).mockRejectedValueOnce(new TypeError('offline'));

    await expect(api.get('/v1/sites')).rejects.toMatchObject({ status: 401 });
    expect(window.location.href).toBe('/login');
  });

  it('shares one refresh between concurrent 401s', async () => {
    let resolveRefresh: (r: Response) => void = () => {};
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/v1/auth/refresh')) {
        return new Promise<Response>((r) => {
          resolveRefresh = r;
        });
      }
      return Promise.resolve(res(401));
    });

    const a = api.get('/v1/a').catch((e: unknown) => e);
    const b = api.get('/v1/b').catch((e: unknown) => e);
    await vi.waitFor(() => {
      expect(calledUrls().filter((u) => u.endsWith('/v1/b'))).toHaveLength(1);
    });
    resolveRefresh(res(500));
    await Promise.all([a, b]);

    expect(calledUrls().filter((u) => u.endsWith('/v1/auth/refresh'))).toHaveLength(1);
  });

  it('logs a create action with sensitive fields masked', async () => {
    fetchMock.mockResolvedValue(res(200, { id: 1 }));

    await api.post('/v1/drivers', { email: 'a@b.c', password: 'secret', token: 'tkn' });

    const body = await accessLogBody();
    expect(body.action).toBe('driver.create');
    expect(body.metadata).toEqual({
      path: '/v1/drivers',
      body: { email: 'a@b.c', password: '***', token: '***' },
    });
  });

  it('derives the action from a hyphenated resource and drops the query string', async () => {
    fetchMock.mockResolvedValue(res(200));

    await api.patch('/v1/pricing-groups/7?x=1', { name: 'n' });

    expect((await accessLogBody()).action).toBe('pricing_group.update');
  });

  it('logs PUT as update and DELETE without a body', async () => {
    fetchMock.mockResolvedValue(res(200));
    await api.put('/v1/sites/1', { name: 's' });
    expect((await accessLogBody()).action).toBe('site.update');

    fetchMock.mockClear();
    await api.delete('/v1/tokens/1');
    const del = await accessLogBody();
    expect(del.action).toBe('token.delete');
    expect(del.metadata).toEqual({ path: '/v1/tokens/1' });
  });

  it('sends a DELETE body and logs it', async () => {
    fetchMock.mockResolvedValue(res(200));
    await api.delete('/v1/stations/bulk', { ids: ['a'] });

    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(first.body).toBe(JSON.stringify({ ids: ['a'] }));
    expect((await accessLogBody()).metadata['body']).toEqual({ ids: ['a'] });
  });

  it('sends the CSRF token on the access log request', async () => {
    document.cookie = 'csms_csrf=tok123';
    fetchMock.mockResolvedValue(res(200));

    await api.post('/v1/sites', { name: 'x' });

    await accessLogBody();
    const call = fetchMock.mock.calls.find((c) => c[0].endsWith('/v1/access-logs'));
    expect((call?.[1] as RequestInit).headers).toMatchObject({ 'X-CSRF-Token': 'tok123' });
  });

  it('does not log the access-log or login calls themselves, nor a bare /v1/ path', async () => {
    fetchMock.mockResolvedValue(res(200));

    await api.post('/v1/access-logs', { action: 'login' });
    await api.post('/v1/auth/login', { email: 'x', password: 'y' });
    await api.post('/v1/', {});
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not log a failed mutation', async () => {
    fetchMock.mockResolvedValue(res(400, { code: 'BAD' }));

    await expect(api.post('/v1/sites', { name: 'x' })).rejects.toMatchObject({
      status: 400,
      body: { code: 'BAD' },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-JSON error body as null', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: vi.fn().mockRejectedValue(new SyntaxError('bad json')),
    } as unknown as Response);

    await expect(api.get('/v1/sites')).rejects.toMatchObject({ status: 422, body: null });
  });
});
