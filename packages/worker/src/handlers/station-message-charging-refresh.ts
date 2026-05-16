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
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';
import type { Logger } from 'pino';

const STATION_MESSAGE_TRANSACTION_CHANNEL = 'station_message_transaction';
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

  const pubsub = getPubSub();
  const now = Date.now();

  // Filter to sessions whose station is past the per-station refresh
  // window, then publish in parallel. Serial publish on N active sessions
  // adds N x Redis-RTT to every cron tick; parallelizing brings it back
  // to a single RTT regardless of fleet size.
  const sessionsToPush = activeSessions.filter((session) => {
    const lastPushedAt = lastPushByStation.get(session.stationUuid);
    return lastPushedAt == null || now - lastPushedAt.getTime() >= refreshSeconds * 1000;
  });

  const results = await Promise.allSettled(
    sessionsToPush.map((session) =>
      pubsub
        .publish(
          STATION_MESSAGE_TRANSACTION_CHANNEL,
          JSON.stringify({
            sessionId: session.sessionId,
            internalStationId: session.stationUuid,
            stationOcppId: session.stationOcppId,
            ocppProtocol: session.ocppProtocol,
            eventType: 'updated',
            chargingState: 'Charging',
          }),
        )
        .catch((err: unknown) => {
          log.warn(
            { sessionId: session.sessionId, error: err },
            'Failed to publish station_message_transaction refresh event',
          );
          throw err;
        }),
    ),
  );

  const published = results.filter((r) => r.status === 'fulfilled').length;
  if (published > 0) {
    log.info({ published }, 'Station message charging refresh published');
  }
}
