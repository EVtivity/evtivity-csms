// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import {
  chargingStations,
  compareRecordIds,
  db,
  getSim,
  getSimProviderSettings,
  recordSimAlertsSynced,
  recordSimLookup,
  recordSimSessionsSynced,
  recordSimStatus,
  simAttachments,
  simAlerts,
  simAuditLog,
  simFetchCoverage,
  simSessions,
  sims,
  stationConfigurations,
  writeAudit,
  type Sim,
  type SimAttachment,
  type SimAuditActor,
  type SimDb,
  type SimProviderMeta,
  type StoredSimStatus,
} from '@evtivity/database';
import {
  gradeSignal,
  isOcpp2x,
  readSignalStrength,
  SIM_RANGE_MAX_DAYS,
  SIM_REFRESH_DAY_OPTIONS,
  type ServiceLogger,
  type SignalGrade,
  type SignalUnit,
  type SimGeneralSettings,
} from '@evtivity/lib';
import {
  SimProviderError,
  SimProviderRegistry,
  type SimAlert,
  type SimProvider,
  type SimProviderErrorKind,
  type SimProviderId,
  type SimRef,
  type SimResetResult,
  type SimSession,
  type SimStatus,
} from '@evtivity/sim-providers';
import {
  clipIntervals,
  coveredDays,
  coveredMs,
  mergeIntervals,
  type SimCoveredDay,
  type SimInterval,
} from './sim-coverage.js';
import { attachReportedStationSim } from './sim-inventory.service.js';
import { sendOcppCommandAndWait, type CommandResult } from './ocpp-command.js';
import {
  classifyDisconnect,
  type DisconnectFacts,
  type SimOfflineCause,
  type StoredSimSessionSpan,
} from './sim-offline-cause.js';

export { clipIntervals, coveredDays, mergeIntervals, zonedDay } from './sim-coverage.js';
export {
  classifyDisconnect,
  SERVER_DISCONNECT_REASONS,
  SIM_ALERT_WINDOW,
} from './sim-offline-cause.js';
export type { DisconnectFacts, OfflineCauseContext, SimOfflineCause } from './sim-offline-cause.js';
export type { SimCoveredDay, SimDayLabel, SimInterval } from './sim-coverage.js';

export { SimProviderError };
export { HOLOGRAM_HISTORY_DAYS, SIM_PROVIDER_ORDER } from '@evtivity/sim-providers';
export type {
  SimCapabilities,
  SimConnectionResult,
  SimProvider,
  SimProviderErrorKind,
  SimProviderId,
  SimRef,
} from '@evtivity/sim-providers';

// SIM data belongs to the SIM (`sims`): its provider lookup, its fetch state
// and its sessions, alerts and fetched periods (`sim_id`). A station reads
// them through its open confirmed attachment, bounded by the SIM's history
// floor (`stationSimView`). This file is the only
// writer of `sim_sessions`, `sim_alerts` and the fetched periods of
// `sim_fetch_coverage` (the writer's lookup deletes those of a provider SIM
// the SIM no longer holds); the SIM rows and attachments go through the writer
// (`@evtivity/database` `sim-inventory.ts`) and the inventory service.

/** How long a lookup that found no SIM is not repeated. */
export const SIM_LOOKUP_MISS_TTL_MS = 3_600_000;
/** One network reset a minute per SIM. */
export const SIM_RESET_COOLDOWN_SECONDS = 60;

/**
 * The SIM providers of the API process, built from the cached SIM settings.
 * `testBaseUrl` points every adapter at a mock (development and test only).
 */
export function createSimProviderRegistry(
  encryptionKey: string,
  testBaseUrl: string | null,
): SimProviderRegistry {
  return new SimProviderRegistry({
    readSettings: () => getSimProviderSettings(encryptionKey),
    testBaseUrl,
  });
}

/** The provider ids a SIM carries after its lookup, as an adapter reads them. */
export function simRefOf(sim: Pick<Sim, 'providerRef' | 'providerMeta'>): SimRef | null {
  if (sim.providerRef == null) return null;
  const meta = (sim.providerMeta ?? {}) as SimProviderMeta;
  return {
    providerSimId: sim.providerRef,
    ...(typeof meta.linkId === 'string' ? { linkId: meta.linkId } : {}),
    ...(typeof meta.simcardId === 'string' ? { simcardId: meta.simcardId } : {}),
  };
}

export type SimProviderResolution =
  | { kind: 'found'; provider: SimProvider; ref: SimRef }
  | { kind: 'not_found' }
  | { kind: 'provider_off' };

/**
 * The SIM at its provider: the stored provider SIM, else a lookup at each
 * enabled provider in order with the SIM's (normalized) ICCID. A miss is
 * cached on the SIM for an hour unless `retryLookup` (Look Up Again). A hit
 * on a provider SIM that another SIM row already holds counts as no hit: the
 * next provider is asked, and a miss is stored only after the last one
 * (`not_found`), so one provider SIM never belongs to two SIM rows. Provider
 * errors propagate. Only a Refresh calls it.
 */
export async function resolveSimProvider(
  registry: SimProviderRegistry,
  sim: Sim,
  options: {
    retryLookup?: boolean;
    log?: ServiceLogger;
    /** Called with each provider before it is asked, so a 429 backs off that provider. */
    onLookup?: (provider: SimProviderId) => void;
  } = {},
): Promise<SimProviderResolution> {
  const stored = simRefOf(sim);
  if (sim.provider != null && stored != null) {
    const provider = await registry.getProvider(sim.provider as SimProviderId);
    if (provider == null) return { kind: 'provider_off' };
    return { kind: 'found', provider, ref: stored };
  }

  const providers = await registry.enabledProviders();
  if (providers.length === 0) return { kind: 'provider_off' };
  if (
    options.retryLookup !== true &&
    sim.lookupMissedAt != null &&
    Date.now() - sim.lookupMissedAt.getTime() < SIM_LOOKUP_MISS_TTL_MS
  ) {
    return { kind: 'not_found' };
  }

  for (const provider of providers) {
    options.onLookup?.(provider.id);
    const found = await provider.findByIccid(sim.iccid);
    if (found == null) continue;
    const meta: SimProviderMeta = {
      ...(found.linkId != null ? { linkId: found.linkId } : {}),
      ...(found.simcardId != null ? { simcardId: found.simcardId } : {}),
    };
    const recorded = await recordSimLookup(sim.id, {
      provider: provider.id,
      providerRef: found.providerSimId,
      meta,
    });
    if (recorded === 'recorded') return { kind: 'found', provider, ref: found };
    // The SIM row is gone: nothing to record.
    if (recorded === 'not_found') return { kind: 'not_found' };
    // Another SIM row holds this provider SIM: the next provider may still have this one.
    options.log?.warn(
      { simId: sim.id, provider: provider.id },
      'SIM lookup found a provider SIM another SIM holds; asking the next provider',
    );
  }
  await recordSimLookup(sim.id, { miss: 'not_found' });
  return { kind: 'not_found' };
}

/** The station's open confirmed attachment and its SIM, else null. Database only. */
export async function confirmedStationSim(
  stationId: string,
  executor: SimDb = db,
): Promise<{ sim: Sim; attachment: SimAttachment } | null> {
  const [row] = await executor
    .select({ sim: sims, attachment: simAttachments })
    .from(simAttachments)
    .innerJoin(sims, eq(sims.id, simAttachments.simId))
    .where(
      and(
        eq(simAttachments.stationId, stationId),
        isNull(simAttachments.detachedAt),
        isNotNull(simAttachments.confirmedAt),
      ),
    );
  return row ?? null;
}

/** The end of a window that is still open. */
export const OPEN_WINDOW_END = new Date('9999-12-31T00:00:00Z');

/**
 * What a station may read of its SIM: the SIM of its open confirmed
 * attachment, that attachment, and the one window after the SIM's history
 * floor (`sims.history_floor_at`, raised by every attachment close and every
 * delete of a station holding the SIM). Every station-path read is bounded by
 * it: rows from before the SIM last left a target (another station, of
 * another site, or one deleted with its attachment rows) never show, while
 * rows from before the first attachment of a SIM never attached elsewhere do
 * (the first Refresh fetches the days before Confirm SIM). Database only.
 */
export interface StationSimView {
  sim: Sim;
  attachment: SimAttachment;
  windows: SimInterval[];
}

export async function stationSimView(
  stationId: string,
  executor: SimDb = db,
): Promise<StationSimView | null> {
  const confirmed = await confirmedStationSim(stationId, executor);
  if (confirmed == null) return null;
  return {
    ...confirmed,
    windows: [{ from: confirmed.sim.historyFloorAt ?? new Date(0), to: OPEN_WINDOW_END }],
  };
}

/** A row time inside one of the windows; never true without a window. */
export function atInWindows(column: AnyColumn, windows: readonly SimInterval[]): SQL {
  return or(...windows.map((w) => and(gte(column, w.from), lte(column, w.to)))) ?? sql`false`;
}

/**
 * A row span wholly inside one of the windows, so a session that began at the
 * previous station never shows; never true without a window.
 */
export function spanInWindows(
  start: AnyColumn,
  end: AnyColumn,
  windows: readonly SimInterval[],
): SQL {
  return or(...windows.map((w) => and(gte(start, w.from), lte(end, w.to)))) ?? sql`false`;
}

/**
 * Whether fetch state (status, sync times, the open session) may show on the
 * station of the SIM's confirmed attachment: fetched after the SIM's history
 * floor. State fetched before the SIM last left a target never shows.
 */
export function fetchedAfterFloor(at: Date | null, sim: Pick<Sim, 'historyFloorAt'>): boolean {
  if (at == null) return false;
  return sim.historyFloorAt == null || at.getTime() > sim.historyFloorAt.getTime();
}

// ---------------------------------------------------------------------------
// Refresh: the provider part. Only a person's Refresh calls it.

/** Redis operations the Refresh needs, shared across API pods. */
export interface SimKeyStore {
  /** Takes the key when free (SET NX PX); true when this caller holds it. */
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Extends the key only while it still holds the token. */
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Deletes the key only while it still holds the token. */
  release(key: string, token: string): Promise<void>;
  /** Seconds the key still lives, null when it does not exist. */
  ttlSeconds(key: string): Promise<number | null>;
  /** Sets the key for a number of seconds. */
  setFor(key: string, seconds: number): Promise<void>;
  /** Counts a call in a fixed window and returns the count so far. */
  increment(key: string, windowSeconds: number): Promise<number>;
}

/**
 * The Redis keys of the SIM feature, all under `sim:*` (`~sim:*` in the ACL).
 * The fetch lock and the reset cooldown are per SIM; the Refresh limit is per
 * target (a station id on the station tab, a SIM id on the SIM page: the
 * `sta_` and `sim_` prefixes keep them apart); the station read is per station.
 */
export const SIM_KEYS = {
  lock: (simId: string): string => `sim:lock:${simId}`,
  backoff: (provider: string): string => `sim:backoff:${provider}`,
  refresh: (targetId: string): string => `sim:refresh:${targetId}`,
  reset: (simId: string): string => `sim:reset:${simId}`,
  signalRead: (stationId: string): string => `sim:signalread:${stationId}`,
  test: (provider: string): string => `sim:test:${provider}`,
} as const;

/** One fetch per SIM at a time; renewed before each page. */
export const SIM_FETCH_LOCK_TTL_MS = 30_000;
/** Backoff after a 429 without Retry-After. */
export const SIM_DEFAULT_BACKOFF_SECONDS = 60;
/** A guard against a provider that never stops paging. */
const MAX_PAGES = 500;

export type SimRefreshRequest = { days: number } | { from: Date; to: Date };

export type SimRefreshInvalidReason =
  | 'days_not_offered'
  | 'range_too_long'
  | 'range_reversed'
  | 'before_history_window'
  | 'before_retention'
  | 'in_future';

export class SimRefreshValidationError extends Error {
  constructor(readonly reason: SimRefreshInvalidReason) {
    super(`The Refresh period is not valid: ${reason}`);
    this.name = 'SimRefreshValidationError';
  }
}

export interface SimRefreshPeriod {
  mode: 'days' | 'range';
  from: Date;
  to: Date;
}

const DAY_MS = 86_400_000;
/** Clock skew allowed on the end of a range. */
const FUTURE_TOLERANCE_MS = 60_000;

/**
 * The period of a Refresh, checked against the offered day counts, the
 * provider's history window and the retention. Throws SimRefreshValidationError.
 */
export function simRefreshPeriod(
  request: SimRefreshRequest,
  bounds: {
    now: Date;
    historyDays: number | null;
    retentionDays: number;
    /** The default period (sim.sessions.fetchDays), allowed besides the offered ones. */
    defaultDays?: number;
  },
): SimRefreshPeriod {
  const now = bounds.now.getTime();
  if ('days' in request) {
    if (!SIM_REFRESH_DAY_OPTIONS.includes(request.days) && request.days !== bounds.defaultDays) {
      throw new SimRefreshValidationError('days_not_offered');
    }
    if (bounds.historyDays != null && request.days > bounds.historyDays) {
      throw new SimRefreshValidationError('before_history_window');
    }
    if (request.days > bounds.retentionDays) {
      throw new SimRefreshValidationError('before_retention');
    }
    return { mode: 'days', from: new Date(now - request.days * DAY_MS), to: new Date(now) };
  }
  const from = request.from.getTime();
  const to = request.to.getTime();
  if (to <= from) throw new SimRefreshValidationError('range_reversed');
  if (to > now + FUTURE_TOLERANCE_MS) throw new SimRefreshValidationError('in_future');
  if (to - from > SIM_RANGE_MAX_DAYS * DAY_MS) {
    throw new SimRefreshValidationError('range_too_long');
  }
  if (bounds.historyDays != null && from < now - bounds.historyDays * DAY_MS) {
    throw new SimRefreshValidationError('before_history_window');
  }
  if (from < now - bounds.retentionDays * DAY_MS) {
    throw new SimRefreshValidationError('before_retention');
  }
  return { mode: 'range', from: request.from, to: new Date(Math.min(to, now)) };
}

/**
 * Why the provider part did not fetch:
 * - `provider_off`: no provider is on (checked before anything is written).
 * - `backoff`: a provider 429 is still being waited out (`retryAfter`).
 * - `in_progress`: another Refresh of the SIM holds its fetch lock.
 * - `no_iccid`: the station has no attachment and no valid ICCID.
 * - `not_found`: no enabled provider has the SIM (a miss is cached for an hour).
 * - `attached_elsewhere`: the station reported a SIM attached to another
 *   target; no attachment is made.
 * - `attach_conflict`: other writers kept changing the attachments of the
 *   station or the SIM while the attachment was made; nothing was attached and
 *   a later Refresh tries again.
 * - `not_confirmed`: the station's attachment is not confirmed: the lookup
 *   ran, nothing was fetched.
 * - `sim_inactive`: the SIM is inactive, also one deactivated while the
 *   fetch lock was taken; the route answers 409 `SIM_INACTIVE`.
 */
export type SimProviderPartSkipReason =
  | 'provider_off'
  | 'backoff'
  | 'in_progress'
  | 'no_iccid'
  | 'not_found'
  | 'attached_elsewhere'
  | 'attach_conflict'
  | 'not_confirmed'
  | 'sim_inactive';

export type SimProviderPartResult =
  | {
      result: 'ok';
      provider: SimProviderId;
      fetchedAt: string;
      sessionsStored: number;
      alertsStored: number;
    }
  | {
      result: 'skipped';
      reason: SimProviderPartSkipReason;
      retryAfter?: number;
      provider?: SimProviderId;
    }
  | {
      result: 'failed';
      kind: SimProviderErrorKind | 'lock_lost';
      retryAfter?: number;
    };

export interface SimRefreshContext {
  registry: SimProviderRegistry;
  keys: SimKeyStore;
  /** The person who pressed Refresh, for the audit rows of a new SIM or attachment. */
  actor: SimAuditActor;
  log: ServiceLogger;
  now?: () => Date;
}

/** The status fields a Refresh keeps: never the ICCID, IMSI or any credential. */
export function storedSimStatus(status: SimStatus): StoredSimStatus {
  return {
    state: status.state,
    providerState: status.providerState,
    inSession: status.inSession,
    openSessionBeganAt: status.openSessionBeganAt,
    apn: status.apn,
    profileName: status.profileName,
    lastSessionAt: status.lastSessionAt,
    usage:
      status.usage == null
        ? null
        : {
            bytes: status.usage.bytes,
            periodEnd: status.usage.periodEnd,
            limitBytes: status.usage.limitBytes,
          },
  };
}

/** The history window that bounds a Refresh: the shortest of the enabled providers. */
export async function simHistoryDays(registry: SimProviderRegistry): Promise<number | null> {
  const providers = await registry.enabledProviders();
  if (providers.length === 0) return null;
  return Math.min(...providers.map((p) => p.historyDays));
}

async function backoffSeconds(
  keys: SimKeyStore,
  providers: readonly SimProvider[],
): Promise<number | null> {
  let longest: number | null = null;
  for (const provider of providers) {
    const left = await keys.ttlSeconds(SIM_KEYS.backoff(provider.id));
    if (left != null && left > 0 && (longest == null || left > longest)) longest = left;
  }
  return longest;
}

/**
 * Stores fetched sessions of a SIM. A row belongs to one SIM forever, so a
 * session already stored (for this or, after a provider id clash, another
 * SIM) is left as it is. Returns the rows inserted.
 */
async function storeSessions(
  simId: string,
  provider: SimProviderId,
  sessions: readonly SimSession[],
): Promise<number> {
  if (sessions.length === 0) return 0;
  const rows = await db
    .insert(simSessions)
    .values(
      sessions.map((s) => ({
        simId,
        provider,
        providerSessionId: s.providerSessionId,
        startedAt: new Date(s.startedAt),
        endedAt: new Date(s.endedAt),
        bytes: s.bytes,
        networkName: s.networkName,
        radioAccessTechnology: s.radioAccessTechnology,
        cellId: s.cellId,
        apn: s.apn,
      })),
    )
    .onConflictDoNothing({ target: [simSessions.provider, simSessions.providerSessionId] })
    .returning({ id: simSessions.id });
  return rows.length;
}

/** Stores fetched alerts of a SIM; one already stored is left as it is. Returns the rows inserted. */
async function storeAlerts(
  simId: string,
  provider: SimProviderId,
  alerts: readonly SimAlert[],
): Promise<number> {
  if (alerts.length === 0) return 0;
  const rows = await db
    .insert(simAlerts)
    .values(
      alerts.map((a) => ({
        simId,
        provider,
        providerAlertId: a.providerAlertId,
        kind: a.kind,
        receivedAt: new Date(a.receivedAt),
      })),
    )
    .onConflictDoNothing({ target: [simAlerts.provider, simAlerts.providerAlertId] })
    .returning({ id: simAlerts.id });
  return rows.length;
}

/** The advisory lock key of a SIM's coverage writes. */
export function simCoverageLockKey(simId: string): string {
  return `sim_coverage:${simId}`;
}

/** Stores a range fetched for a SIM and merges it with that SIM's overlapping and touching ones. */
export async function recordSimFetchCoverage(
  simId: string,
  provider: SimProviderId,
  covered: SimInterval,
  fetchedAt: Date,
): Promise<void> {
  if (covered.to.getTime() <= covered.from.getTime()) return;
  await db.transaction(async (tx) => {
    // Coverage writes of one SIM take turns, so two Refreshes never split a merge.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${simCoverageLockKey(simId)}))`);
    const touching = await tx
      .select()
      .from(simFetchCoverage)
      .where(
        and(
          eq(simFetchCoverage.simId, simId),
          eq(simFetchCoverage.provider, provider),
          lte(simFetchCoverage.coveredFrom, covered.to),
          gte(simFetchCoverage.coveredTo, covered.from),
        ),
      );
    const merged = mergeIntervals([
      covered,
      ...touching.map((row) => ({ from: row.coveredFrom, to: row.coveredTo })),
    ]);
    const range = merged[0] ?? covered;
    if (touching.length > 0) {
      await tx.delete(simFetchCoverage).where(
        inArray(
          simFetchCoverage.id,
          touching.map((row) => row.id),
        ),
      );
    }
    await tx.insert(simFetchCoverage).values({
      simId,
      provider,
      coveredFrom: range.from,
      coveredTo: range.to,
      fetchedAt,
    });
  });
}

async function coverageHolds(
  simId: string,
  provider: SimProviderId,
  from: Date,
  to: Date,
): Promise<boolean> {
  const rows = await db
    .select({ from: simFetchCoverage.coveredFrom, to: simFetchCoverage.coveredTo })
    .from(simFetchCoverage)
    .where(and(eq(simFetchCoverage.simId, simId), eq(simFetchCoverage.provider, provider)));
  return coveredMs(mergeIntervals(rows), from, to) >= to.getTime() - from.getTime();
}

/**
 * The provider part of a station tab Refresh. Nothing is written or asked
 * while no provider is on. The station's open attachment gives the SIM;
 * without one, the ICCID the station reported is attached unconfirmed
 * (`reported`, never displacing: `attached_elsewhere`). Then the SIM is
 * looked up, and a SIM whose attachment nobody confirmed is not fetched
 * (`not_confirmed`): the station chose the ICCID it reported.
 */
export async function refreshStationSimProvider(
  ctx: SimRefreshContext,
  stationId: string,
  period: SimRefreshPeriod,
  options: { retryLookup?: boolean } = {},
): Promise<SimProviderPartResult> {
  const providers = await ctx.registry.enabledProviders();
  if (providers.length === 0) return { result: 'skipped', reason: 'provider_off' };
  const attached = await attachReportedStationSim(stationId, ctx.actor, ctx.log);
  if (attached.kind !== 'attached') return { result: 'skipped', reason: attached.kind };
  return refreshSim(ctx, attached.sim, period, {
    ...options,
    fetch: attached.attachment.confirmedAt != null,
    providers,
    target: stationId,
  });
}

/**
 * The provider part of a Refresh on the SIM page: status, sessions and
 * alerts of the SIM whatever its attachment, confirmed or not. The caller
 * checks who may (an all-site user for any SIM, a site-restricted user only
 * through a confirmed attachment to a station of their sites). An inactive
 * SIM calls no provider (`sim_inactive`).
 */
export async function refreshSimProvider(
  ctx: SimRefreshContext,
  simId: string,
  period: SimRefreshPeriod,
  options: { retryLookup?: boolean } = {},
): Promise<SimProviderPartResult> {
  const sim = await getSim(simId);
  // A SIM deleted since the route read it: nothing to look up.
  if (sim == null) return { result: 'skipped', reason: 'not_found' };
  // Before the provider check, so an inactive SIM always answers sim_inactive.
  if (sim.status !== 'active') return { result: 'skipped', reason: 'sim_inactive' };
  const providers = await ctx.registry.enabledProviders();
  if (providers.length === 0) return { result: 'skipped', reason: 'provider_off' };
  return refreshSim(ctx, sim, period, { ...options, fetch: true, providers, target: simId });
}

/**
 * Looks the SIM up and, when `fetch`, reads its status, its sessions and its
 * alerts for the period and stores them. One fetch per SIM at a time across
 * pods (`sim:lock:<sim>`, renewed before every provider call); a provider 429
 * sets the provider backoff, during which a Refresh calls no provider. A
 * Redis failure reports the part `failed` with kind `unavailable`. Every
 * outcome is reported, never thrown, except a database failure.
 */
async function refreshSim(
  ctx: SimRefreshContext,
  sim: Sim,
  period: SimRefreshPeriod,
  options: {
    retryLookup?: boolean;
    fetch: boolean;
    providers: readonly SimProvider[];
    /** The station or SIM id the Refresh was asked for, for the logs. */
    target: string;
  },
): Promise<SimProviderPartResult> {
  if (sim.status !== 'active') return { result: 'skipped', reason: 'sim_inactive' };
  const now = ctx.now ?? (() => new Date());
  const logged = { simId: sim.id, target: options.target };
  const redisDown = (err: unknown, step: string): SimProviderPartResult => {
    ctx.log.warn({ err, ...logged }, `SIM Refresh ${step} failed in Redis; no provider call`);
    return { result: 'failed', kind: 'unavailable' };
  };

  let waiting: number | null;
  try {
    waiting = await backoffSeconds(ctx.keys, options.providers);
  } catch (err: unknown) {
    return redisDown(err, 'backoff read');
  }
  if (waiting != null) return { result: 'skipped', reason: 'backoff', retryAfter: waiting };

  const token = randomUUID();
  const lockKey = SIM_KEYS.lock(sim.id);
  let acquired: boolean;
  try {
    acquired = await ctx.keys.acquire(lockKey, token, SIM_FETCH_LOCK_TTL_MS);
  } catch (err: unknown) {
    return redisDown(err, 'lock');
  }
  if (!acquired) return { result: 'skipped', reason: 'in_progress' };

  // Each provider call can take seconds, so the lock is renewed before every one.
  const stillHeld = async (): Promise<boolean> => {
    try {
      return await ctx.keys.renew(lockKey, token, SIM_FETCH_LOCK_TTL_MS);
    } catch (err: unknown) {
      ctx.log.warn({ err, ...logged }, 'SIM fetch lock not renewed; the fetch stops');
      return false;
    }
  };
  const LOCK_LOST = { result: 'failed', kind: 'lock_lost' } as const;

  let providerId: SimProviderId | null = null;
  try {
    // A deactivation committed while the lock was taken stops the Refresh here.
    const latest = await getSim(sim.id);
    if (latest == null) return { result: 'skipped', reason: 'not_found' };
    if (latest.status !== 'active') return { result: 'skipped', reason: 'sim_inactive' };
    const resolution = await resolveSimProvider(ctx.registry, sim, {
      ...(options.retryLookup === true ? { retryLookup: true } : {}),
      log: ctx.log,
      onLookup: (id) => {
        providerId = id;
      },
    });
    if (resolution.kind !== 'found') return { result: 'skipped', reason: resolution.kind };
    const { provider, ref } = resolution;
    providerId = provider.id;
    if (!options.fetch) {
      return { result: 'skipped', reason: 'not_confirmed', provider: provider.id };
    }
    const fetchedAt = now();

    if (!(await stillHeld())) return LOCK_LOST;
    const status = await provider.getStatus(ref);
    await recordSimStatus(sim.id, ref.providerSimId, storedSimStatus(status), fetchedAt);

    // The cursor of this provider SIM only: a lookup may have changed it.
    const current = await getSim(sim.id);
    const sameRef = current?.providerRef === ref.providerSimId;
    const cursor = period.mode === 'days' && sameRef ? (current.lastRecordId ?? null) : null;
    const lastSync = sameRef ? (current.sessionsSyncedAt ?? null) : null;
    // The cursor may end the paging only when stored coverage already holds the
    // rest of the period, so a longer period than the last Refresh pages back.
    const cursorUsable =
      cursor != null &&
      lastSync != null &&
      (await coverageHolds(
        sim.id,
        provider.id,
        period.from,
        new Date(lastSync.getTime() - provider.reportingDelayHours * 3_600_000),
      ));

    // The period bounds the provider query, so every session it returns
    // overlaps the period and paging follows the provider.
    let sessionsStored = 0;
    let newest: string | null = null;
    let startAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (!(await stillHeld())) return LOCK_LOST;
      const result = await provider.listSessions(ref, {
        ...(startAfter != null ? { startAfter } : {}),
        range: { from: period.from, to: period.to },
      });
      newest ??= result.items[0]?.providerSessionId ?? null;
      const atCursor = cursorUsable
        ? result.items.findIndex((s) => compareRecordIds(s.providerSessionId, cursor) <= 0)
        : -1;
      const keep = atCursor < 0 ? result.items : result.items.slice(0, atCursor);
      sessionsStored += await storeSessions(sim.id, provider.id, keep);
      if (atCursor >= 0 || !result.continues || result.lastId == null) break;
      startAfter = result.lastId;
    }

    let alertsStored = 0;
    let alertsAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (!(await stillHeld())) return LOCK_LOST;
      const result = await provider.listAlerts(ref, {
        ...(alertsAfter != null ? { startAfter: alertsAfter } : {}),
        range: { from: period.from, to: period.to },
      });
      alertsStored += await storeAlerts(sim.id, provider.id, result.items);
      if (!result.continues || result.lastId == null) break;
      alertsAfter = result.lastId;
    }

    // Another Refresh may hold the lock now: it writes the cursor and coverage, not this one.
    if (!(await stillHeld())) return LOCK_LOST;
    if (period.mode === 'days') {
      // Synced up to the end of the period asked for, the end the coverage
      // records, so the next Refresh can tell the cursor is usable.
      await recordSimSessionsSynced(sim.id, ref.providerSimId, newest, period.to);
      await recordSimAlertsSynced(sim.id, ref.providerSimId, fetchedAt);
    }
    // The provider reports sessions late, so nothing newer than its delay is covered.
    const coveredTo = new Date(
      Math.min(period.to.getTime(), fetchedAt.getTime() - provider.reportingDelayHours * 3_600_000),
    );
    await recordSimFetchCoverage(
      sim.id,
      provider.id,
      { from: period.from, to: coveredTo },
      fetchedAt,
    );
    return {
      result: 'ok',
      provider: provider.id,
      fetchedAt: fetchedAt.toISOString(),
      sessionsStored,
      alertsStored,
    };
  } catch (err: unknown) {
    if (!(err instanceof SimProviderError)) throw err;
    ctx.log.warn(
      { err, ...logged, provider: providerId, kind: err.kind },
      'SIM provider fetch failed; the stored SIM data is kept',
    );
    if (err.kind === 'rate_limited') {
      const retryAfter = err.retryAfterSeconds ?? SIM_DEFAULT_BACKOFF_SECONDS;
      try {
        // The provider that answered 429; a lookup sets it before each provider it asks.
        const backoffProvider = providerId ?? options.providers[0]?.id;
        if (backoffProvider != null) {
          await ctx.keys.setFor(SIM_KEYS.backoff(backoffProvider), retryAfter);
        }
      } catch (setErr: unknown) {
        ctx.log.warn(
          { err: setErr, ...logged },
          'SIM provider backoff not stored in Redis; the next Refresh may call the provider',
        );
      }
      return { result: 'failed', kind: 'rate_limited', retryAfter };
    }
    return { result: 'failed', kind: err.kind };
  } finally {
    try {
      await ctx.keys.release(lockKey, token);
    } catch (err: unknown) {
      ctx.log.warn({ err, ...logged }, 'SIM fetch lock release failed; it expires by itself');
    }
  }
}

// ---------------------------------------------------------------------------
// Network reset. Only a person's click calls it.

export interface SimResetContext {
  registry: SimProviderRegistry;
  keys: SimKeyStore;
  /** The person who asked, for the SIM audit row. */
  actor: SimAuditActor;
  log: ServiceLogger;
}

/**
 * - `reset`: the provider accepted (`status` from the provider).
 * - `sim_not_found`: no such SIM.
 * - `sim_inactive`: the SIM is inactive: 409 `SIM_INACTIVE`, no provider call.
 * - `not_looked_up`: no provider SIM is known for it (no Refresh found it yet).
 * - `provider_off`: its provider is off.
 * - `unsupported`: the provider has no network reset.
 * - `cooldown`: a reset of this SIM ran less than a minute ago (`retryAfter`).
 * - `unavailable`: the cooldown could not be taken in Redis: no provider call.
 * - `provider_error`: the provider refused or failed (`error`); a 429 also
 *   started the provider backoff.
 */
export type SimNetworkResetOutcome =
  | { kind: 'reset'; status: SimResetResult['status'] }
  | { kind: 'sim_not_found' }
  | { kind: 'sim_inactive' }
  | { kind: 'not_looked_up' }
  | { kind: 'provider_off' }
  | { kind: 'unsupported' }
  | { kind: 'cooldown'; retryAfter: number }
  | { kind: 'unavailable' }
  | { kind: 'provider_error'; error: SimProviderError };

/**
 * Resets the network of a SIM at its provider (the station tab and the SIM
 * page). The caller checks who may: on the station tab the station's
 * attachment must be confirmed; on the SIM page a site-restricted user needs a
 * confirmed attachment to a station of their sites. The cooldown is per SIM
 * (`sim:reset:<sim>`), so both pages share it, and is taken before the call.
 * An inactive SIM calls no provider, also one deactivated while the cooldown
 * was taken (the status is read again after it). Audited on the SIM
 * (`network_reset`, outcome in the notes); `onOutcome` gets the outcome and the
 * station the SIM is attached to, for the station's command audit. Both are
 * fail-open: a failure is logged and never changes the outcome. An error that
 * is not a `SimProviderError` gives the cooldown back, is audited `failed` and
 * is rethrown. `stillAllowed` repeats the caller's access check after the
 * cooldown is taken, since the SIM may have moved to another station
 * meanwhile: false gives the cooldown back and answers `sim_not_found`.
 */
export async function resetSimNetwork(
  ctx: SimResetContext,
  simId: string,
  options: {
    onOutcome?: (outcome: 'accepted' | 'failed', attachedStationId: string | null) => Promise<void>;
    stillAllowed?: () => Promise<boolean>;
  } = {},
): Promise<SimNetworkResetOutcome> {
  const sim = await getSim(simId);
  if (sim == null) return { kind: 'sim_not_found' };
  if (sim.status !== 'active') return { kind: 'sim_inactive' };
  const ref = simRefOf(sim);
  if (sim.provider == null || ref == null) return { kind: 'not_looked_up' };
  const provider = await ctx.registry.getProvider(sim.provider as SimProviderId);
  if (provider == null) return { kind: 'provider_off' };
  if (!provider.capabilities.networkReset) return { kind: 'unsupported' };

  const cooldownKey = SIM_KEYS.reset(simId);
  const cooldownToken = randomUUID();
  let taken: boolean;
  try {
    taken = await ctx.keys.acquire(cooldownKey, cooldownToken, SIM_RESET_COOLDOWN_SECONDS * 1000);
  } catch (err: unknown) {
    // Without the cooldown two resets could reach the provider at once: refuse.
    ctx.log.warn({ err, simId }, 'SIM reset cooldown not taken in Redis');
    return { kind: 'unavailable' };
  }
  if (!taken) {
    let retryAfter = SIM_RESET_COOLDOWN_SECONDS;
    try {
      retryAfter = (await ctx.keys.ttlSeconds(cooldownKey)) ?? SIM_RESET_COOLDOWN_SECONDS;
    } catch (err: unknown) {
      ctx.log.warn({ err, simId }, 'SIM reset wait not read in Redis; the full wait is given');
    }
    return { kind: 'cooldown', retryAfter };
  }

  const giveCooldownBack = async (): Promise<void> => {
    try {
      await ctx.keys.release(cooldownKey, cooldownToken);
    } catch (releaseErr: unknown) {
      ctx.log.warn(
        { err: releaseErr, simId },
        'SIM reset cooldown not released in Redis; it expires by itself',
      );
    }
  };
  // Fail-open: the reset already happened or failed at the provider, so
  // an audit or onOutcome failure is logged and never changes the outcome.
  // The SIM row names the station the SIM is attached to (`after.stationId`),
  // so the audit view shows it only to users of that station's site.
  // A row whose station could not be read says so (`stationUnknown`), and the
  // audit view hides it from site-restricted users, as it would hide a row
  // naming another site's station.
  const audit = async (outcome: 'accepted' | 'failed'): Promise<void> => {
    let stationId: string | null = null;
    let stationUnknown = false;
    try {
      const [open] = await db
        .select({ stationId: simAttachments.stationId })
        .from(simAttachments)
        .where(and(eq(simAttachments.simId, simId), isNull(simAttachments.detachedAt)));
      stationId = open?.stationId ?? null;
    } catch (err: unknown) {
      stationUnknown = true;
      ctx.log.warn({ err, simId, outcome }, 'SIM network reset station not read for the audit');
    }
    await writeAudit(
      { table: simAuditLog, idColumn: 'sim_id' },
      {
        entityId: simId,
        entityIdSnapshot: simId,
        action: 'network_reset',
        ...ctx.actor,
        before: null,
        after: stationUnknown ? { outcome, stationId, stationUnknown } : { outcome, stationId },
        notes: `SimNetworkReset (${outcome})`,
      },
      db,
      ctx.log,
    );
    if (options.onOutcome == null) return;
    try {
      await options.onOutcome(outcome, stationId);
    } catch (err: unknown) {
      ctx.log.warn({ err, simId, outcome }, 'SIM network reset station audit failed');
    }
  };

  // A deactivation committed while the cooldown was taken stops the reset here.
  let latest: Sim | null;
  let allowed: boolean;
  try {
    latest = await getSim(simId);
    allowed = options.stillAllowed == null || (await options.stillAllowed());
  } catch (err: unknown) {
    await giveCooldownBack();
    throw err;
  }
  if (latest?.status !== 'active') {
    await giveCooldownBack();
    return latest == null ? { kind: 'sim_not_found' } : { kind: 'sim_inactive' };
  }
  if (!allowed) {
    await giveCooldownBack();
    return { kind: 'sim_not_found' };
  }

  let result: SimResetResult;
  try {
    result = await provider.resetNetwork(ref);
  } catch (err: unknown) {
    if (!(err instanceof SimProviderError)) {
      // Nothing says the provider got the request, so the cooldown is given back.
      await giveCooldownBack();
      await audit('failed');
      throw err;
    }
    await audit('failed');
    ctx.log.warn({ err, simId, kind: err.kind }, 'SIM network reset failed');
    if (err.kind === 'rate_limited') {
      try {
        await ctx.keys.setFor(
          SIM_KEYS.backoff(provider.id),
          err.retryAfterSeconds ?? SIM_RESET_COOLDOWN_SECONDS,
        );
      } catch (setErr: unknown) {
        ctx.log.warn(
          { err: setErr, simId },
          'SIM provider backoff not stored in Redis; the next Refresh may call the provider',
        );
      }
    }
    return { kind: 'provider_error', error: err };
  }
  await audit('accepted');
  return { kind: 'reset', status: result.status };
}

// ---------------------------------------------------------------------------
// Reads for the status and timeline routes (database only).

export interface SimCoverageBounds {
  historyDays: number | null;
  retentionDays: number;
  reportingDelayHours: number;
  /**
   * Only the data and fetched periods inside these windows count: a station's
   * window after the SIM's history floor (`stationSimView`), or on the SIM page
   * of a site-restricted user the periods the SIM was attached to stations of
   * their sites. Omitted for an all-site user on the SIM page, who sees all.
   */
  windows?: readonly SimInterval[];
}

/**
 * The coveredDays entries of a SIM for a range, from its stored data. A
 * station passes the SIM of its confirmed attachment and its window
 * (`stationSimView`); without one (`null`) no day is fetched.
 */
export async function simCoveredDays(
  simId: string | null,
  from: Date,
  to: Date,
  timeZone: string,
  bounds: SimCoverageBounds,
  now: Date = new Date(),
): Promise<SimCoveredDay[]> {
  const windows = bounds.windows;
  const [stored, sessionRows, alertRows] =
    simId == null
      ? [[], [], []]
      : await Promise.all([
          db
            .select({ from: simFetchCoverage.coveredFrom, to: simFetchCoverage.coveredTo })
            .from(simFetchCoverage)
            .where(
              and(
                eq(simFetchCoverage.simId, simId),
                lte(simFetchCoverage.coveredFrom, to),
                gte(simFetchCoverage.coveredTo, from),
              ),
            ),
          db
            .select({ startedAt: simSessions.startedAt, endedAt: simSessions.endedAt })
            .from(simSessions)
            .where(
              and(
                eq(simSessions.simId, simId),
                lte(simSessions.startedAt, to),
                gte(simSessions.endedAt, from),
                windows == null
                  ? undefined
                  : spanInWindows(simSessions.startedAt, simSessions.endedAt, windows),
              ),
            ),
          db
            .select({ receivedAt: simAlerts.receivedAt })
            .from(simAlerts)
            .where(
              and(
                eq(simAlerts.simId, simId),
                gte(simAlerts.receivedAt, from),
                lte(simAlerts.receivedAt, to),
                windows == null ? undefined : atInWindows(simAlerts.receivedAt, windows),
              ),
            ),
        ]);
  const coverage = windows == null ? stored : clipIntervals(stored, windows);
  const keptSince = new Date(now.getTime() - bounds.retentionDays * DAY_MS);
  const historySince =
    bounds.historyDays == null ? now : new Date(now.getTime() - bounds.historyDays * DAY_MS);
  return coveredDays({
    from,
    to,
    timeZone,
    now,
    coverage,
    activity: [
      ...sessionRows.map((s) => ({ from: s.startedAt, to: s.endedAt })),
      ...alertRows.map((a) => ({ from: a.receivedAt, to: a.receivedAt })),
    ],
    reportingDelayHours: bounds.reportingDelayHours,
    fetchableSince: historySince.getTime() > keptSince.getTime() ? historySince : keptSince,
    keptSince,
  });
}

/**
 * The likely offline cause of each disconnect of a station, from the stored
 * sessions, alerts and fetched periods of the SIM of its confirmed attachment
 * and the open session of that SIM's last Refresh. Only the rows after the
 * SIM's history floor count (`stationSimView`), and the open session only when
 * the status was fetched after it: the SIM's data from another station never
 * shows here. Without a confirmed attachment no SIM data
 * is used. Reads the database only. Returns one label per disconnect, in the
 * same order.
 */
export async function stationDisconnectCauses(
  stationId: string,
  disconnects: readonly DisconnectFacts[],
  options: { reportingDelayHours: number; now?: Date },
): Promise<SimOfflineCause[]> {
  if (disconnects.length === 0) return [];
  const times = disconnects.map((d) => d.at.getTime());
  // The alert window reaches a day back; sessions further away only bracket.
  const from = new Date(Math.min(...times) - 25 * 3_600_000);
  const to = new Date(Math.max(...times) + 3_600_000);
  const span = { startedAt: simSessions.startedAt, endedAt: simSessions.endedAt };
  const view = await stationSimView(stationId);
  const sim = view?.sim ?? null;
  const windows = view?.windows ?? [];
  const inWindows = spanInWindows(simSessions.startedAt, simSessions.endedAt, windows);
  const [near, before, after, alerts, coverage] =
    sim == null
      ? [[], [], [], [], []]
      : await Promise.all([
          db
            .select(span)
            .from(simSessions)
            .where(
              and(
                eq(simSessions.simId, sim.id),
                gte(simSessions.endedAt, from),
                lte(simSessions.startedAt, to),
                inWindows,
              ),
            ),
          db
            .select(span)
            .from(simSessions)
            .where(and(eq(simSessions.simId, sim.id), lt(simSessions.endedAt, from), inWindows))
            .orderBy(desc(simSessions.endedAt))
            .limit(1),
          db
            .select(span)
            .from(simSessions)
            .where(and(eq(simSessions.simId, sim.id), gt(simSessions.startedAt, to), inWindows))
            .orderBy(asc(simSessions.startedAt))
            .limit(1),
          db
            .select({ kind: simAlerts.kind, receivedAt: simAlerts.receivedAt })
            .from(simAlerts)
            .where(
              and(
                eq(simAlerts.simId, sim.id),
                gte(simAlerts.receivedAt, from),
                lte(simAlerts.receivedAt, to),
                atInWindows(simAlerts.receivedAt, windows),
              ),
            ),
          db
            .select({ from: simFetchCoverage.coveredFrom, to: simFetchCoverage.coveredTo })
            .from(simFetchCoverage)
            .where(
              and(
                eq(simFetchCoverage.simId, sim.id),
                lte(simFetchCoverage.coveredFrom, to),
                gte(simFetchCoverage.coveredTo, from),
              ),
            ),
        ]);
  const sessions: StoredSimSessionSpan[] = [...before, ...near, ...after];
  const statusHere = view != null && fetchedAfterFloor(view.sim.statusFetchedAt, view.sim);
  const ctx = {
    sessions,
    alerts,
    openSessionBeganAt: statusHere ? (sim?.openSessionBeganAt ?? null) : null,
    lastFetchedAt: statusHere ? (sim?.statusFetchedAt ?? null) : null,
    reportingDelayHours: options.reportingDelayHours,
    now: options.now ?? new Date(),
    coverage: clipIntervals(coverage, windows),
  };
  return disconnects.map((d) => classifyDisconnect(d, ctx));
}

// ---------------------------------------------------------------------------
// Refresh: the station part. One OCPP read of the station's cellular link, only
// while station signal reads are on and only from a person's Refresh.

/** The DataLink variables of OCPP 2.0.1 and 2.1 (generic, all optional). */
export const DATALINK_VARIABLES: readonly string[] = Object.freeze([
  'SignalStrength',
  'Active',
  'Enabled',
  'Fallback',
  'Problem',
  'NetworkAddress',
  'ICCID',
  'IMSI',
]);
export const DATALINK_COMPONENT = 'DataLink';
/** The network profile slot the station uses, read with the DataLink values. */
export const ACTIVE_NETWORK_PROFILE = {
  component: 'OCPPCommCtrlr',
  variable: 'ActiveNetworkProfile',
} as const;
/** One station read a minute per station, across API pods. */
export const SIM_SIGNAL_READ_SECONDS = 60;

export type SimStationSkipReason =
  | 'signal_off'
  | 'station_offline'
  | 'recent'
  | 'no_device_model'
  | 'no_keys'
  | 'not_operator_station';

export type SimStationPartResult =
  | { result: 'ok'; readAt: string }
  | { result: 'skipped'; reason: SimStationSkipReason }
  | { result: 'failed'; kind: 'timeout' | 'command_failed' | 'unsupported' | 'unavailable' };

export interface StationSignalContext {
  keys: SimKeyStore;
  log: ServiceLogger;
  /** The OCPP request and its wait; tests pass their own. */
  send?: typeof sendOcppCommandAndWait;
  now?: () => Date;
}

interface DataLinkRow {
  component: string;
  instance: string | null;
  variable: string;
  value: string | null;
  unit: string | null;
  updatedAt: Date;
}

async function dataLinkRows(stationUuid: string): Promise<DataLinkRow[]> {
  return db
    .select({
      component: stationConfigurations.component,
      instance: stationConfigurations.instance,
      variable: stationConfigurations.variable,
      value: stationConfigurations.value,
      unit: stationConfigurations.unit,
      updatedAt: stationConfigurations.updatedAt,
    })
    .from(stationConfigurations)
    .where(
      and(
        eq(stationConfigurations.stationId, stationUuid),
        eq(stationConfigurations.attributeType, 'Actual'),
        inArray(stationConfigurations.component, [
          DATALINK_COMPONENT,
          ACTIVE_NETWORK_PROFILE.component,
        ]),
      ),
    );
}

/** DeviceDataCtrlr.ItemsPerMessage[GetVariables] or BytesPerMessage[GetVariables], when reported. */
async function getVariablesLimit(
  stationUuid: string,
  variable: 'ItemsPerMessage' | 'BytesPerMessage',
): Promise<number | null> {
  const [row] = await db
    .select({ value: stationConfigurations.value })
    .from(stationConfigurations)
    .where(
      and(
        eq(stationConfigurations.stationId, stationUuid),
        eq(stationConfigurations.component, 'DeviceDataCtrlr'),
        eq(stationConfigurations.variable, variable),
        eq(stationConfigurations.variableInstance, 'GetVariables'),
        eq(stationConfigurations.attributeType, 'Actual'),
      ),
    );
  const limit = Number(row?.value);
  return Number.isInteger(limit) && limit > 0 ? limit : null;
}

/** The bytes of the OCPP-J CALL that carries these items (a 36-character message id). */
function getVariablesFrameBytes(items: ReadonlyArray<Record<string, unknown>>): number {
  return Buffer.byteLength(
    JSON.stringify([2, 'x'.repeat(36), 'GetVariables', { getVariableData: items }]),
  );
}

function dataLinkComponent(instance: string | null): Record<string, unknown> {
  return { name: DATALINK_COMPONENT, ...(instance != null ? { instance } : {}) };
}

/**
 * The GetVariables items of a 2.x station: every reported DataLink variable of
 * each DataLink instance (SignalStrength always), plus the active network
 * profile. Within the station's ItemsPerMessage and BytesPerMessage (the whole
 * CALL), signal strengths first.
 */
export function dataLinkGetVariables(
  rows: readonly Pick<DataLinkRow, 'component' | 'instance' | 'variable'>[],
  limit: number | null,
  maxBytes: number | null = null,
): Array<Record<string, unknown>> {
  const instances = new Map<string, { instance: string | null; variables: Set<string> }>();
  for (const row of rows) {
    if (row.component !== DATALINK_COMPONENT) continue;
    const key = row.instance ?? '';
    const entry = instances.get(key) ?? { instance: row.instance, variables: new Set<string>() };
    if (DATALINK_VARIABLES.includes(row.variable)) entry.variables.add(row.variable);
    instances.set(key, entry);
  }
  if (instances.size === 0) return [];
  const signal = [...instances.values()].map((i) => ({
    component: dataLinkComponent(i.instance),
    variable: { name: 'SignalStrength' },
  }));
  const profile = {
    component: { name: ACTIVE_NETWORK_PROFILE.component },
    variable: { name: ACTIVE_NETWORK_PROFILE.variable },
  };
  const others = [...instances.values()].flatMap((i) =>
    DATALINK_VARIABLES.filter((v) => v !== 'SignalStrength' && i.variables.has(v)).map((v) => ({
      component: dataLinkComponent(i.instance),
      variable: { name: v },
    })),
  );
  const items = [...signal, profile, ...others].slice(0, limit ?? undefined);
  // The station may refuse a longer message (B06.FR.17); the first signal strength always goes.
  while (maxBytes != null && items.length > 1 && getVariablesFrameBytes(items) > maxBytes) {
    items.pop();
  }
  return items;
}

function stationPartFailure(result: CommandResult): SimStationPartResult {
  if (result.timedOut === true) return { result: 'failed', kind: 'timeout' };
  if (result.code === 'OCPP_VERSION_MISMATCH') return { result: 'failed', kind: 'unsupported' };
  if (result.offline === true || result.queued === true) {
    return { result: 'skipped', reason: 'station_offline' };
  }
  return { result: 'failed', kind: 'command_failed' };
}

/**
 * The station part of a Refresh: one GetVariables (2.0.1, 2.1) for the stored
 * DataLink instances and the active network profile, or one native
 * GetConfiguration (1.6) with `sim.ocpp16.signalKeys`. At most once a minute
 * per station (`sim:signalread:<station>`). The OCPP server's projections store
 * the reply in station_configurations; nothing is stored before it. A station
 * without DataLink rows is skipped (`no_device_model`): Read Device Model
 * (GetBaseReport) reports them.
 */
export async function readStationDataLink(
  ctx: StationSignalContext,
  stationUuid: string,
  settings: Pick<SimGeneralSettings, 'stationSignalEnabled' | 'ocpp16SignalKeys'>,
): Promise<SimStationPartResult> {
  if (!settings.stationSignalEnabled) return { result: 'skipped', reason: 'signal_off' };
  const [station] = await db
    .select({
      stationId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
      isOnline: chargingStations.isOnline,
      isConformance: chargingStations.isConformance,
    })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationUuid));
  // A conformance test station runs a scripted test: a read nobody scripted would break it.
  if (station?.isConformance === true) return { result: 'skipped', reason: 'not_operator_station' };
  if (station?.isOnline !== true) return { result: 'skipped', reason: 'station_offline' };

  let action: 'GetVariables' | 'GetConfiguration';
  let payload: Record<string, unknown>;
  let version: string | undefined;
  if (isOcpp2x(station.ocppProtocol)) {
    const [rows, itemsLimit, bytesLimit] = await Promise.all([
      dataLinkRows(stationUuid),
      getVariablesLimit(stationUuid, 'ItemsPerMessage'),
      getVariablesLimit(stationUuid, 'BytesPerMessage'),
    ]);
    const items = dataLinkGetVariables(rows, itemsLimit, bytesLimit);
    if (items.length === 0) return { result: 'skipped', reason: 'no_device_model' };
    action = 'GetVariables';
    payload = { getVariableData: items };
  } else {
    if (settings.ocpp16SignalKeys.length === 0) return { result: 'skipped', reason: 'no_keys' };
    action = 'GetConfiguration';
    payload = { key: settings.ocpp16SignalKeys };
    version = 'ocpp1.6';
  }

  try {
    const taken = await ctx.keys.acquire(
      SIM_KEYS.signalRead(stationUuid),
      randomUUID(),
      SIM_SIGNAL_READ_SECONDS * 1000,
    );
    if (!taken) return { result: 'skipped', reason: 'recent' };
  } catch (err: unknown) {
    ctx.log.warn({ err, stationId: stationUuid }, 'Station signal read limit not taken in Redis');
    return { result: 'failed', kind: 'unavailable' };
  }

  const send = ctx.send ?? sendOcppCommandAndWait;
  // Never queued: a stale is_online would otherwise hold the read until the
  // station reconnects, and a read nobody clicked would reach it then.
  const result = await send(station.stationId, action, payload, version, { noQueue: true });
  if (result.error != null || result.response == null) {
    ctx.log.warn(
      { stationId: station.stationId, action, error: result.error, timedOut: result.timedOut },
      'Station signal read failed; the stored values are kept',
    );
    return stationPartFailure(result);
  }
  return { result: 'ok', readAt: (ctx.now ?? (() => new Date()))().toISOString() };
}

export interface StationSignalReading {
  value: number;
  unit: SignalUnit;
  inferred: boolean;
  dbm: number | null;
  grade: SignalGrade;
}

export interface StationDataLinkValues {
  instance: string | null;
  values: Record<string, string | null>;
  /** The unit the station reported for SignalStrength, null when it reported none. */
  signalUnit: string | null;
  signal: StationSignalReading | null;
}

export interface StationSignalSnapshot {
  protocol: 'ocpp2x' | 'ocpp1.6';
  /** 2.x: `unread` before any NotifyReport, `no_datalink` when the report holds no DataLink. */
  deviceModel: 'unread' | 'no_datalink' | 'ok' | null;
  readAt: string | null;
  values: Record<string, string | null>;
  dataLinks: StationDataLinkValues[];
  activeNetworkProfile: string | null;
  thresholds: { goodDbm: number; fairDbm: number };
}

function signalReading(
  value: string | null,
  unit: string | null,
  thresholds: { goodDbm: number; fairDbm: number },
): StationSignalReading | null {
  const reading = readSignalStrength(value, unit);
  if (reading == null) return null;
  return { ...reading, grade: gradeSignal({ dbm: reading.dbm }, thresholds) };
}

function newestOf(dates: readonly Date[]): Date | null {
  let newest: Date | null = null;
  for (const at of dates) if (newest == null || at > newest) newest = at;
  return newest;
}

async function ocpp16Snapshot(
  stationUuid: string,
  keys: readonly string[],
  thresholds: { goodDbm: number; fairDbm: number },
): Promise<StationSignalSnapshot> {
  const rows =
    keys.length === 0
      ? []
      : await db
          .select({
            variable: stationConfigurations.variable,
            value: stationConfigurations.value,
            updatedAt: stationConfigurations.updatedAt,
          })
          .from(stationConfigurations)
          .where(
            and(
              eq(stationConfigurations.stationId, stationUuid),
              eq(stationConfigurations.component, 'OCPP'),
              inArray(stationConfigurations.variable, [...keys]),
            ),
          );
  const values: Record<string, string | null> = {};
  for (const key of keys) values[key] = rows.find((r) => r.variable === key)?.value ?? null;
  return {
    protocol: 'ocpp1.6',
    deviceModel: null,
    readAt: newestOf(rows.map((r) => r.updatedAt))?.toISOString() ?? null,
    values,
    dataLinks: [],
    activeNetworkProfile: null,
    thresholds,
  };
}

/**
 * What the station reported about its cellular link, from station_configurations
 * (the last Refresh, or a NotifyReport). Database reads only.
 */
export async function stationSignalSnapshot(
  stationUuid: string,
  settings: Pick<SimGeneralSettings, 'ocpp16SignalKeys' | 'signalGoodDbm' | 'signalFairDbm'>,
): Promise<StationSignalSnapshot | null> {
  const [station] = await db
    .select({ ocppProtocol: chargingStations.ocppProtocol })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationUuid));
  if (station == null) return null;
  const thresholds = { goodDbm: settings.signalGoodDbm, fairDbm: settings.signalFairDbm };
  if (!isOcpp2x(station.ocppProtocol)) {
    return ocpp16Snapshot(stationUuid, settings.ocpp16SignalKeys, thresholds);
  }

  const [rows, reported] = await Promise.all([
    dataLinkRows(stationUuid),
    db
      .select({ id: stationConfigurations.id })
      .from(stationConfigurations)
      .where(
        and(
          eq(stationConfigurations.stationId, stationUuid),
          eq(stationConfigurations.source, 'NotifyReport'),
        ),
      )
      .limit(1),
  ]);
  const links = new Map<string, StationDataLinkValues>();
  const values: Record<string, string | null> = {};
  let activeNetworkProfile: string | null = null;
  const readTimes: Date[] = [];
  for (const row of rows) {
    if (row.component === ACTIVE_NETWORK_PROFILE.component) {
      if (row.variable !== ACTIVE_NETWORK_PROFILE.variable) continue;
      activeNetworkProfile = row.value;
      values[`${ACTIVE_NETWORK_PROFILE.component}.${ACTIVE_NETWORK_PROFILE.variable}`] = row.value;
      continue;
    }
    if (!DATALINK_VARIABLES.includes(row.variable)) continue;
    readTimes.push(row.updatedAt);
    const key = row.instance ?? '';
    const link = links.get(key) ?? {
      instance: row.instance,
      values: {},
      signalUnit: null,
      signal: null,
    };
    link.values[row.variable] = row.value;
    if (row.variable === 'SignalStrength') {
      link.signalUnit = row.unit;
      link.signal = signalReading(row.value, row.unit, thresholds);
    }
    links.set(key, link);
    const name = row.instance != null ? `DataLink[${row.instance}]` : 'DataLink';
    values[`${name}.${row.variable}`] = row.value;
  }
  const dataLinks = [...links.values()].sort((a, b) =>
    (a.instance ?? '').localeCompare(b.instance ?? ''),
  );
  return {
    protocol: 'ocpp2x',
    deviceModel: dataLinks.length > 0 ? 'ok' : reported.length > 0 ? 'no_datalink' : 'unread',
    readAt: newestOf(readTimes)?.toISOString() ?? null,
    values,
    dataLinks,
    activeNetworkProfile,
    thresholds,
  };
}
