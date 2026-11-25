// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import {
  EVSE_LIMIT_REFUSALS_BEFORE_FALLBACK,
  EVSE_LIMITS_REFUSAL_RETRY_MS,
} from '@evtivity/lib/load-allocation';
import {
  creditTransition,
  limitTransition,
  parseLimitRecord,
  UNKNOWN_LIMIT,
  type LimitEvent,
} from '@evtivity/lib/load-limit-state';
import { currentLoadManagementFence } from './load-management-fence.js';

// Station events that change what the load management cycle sends next. The
// cycle (`runLoadManagementCycle`, @evtivity/services) reads the limit records
// from `site_load_management.applied_allocations`; these are the only other
// writers of that column and of `applied_at`.

export type LoadManagementRateUnit = 'A' | 'W';

/** Per-EVSE limit refusals count toward the fallback only within this window, ms. */
export const EVSE_LIMIT_REFUSAL_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The station's load management profile may be gone (an accepted
 * ClearChargingProfile, a reboot): null `applied_at` of its site so the next
 * cycle sends the limits again instead of waiting for the refresh interval.
 * Only for a station on a circuit of a site with load management on. Keyed by
 * the station's OCPP identity, one statement. Returns true when a site was
 * marked.
 */
export async function markLoadManagementStale(
  sql: postgres.Sql,
  stationOcppId: string,
): Promise<boolean> {
  const result = await sql`
    UPDATE site_load_management slm
    SET applied_at = NULL
    FROM charging_stations cs
    WHERE cs.station_id = ${stationOcppId}
      AND cs.circuit_id IS NOT NULL
      AND slm.site_id = cs.site_id
      AND slm.is_enabled = true
      AND slm.applied_at IS NOT NULL
  `;
  return result.count > 0;
}

/** A station event that moves a load management limit record. */
export type StationLimitEvent =
  /** The reply to the station limit (stack level 1) of `commandId`, in `unit`. */
  | { type: 'reply'; accepted: boolean; commandId: string | null; unit: LoadManagementRateUnit }
  /** The reply to the credit profile (stack level 2) of `commandId`. */
  | { type: 'creditReply'; accepted: boolean; commandId: string | null }
  /** The reply to the TxProfile of `transactionId` load management sent. */
  | { type: 'evseReply'; accepted: boolean; commandId: string | null; transactionId: string }
  /** The reply to the TxDefaultProfile load management sent on EVSE `evseNumber`. */
  | { type: 'defaultReply'; accepted: boolean; commandId: string | null; evseNumber: number }
  /** The station never decided on `commandId` (no answer, offline): its record is lost. */
  | {
      type: 'notSent';
      commandId: string;
      transactionId: string | null;
      credit?: boolean;
      /** The EVSE of a TxDefaultProfile. */
      evseDefault?: number;
    }
  /** An accepted clear that may have removed the defaults of these EVSEs (`all`: every one). */
  | { type: 'defaultsCleared'; evseNumbers: number[] | 'all' }
  /** The station no longer has the transaction (TxNotFound): its record goes. */
  | { type: 'evseGone'; transactionId: string }
  /** A TxProfile another sender sent for the transaction (ISO 15118): it may hold `kw`. */
  | { type: 'evseSend'; transactionId: string; commandId: string; kw: number }
  /** A boot, or an accepted clear that may have removed the station limit. */
  | { type: 'boot' }
  | { type: 'cleared' };

function recordEvent(event: StationLimitEvent): LimitEvent | null {
  switch (event.type) {
    case 'reply':
    case 'creditReply':
    case 'evseReply':
    case 'defaultReply':
      if (event.commandId == null) return null;
      return { type: event.accepted ? 'accepted' : 'rejected', commandId: event.commandId };
    case 'evseSend':
      return { type: 'send', commandId: event.commandId, kw: event.kw };
    case 'notSent':
      return { type: 'timeout', commandId: event.commandId };
    case 'boot':
      return { type: 'boot' };
    case 'cleared':
    case 'defaultsCleared':
      return { type: 'cleared' };
    case 'evseGone':
      return null;
  }
}

/** The entry after `event`, the transition of `@evtivity/lib/load-limit-state` on its record. */
export function stationEntryAfterEvent(
  entry: Record<string, unknown>,
  event: StationLimitEvent,
): Record<string, unknown> {
  const transition = recordEvent(event);
  if (event.type === 'reply') {
    // A reply changes the entry only for the command its record waits on.
    const record = parseLimitRecord(entry['limit']);
    if (transition == null || limitTransition(record, transition) === record) return entry;
    const unitsOf = (key: string): unknown[] =>
      Array.isArray(entry[key])
        ? (entry[key] as unknown[]).filter((u) => u === 'A' || u === 'W')
        : [];
    const rejected = unitsOf('rejectedUnits');
    const units = event.accepted
      ? rejected.filter((u) => u !== event.unit)
      : [...new Set([...rejected, event.unit])];
    const next: Record<string, unknown> = { ...entry, rejectedUnits: units };
    if (units.length === 0) delete next['rejectedUnits'];
    // A station that accepted an A limit is kept on A limits on any circuit.
    if (event.accepted)
      next['acceptedUnits'] = [...new Set([...unitsOf('acceptedUnits'), event.unit])];
    next['limit'] = limitTransition(record, transition);
    return next;
  }
  if (event.type === 'creditReply' || (event.type === 'notSent' && event.credit === true)) {
    const credit = entry['credit'];
    if (transition == null || credit == null || typeof credit !== 'object') return entry;
    const c = credit as Record<string, unknown>;
    const limit = creditTransition(parseLimitRecord(c['limit']), transition);
    return { ...entry, credit: { ...c, limit } };
  }
  if (
    event.type === 'defaultReply' ||
    event.type === 'defaultsCleared' ||
    (event.type === 'notSent' && event.evseDefault != null)
  ) {
    if (transition == null || !Array.isArray(entry['evseDefaults'])) return entry;
    const matches = (n: unknown): boolean =>
      event.type === 'defaultReply'
        ? n === event.evseNumber
        : event.type === 'notSent'
          ? n === event.evseDefault
          : event.evseNumbers === 'all' || event.evseNumbers.includes(n as number);
    return {
      ...entry,
      evseDefaults: (entry['evseDefaults'] as unknown[]).map((d) => {
        if (d == null || typeof d !== 'object') return d;
        const record = d as Record<string, unknown>;
        if (!matches(record['evseNumber'])) return d;
        const current = record['limit'] != null ? parseLimitRecord(record['limit']) : UNKNOWN_LIMIT;
        return { ...record, limit: limitTransition(current, transition) };
      }),
    };
  }
  if (event.type === 'notSent' && event.transactionId == null) {
    return transition != null
      ? { ...entry, limit: limitTransition(parseLimitRecord(entry['limit']), transition) }
      : entry;
  }
  if (event.type === 'boot' || event.type === 'cleared') {
    const next: Record<string, unknown> = { ...entry, limit: UNKNOWN_LIMIT };
    // The EVSE TxProfiles end with a boot, and a boot may drop the defaults;
    // a clear of the station limit leaves both.
    if (event.type === 'boot') {
      for (const key of ['evses', 'evseDefaults'] as const) {
        if (!Array.isArray(entry[key])) continue;
        next[key] = (entry[key] as unknown[]).map((e) =>
          e != null && typeof e === 'object' ? { ...e, limit: UNKNOWN_LIMIT } : e,
        );
      }
    }
    return next;
  }
  if (!Array.isArray(entry['evses'])) return entry;
  const evses = entry['evses'] as unknown[];
  const matches = (e: unknown): boolean =>
    e != null &&
    typeof e === 'object' &&
    (e as Record<string, unknown>)['transactionId'] === event.transactionId;
  if (event.type === 'evseGone') {
    const kept = evses.filter((e) => !matches(e));
    if (kept.length === evses.length) return entry;
    const next: Record<string, unknown> = { ...entry, evses: kept };
    if (kept.length === 0) delete next['evses'];
    return next;
  }
  if (transition == null) return entry;
  return {
    ...entry,
    evses: evses.map((e) => {
      if (!matches(e)) return e;
      const record = e as Record<string, unknown>;
      const current = record['limit'] != null ? parseLimitRecord(record['limit']) : UNKNOWN_LIMIT;
      return { ...record, limit: limitTransition(current, transition) };
    }),
  };
}

/** Deep equality of two JSON values, key order ignored (jsonb reorders keys). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

async function hasStoredStationLimit(
  tx: postgres.TransactionSql,
  stationUuid: string,
): Promise<boolean> {
  const rows = await tx<{ found: number }[]>`
    SELECT 1 AS found FROM charging_profiles
    WHERE station_id = ${stationUuid}
      AND source = 'csms_set'
      AND profile_data ->> 'stackLevel' = '1'
      AND profile_data ->> 'chargingProfilePurpose' IN ('ChargingStationMaxProfile', 'ChargePointMaxProfile')
    LIMIT 1
  `;
  return rows.length > 0;
}

function hasStationEntry(current: unknown, stationUuid: string): boolean {
  return (
    Array.isArray(current) &&
    current.some(
      (e) =>
        e != null &&
        typeof e === 'object' &&
        (e as Record<string, unknown>)['stationDbId'] === stationUuid,
    )
  );
}

/** A boot of a station without an entry: the entry it gets depends on a stored station limit. */
export function bootAddsEntry(
  current: unknown,
  stationUuid: string,
  event: StationLimitEvent,
): boolean {
  return event.type === 'boot' && !hasStationEntry(current, stationUuid);
}

/**
 * The `applied_allocations` after a station event (the pure part of
 * `applyStationLimitEvent`): the station's entry moved by the event; for a
 * boot of a station without an entry but with a stored station limit
 * (`hasStoredLimit`), an unknown entry added. `resend`: the next cycle sends
 * at once (a boot, a clear, a lost send, a refusal).
 */
export function allocationsAfterStationEvent(
  current: unknown,
  station: { stationUuid: string; stationId: string },
  event: StationLimitEvent,
  options: { hasStoredLimit: boolean },
): { next: unknown[]; changed: boolean; resend: boolean } {
  const entries = Array.isArray(current) ? (current as unknown[]) : [];
  const seen = { found: false };
  const next = entries.map((entry) => {
    if (entry == null || typeof entry !== 'object') return entry;
    const e = entry as Record<string, unknown>;
    if (e['stationDbId'] !== station.stationUuid) return entry;
    seen.found = true;
    const merged = stationEntryAfterEvent(e, event);
    return sameJson(merged, e) ? entry : merged;
  });
  // A station without an entry is counted at its stored load management
  // profile, which a boot may have removed: it becomes unknown. Without a
  // stored profile it is unlimited already and needs no entry.
  if (!seen.found && event.type === 'boot' && options.hasStoredLimit) {
    next.push({
      stationId: station.stationId,
      stationDbId: station.stationUuid,
      allocatedKw: 0,
      limit: UNKNOWN_LIMIT,
    });
  }
  const changed = next.length !== entries.length || next.some((e, i) => e !== entries[i]);
  // A refusal, in a unit new to the entry or not, is sent again on the next
  // cycle: the station stays reserved until it accepts a limit.
  const refused =
    (event.type === 'reply' ||
      event.type === 'creditReply' ||
      event.type === 'evseReply' ||
      event.type === 'defaultReply') &&
    !event.accepted;
  const resend =
    event.type === 'boot' ||
    event.type === 'cleared' ||
    event.type === 'defaultsCleared' ||
    event.type === 'notSent' ||
    refused;
  return { next, changed, resend };
}

/**
 * Applies a station event to the station's entry of `applied_allocations`
 * under the site row lock (the one place outside the cycle that moves a limit
 * record). A refusal, a boot, a clear and a lost send null
 * `applied_at`, so the next cycle sends at once; a boot of a managed station
 * without an entry but with a stored station limit adds one in the unknown
 * state, so it is reserved at what it may draw. Only while load management is
 * on. Returns true when the entry changed.
 */
export async function applyStationLimitEvent(
  sql: postgres.Sql,
  stationUuid: string,
  event: StationLimitEvent,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx<
      {
        site_id: string;
        applied_allocations: unknown;
        station_id: string;
        on_circuit: boolean;
      }[]
    >`
      SELECT slm.site_id, slm.applied_allocations, cs.station_id,
        cs.circuit_id IS NOT NULL AS on_circuit
      FROM site_load_management slm
      JOIN charging_stations cs ON cs.site_id = slm.site_id
      WHERE cs.id = ${stationUuid} AND slm.is_enabled = true
      FOR UPDATE OF slm
    `;
    const row = rows[0];
    if (row == null) return false;
    // A station off its circuit is no longer managed: its entry waits for its clear.
    if (event.type === 'boot' && !row.on_circuit) return false;
    const current = row.applied_allocations;
    const station = { stationUuid, stationId: row.station_id };
    const hasStoredLimit =
      bootAddsEntry(current, stationUuid, event) && (await hasStoredStationLimit(tx, stationUuid));
    const { next, changed, resend } = allocationsAfterStationEvent(current, station, event, {
      hasStoredLimit,
    });
    if (!changed) return false;
    if (resend) {
      await tx`
        UPDATE site_load_management
        SET applied_allocations = ${tx.json(next as never)}, applied_at = NULL
        WHERE site_id = ${row.site_id}
      `;
    } else {
      await tx`
        UPDATE site_load_management SET applied_allocations = ${tx.json(next as never)}
        WHERE site_id = ${row.site_id}
      `;
    }
    return true;
  });
}

/**
 * Writes the station records of a load management send under the site row
 * lock: `build` turns the locked entries into the ones to store (the raises
 * recorded as sends before they go out, or the send's failures). Only while
 * load management is on and, inside a fenced cycle, while the cycle still
 * holds the site's fence: a newer holder's state is never overwritten.
 * `nullAppliedAt` makes the next cycle send again; `appliedAt` records the
 * send as complete (the raise claim). Returns true when it wrote.
 */
export async function writeLoadManagementRecords(
  sql: postgres.Sql,
  siteId: string,
  build: (locked: unknown) => unknown[],
  options: { nullAppliedAt?: boolean; appliedAt?: Date } = {},
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx<
      { applied_allocations: unknown; cycle_fence: string | number | null; is_enabled: boolean }[]
    >`
      SELECT applied_allocations, cycle_fence, is_enabled
      FROM site_load_management
      WHERE site_id = ${siteId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row?.is_enabled !== true) return false;
    const fence = currentLoadManagementFence(siteId);
    if (fence != null && Number(row.cycle_fence) !== fence.fence) return false;
    if (fence?.signal?.aborted === true) return false;
    const next = build(row.applied_allocations);
    if (options.nullAppliedAt === true) {
      await tx`
        UPDATE site_load_management
        SET applied_allocations = ${tx.json(next as never)}, applied_at = NULL
        WHERE site_id = ${siteId}
      `;
    } else if (options.appliedAt != null) {
      await tx`
        UPDATE site_load_management
        SET applied_allocations = ${tx.json(next as never)}, applied_at = ${options.appliedAt}
        WHERE site_id = ${siteId}
      `;
    } else {
      await tx`
        UPDATE site_load_management SET applied_allocations = ${tx.json(next as never)}
        WHERE site_id = ${siteId}
      `;
    }
    return true;
  });
}

/**
 * The station refused (or answered with an error) the per-EVSE limit load
 * management sent for `transactionId`. Counts only while that transaction is
 * active and in the EVSE limits stored for the station (a refused depot plan
 * or ISO 15118 TxProfile, or one whose transaction ended, counts nothing),
 * and never for reason code TxNotFound (K01.FR.09: the transaction is gone).
 * After `EVSE_LIMIT_REFUSALS_BEFORE_FALLBACK` such refusals with no accepted
 * one between, the last within `EVSE_LIMIT_REFUSAL_WINDOW_MS` of the one
 * before (an older count starts again at this refusal,
 * `evse_limit_refusal_at`), it gets one station limit only (`evse_limits_refused_at`, read
 * for `EVSE_LIMITS_REFUSAL_RETRY_MS`) and its site sends again on the next
 * cycle. Returns true when it was marked.
 */
export async function markEvseLimitsRefused(
  sql: postgres.Sql,
  stationUuid: string,
  transactionId: string,
  reasonCode: string | null = null,
): Promise<boolean> {
  if (reasonCode === 'TxNotFound') return false;
  const retrySeconds = EVSE_LIMITS_REFUSAL_RETRY_MS / 1000;
  const windowSeconds = EVSE_LIMIT_REFUSAL_WINDOW_MS / 1000;
  const rows = await sql<{ marked: number }[]>`
    WITH counted AS (
      UPDATE charging_stations cs
      SET evse_limit_refusals = CASE
            WHEN (CASE
              WHEN cs.evse_limit_refusal_at IS NULL
                OR cs.evse_limit_refusal_at < now() - make_interval(secs => ${windowSeconds})
                THEN 0
              ELSE cs.evse_limit_refusals
            END) + 1 >= ${EVSE_LIMIT_REFUSALS_BEFORE_FALLBACK} THEN 0
            ELSE (CASE
              WHEN cs.evse_limit_refusal_at IS NULL
                OR cs.evse_limit_refusal_at < now() - make_interval(secs => ${windowSeconds})
                THEN 0
              ELSE cs.evse_limit_refusals
            END) + 1
          END,
          evse_limits_refused_at = CASE
            WHEN (CASE
              WHEN cs.evse_limit_refusal_at IS NULL
                OR cs.evse_limit_refusal_at < now() - make_interval(secs => ${windowSeconds})
                THEN 0
              ELSE cs.evse_limit_refusals
            END) + 1 >= ${EVSE_LIMIT_REFUSALS_BEFORE_FALLBACK} THEN now()
            ELSE cs.evse_limits_refused_at
          END,
          evse_limit_refusal_at = now()
      WHERE cs.id = ${stationUuid}
        AND (
          cs.evse_limits_refused_at IS NULL
          OR cs.evse_limits_refused_at < now() - make_interval(secs => ${retrySeconds})
        )
        AND EXISTS (
          SELECT 1 FROM charging_sessions s
          WHERE s.station_id = cs.id
            AND s.transaction_id = ${transactionId}
            AND s.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM site_load_management slm,
            jsonb_array_elements(
              CASE WHEN jsonb_typeof(slm.applied_allocations) = 'array'
                THEN slm.applied_allocations ELSE '[]'::jsonb END
            ) AS a(e),
            jsonb_array_elements(
              CASE WHEN jsonb_typeof(a.e -> 'evses') = 'array'
                THEN a.e -> 'evses' ELSE '[]'::jsonb END
            ) AS v(x)
          WHERE slm.site_id = cs.site_id
            AND slm.is_enabled = true
            AND a.e ->> 'stationDbId' = cs.id
            AND v.x ->> 'transactionId' = ${transactionId}
        )
      RETURNING cs.site_id, cs.evse_limits_refused_at = now() AS marked
    ),
    marked AS (
      SELECT site_id FROM counted WHERE marked
    ),
    -- Every counted refusal sends again on the next cycle, so the count (and a
    -- fallback) is reached in seconds, not at the refresh interval.
    stale AS (
      UPDATE site_load_management slm
      SET applied_at = NULL
      FROM counted
      WHERE slm.site_id = counted.site_id AND slm.is_enabled = true
      RETURNING slm.site_id
    )
    SELECT count(*)::int AS marked FROM marked
  `;
  return (rows[0]?.marked ?? 0) > 0;
}

/** The station accepted a per-EVSE limit: its refusals start again from zero. */
export async function recordEvseLimitAccepted(
  sql: postgres.Sql,
  stationUuid: string,
): Promise<boolean> {
  const result = await sql`
    UPDATE charging_stations
    SET evse_limit_refusals = 0
    WHERE id = ${stationUuid} AND evse_limit_refusals > 0
  `;
  return result.count > 0;
}

/**
 * Lets the station take per-EVSE limits again (the operator chose its
 * balancing mode, or the station booted). Returns true when a refusal was
 * cleared.
 */
export async function clearEvseLimitsRefused(
  sql: postgres.Sql,
  stationUuid: string,
): Promise<boolean> {
  const result = await sql`
    UPDATE charging_stations
    SET evse_limits_refused_at = NULL, evse_limit_refusals = 0
    WHERE id = ${stationUuid}
      AND (evse_limits_refused_at IS NOT NULL OR evse_limit_refusals > 0)
  `;
  return result.count > 0;
}

/**
 * The station refused a per-EVSE limit that named a phase for the car
 * (phaseToUse): its entry in the station's stored EVSE limits keeps
 * `phaseToUseRefused`, so the session is sent no phase again and keeps the
 * phase it charges on, and the next cycle sends the limit again without it.
 * Returns true when an entry changed.
 */
export async function recordPhaseToUseRefused(
  sql: postgres.Sql,
  stationUuid: string,
  transactionId: string,
): Promise<boolean> {
  const result = await sql`
    UPDATE site_load_management slm
    SET applied_allocations = (
      SELECT jsonb_agg(
        CASE WHEN t.e ->> 'stationDbId' = ${stationUuid}
            AND jsonb_typeof(t.e -> 'evses') = 'array'
          THEN jsonb_set(t.e, '{evses}', (
            SELECT jsonb_agg(
              CASE WHEN v.x ->> 'transactionId' = ${transactionId}
                THEN (v.x - 'phaseToUse' - 'phaseToUseSinceMs')
                  || jsonb_build_object('phaseToUseRefused', true)
                ELSE v.x
              END
              ORDER BY v.ord
            )
            FROM jsonb_array_elements(t.e -> 'evses') WITH ORDINALITY AS v(x, ord)
          ))
          ELSE t.e
        END
        ORDER BY t.ord
      )
      FROM jsonb_array_elements(slm.applied_allocations) WITH ORDINALITY AS t(e, ord)
    ),
    applied_at = NULL
    WHERE slm.site_id = (SELECT site_id FROM charging_stations WHERE id = ${stationUuid})
      AND jsonb_typeof(slm.applied_allocations) = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(slm.applied_allocations) AS a(e),
          jsonb_array_elements(
            CASE WHEN jsonb_typeof(a.e -> 'evses') = 'array' THEN a.e -> 'evses' ELSE '[]'::jsonb END
          ) AS w(x)
        WHERE a.e ->> 'stationDbId' = ${stationUuid}
          AND w.x ->> 'transactionId' = ${transactionId}
          AND w.x -> 'phaseToUseRefused' IS DISTINCT FROM 'true'::jsonb
      )
  `;
  return result.count > 0;
}
