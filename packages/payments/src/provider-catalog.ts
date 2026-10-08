// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PaymentProviderNotConfiguredError } from './errors.js';
import { providerUpgradePending } from './provider-switch-guard.js';
import type { ProviderUpgradePendingDetails } from './provider-switch-guard.js';
import type { ProcessWatchStore } from '@evtivity/database';
import { adyenCapabilities, ADYEN_PROVIDER_ID } from './providers/adyen/index.js';
import { STRIPE_CAPABILITIES, STRIPE_PROVIDER_ID } from './providers/stripe/index.js';
import type { PaymentProviderRegistry } from './registry.js';
import type { PaymentProviderId, ProviderCapabilities } from './types.js';

export type ProviderCatalogCapabilities = Pick<
  ProviderCapabilities,
  'savedMethods' | 'clientActions' | 'nativeMobileSheet' | 'marketplaceSplit'
>;

export interface ProviderCatalogEntry {
  id: PaymentProviderId;
  /** The provider has its credentials (it can be built). */
  configured: boolean;
  /** The provider can be selected for new payments (`payments.provider`). */
  selectable: boolean;
  /**
   * Why it cannot be selected: no credentials, or the provider-switch guard
   * sees processes of an older release. Null when selectable.
   */
  reason: 'not_configured' | 'requires_upgrade' | null;
  /**
   * The provider-switch guard's refusal (old processes still connected), or
   * null. Set only for a configured provider the guard covers.
   */
  upgradePending: ProviderUpgradePendingDetails | null;
  capabilities: ProviderCatalogCapabilities;
}

/**
 * Capabilities of a built-in provider that cannot be built without its
 * credentials. Adyen reports the top-up variant, the default of
 * `adyen.authorisationAdjustment`; the fields listed here do not depend on it.
 */
const UNBUILT_CAPABILITIES: Record<string, ProviderCapabilities> = {
  [STRIPE_PROVIDER_ID]: STRIPE_CAPABILITIES,
  [ADYEN_PROVIDER_ID]: adyenCapabilities(false),
};

/** A provider of a plugin that cannot be built: nothing is assumed. */
const NO_CAPABILITIES: ProviderCatalogCapabilities = {
  savedMethods: false,
  clientActions: false,
  nativeMobileSheet: false,
  marketplaceSplit: 'none',
};

function pickCapabilities(capabilities: ProviderCapabilities): ProviderCatalogCapabilities {
  return {
    savedMethods: capabilities.savedMethods,
    clientActions: capabilities.clientActions,
    nativeMobileSheet: capabilities.nativeMobileSheet,
    marketplaceSplit: capabilities.marketplaceSplit,
  };
}

/**
 * Every provider registered in this process, for the provider select of the
 * payment settings. A configured provider is selectable unless the
 * provider-switch guard refuses it (`watchStore` holds the worker's
 * process-version watch), so the select shows a guarded provider as
 * requiring the upgrade while processes of an older release run. A provider without credentials is listed as not
 * configured; any other error (a setting that cannot be decrypted, a failed
 * guard check) is thrown (P9).
 */
export async function describePaymentProviders(
  registry: PaymentProviderRegistry,
  watchStore: ProcessWatchStore,
): Promise<ProviderCatalogEntry[]> {
  const entries: ProviderCatalogEntry[] = [];
  for (const id of registry.registeredIds()) {
    let capabilities: ProviderCatalogCapabilities;
    let configured: boolean;
    try {
      const provider = await registry.getPaymentProvider(id);
      capabilities = pickCapabilities(provider.capabilities);
      configured = true;
    } catch (err) {
      if (!(err instanceof PaymentProviderNotConfiguredError)) throw err;
      const known = UNBUILT_CAPABILITIES[id];
      capabilities = known != null ? pickCapabilities(known) : NO_CAPABILITIES;
      configured = false;
    }
    const upgradePending = configured ? await providerUpgradePending(id, watchStore) : null;
    const selectable = configured && upgradePending == null;
    entries.push({
      id,
      configured,
      selectable,
      reason: !configured ? 'not_configured' : selectable ? null : 'requires_upgrade',
      upgradePending,
      capabilities,
    });
  }
  return entries;
}
