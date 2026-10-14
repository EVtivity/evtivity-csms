// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, sql, inArray } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  stationMessagePushes,
  isStationMessageEnabled,
  getStationMessageRefreshSeconds,
} from '@evtivity/database';
import { enqueueStationTransaction } from '@evtivity/services/station-message.service';
import type { Logger } from 'pino';

const STATION_MESSAGE_SLOT_CHARGING = 9001;

export async function stationMessageChargingRefreshHandler(log: Logger): Promise<void> {
  const enabled = await isStationMessageEnabled();
  if (!enabled) return;

  const refreshSeconds = await getStationMessageRefreshSeconds();

  const activeSessions = await db
    .select({
      sessionId: chargingSessions.id,
      stationUuid: chargingSessions.stationId,
      stationOcppId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .where(
      and(
        eq(chargingSessions.status, 'active'),
        // An offline station would get the message queued, and a queued send
        // records no push, so every tick would queue it again.
        eq(chargingStations.isOnline, true),
        sql`${chargingStations.ocppProtocol} LIKE 'ocpp2%'`,
      ),
    );

  if (activeSessions.length === 0) return;

  const stationIds = activeSessions.map((s) => s.stationUuid);
  const recentPushes = await db
    .select({
      stationId: stationMessagePushes.stationId,
      pushedAt: stationMessagePushes.pushedAt,
    })
    .from(stationMessagePushes)
    .where(
      and(
        inArray(stationMessagePushes.stationId, stationIds),
        eq(stationMessagePushes.ocppMessageId, STATION_MESSAGE_SLOT_CHARGING),
      ),
    );

  const lastPushByStation = new Map<string, Date>();
  for (const row of recentPushes) {
    lastPushByStation.set(row.stationId, row.pushedAt);
  }

  const now = Date.now();

  // Sessions whose station is past the per-station refresh window, queued in
  // parallel (one Redis round trip per tick, not one per session).
  const sessionsToPush = activeSessions.flatMap((session) => {
    const lastPushedAt = lastPushByStation.get(session.stationUuid);
    const due = lastPushedAt == null || now - lastPushedAt.getTime() >= refreshSeconds * 1000;
    return due && session.ocppProtocol != null
      ? [{ ...session, ocppProtocol: session.ocppProtocol }]
      : [];
  });

  const results = await Promise.allSettled(
    sessionsToPush.map((session) =>
      enqueueStationTransaction({
        sessionId: session.sessionId,
        internalStationId: session.stationUuid,
        stationOcppId: session.stationOcppId,
        ocppProtocol: session.ocppProtocol,
        // No chargingState: the render keeps the state the station last
        // reported, so a suspended session keeps its suspended screen.
        eventType: 'updated',
      }).catch((err: unknown) => {
        log.warn(
          { sessionId: session.sessionId, error: err },
          'Failed to queue the station message charging refresh',
        );
        throw err;
      }),
    ),
  );

  const queued = results.filter((r) => r.status === 'fulfilled').length;
  if (queued > 0) {
    log.info({ queued }, 'Station message charging refresh queued');
  }
}
