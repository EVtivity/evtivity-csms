// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import type postgres from 'postgres';
import type { Redis } from 'ioredis';
import {
  client,
  findStaleOnlineStations,
  getHeartbeatIntervalSeconds,
  isRoamingEnabled,
  markStationOfflineIfStale,
} from '@evtivity/database';
import {
  createRedisClient,
  dispatchDriverNotification,
  offlineSweepThresholdMs,
  RedisConnectionRegistry,
  shouldMarkStationOffline,
} from '@evtivity/lib';
import type { ConnectionRegistry, PubSubClient } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';

let redis: Redis | null = null;

function registryStore(): Redis {
  if (redis == null) {
    redis = createRedisClient(
      process.env['REDIS_URL'] ?? 'redis://localhost:6379',
      'station-offline-sweep',
      { maxRetriesPerRequest: 2 },
    );
  }
  return redis;
}

export interface OfflineSweepDeps {
  sql: postgres.Sql;
  registry: ConnectionRegistry;
  pubsub: PubSubClient;
  heartbeatSeconds: number;
  roamingEnabled: () => Promise<boolean>;
  notifyDriver: (driverId: string, reservationId: string, stationId: string) => Promise<void>;
}

export interface OfflineSweepResult {
  candidates: number;
  markedOffline: number;
}

/**
 * Marks offline the stations an OCPP process left online when it died
 * without publishing station.Disconnected. A station is offline only when
 * no OCPP pod holds its connection registry key AND nothing arrived from it
 * within the heartbeat timeout plus slack. A registry lookup failure stops
 * the run: the sweep never marks a station offline it could not check.
 */
export async function runStationOfflineSweep(
  deps: OfflineSweepDeps,
  log: Logger,
): Promise<OfflineSweepResult> {
  const thresholdMs = offlineSweepThresholdMs(deps.heartbeatSeconds);
  const candidates = await findStaleOnlineStations(deps.sql, thresholdMs);
  let markedOffline = 0;

  for (const station of candidates) {
    let registryOwner: string | null;
    try {
      registryOwner = await deps.registry.getInstanceId(station.stationId);
    } catch (err) {
      log.warn(
        { err, stationId: station.stationId },
        'Connection registry lookup failed; offline sweep stopped until the next run',
      );
      break;
    }
    if (
      !shouldMarkStationOffline({
        registryOwner,
        lastActivityAt: station.lastActivityAt,
        staleBefore: station.staleBefore,
      })
    ) {
      continue;
    }

    let marked;
    try {
      marked = await markStationOfflineIfStale(deps.sql, station.id, thresholdMs);
    } catch (err) {
      log.warn({ err, stationId: station.stationId }, 'Offline sweep failed for a station');
      continue;
    }
    if (marked == null) continue;
    markedOffline++;
    log.info(
      { stationId: station.stationId, lastActivityAt: station.lastActivityAt },
      'Station marked offline: no OCPP connection and no recent activity',
    );
    await publishStationOffline(deps, station.id, station.stationId, marked.siteId, log);
  }

  return { candidates: candidates.length, markedOffline };
}

// The effects the station.Disconnected projection has after its database
// writes: SSE, OCPI location push, reservation fault notifications. All
// fail-open: the station is already stored offline.
async function publishStationOffline(
  deps: OfflineSweepDeps,
  stationUuid: string,
  stationOcppId: string,
  siteId: string | null,
  log: Logger,
): Promise<void> {
  try {
    await deps.pubsub.publish(
      'csms_events',
      JSON.stringify({
        eventType: 'station.status',
        stationId: stationUuid,
        siteId,
        sessionId: null,
      }),
    );
  } catch (err) {
    log.warn({ err, stationId: stationOcppId }, 'station.status publish failed');
  }
  if (siteId != null) {
    try {
      if (await deps.roamingEnabled()) {
        await deps.pubsub.publish('ocpi_push', JSON.stringify({ type: 'location', siteId }));
      }
    } catch (err) {
      log.warn({ err, stationId: stationOcppId }, 'OCPI location push publish failed');
    }
  }
  try {
    const reservations = await deps.sql<{ id: string; driver_id: string | null }[]>`
      SELECT id, driver_id FROM reservations
      WHERE station_id = ${stationUuid} AND status IN ('active', 'in_use')
    `;
    for (const r of reservations) {
      if (r.driver_id == null) continue;
      try {
        await deps.notifyDriver(r.driver_id, r.id, stationOcppId);
      } catch (err) {
        log.warn({ err, reservationId: r.id }, 'reservation.StationFaulted notification failed');
      }
    }
  } catch (err) {
    log.warn(
      { err, stationId: stationOcppId },
      'Reservation lookup for the offline station failed',
    );
  }
}

export async function stationOfflineSweepHandler(log: Logger): Promise<void> {
  const pubsub = getPubSub();
  const result = await runStationOfflineSweep(
    {
      sql: client,
      registry: new RedisConnectionRegistry(registryStore()),
      pubsub,
      heartbeatSeconds: await getHeartbeatIntervalSeconds(),
      roamingEnabled: isRoamingEnabled,
      notifyDriver: (driverId, reservationId, stationId) =>
        dispatchDriverNotification(
          client,
          'reservation.StationFaulted',
          driverId,
          { reservationId, stationId },
          ALL_TEMPLATES_DIRS,
          pubsub,
        ),
    },
    log,
  );
  if (result.markedOffline > 0) {
    log.info(result, 'Offline sweep marked stations offline');
  }
}
