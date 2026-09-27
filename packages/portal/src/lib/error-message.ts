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
