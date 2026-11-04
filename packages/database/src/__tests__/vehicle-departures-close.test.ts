// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  completePassedDepartures,
  completePassedDeparturesSql,
  type DepartureDb,
} from '../lib/vehicle-departures.js';

const dialect = new PgDialect();

describe('completePassedDeparturesSql', () => {
  const now = new Date('2026-11-01T05:30:00Z');
  const { sql, params } = dialect.sqlToQuery(completePassedDeparturesSql(now, 250));

  it('moves only scheduled rows whose time passed, oldest first, skipping locked rows', () => {
    expect(sql).toContain("SET\n      status = 'completed'");
    expect(sql).toContain(
      "d2.status = 'scheduled' AND (\n        d2.departure_at <= $1::timestamptz",
    );
    expect(sql).toContain('ORDER BY COALESCE(d2.departure_at, d2.created_at), d2.id');
    expect(sql).toContain('FOR UPDATE OF d2 SKIP LOCKED');
    expect(sql).toContain("WHERE d.id = x.id AND d.status = 'scheduled'");
    expect(params).toEqual([now.toISOString(), now.toISOString(), 250]);
  });

  it('completes an ad hoc departure when its session ended, or a day after an unplugged request', () => {
    expect(sql).toContain("(d2.session_id IS NOT NULL AND s.status IS DISTINCT FROM 'active')");
    expect(sql).toContain(
      "(d2.session_id IS NULL AND d2.created_at <= $2::timestamptz - interval '24 hours')",
    );
  });

  it('decides met before no_vehicle before short', () => {
    const met = sql.indexOf("THEN 'met'");
    const noVehicle = sql.indexOf("WHEN d.session_id IS NULL THEN 'no_vehicle'");
    const short = sql.indexOf("ELSE 'short'");
    expect(met).toBeGreaterThan(0);
    expect(noVehicle).toBeGreaterThan(met);
    expect(short).toBeGreaterThan(noVehicle);
    expect(sql).toContain('x.energy_wh / 1000 >= d.target_energy_kwh');
    expect(sql).toContain('x.soc >= d.target_soc_percent');
  });
});

describe('completePassedDepartures', () => {
  it('maps the returned rows', async () => {
    const execute = vi.fn().mockResolvedValue([
      { id: 'vdp_1', site_id: 'sit_1', outcome: 'met' },
      { id: 'vdp_2', site_id: 'sit_1', outcome: 'no_vehicle' },
    ]);
    const tx = { execute } as unknown as DepartureDb;
    const rows = await completePassedDepartures(new Date(), 10, tx);
    expect(rows).toEqual([
      { id: 'vdp_1', siteId: 'sit_1', outcome: 'met' },
      { id: 'vdp_2', siteId: 'sit_1', outcome: 'no_vehicle' },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
