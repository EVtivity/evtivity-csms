// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Stuck sessions (background AI worker `stuck_sessions`): deterministic SQL
 * only. Activity is the session's `updated_at` (server time, bumped by every
 * transaction event and meter value projection), the same signal the
 * `stale-session-cleanup` cron uses. A session is stuck when it is `active`,
 * not already being ended (`end_request_reason`), and nothing was heard of
 * it for `idleMinutes`, or its station is offline or its connector reports
 * `available` and nothing was heard for `SIGNAL_GRACE_MINUTES`. Sessions the
 * cleanup faults on its next run, and sessions with a pending or rejected
 * stop proposal, are left out (an operator who rejected a stop is not asked
 * again for the same session).
 */

import {
  client,
  operatorStationSql,
  stationInsightsSuppressedSql,
  toDate,
  toDateOrNull,
  STALE_CLEANUP_IN_TRANSACTION_STATUSES,
} from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';

/** An offline station or an available connector counts after this much silence. */
export const SIGNAL_GRACE_MINUTES = 15;

export type StuckReason = 'station_offline' | 'connector_available' | 'no_activity';

export interface StuckSession {
  sessionId: string;
  /** Internal station id. */
  stationId: string;
  /** OCPP identity, what the command routes take. */
  ocppStationId: string;
  ocppProtocol: string | null;
  /** OCPP EVSE number of the session (the EVSE stop route), null when unknown. */
  ocppEvseId: number | null;
  transactionId: string;
  siteId: string | null;
  reason: StuckReason;
  /**
   * Since when the station is offline: its last disconnect, else its last
   * heartbeat, else the session's last activity. Null for an online station.
   */
  stationOfflineSince: Date | null;
  /** Energy the session delivered so far (its last meter value), in Wh. */
  energyWh: number;
  /** Running cost of the session, null when not priced. */
  currentCostCents: number | null;
  currency: string;
  startedAt: Date | null;
  lastActivityAt: Date;
}

/** Time an operator gets to confirm a stop before the stale cleanup faults the session. */
export const STALE_CLEANUP_MARGIN_MINUTES = 60;

/**
 * The idle time the job uses: the setting (which allows up to 1,440 minutes),
 * clamped so it stays at least `STALE_CLEANUP_MARGIN_MINUTES` below the
 * stale-session timeout and never below `SIGNAL_GRACE_MINUTES`. A timeout of
 * 0 or less turns the cleanup off: the setting is used as is.
 */
export function effectiveIdleMinutes(idleMinutes: number, staleTimeoutHours: number): number {
  if (staleTimeoutHours <= 0) return Math.max(SIGNAL_GRACE_MINUTES, idleMinutes);
  const ceiling = staleTimeoutHours * 60 - STALE_CLEANUP_MARGIN_MINUTES;
  return Math.max(SIGNAL_GRACE_MINUTES, Math.min(idleMinutes, ceiling));
}

interface StuckRow {
  id: string;
  station_id: string;
  ocpp_station_id: string;
  ocpp_protocol: string | null;
  ocpp_evse_id: number | null;
  transaction_id: string;
  site_id: string | null;
  energy_wh: number | string | null;
  current_cost_cents: number | null;
  currency: string;
  is_online: boolean;
  offline_since: RawTimestamp | null;
  connector_status: string | null;
  started_at: RawTimestamp;
  last_activity_at: RawTimestamp;
}

/**
 * The stuck sessions, oldest activity first, at one site (`siteId`), at
 * unsited stations (`siteId: null`), or everywhere (`siteId` omitted).
 */
export async function findStuckSessions(input: {
  idleMinutes: number;
  staleTimeoutHours: number;
  siteId?: string | null;
  limit?: number;
}): Promise<StuckSession[]> {
  const siteFilter =
    input.siteId === undefined
      ? client`true`
      : input.siteId === null
        ? client`cs.site_id IS NULL`
        : client`cs.site_id = ${input.siteId}`;
  // Left out: sessions the stale cleanup faults on its next run. It skips a
  // session whose online station still reports the transaction (connector in
  // a transaction status, or a transaction event since its cutoff), so such a
  // session stays a stop suggestion past the timeout.
  const cleanupFilter =
    input.staleTimeoutHours > 0
      ? client`(s.updated_at > now() - ${input.staleTimeoutHours} * interval '1 hour'
          OR (cs.is_online AND (
            EXISTS (
              SELECT 1 FROM connectors sc
              WHERE (sc.id = s.connector_id OR (s.connector_id IS NULL AND sc.evse_id = s.evse_id))
                AND sc.status::text IN ${client([...STALE_CLEANUP_IN_TRANSACTION_STATUSES])}
            )
            OR EXISTS (
              SELECT 1 FROM transaction_events te
              WHERE te.session_id = s.id
                AND te.created_at > now() - ${input.staleTimeoutHours} * interval '1 hour'
            )
          )))`
      : client`true`;
  const rows = await client<StuckRow[]>`
    SELECT s.id, s.station_id, cs.station_id AS ocpp_station_id, cs.ocpp_protocol,
      (SELECT e.evse_id FROM evses e WHERE e.id = s.evse_id) AS ocpp_evse_id,
      s.transaction_id, cs.site_id, s.energy_delivered_wh AS energy_wh,
      s.current_cost_cents, upper(s.currency) AS currency, cs.is_online,
      CASE WHEN cs.is_online THEN NULL ELSE COALESCE(
        (SELECT l.created_at FROM connection_logs l
          WHERE l.station_id = cs.id AND l.event = 'disconnected'
          ORDER BY l.created_at DESC LIMIT 1),
        cs.last_heartbeat,
        s.updated_at
      ) END AS offline_since, c.status AS connector_status,
      s.started_at, s.updated_at AS last_activity_at
    FROM charging_sessions s
    JOIN charging_stations cs ON cs.id = s.station_id
    LEFT JOIN connectors c ON c.id = s.connector_id
    WHERE s.status = 'active'
      AND s.end_request_reason IS NULL
      AND s.updated_at < now() - ${SIGNAL_GRACE_MINUTES} * interval '1 minute'
      AND ${cleanupFilter}
      AND ${siteFilter}
      AND (
        s.updated_at < now() - ${input.idleMinutes} * interval '1 minute'
        OR cs.is_online = false
        OR c.status = 'available'
      )
      AND NOT EXISTS (
        SELECT 1 FROM ai_proposals p
        WHERE p.session_id = s.id AND p.job = 'stuck_sessions'
          AND p.status IN ('pending', 'rejected')
      )
      AND ${client.unsafe(operatorStationSql('cs'))}
      AND NOT ${client.unsafe(stationInsightsSuppressedSql('cs'))}
      AND NOT EXISTS (
        SELECT 1 FROM ai_insight_cooldowns c
        WHERE c.subject_type = 'session' AND c.subject_id = s.id
          AND c.kind = 'stuck_session' AND c.next_allowed_at > now()
      )
    ORDER BY s.updated_at ASC
    LIMIT ${input.limit ?? 200}
  `;
  return rows.map((row) => ({
    sessionId: row.id,
    stationId: row.station_id,
    ocppStationId: row.ocpp_station_id,
    ocppProtocol: row.ocpp_protocol,
    ocppEvseId: row.ocpp_evse_id,
    transactionId: row.transaction_id,
    siteId: row.site_id,
    reason: !row.is_online
      ? 'station_offline'
      : row.connector_status === 'available'
        ? 'connector_available'
        : 'no_activity',
    stationOfflineSince: toDateOrNull(row.offline_since),
    energyWh: Number(row.energy_wh ?? 0),
    currentCostCents: row.current_cost_cents,
    currency: row.currency,
    startedAt: toDateOrNull(row.started_at),
    lastActivityAt: toDate(row.last_activity_at as Date | string),
  }));
}

/** The sites (null: unsited stations) with at least one stuck session. */
export async function sitesWithStuckSessions(input: {
  idleMinutes: number;
  staleTimeoutHours: number;
}): Promise<(string | null)[]> {
  const sessions = await findStuckSessions({ ...input, limit: 5000 });
  return [...new Set(sessions.map((s) => s.siteId))];
}
