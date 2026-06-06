// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, chargingStations } from '@evtivity/database';
import { buildDerivedStatusSubquery } from '../lib/station-derived-status.js';

describe('buildDerivedStatusSubquery', () => {
  it('table-qualifies the correlated column in a no-join select', () => {
    // Regression: in a select without joins, drizzle renders outer columns
    // unqualified. An unqualified "id" inside the subquery is ambiguous
    // (e2.id and c2.id both exist) and Postgres rejects the query at
    // runtime, which 500ed the maintenance station-preview endpoint.
    const query = db
      .select({
        id: chargingStations.id,
        status: buildDerivedStatusSubquery(chargingStations.id),
      })
      .from(chargingStations)
      .where(eq(chargingStations.siteId, 'sit_test'));

    const { sql } = query.toSQL();
    expect(sql).toContain('e2.station_id = "charging_stations"."id"');
    expect(sql).not.toMatch(/e2\.station_id = "id"/);
  });

  it('keeps the status precedence order in the generated CASE', () => {
    const { sql } = db
      .select({ status: buildDerivedStatusSubquery(chargingStations.id) })
      .from(chargingStations)
      .toSQL();

    const order = ['charging', 'reserved', 'faulted', 'unknown', 'available', 'unavailable'];
    const positions = order.map((s) => sql.indexOf(`'${s}'`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
