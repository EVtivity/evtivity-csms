// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, chargingStations } from '@evtivity/database';
import { buildUnderMaintenanceSubquery } from '../lib/station-maintenance-flag.js';

describe('buildUnderMaintenanceSubquery', () => {
  it('table-qualifies both correlated columns so a no-join select stays unambiguous', () => {
    const query = db
      .select({
        id: chargingStations.id,
        underMaintenance: buildUnderMaintenanceSubquery(
          chargingStations.id,
          chargingStations.siteId,
        ),
      })
      .from(chargingStations)
      .where(eq(chargingStations.siteId, 'sit_test'));

    const { sql } = query.toSQL();
    expect(sql).toContain('me.site_id = "charging_stations"."site_id"');
    expect(sql).toContain('= ANY(me.affected_station_ids)');
    expect(sql).toContain('"charging_stations"."id" = ANY');
  });

  it('mirrors the maintenance coverage semantics: active window plus whole-site for null/empty arrays', () => {
    const { sql } = db
      .select({
        underMaintenance: buildUnderMaintenanceSubquery(
          chargingStations.id,
          chargingStations.siteId,
        ),
      })
      .from(chargingStations)
      .toSQL();

    expect(sql).toContain("me.status = 'active'");
    expect(sql).toContain('me.planned_start_at < now()');
    expect(sql).toContain('me.planned_end_at > now()');
    expect(sql).toContain('me.affected_station_ids IS NULL');
    expect(sql).toContain("me.affected_station_ids = '{}'::text[]");
  });
});
