// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PaymentProviderModule } from './types';

// Each provider's UI is its own chunk, loaded only when the API names that provider.
const MODULES: Record<string, () => Promise<{ default: PaymentProviderModule }>> = {
  stripe: () => import('./stripe'),
  simulated: () => import('./simulated'),
  adyen: () => import('./adyen'),
};

export function isPaymentModuleRegistered(id: string): boolean {
  return Object.hasOwn(MODULES, id);
}

/** Loads the UI module for a provider id, or returns null when this app has none. */
export function loadPaymentModule(id: string): Promise<PaymentProviderModule> | null {
  if (!isPaymentModuleRegistered(id)) return null;
  const load = MODULES[id];
  if (load == null) return null;
  return load().then((mod) => mod.default);
}
