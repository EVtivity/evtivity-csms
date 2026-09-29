// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { DEFAULT_CURRENCY, isSupportedCurrency } from '@evtivity/lib/currency';

/**
 * Resolve the platform currency from the `/v1/portal/branding` response, which
 * exposes `company.*` settings without their prefix. Returns undefined while
 * loading. Falls back to DEFAULT_CURRENCY when the setting is unset or not a
 * supported currency, matching the server.
 */
export function resolveCompanyCurrency(
  branding: Record<string, string> | undefined,
): string | undefined {
  if (branding == null) return undefined;
  const value = branding['currency'];
  return isSupportedCurrency(value) ? value : DEFAULT_CURRENCY;
}
