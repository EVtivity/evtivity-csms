// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, sql } from 'drizzle-orm';
import { createLogger } from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

// A portal or guest start the station accepted, where the driver never
// plugged in. A station whose transaction starts with the cable
// (TxStartPoint PowerPathClosed or EVConnected, every OCPP 1.6 station)
// reports nothing when its connection timeout expires: it only drops the
// authorization (OCPP 2.1 C01.FR.26, 1.6 ConnectionTimeOut). The CSMS closes
// the start itself once that timeout and a margin have passed.

const logger = createLogger('remote-start-timeout');

/**
 * Pub/sub channel the API publishes an accepted portal or guest start on; the
 * worker turns each message into a delayed `remote-start-timeouts` job.
 */
export const REMOTE_START_TIMEOUT_CHANNEL = 'remote_start_timeout';

export type RemoteStartTimeoutTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'guest'; guestSessionId: number };

export type RemoteStartTimeoutMessage = RemoteStartTimeoutTarget & { delayMs: number };

/** Setting: the connection timeout assumed for a station that has not reported its own. */
export const EV_CONNECTION_TIMEOUT_SETTING = 'session.evConnectionTimeoutSeconds';
export const DEFAULT_EV_CONNECTION_TIMEOUT_SECONDS = 180;

/**
 * Time after the station's connection timeout before the CSMS closes the
 * start. It covers delivery, not policy: a TransactionEvent or
 * StartTransaction sent just before the timeout expired, the projection
 * queue, and clock skew between station and CSMS.
 */
export const REMOTE_START_TIMEOUT_MARGIN_SECONDS = 60;

const TTL_MS = 60_000;
let cachedDefault: number | undefined;
let cachedAt = 0;

function positiveSeconds(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** The `session.evConnectionTimeoutSeconds` setting (60 s cache). */
export async function getEvConnectionTimeoutDefaultSeconds(): Promise<number> {
  const now = Date.now();
  if (cachedDefault !== undefined && now - cachedAt < TTL_MS) return cachedDefault;
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, EV_CONNECTION_TIMEOUT_SETTING));
    cachedDefault = positiveSeconds(row?.value) ?? DEFAULT_EV_CONNECTION_TIMEOUT_SECONDS;
    cachedAt = now;
    return cachedDefault;
  } catch (err) {
    logger.warn({ err }, 'Connection timeout setting lookup failed; using cached or default');
    return cachedDefault ?? DEFAULT_EV_CONNECTION_TIMEOUT_SECONDS;
  }
}

export function clearEvConnectionTimeoutCache(): void {
  cachedDefault = undefined;
  cachedAt = 0;
}

/**
 * The connection timeout the station reported (NotifyReport, GetVariables,
 * GetConfiguration): OCPP 2.1 `TxCtrlr.EVConnectionTimeOut`, OCPP 1.6
 * `ConnectionTimeOut`. The longest reported value wins (a per-EVSE value can
 * differ). Null when the station reported none or only a value of 0.
 */
export async function getStationConnectionTimeoutSeconds(
  stationUuid: string,
  ocppProtocol: string | null,
): Promise<number | null> {
  const [component, variable] =
    ocppProtocol === 'ocpp1.6' ? ['OCPP', 'ConnectionTimeOut'] : ['TxCtrlr', 'EVConnectionTimeOut'];
  const rows = await db.execute<{ value: string | null }>(sql`
    SELECT value FROM station_configurations
    WHERE station_id = ${stationUuid}
      AND component = ${component}
      AND variable = ${variable}
      AND attribute_type = 'Actual'
  `);
  let longest: number | null = null;
  for (const row of rows) {
    const seconds = positiveSeconds(row.value);
    if (seconds != null && (longest == null || seconds > longest)) longest = seconds;
  }
  return longest;
}

/**
 * Delay after an accepted remote start before the CSMS closes it: the
 * station's connection timeout (else the setting) plus the margin.
 */
export async function remoteStartTimeoutDelayMs(station: {
  id: string;
  ocppProtocol: string | null;
}): Promise<number> {
  let seconds: number | null = null;
  try {
    seconds = await getStationConnectionTimeoutSeconds(station.id, station.ocppProtocol);
  } catch (err) {
    logger.warn({ err, stationUuid: station.id }, 'Station connection timeout lookup failed');
  }
  seconds ??= await getEvConnectionTimeoutDefaultSeconds();
  return (seconds + REMOTE_START_TIMEOUT_MARGIN_SECONDS) * 1000;
}

/** Stopped reason of a start closed because no EV was connected in time. */
export const EV_CONNECT_TIMEOUT_REASON = 'EVConnectTimeout';

export type UnstartedSessionOutcome =
  /** This call failed the session: it was active and no transaction was reported. */
  | { outcome: 'failed'; session: UnstartedSession }
  /** The session is already failed or faulted and never reported a transaction. */
  | { outcome: 'closed'; session: UnstartedSession }
  /** The station reported a transaction for the session, or it ended otherwise: left alone. */
  | { outcome: 'skipped' }
  | { outcome: 'not_found' };

export interface UnstartedSession {
  id: string;
  stationUuid: string;
  siteId: string | null;
  driverId: string | null;
  reservationId: string | null;
}

/**
 * Fails a remote-start session for which the station reported no
 * transaction (no TransactionEvent or StartTransaction was projected onto
 * it): status `failed`, stopped reason `EVConnectTimeout`, cost 0, written
 * only while the session is still `active` (P5). A session that is already
 * failed or faulted and never started is reported `closed`, so a retried
 * job still releases its hold.
 */
export async function failUnstartedRemoteSession(
  sessionId: string,
): Promise<UnstartedSessionOutcome> {
  const [failed] = await db.execute<SessionRow>(sql`
    UPDATE charging_sessions cs
    SET status = 'failed',
        stopped_reason = ${EV_CONNECT_TIMEOUT_REASON},
        ended_at = now(),
        final_cost_cents = 0,
        current_cost_cents = 0,
        updated_at = now()
    FROM charging_stations st
    WHERE cs.id = ${sessionId}
      AND st.id = cs.station_id
      AND cs.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM transaction_events te WHERE te.session_id = cs.id)
    RETURNING cs.id, cs.station_id, st.site_id, cs.driver_id, cs.reservation_id
  `);
  if (failed != null) return { outcome: 'failed', session: toSession(failed) };

  const [row] = await db.execute<SessionRow & { status: string; started: boolean }>(sql`
    SELECT cs.id, cs.station_id, st.site_id, cs.driver_id, cs.reservation_id, cs.status,
           EXISTS (SELECT 1 FROM transaction_events te WHERE te.session_id = cs.id) AS started
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    WHERE cs.id = ${sessionId}
  `);
  if (row == null) return { outcome: 'not_found' };
  if (!row.started && (row.status === 'failed' || row.status === 'faulted')) {
    return { outcome: 'closed', session: toSession(row) };
  }
  return { outcome: 'skipped' };
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  station_id: string;
  site_id: string | null;
  driver_id: string | null;
  reservation_id: string | null;
}

function toSession(row: SessionRow): UnstartedSession {
  return {
    id: row.id,
    stationUuid: row.station_id,
    siteId: row.site_id,
    driverId: row.driver_id,
    reservationId: row.reservation_id,
  };
}
