// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { API_BASE_URL } from './config';

const BASE_URL = API_BASE_URL;

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)portal_csrf=([^;]*)/);
  return match?.[1] ?? null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${String(status)}`);
    this.name = 'ApiError';
  }

  get isServerDown(): boolean {
    return (
      this.status === 0 ||
      this.status === 500 ||
      this.status === 502 ||
      this.status === 503 ||
      this.status === 504
    );
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let refreshPromise: Promise<boolean> | null = null;

const PUBLIC_PATHS = new Set([
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/privacy-policy',
  '/terms-of-service',
]);

function isPublicPage(): boolean {
  const p = window.location.pathname;
  return (
    PUBLIC_PATHS.has(p) ||
    p.startsWith('/charge') ||
    p.startsWith('/guest-session') ||
    p.startsWith('/location')
  );
}

async function attemptRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/v1/portal/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  const method = init?.method ?? 'GET';
  if (MUTATING_METHODS.has(method)) {
    const csrf = getCsrfToken();
    if (csrf != null) {
      headers['X-CSRF-Token'] = csrf;
    }
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (
    res.status === 401 &&
    !path.endsWith('/auth/login') &&
    !path.endsWith('/auth/refresh') &&
    !path.endsWith('/auth/register')
  ) {
    // Deduplicate concurrent refresh attempts
    if (refreshPromise == null) {
      refreshPromise = attemptRefresh().finally(() => {
        refreshPromise = null;
      });
    }

    const refreshed = await refreshPromise;

    if (refreshed) {
      // Retry original request with new cookie
      const retryRes = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers,
        credentials: 'include',
      });
      if (retryRes.ok) {
        return retryRes.json() as Promise<T>;
      }
    }

    // Refresh failed - redirect to login with reason (unless on public page)
    if (!isPublicPage()) {
      window.location.href = '/login?reason=session_expired';
    }
    throw new ApiError(401, null);
  }

  if (!res.ok) {
    const body: unknown = await (res.json() as Promise<unknown>).catch(() => null);
    throw new ApiError(res.status, body);
  }

  return res.json() as Promise<T>;
}

const METHOD_VERBS: Record<string, string> = {
  POST: 'create',
  PATCH: 'update',
  PUT: 'update',
  DELETE: 'delete',
};

const SKIP_ACTION_LOG = new Set(['/v1/portal/access-logs', '/v1/portal/auth/login']);

function deriveAction(method: string, path: string): string | null {
  if (SKIP_ACTION_LOG.has(path)) return null;
  const verb = METHOD_VERBS[method];
  if (verb == null) return null;
  const pathOnly = path.split('?')[0] ?? path;
  const segments = pathOnly.replace(/^\/v1\/portal\//, '').split('/');
  const resource = segments[0];
  if (resource == null || resource === '') return null;
  const singular = resource.replace(/-/g, '_').replace(/s$/, '');
  return `${singular}.${verb}`;
}

const SENSITIVE_KEYS = new Set(['password', 'currentPassword', 'newPassword', 'token', 'secret']);

function sanitizeBody(body: unknown): Record<string, unknown> | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      clean[key] = '***';
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function logAction(method: string, path: string, body?: unknown): void {
  if (path.startsWith('/v1/portal/guest/')) return;
  const action = deriveAction(method, path);
  if (action == null) return;
  const metadata: Record<string, unknown> = { path };
  const sanitized = sanitizeBody(body);
  if (sanitized != null) {
    metadata['body'] = sanitized;
  }
  request('/v1/portal/access-logs', {
    method: 'POST',
    body: JSON.stringify({ action, metadata }),
  }).catch(() => {});
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>(path);
  },
  post<T>(path: string, body: unknown): Promise<T> {
    const result = request<T>(path, { method: 'POST', body: JSON.stringify(body) });
    result
      .then(() => {
        logAction('POST', path, body);
      })
      .catch(() => {});
    return result;
  },
  put<T>(path: string, body: unknown): Promise<T> {
    const result = request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
    result
      .then(() => {
        logAction('PUT', path, body);
      })
      .catch(() => {});
    return result;
  },
  patch<T>(path: string, body: unknown): Promise<T> {
    const result = request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
    result
      .then(() => {
        logAction('PATCH', path, body);
      })
      .catch(() => {});
    return result;
  },
  delete<T>(path: string, body?: unknown): Promise<T> {
    const result = request<T>(path, {
      method: 'DELETE',
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    result
      .then(() => {
        logAction('DELETE', path, body);
      })
      .catch(() => {});
    return result;
  },
};
