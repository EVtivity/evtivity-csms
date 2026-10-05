// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  REMOTE_START_TIMEOUT_CHANNEL,
  chargingStations,
  db,
  guestSessions,
  remoteStartTimeoutDelayMs,
} from '@evtivity/database';
import type { RemoteStartTimeoutMessage, RemoteStartTimeoutTarget } from '@evtivity/database';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

/**
 * Schedules the close-out of a portal or guest start the station accepted:
 * the worker turns the message into a delayed job (deterministic jobId per
 * session) that fails the session and cancels its hold when the station
 * reported no transaction by its connection timeout plus a margin. Fail-open
 * (P9): a lost message leaves the start to the stale-session cleanup (driver
 * session) or the guest-session expiry (guest), which also cancel the hold.
 */
export async function scheduleRemoteStartTimeout(
  target: RemoteStartTimeoutTarget,
  station: { id: string; ocppProtocol: string | null },
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const delayMs = await remoteStartTimeoutDelayMs(station);
    const message: RemoteStartTimeoutMessage = { ...target, delayMs };
    await getPubSub().publish(REMOTE_START_TIMEOUT_CHANNEL, JSON.stringify(message));
  } catch (err) {
    log.warn({ err, target }, 'Failed to schedule the remote start timeout');
  }
}

/** Schedules the close-out of a guest start, found by its session token. */
export async function scheduleGuestStartTimeout(
  sessionToken: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const [row] = await db
      .select({
        guestSessionId: guestSessions.id,
        stationUuid: chargingStations.id,
        ocppProtocol: chargingStations.ocppProtocol,
      })
      .from(guestSessions)
      .innerJoin(chargingStations, eq(chargingStations.stationId, guestSessions.stationOcppId))
      .where(eq(guestSessions.sessionToken, sessionToken));
    if (row == null) return;
    await scheduleRemoteStartTimeout(
      { kind: 'guest', guestSessionId: row.guestSessionId },
      { id: row.stationUuid, ocppProtocol: row.ocppProtocol },
      log,
    );
  } catch (err) {
    log.warn({ err }, 'Failed to schedule the guest start timeout');
  }
}
