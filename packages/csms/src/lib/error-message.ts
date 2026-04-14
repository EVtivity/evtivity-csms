// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { ApiError } from './api';

export function getErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    const body = error.body as { code?: string; error?: string } | null;
    if (body?.code != null) {
      const key = `errors.${body.code}` as 'errors.unknown';
      const translated: string = t(key);
      if (translated !== key) return translated;
    }
    if (body?.error != null) return body.error;
  }
  if (error instanceof Error) return error.message;
  return t('errors.unknown');
}
