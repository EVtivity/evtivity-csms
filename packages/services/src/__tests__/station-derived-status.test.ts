// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, chargingStations } from '@evtivity/database';
import {
  buildDerivedStatusSubquery,
  buildStatusReasonSubquery,
} from '../station-derived-status.js';

describe('buildDerivedStatusSubquery', () => {
  it('table-qualifies the correlated column in a no-join select', () => {
    // Regression: in a select without joins, drizzle renders outer columns
    // unqualified. An unqualified "id" inside the subquery is ambiguous
    // (s2.id, e2.id, and c2.id all exist) and Postgres rejects the query at
    // runtime, which 500ed the maintenance station-preview endpoint.
    const query = db
      .select({
        id: chargingStations.id,
        status: buildDerivedStatusSubquery(chargingStations.id),
      })
      .from(chargingStations)
      .where(eq(chargingStations.siteId, 'sit_test'));

    const { sql } = query.toSQL();
    expect(sql).toContain('s2.id = "charging_stations"."id"');
    expect(sql).not.toMatch(/s2\.id = "id"/);
  });

  it('puts station-level states before the plug summary', () => {
    const { sql } = db
      .select({ status: buildDerivedStatusSubquery(chargingStations.id) })
      .from(chargingStations)
      .toSQL();

    const stationBlock = sql.indexOf('s2.disabled_reason');
    const firstPlugCheck = sql.indexOf("'charging'");
    expect(stationBlock).toBeGreaterThanOrEqual(0);
    expect(stationBlock).toBeLessThan(firstPlugCheck);
    // The plug summary keeps its order after the station block.
    const plugSql = sql.slice(firstPlugCheck);
    const order = ['charging', 'reserved', 'faulted', 'unknown', 'available', 'unavailable'];
    const positions = order.map((st) => plugSql.indexOf(`'${st}'`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('builds the reason from the shared rule, correlated on the station', () => {
    const { sql } = db
      .select({ reason: buildStatusReasonSubquery(chargingStations.id) })
      .from(chargingStations)
      .toSQL();

    expect(sql).toContain('s3.id = "charging_stations"."id"');
    expect(sql).toContain("'operator_disabled'");
    expect(sql).toContain("'firmware_failed'");
  });

  it('counts idle and discharging plugs as charging', () => {
    const { sql } = db
      .select({ status: buildDerivedStatusSubquery(chargingStations.id) })
      .from(chargingStations)
      .toSQL();
    const chargingClause = sql.slice(0, sql.indexOf("THEN 'charging'"));
    expect(chargingClause).toContain("'idle'");
    expect(chargingClause).toContain("'discharging'");
  });

  it('drops connector_faulted while another plug is in use or reserved, like the status', () => {
    const { sql } = db
      .select({ reason: buildStatusReasonSubquery(chargingStations.id) })
      .from(chargingStations)
      .toSQL();
    expect(sql).toMatch(/WHEN r3\.reason = 'connector_faulted' AND EXISTS/);
    const existsClause = sql.slice(sql.indexOf('EXISTS'), sql.indexOf('THEN NULL'));
    expect(existsClause).toContain("'charging'");
    expect(existsClause).toContain("'reserved'");
  });
});
