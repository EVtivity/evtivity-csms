// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The session a token was refused for (`concurrent_tx`: the token already
 * runs a session elsewhere) and what an operator should do about it. A live
 * session (its station online, activity within the stuck-session idle time,
 * the connector not `available`) is a healthy charge: the driver waits, or
 * the card is shared or copied; nothing is ended. A stuck one gets the same
 * step as a stuck-session insight (`stuckSessionCase`): the stop at an online
 * station, advice to restore an offline station first, the CSMS end once the
 * station has been offline for `aiWorkers.stuckSessions.offlineEndAfterHours`.
 */

import { client, getAiWorkerSettings, toDate, toDateOrNull } from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import { AI_THRESHOLD_SETTINGS } from '@evtivity/lib/ai-config';
import { AI_WORKER_SETTING_KEYS } from '@evtivity/lib/ai-proposals';
import type { FixCode } from '@evtivity/lib/ai-insights';

/** `authorize_attempts.reason` of a `concurrent_tx` refusal: `concurrent_session <session id>`. */
const CONCURRENT_REASON = /^concurrent_session (\S+)$/;

/** The session id a `concurrent_tx` refusal names, null for any other reason. */
export function concurrentSessionIdOf(reason: string | null | undefined): string | null {
  if (reason == null) return null;
  return CONCURRENT_REASON.exec(reason)?.[1] ?? null;
}

/**
 * What to do about the concurrent session:
 * - `wait`: it is live; the driver waits for it to end (or the card is shared or copied);
 * - `stop`: it looks stuck at an online station; stop it there;
 * - `restore`: it looks stuck because its station is offline; restore the station first;
 * - `end`: its station has been offline past the setting; end it in the CSMS.
 */
export type ConcurrentSessionStep = 'wait' | 'stop' | 'restore' | 'end';

export interface ConcurrentSessionFacts {
  active: boolean;
  stationOnline: boolean;
  lastActivityAt: Date;
  connectorStatus: string | null;
  stationOfflineSince: Date | null;
}

/** The step for a concurrent session, null when it is no longer active. */
export function concurrentSessionStep(
  facts: ConcurrentSessionFacts,
  input: { idleMinutes: number; offlineEndAfterHours: number; now: Date },
): ConcurrentSessionStep | null {
  if (!facts.active) return null;
  const minutes = (since: Date): number =>
    Math.max(0, Math.floor((input.now.getTime() - since.getTime()) / 60_000));
  if (!facts.stationOnline) {
    const offline = minutes(facts.stationOfflineSince ?? facts.lastActivityAt);
    return offline >= input.offlineEndAfterHours * 60 ? 'end' : 'restore';
  }
  const silent = minutes(facts.lastActivityAt) >= input.idleMinutes;
  return silent || facts.connectorStatus === 'available' ? 'stop' : 'wait';
}

/** The fixes of each step: a live session is never ended. */
export const CONCURRENT_SESSION_FIXES: Readonly<Record<ConcurrentSessionStep, readonly FixCode[]>> =
  {
    wait: ['wait_for_concurrent_session', 'check_shared_token'],
    stop: ['end_concurrent_session'],
    restore: ['end_concurrent_session'],
    end: ['end_concurrent_session'],
  };

export interface ConcurrentSessionState extends ConcurrentSessionFacts {
  sessionId: string;
  /** Internal station id of the concurrent session. */
  stationId: string;
  /** OCPP identity of that station. */
  stationOcppId: string;
  startedAt: Date | null;
  /** Null when the session is no longer active. */
  step: ConcurrentSessionStep | null;
}

interface ConcurrentRow {
  id: string;
  status: string;
  station_id: string;
  station_ocpp_id: string;
  is_online: boolean;
  started_at: RawTimestamp;
  last_activity_at: RawTimestamp;
  connector_status: string | null;
  offline_since: RawTimestamp;
}

/** The stuck-session thresholds, their defaults when settings cannot be read (fail-open, P9). */
async function thresholds(): Promise<{ idleMinutes: number; offlineEndAfterHours: number }> {
  try {
    const s = await getAiWorkerSettings();
    return {
      idleMinutes: s.stuckSessionsIdleMinutes,
      offlineEndAfterHours: s.stuckSessionsOfflineEndAfterHours,
    };
  } catch {
    // fail-open: the defaults classify the session the same way as a fresh install.
    return {
      idleMinutes:
        AI_THRESHOLD_SETTINGS[AI_WORKER_SETTING_KEYS.stuckSessionsIdleMinutes].defaultValue,
      offlineEndAfterHours:
        AI_THRESHOLD_SETTINGS[AI_WORKER_SETTING_KEYS.stuckSessionsOfflineEndAfterHours]
          .defaultValue,
    };
  }
}

/** The concurrent session's state and step now; null when the session is unknown. */
export async function loadConcurrentSessionState(
  sessionId: string,
  now: Date = new Date(),
): Promise<ConcurrentSessionState | null> {
  const [row] = await client<ConcurrentRow[]>`
    SELECT s.id, s.status::text AS status, s.station_id, cs.station_id AS station_ocpp_id,
      cs.is_online, s.started_at, s.updated_at AS last_activity_at,
      c.status::text AS connector_status,
      CASE WHEN cs.is_online THEN NULL ELSE COALESCE(
        (SELECT l.created_at FROM connection_logs l
          WHERE l.station_id = cs.id AND l.event = 'disconnected'
          ORDER BY l.created_at DESC LIMIT 1),
        cs.last_heartbeat,
        s.updated_at
      ) END AS offline_since
    FROM charging_sessions s
    JOIN charging_stations cs ON cs.id = s.station_id
    LEFT JOIN connectors c ON c.id = s.connector_id
    WHERE s.id = ${sessionId}
  `;
  if (row == null) return null;
  const facts: ConcurrentSessionFacts = {
    active: row.status === 'active',
    stationOnline: row.is_online,
    lastActivityAt: toDate(row.last_activity_at as Date | string),
    connectorStatus: row.connector_status,
    stationOfflineSince: toDateOrNull(row.offline_since),
  };
  return {
    ...facts,
    sessionId: row.id,
    stationId: row.station_id,
    stationOcppId: row.station_ocpp_id,
    startedAt: toDateOrNull(row.started_at),
    step: concurrentSessionStep(facts, { ...(await thresholds()), now }),
  };
}

/** The concurrent session a refused attempt names, with its state now. */
export async function concurrentSessionOfAttempt(
  attemptId: number,
  now: Date = new Date(),
): Promise<ConcurrentSessionState | null> {
  const [attempt] = await client<{ outcome: string; reason: string | null }[]>`
    SELECT outcome::text AS outcome, reason FROM authorize_attempts WHERE id = ${attemptId}
  `;
  if (attempt?.outcome !== 'concurrent_tx') return null;
  const sessionId = concurrentSessionIdOf(attempt.reason);
  return sessionId == null ? null : loadConcurrentSessionState(sessionId, now);
}
