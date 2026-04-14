// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../api';

function createMockResponse(overrides: Partial<Response> & { jsonData?: unknown } = {}): Response {
  const { jsonData = {}, ...rest } = overrides;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    redirected: false,
    type: 'basic' as ResponseType,
    url: '',
    clone: vi.fn(),
    body: null,
    bodyUsed: false,
    arrayBuffer: vi.fn(),
    blob: vi.fn(),
    formData: vi.fn(),
    text: vi.fn().mockResolvedValue(JSON.stringify(jsonData)),
    json: vi.fn().mockResolvedValue(jsonData),
    bytes: vi.fn(),
    ...rest,
  } as unknown as Response;
}

describe('ApiError', () => {
  it('creates error with status and body', () => {
    const error = new ApiError(404, { message: 'Not found' });
    expect(error.status).toBe(404);
    expect(error.body).toEqual({ message: 'Not found' });
    expect(error.name).toBe('ApiError');
    expect(error.message).toBe('API error 404');
  });

  it('is an instance of Error', () => {
    const error = new ApiError(500, null);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('api', () => {
  let api: typeof import('../api').api;
  let DynApiError: typeof import('../api').ApiError;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    Object.defineProperty(window, 'location', {
      value: { href: '/', pathname: '/' },
      writable: true,
      configurable: true,
    });

    localStorage.clear();

    const mod = await import('../api');
    api = mod.api;
    DynApiError = mod.ApiError;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('error handling', () => {
    it('throws ApiError on non-ok response', async () => {
      const errorBody = { message: 'Not found' };
      fetchMock.mockResolvedValue(
        createMockResponse({ ok: false, status: 404, jsonData: errorBody }),
      );

      await expect(api.get('/v1/missing')).rejects.toThrow(DynApiError);
    });

    it('includes status and body in ApiError', async () => {
      const errorBody = { error: 'Validation error' };
      fetchMock.mockResolvedValue(
        createMockResponse({ ok: false, status: 400, jsonData: errorBody }),
      );

      await expect(api.get('/v1/items')).rejects.toMatchObject({
        status: 400,
        body: errorBody,
      });
    });

    it('sets body to null when error response has no JSON', async () => {
      fetchMock.mockResolvedValue(
        createMockResponse({
          ok: false,
          status: 500,
          json: vi.fn().mockRejectedValue(new Error('not json')),
        }),
      );

      await expect(api.get('/v1/broken')).rejects.toMatchObject({
        status: 500,
        body: null,
      });
    });

    it('does not hard-redirect on 401 from /users/me (hydration endpoint)', async () => {
      window.location.href = '/dashboard';
      fetchMock.mockResolvedValue(createMockResponse({ ok: false, status: 401, jsonData: null }));

      await expect(api.get('/v1/users/me')).rejects.toThrow(DynApiError);
      // ProtectedRoute handles the redirect, not api.ts
      expect(window.location.href).toBe('/dashboard');
    });

    it('redirects to /login on 401 from a normal endpoint', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ ok: false, status: 401, jsonData: null }));

      await expect(api.get('/v1/stations')).rejects.toThrow(DynApiError);
      expect(window.location.href).toBe('/login');
    });

    it('does not redirect on 401 from /auth/login endpoint', async () => {
      window.location.href = '/login';
      fetchMock.mockResolvedValue(
        createMockResponse({ ok: false, status: 401, jsonData: { code: 'INVALID_CREDENTIALS' } }),
      );

      await expect(
        api.post('/v1/auth/login', { email: 'a@b.com', password: 'wrong' }),
      ).rejects.toThrow(DynApiError);
      expect(window.location.href).toBe('/login');
    });

    it('does not redirect on non-401 errors', async () => {
      window.location.href = '/dashboard';
      fetchMock.mockResolvedValue(
        createMockResponse({ ok: false, status: 403, jsonData: { error: 'forbidden' } }),
      );

      await expect(api.get('/v1/admin')).rejects.toThrow(DynApiError);
      expect(window.location.href).toBe('/dashboard');
    });
  });

  describe('request handling', () => {
    it('sends GET request', async () => {
      const data = { id: 1 };
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: data }));

      const result = await api.get('/v1/items');
      expect(result).toEqual(data);
    });

    it('sends POST request with JSON body', async () => {
      const body = { name: 'test' };
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: { id: 1 } }));

      await api.post('/v1/items', body);

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].method).toBe('POST');
      expect(callArgs[1].body).toBe(JSON.stringify(body));
    });

    it('includes credentials: include on all requests', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.get('/v1/items');

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].credentials).toBe('include');
    });

    it('includes X-CSRF-Token header on mutating requests when csrf cookie exists', async () => {
      Object.defineProperty(document, 'cookie', {
        value: 'csms_csrf=test-csrf-token',
        writable: true,
        configurable: true,
      });
      vi.resetModules();
      const mod = await import('../api');

      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await mod.api.post('/v1/items', { name: 'test' });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBe('test-csrf-token');
    });

    it('returns undefined for 204 responses', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ ok: true, status: 204 }));

      const result = await api.delete('/v1/items/1');
      expect(result).toBeUndefined();
    });
  });
});
