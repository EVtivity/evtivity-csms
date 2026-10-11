// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The current state of an insight's subject: a fingerprint (the read routes
 * compare it with `basis_fingerprint` to report `stale`) and whether the
 * condition that raised the insight has cleared (the debounce re-check and
 * the scan's resolve pass).
 *
 * - Station kinds: online flag, availability, its reason, latest status log id.
 * - Session: status and updated_at (a re-bill changes it).
 * - Authorization: the latest refusal of the token at the station in the bucket.
 * - Site incident: the online flag and availability of every member station.
 * - Reservation kinds: the reservation's status and updated_at.
 */

import { createHash } from 'node:crypto';
import {
  client,
  stationAvailabilitySql,
  stationStatusReasonSql,
  toIsoOrNull,
} from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import { isReservationInsightKind } from '@evtivity/lib/ai-insights';
import type { InsightKind } from '@evtivity/lib/ai-insights';

export interface InsightSubjectRef {
  id: string;
  kind: InsightKind;
  stationId: string | null;
  sessionId: string | null;
  authorizeAttemptId: number | null;
  reservationId?: string | null;
}

export const STATION_INSIGHT_KINDS: ReadonlySet<InsightKind> = new Set([
  'station_offline',
  'station_faulted',
  'station_alert',
]);

function hash(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

interface StationStateRow {
  id: string;
  is_online: boolean;
  availability: string;
  status_reason: string | null;
  last_status_id: number | null;
}

async function stationStates(ids: readonly string[]): Promise<Map<string, StationStateRow>> {
  if (ids.length === 0) return new Map();
  const rows = await client<StationStateRow[]>`
    SELECT cs.id, cs.is_online,
      ${client.unsafe(stationAvailabilitySql('cs'))} AS availability,
      ${client.unsafe(stationStatusReasonSql('cs'))} AS status_reason,
      (SELECT max(p.id) FROM port_status_log p WHERE p.station_id = cs.id) AS last_status_id
    FROM charging_stations cs WHERE cs.id = ANY(${[...ids]}::text[])
  `;
  return new Map(rows.map((r) => [r.id, r]));
}

function stationFingerprint(s: StationStateRow): string {
  return hash([s.is_online, s.availability, s.status_reason, s.last_status_id]);
}

async function sessionFingerprints(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await client<{ id: string; status: string; updated_at: RawTimestamp }[]>`
    SELECT id, status::text AS status, updated_at FROM charging_sessions
    WHERE id = ANY(${[...ids]}::text[])
  `;
  return new Map(rows.map((r) => [r.id, hash([r.status, toIsoOrNull(r.updated_at)])]));
}

async function reservationFingerprints(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await client<{ id: string; status: string; updated_at: RawTimestamp }[]>`
    SELECT id, status::text AS status, updated_at FROM reservations
    WHERE id = ANY(${[...ids]}::text[])
  `;
  return new Map(rows.map((r) => [r.id, hash([r.status, toIsoOrNull(r.updated_at)])]));
}

async function authorizationFingerprint(attemptId: number): Promise<string | null> {
  const [row] = await client<{ last_id: number | null }[]>`
    SELECT (
      SELECT max(b.id) FROM authorize_attempts b
      WHERE b.station_id = a.station_id AND b.id_token = a.id_token AND b.outcome <> 'accepted'
        AND b.created_at >= date_trunc('hour', a.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND b.created_at < (date_trunc('hour', a.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
          + interval '1 hour'
    ) AS last_id
    FROM authorize_attempts a WHERE a.id = ${attemptId}
  `;
  return row == null ? null : hash([row.last_id]);
}

/** Member station ids of a site incident. */
export async function incidentMemberStationIds(incidentId: string): Promise<string[]> {
  const rows = await client<{ station_id: string }[]>`
    SELECT DISTINCT station_id FROM ai_insights
    WHERE parent_insight_id = ${incidentId} AND station_id IS NOT NULL
  `;
  return rows.map((r) => r.station_id);
}

async function incidentState(
  incidentId: string,
): Promise<{ fingerprint: string; cleared: boolean } | null> {
  const members = await incidentMemberStationIds(incidentId);
  if (members.length === 0) return null;
  const states = await stationStates(members);
  const sorted = [...states.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    fingerprint: hash(sorted.map((s) => [s.id, s.is_online, s.availability])),
    cleared: sorted.every((s) => s.is_online && s.availability !== 'faulted'),
  };
}

/** Current fingerprints of the subjects (null: the kind has none, or the subject is gone). */
export async function currentFingerprints(
  refs: readonly InsightSubjectRef[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const stations = await stationStates(
    refs
      .filter((r) => STATION_INSIGHT_KINDS.has(r.kind) && r.stationId != null)
      .map((r) => r.stationId as string),
  );
  const sessions = await sessionFingerprints(
    refs
      .filter((r) => r.kind === 'session_failed' && r.sessionId != null)
      .map((r) => r.sessionId as string),
  );
  const reservations = await reservationFingerprints(
    refs
      .filter((r) => isReservationInsightKind(r.kind) && r.reservationId != null)
      .map((r) => r.reservationId as string),
  );
  for (const r of refs) {
    if (isReservationInsightKind(r.kind)) {
      out.set(r.id, r.reservationId == null ? null : (reservations.get(r.reservationId) ?? null));
    } else if (STATION_INSIGHT_KINDS.has(r.kind) && r.stationId != null) {
      const s = stations.get(r.stationId);
      out.set(r.id, s == null ? null : stationFingerprint(s));
    } else if (r.kind === 'session_failed' && r.sessionId != null) {
      out.set(r.id, sessions.get(r.sessionId) ?? null);
    } else if (r.kind === 'authorization_refused' && r.authorizeAttemptId != null) {
      out.set(r.id, await authorizationFingerprint(r.authorizeAttemptId));
    } else if (r.kind === 'site_incident') {
      out.set(r.id, (await incidentState(r.id))?.fingerprint ?? null);
    } else {
      out.set(r.id, null);
    }
  }
  return out;
}

/** The fingerprint of one subject now (stored as `basis_fingerprint`). */
export async function currentFingerprint(ref: InsightSubjectRef): Promise<string | null> {
  return (await currentFingerprints([ref])).get(ref.id) ?? null;
}

/** A fee of the reservation was captured after all (a resumed or retried charge). */
async function reservationFeeCaptured(reservationId: string): Promise<boolean> {
  const [row] = await client<{ captured: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM payment_records
      WHERE reservation_id = ${reservationId} AND status = 'captured'
    ) AS captured
  `;
  return row?.captured === true;
}

/**
 * Whether the condition that raised the insight is gone: the station is back
 * online (offline), no longer faulted (faulted, and a station that faulted
 * during a reservation), every incident station recovered, or a failed
 * reservation fee was captured later. Alerts, sessions, refusals and the
 * other reservation events are events: never cleared.
 */
export async function conditionCleared(ref: InsightSubjectRef): Promise<boolean> {
  if (ref.kind === 'reservation_station_faulted') {
    if (ref.stationId == null) return false;
    const s = (await stationStates([ref.stationId])).get(ref.stationId);
    return s == null || (s.is_online && s.availability !== 'faulted');
  }
  if (ref.kind === 'reservation_fee_failed') {
    return ref.reservationId != null && (await reservationFeeCaptured(ref.reservationId));
  }
  if (ref.kind === 'station_offline' || ref.kind === 'station_faulted') {
    if (ref.stationId == null) return false;
    const s = (await stationStates([ref.stationId])).get(ref.stationId);
    if (s == null) return true;
    return ref.kind === 'station_offline' ? s.is_online : s.availability !== 'faulted';
  }
  if (ref.kind === 'site_incident') return (await incidentState(ref.id))?.cleared ?? false;
  return false;
}
