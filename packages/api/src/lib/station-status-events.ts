// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { isRoamingEnabled } from '@evtivity/database';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

// Tell the dashboards (station.status on csms_events) and roaming partners
// (location push on ocpi_push, when roaming is enabled and the station has a
// site) that a station's availability changed. Both are fail-open: the
// availability is already stored.
export async function publishStationStatusChanged(
  station: { id: string; siteId: string | null },
  logger?: FastifyBaseLogger,
): Promise<void> {
  const pubsub = getPubSub();
  try {
    await pubsub.publish(
      'csms_events',
      JSON.stringify({
        eventType: 'station.status',
        stationId: station.id,
        siteId: station.siteId,
      }),
    );
  } catch (err) {
    logger?.warn({ err, stationId: station.id }, 'station.status publish failed');
  }
  if (station.siteId == null) return;
  try {
    if (!(await isRoamingEnabled())) return;
    await pubsub.publish('ocpi_push', JSON.stringify({ type: 'location', siteId: station.siteId }));
  } catch (err) {
    logger?.warn({ err, stationId: station.id }, 'OCPI location push publish failed');
  }
}
