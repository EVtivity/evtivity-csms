// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client } from '@evtivity/database';
import { dispatchDriverNotification } from '@evtivity/lib';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const API_TEMPLATES_DIR =
  process.env['API_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'api', 'src', 'templates');
const OCPP_TEMPLATES_DIR =
  process.env['OCPP_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');
const ALL_TEMPLATES_DIRS = [OCPP_TEMPLATES_DIR, API_TEMPLATES_DIR];

interface StationRow {
  station_id: string;
  site_name: string | null;
}

/**
 * Dispatches the station-watch availability alert. Claims all active watches
 * for the station with a single DELETE ... RETURNING so the alert is one-shot
 * and safe against concurrent workers, then notifies each watching driver
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
  // so the alert fires once and two workers cannot double-send.
  const claimed = (await client`
    DELETE FROM station_watches
    WHERE station_id = (SELECT id FROM charging_stations WHERE station_id = ${stationId})
      AND expires_at > now()
    RETURNING driver_id
  `) as unknown as { driver_id: string }[];

  if (claimed.length === 0) return;

  const pubsub = getPubSub();
  for (const row of claimed) {
    // dispatchDriverNotification is fail-open internally (warn + continue), so
    // one driver's delivery failure never blocks the rest.
    await dispatchDriverNotification(
      client,
      'watch.StationAvailable',
      row.driver_id,
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
