// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';
import { LEGACY_CONNECTION_NAME } from '@evtivity/lib';
import type { PaymentProviderId } from './types.js';

/**
 * Provider-switch guard (Payments P10, plan section 2.2, layer 1).
 *
 * Processes of releases before v0.1.38 refuse Adyen as the active provider
 * and then treat payments as off (guests charge for free, portal starts skip
 * the pre-auth), send Adyen cards to Stripe, and fail Adyen holds they try to
 * settle. So `payments.provider` may become a guarded provider only while no
 * such process can be running. From v0.1.38 on every process names its
 * Postgres connections `evtivity@<version>` (connectionName() in
 * @evtivity/lib); older ones connect with the postgres.js default name. All
 * services share one database role, so pg_stat_activity shows them all.
 *
 * An old process can have no open connection at the instant of the check
 * (pool idle timeout 30 s), so the worker cron `process-version-watch` runs
 * the same check every minute and keeps when it last saw one. The switch is
 * allowed only when:
 *   (a) the instant check finds no old connection,
 *   (b) the watch ran less than WATCH_FRESH_MS ago (a v0.1.38 worker watches),
 *   (c) the watch saw no old connection for at least LEGACY_CLEAN_MS.
 */

/** Providers an older process mishandles: selecting one is guarded. */
export const GUARDED_PROVIDER_IDS: readonly PaymentProviderId[] = ['adyen'];

/** Redis key of the watch result (no schema, expires after WATCH_TTL_SECONDS). */
export const PROCESS_VERSION_WATCH_KEY = 'evtivity:payments:process-version-watch';

const WATCH_TTL_SECONDS = 60 * 60;

/** The watch must have run within this window (rule b). */
export const WATCH_FRESH_MS = 3 * 60_000;

/** No old connection may have been seen within this window (rule c). */
export const LEGACY_CLEAN_MS = 10 * 60_000;

/** The Redis calls the guard needs; an ioredis client satisfies it. */
export interface ProcessWatchStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, secondsToken: 'EX', seconds: number): Promise<unknown>;
}

export interface LegacyProcessCheck {
  /** Open connections of processes before v0.1.38 (this database, this role). */
  legacy: number;
  /** Their client addresses (empty for Unix socket connections). */
  hosts: string[];
}

export interface ProcessWatchState {
  /** When the watch cron last ran the check (ISO 8601). */
  checkedAt: string;
  /** When the watch cron last saw an old connection (ISO 8601), or null. */
  legacySeenAt: string | null;
}

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

/** Counts open connections of processes before v0.1.38 (the shared client). */
export async function legacyProcessCheck(): Promise<LegacyProcessCheck> {
  const rows = await client<{ legacy: number; hosts: string[] | null }[]>`
    SELECT count(*)::int AS legacy,
           array_remove(array_agg(DISTINCT host(client_addr)), NULL) AS hosts
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND usename = current_user
      AND backend_type = 'client backend'
      AND pid <> pg_backend_pid()
      AND application_name = ${LEGACY_CONNECTION_NAME}
  `;
  const row = rows[0];
  return { legacy: row?.legacy ?? 0, hosts: row?.hosts ?? [] };
}

function parseWatchState(raw: string | null): ProcessWatchState | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ProcessWatchState>;
    if (typeof parsed.checkedAt !== 'string') return null;
    return {
      checkedAt: parsed.checkedAt,
      legacySeenAt: typeof parsed.legacySeenAt === 'string' ? parsed.legacySeenAt : null,
    };
  } catch {
    // A value this code did not write: treated as no watch (the guard refuses).
    return null;
  }
}

/**
 * Runs the check and stores the watch result (the `process-version-watch`
 * cron). Keeps the previous `legacySeenAt` when no old connection is open.
 */
export async function recordProcessWatch(
  store: ProcessWatchStore,
  now: Date = new Date(),
): Promise<{ check: LegacyProcessCheck; state: ProcessWatchState }> {
  const check = await legacyProcessCheck();
  const previous = parseWatchState(await store.get(PROCESS_VERSION_WATCH_KEY));
  const state: ProcessWatchState = {
    checkedAt: now.toISOString(),
    legacySeenAt: check.legacy > 0 ? now.toISOString() : (previous?.legacySeenAt ?? null),
  };
  await store.set(PROCESS_VERSION_WATCH_KEY, JSON.stringify(state), 'EX', WATCH_TTL_SECONDS);
  return { check, state };
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
  const [check, raw] = await Promise.all([
    legacyProcessCheck(),
    store.get(PROCESS_VERSION_WATCH_KEY),
  ]);
  const watch = parseWatchState(raw);
  const nowMs = now.getTime();
  const watchFresh = watch != null && nowMs - Date.parse(watch.checkedAt) < WATCH_FRESH_MS;
  const legacyClean =
    watch?.legacySeenAt == null || nowMs - Date.parse(watch.legacySeenAt) >= LEGACY_CLEAN_MS;
  if (check.legacy === 0 && watchFresh && legacyClean) return null;
  return {
    legacyConnections: check.legacy,
    hosts: check.hosts,
    lastLegacySeenAt: watch?.legacySeenAt ?? null,
    watchCheckedAt: watch?.checkedAt ?? null,
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
