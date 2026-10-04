// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { ApiError, getApiErrorCode } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

/**
 * The translated error of a payment provider call, followed by what the
 * provider said when it refused the call (Stripe's or Adyen's message, for
 * example a platform setting to acknowledge) or the missing credential
 * permission. Both come from the provider, so they stay untranslated.
 */
export function providerErrorMessage(err: unknown, t: TFunction): string {
  const message = getErrorMessage(err, t);
  if (!(err instanceof ApiError)) return message;
  const body = err.body as { error?: unknown; permission?: unknown } | null;
  const code = getApiErrorCode(err);
  if (code === 'PAYMENT_PROVIDER_PERMISSION_MISSING' && typeof body?.permission === 'string') {
    return `${message}: ${body.permission}`;
  }
  if (
    code === 'PAYMENT_PROVIDER_CONNECTION_FAILED' &&
    typeof body?.error === 'string' &&
    body.error !== '' &&
    body.error !== message
  ) {
    return `${message}: ${body.error}`;
  }
  return message;
}
