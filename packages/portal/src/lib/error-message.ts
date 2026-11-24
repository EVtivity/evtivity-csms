// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { ApiError } from './api';
import { formatNumberUpTo } from './utils';

// Never returns Error.message: "API error 400" and "Failed to fetch" are not driver text.
export function getErrorMessage(
  error: unknown,
  t: TFunction,
  fallbackKey = 'errors.unknown',
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
        const key = `errors.${code}`;
        const translated = t(key);
        if (translated !== key) {
          // A message that names values takes them from the reply's details.
          const replace = scalarDetails(details);
          return Object.keys(replace).length > 0 ? t(key, { replace }) : translated;
        }
      }
      if (typeof message === 'string' && message !== '') return message;
    }
  }
  return t(fallbackKey);
}

// The string and number fields of a reply's details fill the placeholders of its translated
// message, numbers in the UI language (19,2 in German).
function scalarDetails(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (details == null || typeof details !== 'object' || Array.isArray(details)) return out;
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = formatNumberUpTo(v, 2);
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
