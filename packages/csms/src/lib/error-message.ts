// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ParseKeys, TFunction } from 'i18next';
import { ApiError } from './api';

// Never show ApiError.message ("API error 400") or a fetch TypeError ("Failed to fetch").
// Other Errors keep their message because callers throw them with translated text.
export function getErrorMessage(
  error: unknown,
  t: TFunction,
  fallbackKey: ParseKeys = 'errors.unknown',
): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (body != null && typeof body === 'object' && !Array.isArray(body)) {
      const {
        code,
        error: message,
        details,
      } = body as {
        code?: unknown;
        error?: unknown;
        details?: unknown;
      };
      if (typeof code === 'string' && code !== '') {
        const key = `errors.${code}` as 'errors.unknown';
        const translated: string = t(key);
        if (translated !== key) {
          // A message that names values takes them from the reply's details.
          const replace = scalarDetails(details);
          return Object.keys(replace).length > 0 ? t(key, { replace }) : translated;
        }
      }
      if (typeof message === 'string' && message !== '') return message;
    }
    // A gateway answer without a body: the API itself never answered.
    if (fallbackKey === 'errors.unknown' && GATEWAY_STATUSES.has(error.status)) {
      return t('errors.networkError');
    }
    return t(fallbackKey);
  }
  if (error instanceof Error && !(error instanceof TypeError)) return error.message;
  // A fetch TypeError: the request never reached the server.
  if (error instanceof TypeError && fallbackKey === 'errors.unknown') {
    return t('errors.networkError');
  }
  return t(fallbackKey);
}

const GATEWAY_STATUSES = new Set([502, 503, 504]);

// The string and number fields of a reply's details fill the placeholders of its translated message.
function scalarDetails(details: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (details == null || typeof details !== 'object' || Array.isArray(details)) return out;
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

// A throttled request (429 RATE_LIMITED) gets the translated "too many requests" text, so a
// page that maps its own failures (wrong password, invalid code) never shows those instead.
export function rateLimitedMessage(error: unknown, t: TFunction): string | null {
  return isRateLimited(error) ? t('errors.RATE_LIMITED') : null;
}

// True for a throttled request (429 or code RATE_LIMITED). For pages that keep the error as a
// translation key (errors.RATE_LIMITED) and translate it at render.
export function isRateLimited(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const body = error.body as { code?: unknown } | null;
  const code = body != null && typeof body === 'object' ? body.code : undefined;
  return error.status === 429 || code === 'RATE_LIMITED';
}
