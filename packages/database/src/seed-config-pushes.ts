// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The station outcomes of a seeded config template push: no station is left pending. */
export type DemoPushStationStatus = 'accepted' | 'rejected' | 'failed';

const DEMO_PUSH_STATION_STATUSES: readonly DemoPushStationStatus[] = [
  'accepted',
  'accepted',
  'accepted',
  'accepted',
  'rejected',
  'failed',
];

/**
 * A seeded config template push and its station rows, finished: every push is
 * completed and every station has an outcome. A push left active with pending
 * stations is ended by the worker sweep an hour later as if an API restart had
 * interrupted it.
 */
export function demoConfigPush(
  stationIds: readonly string[],
  pick: (items: DemoPushStationStatus[]) => DemoPushStationStatus,
): {
  status: 'completed';
  stations: Array<{ stationId: string; status: DemoPushStationStatus; errorInfo: string | null }>;
} {
  return {
    status: 'completed',
    stations: stationIds.map((stationId) => {
      const status = pick([...DEMO_PUSH_STATION_STATUSES]);
      return { stationId, status, errorInfo: status === 'failed' ? 'Station offline' : null };
    }),
  };
}
