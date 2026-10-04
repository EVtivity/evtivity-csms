// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ParseKeys, TFunction } from 'i18next';

const PROVIDER_NAME_KEYS: Record<string, ParseKeys> = {
  stripe: 'paymentProviders.names.stripe',
  adyen: 'paymentProviders.names.adyen',
  simulated: 'paymentProviders.names.simulated',
};

/** Display name of a payment provider id; a plugin id without a name shows as is. */
export function providerLabel(provider: string, t: TFunction): string {
  const key = Object.hasOwn(PROVIDER_NAME_KEYS, provider) ? PROVIDER_NAME_KEYS[provider] : null;
  return key != null ? t(key) : provider;
}
