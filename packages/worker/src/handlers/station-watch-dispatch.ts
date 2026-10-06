// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { client, claimStationWatches } from '@evtivity/database';
import { dispatchDriverNotification } from '@evtivity/lib';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

interface StationRow {
  station_id: string;
  site_name: string | null;
}

/**
 * Dispatches the station-watch availability alert. Claims all active watches
 * for the station with a single DELETE ... RETURNING, only while the station is
 * free by the shared driver availability rule, so the alert is one-shot and
 * safe against concurrent workers and duplicate signals, then notifies each watching driver
 * through their existing notification preferences.
 */
export async function handleStationWatchDispatch(stationId: string, logger: Logger): Promise<void> {
  const stationRows = (await client`
    SELECT cs.station_id, s.name AS site_name
    FROM charging_stations cs
    LEFT JOIN sites s ON s.id = cs.site_id
    WHERE cs.station_id = ${stationId}
    LIMIT 1
  `) as unknown as StationRow[];
  const station = stationRows[0];
  if (station == null) {
    logger.warn({ stationId }, 'Station-watch dispatch: station not found');
    return;
  }

  // Claim the watches in one statement: the rows are deleted as they are read,
  // so the alert fires once and two workers cannot double-send. The claim
  // applies the shared driver availability rule, so a stale signal for a
  // station that is no longer free alerts nobody and keeps the watches.
  const claimed = await claimStationWatches(client, stationId);

  if (claimed.length === 0) return;

  const pubsub = getPubSub();
  for (const driverId of claimed) {
    // dispatchDriverNotification is fail-open internally (warn + continue), so
    // one driver's delivery failure never blocks the rest.
    await dispatchDriverNotification(
      client,
      'watch.StationAvailable',
      driverId,
      {
        stationId: station.station_id,
        stationName: station.station_id,
        siteName: station.site_name ?? '',
      },
      ALL_TEMPLATES_DIRS,
      pubsub,
    );
  }

  logger.info({ stationId, notified: claimed.length }, 'Station-watch alerts dispatched');
}
