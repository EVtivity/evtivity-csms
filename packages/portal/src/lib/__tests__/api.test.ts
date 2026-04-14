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

  it('stores numeric status codes', () => {
    const error = new ApiError(422, { errors: ['invalid'] });
    expect(error.status).toBe(422);
    expect(error.body).toEqual({ errors: ['invalid'] });
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
      value: { href: '/', pathname: '/dashboard' },
      writable: true,
      configurable: true,
    });

    // Clear cookies
    document.cookie = 'portal_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';

    const mod = await import('../api');
    api = mod.api;
    DynApiError = mod.ApiError;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('api.get', () => {
    it('sends GET request with correct headers', async () => {
      const data = { id: 1, name: 'test' };
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: data }));

      const result = await api.get('/v1/portal/items');

      expect(fetchMock).toHaveBeenCalledWith('/v1/portal/items', {
        headers: {},
        credentials: 'include',
      });
      expect(result).toEqual(data);
    });

    it('returns parsed JSON data', async () => {
      const data = [{ id: 1 }, { id: 2 }];
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: data }));

      const result = await api.get<typeof data>('/v1/portal/list');
      expect(result).toEqual(data);
    });

    it('does not include CSRF token for GET requests', async () => {
      document.cookie = 'portal_csrf=abc123';
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.get('/v1/portal/items');

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBeUndefined();
    });
  });

  describe('api.post', () => {
    it('sends POST request with JSON body', async () => {
      const body = { name: 'new item' };
      const response = { id: 1, name: 'new item' };
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: response }));

      const result = await api.post('/v1/portal/items', body);

      expect(fetchMock).toHaveBeenCalledWith('/v1/portal/items', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        credentials: 'include',
      });
      expect(result).toEqual(response);
    });

    it('includes CSRF token from cookie', async () => {
      document.cookie = 'portal_csrf=token123';
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/items', { name: 'test' });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBe('token123');
    });

    it('omits CSRF header when no cookie is present', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/items', { name: 'test' });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBeUndefined();
    });

    it('logs action after successful request', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: { id: 1 } }));

      await api.post('/v1/portal/items', { name: 'test' });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const logCall = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(logCall[0]).toBe('/v1/portal/access-logs');
      const logBody = JSON.parse(logCall[1].body as string) as {
        action: string;
        metadata: unknown;
      };
      expect(logBody.action).toBe('item.create');
    });

    it('does not log action for skipped paths', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/access-logs', { action: 'test' });

      await new Promise((r) => setTimeout(r, 50));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not log action for login path', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/auth/login', { email: 'a@b.com', password: 'pw' });

      await new Promise((r) => setTimeout(r, 50));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('api.put', () => {
    it('sends PUT request with JSON body', async () => {
      const body = { name: 'updated' };
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: { id: 1, name: 'updated' } }));

      await api.put('/v1/portal/items/1', body);

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].method).toBe('PUT');
      expect(callArgs[1].body).toBe(JSON.stringify(body));
    });

    it('includes CSRF token for PUT requests', async () => {
      document.cookie = 'portal_csrf=csrf-put';
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.put('/v1/portal/items/1', { name: 'test' });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBe('csrf-put');
    });

    it('logs action with update verb', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.put('/v1/portal/drivers/123', { name: 'updated' });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const logCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const logBody = JSON.parse(logCall[1].body as string) as { action: string };
      expect(logBody.action).toBe('driver.update');
    });
  });

  describe('api.patch', () => {
    it('sends PATCH request with JSON body', async () => {
      const body = { status: 'active' };
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.patch('/v1/portal/items/1', body);

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].method).toBe('PATCH');
      expect(callArgs[1].body).toBe(JSON.stringify(body));
    });

    it('includes CSRF token for PATCH requests', async () => {
      document.cookie = 'portal_csrf=csrf-patch';
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.patch('/v1/portal/items/1', { status: 'active' });

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBe('csrf-patch');
    });

    it('logs action with update verb', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.patch('/v1/portal/support-cases/1', { status: 'resolved' });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const logCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const logBody = JSON.parse(logCall[1].body as string) as { action: string };
      expect(logBody.action).toBe('support_case.update');
    });
  });

  describe('api.delete', () => {
    it('sends DELETE request without body', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.delete('/v1/portal/items/1');

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].method).toBe('DELETE');
      expect(callArgs[1].body).toBeUndefined();
    });

    it('includes CSRF token for DELETE requests', async () => {
      document.cookie = 'portal_csrf=csrf-del';
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.delete('/v1/portal/items/1');

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBe('csrf-del');
    });

    it('logs action with delete verb', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.delete('/v1/portal/sessions/abc');

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const logCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const logBody = JSON.parse(logCall[1].body as string) as { action: string };
      expect(logBody.action).toBe('session.delete');
    });
  });

  describe('error handling', () => {
    it('throws ApiError on non-ok response', async () => {
      const errorBody = { message: 'Not found' };
      fetchMock.mockResolvedValue(
        createMockResponse({ ok: false, status: 404, jsonData: errorBody }),
      );

      await expect(api.get('/v1/portal/missing')).rejects.toThrow(DynApiError);
    });

    it('includes status and body in ApiError', async () => {
      const errorBody = { message: 'Not found' };
      fetchMock.mockResolvedValue(
        createMockResponse({ ok: false, status: 404, jsonData: errorBody }),
      );

      await expect(api.get('/v1/portal/missing')).rejects.toMatchObject({
        status: 404,
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

      await expect(api.get('/v1/portal/broken')).rejects.toMatchObject({
        status: 500,
        body: null,
      });
    });

    it('redirects to /login on 401 from a normal page', async () => {
      window.location.pathname = '/dashboard';
      fetchMock.mockResolvedValue(createMockResponse({ ok: false, status: 401, jsonData: null }));

      await expect(api.get('/v1/portal/me')).rejects.toThrow(DynApiError);
      expect(window.location.href).toBe('/login?reason=session_expired');
    });

    it('does not redirect to /login on 401 from /charge path', async () => {
      window.location.pathname = '/charge/abc';
      window.location.href = '/charge/abc';
      fetchMock.mockResolvedValue(createMockResponse({ ok: false, status: 401, jsonData: null }));

      await expect(api.get('/v1/portal/me')).rejects.toThrow(DynApiError);
      expect(window.location.href).toBe('/charge/abc');
    });

    it('does not redirect to /login on 401 from /guest-session path', async () => {
      window.location.pathname = '/guest-session/xyz';
      window.location.href = '/guest-session/xyz';
      fetchMock.mockResolvedValue(createMockResponse({ ok: false, status: 401, jsonData: null }));

      await expect(api.get('/v1/portal/me')).rejects.toThrow(DynApiError);
      expect(window.location.href).toBe('/guest-session/xyz');
    });

    it('does not redirect on non-401 errors', async () => {
      window.location.pathname = '/dashboard';
      window.location.href = '/dashboard';
      fetchMock.mockResolvedValue(
        createMockResponse({ ok: false, status: 403, jsonData: { error: 'forbidden' } }),
      );

      await expect(api.get('/v1/portal/admin')).rejects.toThrow(DynApiError);
      expect(window.location.href).toBe('/dashboard');
    });
  });

  describe('CSRF token parsing', () => {
    it('reads csrf token from cookie with other cookies present', async () => {
      document.cookie = 'session=abc';
      document.cookie = 'portal_csrf=my-csrf-token';
      document.cookie = 'other=xyz';
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/items', {});

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBe('my-csrf-token');
    });

    it('handles csrf token at the start of cookie string', async () => {
      document.cookie = 'portal_csrf=first-token';
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/items', {});

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBe('first-token');
    });
  });

  describe('action logging details', () => {
    it('sanitizes sensitive fields in log body', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/auth/register', {
        email: 'user@test.com',
        password: 'secret123',
        currentPassword: 'old',
        newPassword: 'new',
        token: 'tkn',
        secret: 'shhh',
        name: 'Test User',
      });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const logCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const logBody = JSON.parse(logCall[1].body as string) as {
        action: string;
        metadata: { body: Record<string, unknown>; path: string };
      };
      const sanitized = logBody.metadata.body;
      expect(sanitized['password']).toBe('***');
      expect(sanitized['currentPassword']).toBe('***');
      expect(sanitized['newPassword']).toBe('***');
      expect(sanitized['token']).toBe('***');
      expect(sanitized['secret']).toBe('***');
      expect(sanitized['email']).toBe('user@test.com');
      expect(sanitized['name']).toBe('Test User');
    });

    it('includes path in log metadata', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/support-cases', { subject: 'help' });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const logCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const logBody = JSON.parse(logCall[1].body as string) as {
        metadata: { path: string };
      };
      expect(logBody.metadata.path).toBe('/v1/portal/support-cases');
    });

    it('derives action from resource name with hyphens converted to underscores', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/support-cases', { subject: 'test' });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const logCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const logBody = JSON.parse(logCall[1].body as string) as { action: string };
      expect(logBody.action).toBe('support_case.create');
    });

    it('strips trailing s from resource name to create singular', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/drivers', { name: 'test' });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const logCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const logBody = JSON.parse(logCall[1].body as string) as { action: string };
      expect(logBody.action).toBe('driver.create');
    });

    it('strips query params when deriving action', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.post('/v1/portal/items?page=1&limit=10', { name: 'test' });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const logCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const logBody = JSON.parse(logCall[1].body as string) as { action: string };
      expect(logBody.action).toBe('item.create');
    });

    it('does not log on failed request', async () => {
      fetchMock.mockResolvedValue(
        createMockResponse({ ok: false, status: 400, jsonData: { error: 'bad' } }),
      );

      await expect(api.post('/v1/portal/items', { bad: true })).rejects.toThrow(DynApiError);

      await new Promise((r) => setTimeout(r, 50));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not crash if log request fails', async () => {
      fetchMock
        .mockResolvedValueOnce(createMockResponse({ jsonData: { id: 1 } }))
        .mockRejectedValueOnce(new Error('network error'));

      const result = await api.post('/v1/portal/items', { name: 'test' });
      expect(result).toEqual({ id: 1 });

      await new Promise((r) => setTimeout(r, 50));
    });

    it('does not include body in log for DELETE requests', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.delete('/v1/portal/items/1');

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      const logCall = fetchMock.mock.calls[1] as [string, RequestInit];
      const logBody = JSON.parse(logCall[1].body as string) as {
        metadata: { path: string; body?: unknown };
      };
      expect(logBody.metadata['body']).toBeUndefined();
    });
  });

  describe('credentials', () => {
    it('always sends credentials include', async () => {
      fetchMock.mockResolvedValue(createMockResponse({ jsonData: {} }));

      await api.get('/v1/portal/me');

      const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].credentials).toBe('include');
    });
  });
});
