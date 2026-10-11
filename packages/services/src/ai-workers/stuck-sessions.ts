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

import { client, toDate, toDateOrNull } from '@evtivity/database';
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
  transactionId: string;
  siteId: string | null;
  reason: StuckReason;
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
  transaction_id: string;
  site_id: string | null;
  is_online: boolean;
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
  const cleanupFilter =
    input.staleTimeoutHours > 0
      ? client`s.updated_at > now() - ${input.staleTimeoutHours} * interval '1 hour'`
      : client`true`;
  const rows = await client<StuckRow[]>`
    SELECT s.id, s.station_id, cs.station_id AS ocpp_station_id, cs.ocpp_protocol,
      s.transaction_id, cs.site_id, cs.is_online, c.status AS connector_status,
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
    ORDER BY s.updated_at ASC
    LIMIT ${input.limit ?? 200}
  `;
  return rows.map((row) => ({
    sessionId: row.id,
    stationId: row.station_id,
    ocppStationId: row.ocpp_station_id,
    ocppProtocol: row.ocpp_protocol,
    transactionId: row.transaction_id,
    siteId: row.site_id,
    reason: !row.is_online
      ? 'station_offline'
      : row.connector_status === 'available'
        ? 'connector_available'
        : 'no_activity',
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
