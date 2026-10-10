// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { shouldMarkStationOffline } from '@evtivity/lib';
import { findStaleOnlineStations } from '../lib/station-offline.js';

// A tagged-template stand-in that returns fixed rows.
function sqlReturning(rows: Record<string, unknown>[]): postgres.Sql {
  return (() => Promise.resolve(rows)) as unknown as postgres.Sql;
}

describe('findStaleOnlineStations', () => {
  it('maps the raw row shape of the shared client (ISO strings) to Dates', async () => {
    // drizzle-orm's postgres-js driver replaces the client's date parsers, so
    // the worker's `client` returns timestamptz columns as strings.
    const sql = sqlReturning([
      {
        id: 'uuid-1',
        station_id: 'CS-1',
        last_heartbeat: '2026-10-10 09:00:00.123+00',
        stale_before: '2026-10-10 09:44:00+00',
      },
      {
        id: 'uuid-2',
        station_id: 'CS-2',
        last_heartbeat: null,
        stale_before: '2026-10-10 09:44:00+00',
      },
    ]);

    const rows = await findStaleOnlineStations(sql, 960_000);

    expect(rows[0]?.lastActivityAt).toBeInstanceOf(Date);
    expect(rows[0]?.lastActivityAt?.toISOString()).toBe('2026-10-10T09:00:00.123Z');
    expect(rows[0]?.staleBefore).toBeInstanceOf(Date);
    expect(rows[0]?.staleBefore.toISOString()).toBe('2026-10-10T09:44:00.000Z');
    expect(rows[1]?.lastActivityAt).toBeNull();
    // The sweep decision runs on the mapped row without a TypeError.
    expect(
      shouldMarkStationOffline({
        registryOwner: null,
        lastActivityAt: rows[0]?.lastActivityAt ?? null,
        staleBefore: rows[0]!.staleBefore,
      }),
    ).toBe(true);
  });

  it('keeps Dates from a client with the default parsers', async () => {
    const at = new Date('2026-10-10T09:00:00Z');
    const before = new Date('2026-10-10T09:44:00Z');
    const sql = sqlReturning([
      { id: 'uuid-1', station_id: 'CS-1', last_heartbeat: at, stale_before: before },
    ]);

    const [row] = await findStaleOnlineStations(sql, 960_000);

    expect(row).toEqual({
      id: 'uuid-1',
      stationId: 'CS-1',
      lastActivityAt: at,
      staleBefore: before,
    });
  });
});
