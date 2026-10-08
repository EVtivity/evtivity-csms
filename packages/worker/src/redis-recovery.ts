// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db, remoteStartTimeoutDelayMs } from '@evtivity/database';
import {
  findMissingSchedulers,
  scheduleCronJobs,
  scheduleLoadManagementCoordinator,
} from './scheduler.js';
import { enqueueReservationActivation } from './reservation-worker.js';
import { enqueueRemoteStartTimeout } from './remote-start-timeout-worker.js';
import { enqueueGuestSessionEnded, enqueueGuestSessionStarted } from './guest-session-worker.js';

/**
 * Redis holds the BullMQ job schedulers and delayed jobs only in memory
 * unless it persists. A restart or failover without persistence (an
 * ElastiCache node reboot, a Redis container without AOF) drops every key
 * while the worker's clients reconnect and keep running, so no cron job runs
 * again and pending delayed jobs never fire. The worker checks the
 * schedulers at startup, whenever its Redis connection becomes ready, and
 * every 30 s; when any is missing it registers them again and rebuilds the
 * delayed jobs whose state the database holds, under the same job ids as
 * their producers (P7), so a job that still exists is not added twice.
 *
 * Rebuilt from the database:
 * - `reservations`: activation of each `scheduled` reservation not yet
 *   expired, at its `starts_at`.
 * - `remote-start-timeouts`: each accepted portal start still `active` with
 *   no transaction, and each guest start still `payment_authorized` with no
 *   started transaction, at its start plus the station's connection timeout
 *   and margin (at once when that has passed).
 * - `guest-session-events`: the link of a guest session whose transaction
 *   started (a `started` transaction event carries its token), and the
 *   capture of a `charging` guest session whose charging session ended.
 *
 * Not rebuilt (Redis was their only copy): delayed simulated provider events
 * in `payment-webhooks` (test provider only), `maintenance-fanout` jobs not
 * yet run (the `maintenance-scheduler` cron or an operator re-save triggers
 * them again), `fleet-billing-fanout` jobs not yet run (only driver notices
 * are lost), `station-watch` dispatches not yet run, and queued OCTT runs.
 * The worker also rebuilds at startup, which covers a worker that restarted
 * together with Redis.
 */

export const SCHEDULER_CHECK_INTERVAL_MS = 30_000;

export interface RecoveryQueues {
  cronQueue: Queue;
  loadQueue: Queue;
  reservationQueue: Queue;
  remoteStartTimeoutQueue: Queue;
  guestSessionQueue: Queue;
}

export interface RebuiltJobs {
  reservationActivations: number;
  remoteStartTimeouts: number;
  guestStartTimeouts: number;
  guestLinks: number;
  guestCaptures: number;
}

export interface RecoveryResult {
  missing: string[];
  rebuilt: RebuiltJobs | null;
}

interface ElapsedRow extends Record<string, unknown> {
  station_uuid: string;
  ocpp_protocol: string | null;
  elapsed_ms: number;
}

/** Re-adds the delayed and pending jobs whose state the database holds. */
export async function rebuildDelayedJobs(queues: RecoveryQueues): Promise<RebuiltJobs> {
  const rebuilt: RebuiltJobs = {
    reservationActivations: 0,
    remoteStartTimeouts: 0,
    guestStartTimeouts: 0,
    guestLinks: 0,
    guestCaptures: 0,
  };

  const reservations = await db.execute<{ id: string; delay_ms: number }>(sql`
    SELECT id,
           GREATEST(0, EXTRACT(EPOCH FROM (starts_at - now())) * 1000)::float8 AS delay_ms
    FROM reservations
    WHERE status = 'scheduled' AND expires_at > now()
  `);
  for (const row of reservations) {
    await enqueueReservationActivation(queues.reservationQueue, row.id, Math.round(row.delay_ms));
    rebuilt.reservationActivations++;
  }

  // The full delay depends on the station's reported connection timeout,
  // read once per station.
  const fullDelays = new Map<string, number>();
  const remainingMs = async (row: ElapsedRow): Promise<number> => {
    let full = fullDelays.get(row.station_uuid);
    if (full === undefined) {
      full = await remoteStartTimeoutDelayMs({
        id: row.station_uuid,
        ocppProtocol: row.ocpp_protocol,
      });
      fullDelays.set(row.station_uuid, full);
    }
    return Math.max(0, Math.round(full - row.elapsed_ms));
  };

  const sessions = await db.execute<ElapsedRow & { id: string }>(sql`
    SELECT cs.id, st.id AS station_uuid, st.ocpp_protocol,
           (EXTRACT(EPOCH FROM (now() - cs.created_at)) * 1000)::float8 AS elapsed_ms
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    WHERE cs.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM transaction_events te WHERE te.session_id = cs.id)
  `);
  for (const row of sessions) {
    await enqueueRemoteStartTimeout(
      queues.remoteStartTimeoutQueue,
      { kind: 'session', sessionId: row.id },
      await remainingMs(row),
    );
    rebuilt.remoteStartTimeouts++;
  }

  // A guest start the station turned into a transaction is linked, never
  // timed out: the timeout would fail a guest who is charging.
  const guests = await db.execute<
    ElapsedRow & {
      id: number;
      session_token: string;
      started_session_id: string | null;
      started_token_type: string | null;
    }
  >(sql`
    SELECT gs.id, gs.session_token, st.id AS station_uuid, st.ocpp_protocol,
           (EXTRACT(EPOCH FROM (now() - gs.start_requested_at)) * 1000)::float8 AS elapsed_ms,
           started.session_id AS started_session_id,
           started.token_type AS started_token_type
    FROM guest_sessions gs
    JOIN charging_stations st ON st.station_id = gs.station_ocpp_id
    LEFT JOIN LATERAL (
      SELECT te.session_id, te.payload->>'tokenType' AS token_type
      FROM charging_sessions cs
      JOIN transaction_events te ON te.session_id = cs.id
      WHERE cs.station_id = st.id
        AND cs.created_at >= gs.start_requested_at - interval '5 minutes'
        AND te.event_type = 'started'
        AND te.payload->>'idToken' = gs.session_token
      ORDER BY te.id
      LIMIT 1
    ) started ON true
    WHERE gs.status = 'payment_authorized'
      AND gs.start_requested_at IS NOT NULL
      AND gs.charging_session_id IS NULL
  `);
  for (const row of guests) {
    if (row.started_session_id != null) {
      await enqueueGuestSessionStarted(queues.guestSessionQueue, {
        type: 'TransactionStarted',
        sessionId: row.started_session_id,
        idToken: { idToken: row.session_token, type: row.started_token_type ?? 'DirectPayment' },
      });
      rebuilt.guestLinks++;
    } else {
      await enqueueRemoteStartTimeout(
        queues.remoteStartTimeoutQueue,
        { kind: 'guest', guestSessionId: row.id },
        await remainingMs(row),
      );
      rebuilt.guestStartTimeouts++;
    }
  }

  const ended = await db.execute<{ charging_session_id: string }>(sql`
    SELECT gs.charging_session_id
    FROM guest_sessions gs
    JOIN charging_sessions cs ON cs.id = gs.charging_session_id
    WHERE gs.status = 'charging'
      AND cs.status IN ('completed', 'failed', 'faulted')
  `);
  for (const row of ended) {
    await enqueueGuestSessionEnded(queues.guestSessionQueue, row.charging_session_id);
    rebuilt.guestCaptures++;
  }

  return rebuilt;
}

/**
 * Registers every job scheduler again and rebuilds the delayed jobs when
 * any scheduler is missing. A no-op while Redis still holds them.
 */
export async function recoverLostRedisState(
  queues: RecoveryQueues,
  log: Logger,
): Promise<RecoveryResult> {
  const missing = await findMissingSchedulers(queues.cronQueue, queues.loadQueue);
  if (missing.length === 0) return { missing, rebuilt: null };
  log.warn(
    { missing: missing.length, schedulers: missing.slice(0, 30) },
    'BullMQ job schedulers missing (Redis lost its data, or a cron job was added); registering them and rebuilding delayed jobs',
  );
  await scheduleCronJobs(queues.cronQueue);
  await scheduleLoadManagementCoordinator(queues.loadQueue);
  const rebuilt = await rebuildDelayedJobs(queues);
  log.warn(
    { ...rebuilt },
    'Job schedulers registered again; delayed jobs rebuilt from the database',
  );
  return { missing, rebuilt };
}

export interface RedisRecoveryWatch {
  /** Runs one check now (shares a check already running). */
  check(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Checks the job schedulers whenever the cron queue's Redis connection
 * becomes ready and every `intervalMs`. An in-process interval on purpose:
 * BullMQ scheduling lives in the Redis whose loss this detects. A failed
 * check is logged at error and retried on the next tick (P9: the worker
 * keeps running, but cron jobs stay stopped until a check succeeds).
 */
export async function startRedisRecoveryWatch(
  queues: RecoveryQueues,
  log: Logger,
  intervalMs = SCHEDULER_CHECK_INTERVAL_MS,
): Promise<RedisRecoveryWatch> {
  let running: Promise<void> | null = null;
  const check = (): Promise<void> => {
    running ??= recoverLostRedisState(queues, log)
      .then(() => undefined)
      .catch((err: unknown) => {
        log.error({ err }, 'Job scheduler check failed; retrying on the next tick');
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  // BullMQ 6 moved the raw Redis client from the queue to its backend.
  const client = await queues.cronQueue.getBackend().client;
  const onReady = (): void => {
    void check();
  };
  client.on('ready', onReady);
  const timer = setInterval(onReady, intervalMs);
  timer.unref();

  return {
    check,
    async stop() {
      clearInterval(timer);
      client.off('ready', onReady);
      await running;
    },
  };
}
