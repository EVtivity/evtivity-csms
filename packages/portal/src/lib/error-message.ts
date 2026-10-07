// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { ApiError } from './api';

// Never returns Error.message: "API error 400" and "Failed to fetch" are not driver text.
export function getErrorMessage(
  error: unknown,
  t: TFunction,
  fallbackKey = 'errors.unknown',
): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (body != null && typeof body === 'object' && !Array.isArray(body)) {
      const { code, error: message } = body as { code?: unknown; error?: unknown };
      if (typeof code === 'string' && code !== '') {
        const key = `errors.${code}`;
        const translated = t(key);
        if (translated !== key) return translated;
      }
      if (typeof message === 'string' && message !== '') return message;
    }
  }
  return t(fallbackKey);
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
