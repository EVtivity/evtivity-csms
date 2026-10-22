// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  chargingStations,
  clearStationSimMatch,
  compareRecordIds,
  confirmStationSimMatch,
  db,
  getSimProviderSettings,
  getStationSimMatch,
  recordSimAlertsSynced,
  recordSimLookupMiss,
  recordSimSessionsSynced,
  recordSimStatus,
  setStationSimMatch,
  simAlerts,
  simFetchCoverage,
  simSessions,
  stationConfigurations,
  type ConfirmStationSimMatchResult,
  type SimAuditActor,
  type SimMatchMeta,
  type StationSimMatch,
  type StoredSimStatus,
} from '@evtivity/database';
import {
  gradeSignal,
  isOcpp2x,
  normalizeIccid,
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
  type SimSession,
  type SimStatus,
} from '@evtivity/sim-providers';
import {
  coveredDays,
  coveredMs,
  mergeIntervals,
  type SimCoveredDay,
  type SimInterval,
} from './sim-coverage.js';
import { sendOcppCommandAndWait, type CommandResult } from './ocpp-command.js';
import {
  classifyDisconnect,
  type DisconnectFacts,
  type SimOfflineCause,
  type StoredSimSessionSpan,
} from './sim-offline-cause.js';

export { coveredDays, mergeIntervals, zonedDay } from './sim-coverage.js';
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

/** How long a lookup that found no SIM is not repeated. */
export const SIM_LOOKUP_MISS_TTL_MS = 3_600_000;

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

export type SimNotMatchedReason = 'no_iccid' | 'not_found' | 'sim_matched_elsewhere';

export type StationSimResolution =
  | { kind: 'matched'; provider: SimProvider; ref: SimRef; confirmed: boolean }
  | { kind: 'not_matched'; reason: SimNotMatchedReason }
  | { kind: 'provider_off' };

/** The provider ids a stored match carries, as an adapter reads them. */
export function simRefOf(match: StationSimMatch): SimRef | null {
  if (match.providerRef == null) return null;
  const meta = (match.meta ?? {}) as SimMatchMeta;
  return {
    providerSimId: match.providerRef,
    ...(typeof meta.linkId === 'string' ? { linkId: meta.linkId } : {}),
    ...(typeof meta.simcardId === 'string' ? { simcardId: meta.simcardId } : {}),
  };
}

/** The SIM a station's stored SIM data is read for: its confirmed match. */
export interface ConfirmedSimRef {
  provider: string;
  providerRef: string;
}

/**
 * The provider and ref of a confirmed match, else null. Reads of stored SIM
 * sessions, alerts and coverage use only the rows of this SIM, so data fetched
 * for an earlier SIM of the station never shows.
 */
export function confirmedSimRef(match: StationSimMatch | null): ConfirmedSimRef | null {
  if (match?.provider == null || match.providerRef == null || match.confirmedAt == null) {
    return null;
  }
  return { provider: match.provider, providerRef: match.providerRef };
}

async function stationIccid(stationId: string): Promise<string | null> {
  const [row] = await db
    .select({ iccid: chargingStations.iccid })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));
  return row?.iccid ?? null;
}

/**
 * The station's SIM at its provider, for a Refresh: the stored match, else a
 * lookup at each enabled provider in order with the normalized ICCID. A miss
 * is cached for an hour unless `retryLookup` (Look Up Again). A hit is
 * confirmed at once, for the person who entered it, when it is the ICCID an
 * operator with access to every site entered; a SIM matched to another
 * station is refused. Provider errors propagate.
 */
export async function resolveStationSim(
  registry: SimProviderRegistry,
  stationId: string,
  actor: SimAuditActor,
  options: {
    retryLookup?: boolean;
    log?: ServiceLogger;
    /** Called with each provider before it is asked, so a 429 backs off that provider. */
    onLookup?: (provider: SimProviderId) => void;
  } = {},
): Promise<StationSimResolution> {
  const match = await getStationSimMatch(stationId);
  const ref = match != null ? simRefOf(match) : null;
  if (match?.provider != null && ref != null) {
    const provider = await registry.getProvider(match.provider as SimProviderId);
    if (provider == null) return { kind: 'provider_off' };
    return { kind: 'matched', provider, ref, confirmed: match.confirmedAt != null };
  }

  const providers = await registry.enabledProviders();
  if (providers.length === 0) return { kind: 'provider_off' };

  const iccid = normalizeIccid(await stationIccid(stationId));
  if (iccid == null) return { kind: 'not_matched', reason: 'no_iccid' };

  if (
    options.retryLookup !== true &&
    match?.lookupMissedAt != null &&
    Date.now() - match.lookupMissedAt.getTime() < SIM_LOOKUP_MISS_TTL_MS
  ) {
    return {
      kind: 'not_matched',
      reason:
        match.lookupMissReason === 'sim_matched_elsewhere' ? 'sim_matched_elsewhere' : 'not_found',
    };
  }

  for (const provider of providers) {
    options.onLookup?.(provider.id);
    const found = await provider.findByIccid(iccid);
    if (found == null) continue;
    // Only an ICCID entered by a person with access to every site vouches for the SIM.
    const confirm =
      match?.enteredIccid === iccid && match.enteredWithAllSites
        ? { by: match.enteredBy ?? null }
        : null;
    const meta: SimMatchMeta = {
      ...(found.linkId != null ? { linkId: found.linkId } : {}),
      ...(found.simcardId != null ? { simcardId: found.simcardId } : {}),
    };
    const result = await setStationSimMatch(
      stationId,
      { provider: provider.id, providerRef: found.providerSimId, meta, confirm },
      actor,
      options.log,
    );
    if (!result.matched) return { kind: 'not_matched', reason: result.reason };
    return { kind: 'matched', provider, ref: found, confirmed: confirm != null };
  }
  await recordSimLookupMiss(stationId, 'not_found');
  return { kind: 'not_matched', reason: 'not_found' };
}

/**
 * Confirm SIM: the stored match becomes a reset target and its data is fetched
 * from the next Refresh on. Only the match the person saw (`shownMatchedAt`) is
 * confirmed; an already confirmed match stays as it is; a SIM another station
 * holds confirmed is refused.
 */
export async function confirmStationSim(
  stationId: string,
  actor: SimAuditActor,
  shownMatchedAt: Date,
  log?: ServiceLogger,
): Promise<ConfirmStationSimMatchResult> {
  return confirmStationSimMatch(stationId, actor, shownMatchedAt, log);
}

/**
 * Clears the match; the next Refresh looks the SIM up again. Without a match
 * it changes nothing (a cached lookup miss stays) and answers false.
 */
export async function clearStationSim(
  stationId: string,
  actor: SimAuditActor,
  log?: ServiceLogger,
): Promise<boolean> {
  const match = await getStationSimMatch(stationId);
  if (match?.provider == null) return false;
  return clearStationSimMatch(stationId, actor, {}, log);
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

export const SIM_KEYS = {
  lock: (stationId: string): string => `sim:lock:${stationId}`,
  backoff: (provider: string): string => `sim:backoff:${provider}`,
  refresh: (stationId: string): string => `sim:refresh:${stationId}`,
  reset: (stationId: string): string => `sim:reset:${stationId}`,
  signalRead: (stationId: string): string => `sim:signalread:${stationId}`,
  test: (provider: string): string => `sim:test:${provider}`,
} as const;

/** One fetch per station at a time; renewed before each page. */
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

export type SimProviderPartSkipReason =
  | 'provider_off'
  | 'not_matched'
  | 'not_confirmed'
  | 'backoff'
  | 'in_progress';

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
      matchReason?: SimNotMatchedReason;
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

type SimTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Rows of one SIM a fetch moved here from another station (or SIM ref), and their time span. */
interface MovedSimRows {
  stationId: string;
  providerRef: string | null;
  from: Date;
  to: Date;
}

/**
 * Drops the fetched periods that rows moved away from: the station they left
 * no longer holds every session or alert of those periods, so they show as not
 * fetched there. Each station's coverage lock is taken in id order.
 */
async function dropMovedCoverage(
  tx: SimTx,
  provider: SimProviderId,
  moved: readonly MovedSimRows[],
): Promise<void> {
  const spans = new Map<string, MovedSimRows>();
  for (const row of moved) {
    const key = `${row.stationId}\u0000${row.providerRef ?? ''}`;
    const span = spans.get(key);
    spans.set(
      key,
      span == null
        ? { ...row }
        : {
            ...span,
            from: row.from < span.from ? row.from : span.from,
            to: row.to > span.to ? row.to : span.to,
          },
    );
  }
  const ordered = [...spans.values()].sort((a, b) => a.stationId.localeCompare(b.stationId));
  for (const span of ordered) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`sim_coverage:${span.stationId}`}))`,
    );
    await tx
      .delete(simFetchCoverage)
      .where(
        and(
          eq(simFetchCoverage.stationId, span.stationId),
          eq(simFetchCoverage.provider, provider),
          span.providerRef == null
            ? isNull(simFetchCoverage.providerRef)
            : eq(simFetchCoverage.providerRef, span.providerRef),
          lte(simFetchCoverage.coveredFrom, span.to),
          gte(simFetchCoverage.coveredTo, span.from),
        ),
      );
  }
}

/**
 * Stores fetched sessions. A session stored for another station (the SIM
 * moved) moves to this one with the fetched values, and the old station's
 * fetched periods it falls in are dropped. Returns the rows inserted or moved.
 */
async function storeSessions(
  stationId: string,
  provider: SimProviderId,
  providerSimId: string,
  sessions: readonly SimSession[],
): Promise<number> {
  if (sessions.length === 0) return 0;
  return db.transaction(async (tx) => {
    const elsewhere = await tx
      .select({
        stationId: simSessions.stationId,
        providerRef: simSessions.providerSimId,
        from: simSessions.startedAt,
        to: simSessions.endedAt,
      })
      .from(simSessions)
      .where(
        and(
          eq(simSessions.provider, provider),
          inArray(
            simSessions.providerSessionId,
            sessions.map((s) => s.providerSessionId),
          ),
          or(
            sql`${simSessions.stationId} <> ${stationId}`,
            sql`${simSessions.providerSimId} <> ${providerSimId}`,
          ),
        ),
      )
      .for('update');
    const rows = await tx
      .insert(simSessions)
      .values(
        sessions.map((s) => ({
          stationId,
          provider,
          providerSimId,
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
      .onConflictDoUpdate({
        target: [simSessions.provider, simSessions.providerSessionId],
        set: {
          stationId: sql`excluded.station_id`,
          providerSimId: sql`excluded.provider_sim_id`,
          startedAt: sql`excluded.started_at`,
          endedAt: sql`excluded.ended_at`,
          bytes: sql`excluded.bytes`,
          networkName: sql`excluded.network_name`,
          radioAccessTechnology: sql`excluded.radio_access_technology`,
          cellId: sql`excluded.cell_id`,
          apn: sql`excluded.apn`,
        },
        // Only a move rewrites a row, so a repeated fetch stores nothing.
        setWhere: sql`${simSessions.stationId} <> excluded.station_id
          OR ${simSessions.providerSimId} <> excluded.provider_sim_id`,
      })
      .returning({ id: simSessions.id });
    await dropMovedCoverage(tx, provider, elsewhere);
    return rows.length;
  });
}

/** Stores fetched alerts; an alert of a SIM that moved here moves with it, as sessions do. */
async function storeAlerts(
  stationId: string,
  provider: SimProviderId,
  providerRef: string,
  alerts: readonly SimAlert[],
): Promise<number> {
  if (alerts.length === 0) return 0;
  return db.transaction(async (tx) => {
    const elsewhere = await tx
      .select({
        stationId: simAlerts.stationId,
        providerRef: simAlerts.providerRef,
        from: simAlerts.receivedAt,
        to: simAlerts.receivedAt,
      })
      .from(simAlerts)
      .where(
        and(
          eq(simAlerts.provider, provider),
          inArray(
            simAlerts.providerAlertId,
            alerts.map((a) => a.providerAlertId),
          ),
          or(
            sql`${simAlerts.stationId} <> ${stationId}`,
            sql`${simAlerts.providerRef} IS DISTINCT FROM ${providerRef}`,
          ),
        ),
      )
      .for('update');
    const rows = await tx
      .insert(simAlerts)
      .values(
        alerts.map((a) => ({
          stationId,
          provider,
          providerRef,
          providerAlertId: a.providerAlertId,
          kind: a.kind,
          receivedAt: new Date(a.receivedAt),
        })),
      )
      .onConflictDoUpdate({
        target: [simAlerts.provider, simAlerts.providerAlertId],
        set: {
          stationId: sql`excluded.station_id`,
          providerRef: sql`excluded.provider_ref`,
          kind: sql`excluded.kind`,
          receivedAt: sql`excluded.received_at`,
        },
        setWhere: sql`${simAlerts.stationId} <> excluded.station_id
          OR ${simAlerts.providerRef} IS DISTINCT FROM excluded.provider_ref`,
      })
      .returning({ id: simAlerts.id });
    await dropMovedCoverage(tx, provider, elsewhere);
    return rows.length;
  });
}

/** Stores a range fetched for a SIM and merges it with that SIM's overlapping and touching ones. */
export async function recordSimFetchCoverage(
  stationId: string,
  provider: SimProviderId,
  providerRef: string,
  covered: SimInterval,
  fetchedAt: Date,
): Promise<void> {
  if (covered.to.getTime() <= covered.from.getTime()) return;
  await db.transaction(async (tx) => {
    // Coverage writes of one station take turns, so two Refreshes never split a merge.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sim_coverage:${stationId}`}))`);
    const touching = await tx
      .select()
      .from(simFetchCoverage)
      .where(
        and(
          eq(simFetchCoverage.stationId, stationId),
          eq(simFetchCoverage.provider, provider),
          eq(simFetchCoverage.providerRef, providerRef),
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
      stationId,
      provider,
      providerRef,
      coveredFrom: range.from,
      coveredTo: range.to,
      fetchedAt,
    });
  });
}

async function coverageHolds(
  stationId: string,
  sim: ConfirmedSimRef,
  from: Date,
  to: Date,
): Promise<boolean> {
  const rows = await db
    .select({ from: simFetchCoverage.coveredFrom, to: simFetchCoverage.coveredTo })
    .from(simFetchCoverage)
    .where(
      and(
        eq(simFetchCoverage.stationId, stationId),
        eq(simFetchCoverage.provider, sim.provider),
        eq(simFetchCoverage.providerRef, sim.providerRef),
      ),
    );
  return coveredMs(mergeIntervals(rows), from, to) >= to.getTime() - from.getTime();
}

/**
 * The provider part of a Refresh: resolves the SIM, then reads its status, its
 * sessions and its alerts for the period and stores them. One fetch per station
 * at a time across pods (`sim:lock:<station>`, renewed before every provider
 * call); a provider 429 sets the provider backoff, during which a Refresh calls
 * no provider. A Redis failure reports the part `failed` with kind
 * `unavailable`. Every outcome is reported, never thrown, except a database
 * failure.
 */
export async function refreshStationSimProvider(
  ctx: SimRefreshContext,
  stationId: string,
  period: SimRefreshPeriod,
  options: { retryLookup?: boolean } = {},
): Promise<SimProviderPartResult> {
  const now = ctx.now ?? (() => new Date());
  const providers = await ctx.registry.enabledProviders();
  if (providers.length === 0) return { result: 'skipped', reason: 'provider_off' };
  const redisDown = (err: unknown, step: string): SimProviderPartResult => {
    ctx.log.warn({ err, stationId }, `SIM Refresh ${step} failed in Redis; no provider call`);
    return { result: 'failed', kind: 'unavailable' };
  };

  let waiting: number | null;
  try {
    waiting = await backoffSeconds(ctx.keys, providers);
  } catch (err: unknown) {
    return redisDown(err, 'backoff read');
  }
  if (waiting != null) return { result: 'skipped', reason: 'backoff', retryAfter: waiting };

  const token = randomUUID();
  const lockKey = SIM_KEYS.lock(stationId);
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
      ctx.log.warn({ err, stationId }, 'SIM fetch lock not renewed; the fetch stops');
      return false;
    }
  };
  const LOCK_LOST = { result: 'failed', kind: 'lock_lost' } as const;

  let providerId: SimProviderId | null = null;
  try {
    const resolution = await resolveStationSim(ctx.registry, stationId, ctx.actor, {
      ...(options.retryLookup === true ? { retryLookup: true } : {}),
      log: ctx.log,
      onLookup: (id) => {
        providerId = id;
      },
    });
    if (resolution.kind === 'provider_off') return { result: 'skipped', reason: 'provider_off' };
    if (resolution.kind === 'not_matched') {
      return { result: 'skipped', reason: 'not_matched', matchReason: resolution.reason };
    }
    const { provider, ref } = resolution;
    providerId = provider.id;
    // Until a person with access to every site confirms the SIM, nothing is
    // fetched from the provider: the station chose the ICCID it reported.
    if (!resolution.confirmed) {
      return { result: 'skipped', reason: 'not_confirmed', provider: provider.id };
    }
    const fetchedAt = now();

    if (!(await stillHeld())) return LOCK_LOST;
    const status = await provider.getStatus(ref);
    await recordSimStatus(stationId, ref.providerSimId, storedSimStatus(status), fetchedAt);

    const match = await getStationSimMatch(stationId);
    const cursor = period.mode === 'days' ? (match?.lastRecordId ?? null) : null;
    const lastSync = match?.sessionsSyncedAt ?? null;
    // The cursor may end the paging only when stored coverage already holds the
    // rest of the period, so a longer period than the last Refresh pages back.
    const cursorUsable =
      cursor != null &&
      lastSync != null &&
      (await coverageHolds(
        stationId,
        { provider: provider.id, providerRef: ref.providerSimId },
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
      sessionsStored += await storeSessions(stationId, provider.id, ref.providerSimId, keep);
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
      alertsStored += await storeAlerts(stationId, provider.id, ref.providerSimId, result.items);
      if (!result.continues || result.lastId == null) break;
      alertsAfter = result.lastId;
    }

    // Another Refresh may hold the lock now: it writes the cursor and coverage, not this one.
    if (!(await stillHeld())) return LOCK_LOST;
    if (period.mode === 'days') {
      // Synced up to the end of the period asked for, the end the coverage
      // records, so the next Refresh can tell the cursor is usable.
      await recordSimSessionsSynced(stationId, ref.providerSimId, newest, period.to);
      await recordSimAlertsSynced(stationId, ref.providerSimId, fetchedAt);
    }
    // The provider reports sessions late, so nothing newer than its delay is covered.
    const coveredTo = new Date(
      Math.min(period.to.getTime(), fetchedAt.getTime() - provider.reportingDelayHours * 3_600_000),
    );
    await recordSimFetchCoverage(
      stationId,
      provider.id,
      ref.providerSimId,
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
      { err, stationId, provider: providerId, kind: err.kind },
      'SIM provider fetch failed; the stored SIM data is kept',
    );
    if (err.kind === 'rate_limited') {
      const retryAfter = err.retryAfterSeconds ?? SIM_DEFAULT_BACKOFF_SECONDS;
      try {
        // The provider that answered 429; a lookup sets it before each provider it asks.
        const backoffProvider = providerId ?? providers[0]?.id;
        if (backoffProvider != null) {
          await ctx.keys.setFor(SIM_KEYS.backoff(backoffProvider), retryAfter);
        }
      } catch (setErr: unknown) {
        ctx.log.warn(
          { err: setErr, stationId },
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
      ctx.log.warn({ err, stationId }, 'SIM fetch lock release failed; it expires by itself');
    }
  }
}

// ---------------------------------------------------------------------------
// Reads for the status and timeline routes (database only).

export interface SimCoverageBounds {
  historyDays: number | null;
  retentionDays: number;
  reportingDelayHours: number;
}

/** The stored rows of one SIM of a station: sessions, alerts and coverage. */
function simSessionsOf(stationId: string, sim: ConfirmedSimRef) {
  return and(
    eq(simSessions.stationId, stationId),
    eq(simSessions.provider, sim.provider),
    eq(simSessions.providerSimId, sim.providerRef),
  );
}

function simAlertsOf(stationId: string, sim: ConfirmedSimRef) {
  return and(
    eq(simAlerts.stationId, stationId),
    eq(simAlerts.provider, sim.provider),
    eq(simAlerts.providerRef, sim.providerRef),
  );
}

function simCoverageOf(stationId: string, sim: ConfirmedSimRef) {
  return and(
    eq(simFetchCoverage.stationId, stationId),
    eq(simFetchCoverage.provider, sim.provider),
    eq(simFetchCoverage.providerRef, sim.providerRef),
  );
}

/**
 * The coveredDays entries of a station for a range, from the stored data of its
 * confirmed SIM only (`sim`, from `confirmedSimRef`); without one no day is fetched.
 */
export async function stationCoveredDays(
  stationId: string,
  sim: ConfirmedSimRef | null,
  from: Date,
  to: Date,
  timeZone: string,
  bounds: SimCoverageBounds,
  now: Date = new Date(),
): Promise<SimCoveredDay[]> {
  const [coverage, sessionRows, alertRows] =
    sim == null
      ? [[], [], []]
      : await Promise.all([
          db
            .select({ from: simFetchCoverage.coveredFrom, to: simFetchCoverage.coveredTo })
            .from(simFetchCoverage)
            .where(
              and(
                simCoverageOf(stationId, sim),
                lte(simFetchCoverage.coveredFrom, to),
                gte(simFetchCoverage.coveredTo, from),
              ),
            ),
          db
            .select({ startedAt: simSessions.startedAt, endedAt: simSessions.endedAt })
            .from(simSessions)
            .where(
              and(
                simSessionsOf(stationId, sim),
                lte(simSessions.startedAt, to),
                gte(simSessions.endedAt, from),
              ),
            ),
          db
            .select({ receivedAt: simAlerts.receivedAt })
            .from(simAlerts)
            .where(
              and(
                simAlertsOf(stationId, sim),
                gte(simAlerts.receivedAt, from),
                lte(simAlerts.receivedAt, to),
              ),
            ),
        ]);
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
 * The likely offline cause of each disconnect, from the stored SIM sessions and
 * alerts of the station's confirmed SIM and the open session of its last
 * Refresh; data of an earlier SIM is never used. Reads the database only.
 * Returns one label per disconnect, in the same order.
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
  const match = await getStationSimMatch(stationId);
  const sim = confirmedSimRef(match);
  const [near, before, after, alerts, coverage] =
    sim == null
      ? [[], [], [], [], []]
      : await Promise.all([
          db
            .select(span)
            .from(simSessions)
            .where(
              and(
                simSessionsOf(stationId, sim),
                gte(simSessions.endedAt, from),
                lte(simSessions.startedAt, to),
              ),
            ),
          db
            .select(span)
            .from(simSessions)
            .where(and(simSessionsOf(stationId, sim), lt(simSessions.endedAt, from)))
            .orderBy(desc(simSessions.endedAt))
            .limit(1),
          db
            .select(span)
            .from(simSessions)
            .where(and(simSessionsOf(stationId, sim), gt(simSessions.startedAt, to)))
            .orderBy(asc(simSessions.startedAt))
            .limit(1),
          db
            .select({ kind: simAlerts.kind, receivedAt: simAlerts.receivedAt })
            .from(simAlerts)
            .where(
              and(
                simAlertsOf(stationId, sim),
                gte(simAlerts.receivedAt, from),
                lte(simAlerts.receivedAt, to),
              ),
            ),
          db
            .select({ from: simFetchCoverage.coveredFrom, to: simFetchCoverage.coveredTo })
            .from(simFetchCoverage)
            .where(
              and(
                simCoverageOf(stationId, sim),
                lte(simFetchCoverage.coveredFrom, to),
                gte(simFetchCoverage.coveredTo, from),
              ),
            ),
        ]);
  const sessions: StoredSimSessionSpan[] = [...before, ...near, ...after];
  const ctx = {
    sessions,
    alerts,
    openSessionBeganAt: sim == null ? null : (match?.openSessionBeganAt ?? null),
    lastFetchedAt: sim == null ? null : (match?.statusFetchedAt ?? null),
    reportingDelayHours: options.reportingDelayHours,
    now: options.now ?? new Date(),
    coverage: mergeIntervals(coverage),
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
