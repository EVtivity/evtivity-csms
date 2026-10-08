// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { releaseUpgradePending } from '@evtivity/database';
import type { ProcessWatchStore } from '@evtivity/database';
import type { PaymentProviderId } from './types.js';

/**
 * Provider-switch guard (Payments P10, plan section 2.2, layer 1).
 *
 * Processes of releases before v0.1.38 refuse Adyen as the active provider
 * and then treat payments as off (guests charge for free, portal starts skip
 * the pre-auth), send Adyen cards to Stripe, and fail Adyen holds they try to
 * settle. So `payments.provider` may become a guarded provider only while no
 * such process can be running. The check and the worker's process-version
 * watch are the shared release guard (`releaseUpgradePending` in
 * @evtivity/database, `process-versions.ts`): no `postgres.js` connection now,
 * a fresh watch, and none seen for LEGACY_CLEAN_MS.
 */

/** Providers an older process mishandles: selecting one is guarded. */
export const GUARDED_PROVIDER_IDS: readonly PaymentProviderId[] = ['adyen'];

/** Why a guarded provider cannot be selected now (the 409 `details`). */
export interface ProviderUpgradePendingDetails {
  legacyConnections: number;
  hosts: string[];
  lastLegacySeenAt: string | null;
  watchCheckedAt: string | null;
}

/** Selecting the provider is refused while processes of an older release may run. */
export class PaymentProviderUpgradePendingError extends Error {
  readonly providerId: string;
  readonly details: ProviderUpgradePendingDetails;

  constructor(providerId: string, details: ProviderUpgradePendingDetails) {
    super(
      `A process older than v0.1.38 is still connected. Finish the upgrade, then select ${providerId}.`,
    );
    this.name = 'PaymentProviderUpgradePendingError';
    this.providerId = providerId;
    this.details = details;
  }
}

export function isGuardedProvider(providerId: string): boolean {
  return GUARDED_PROVIDER_IDS.includes(providerId);
}

/**
 * Why `providerId` cannot be selected now, or null when it can. Providers
 * outside GUARDED_PROVIDER_IDS are never blocked and never run the check.
 */
export async function providerUpgradePending(
  providerId: string,
  store: ProcessWatchStore,
  now: Date = new Date(),
): Promise<ProviderUpgradePendingDetails | null> {
  if (!isGuardedProvider(providerId)) return null;
  const pending = await releaseUpgradePending(null, store, now);
  if (pending == null) return null;
  return {
    legacyConnections: pending.oldConnections,
    hosts: pending.hosts,
    lastLegacySeenAt: pending.lastOldSeenAt,
    watchCheckedAt: pending.watchCheckedAt,
  };
}

/**
 * The one enforcement point for every writer of `payments.provider`: throws
 * PaymentProviderUpgradePendingError when a guarded provider cannot be
 * selected yet (fail loud, P9). A Redis or database error is thrown too, so
 * the switch never passes unchecked.
 */
export async function assertProviderSelectable(
  providerId: string,
  store: ProcessWatchStore,
  now: Date = new Date(),
): Promise<void> {
  const details = await providerUpgradePending(providerId, store, now);
  if (details != null) throw new PaymentProviderUpgradePendingError(providerId, details);
}
