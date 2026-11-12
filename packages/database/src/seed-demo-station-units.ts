// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The units of the demo stations with units: the AC master with seven
// extenders of Parkhaus Lindenhof (GitHub discussion 59, the site layout
// demo, seed-demo-layout-plan.ts), 8 boxes "Box 1" to "Box 8" of 2 Type 2
// EVSEs each. The station, its EVSEs, connectors and simulator come from the
// layout demo (`seedLayoutDemo`); this module creates the units through the
// unit writer only while the station has none, so a rerun and an operator's
// own units stay. Each unit is audited like the API service does
// (`station.unit_changed`).

import type postgres from 'postgres';
import { writeAudit } from './lib/audit.js';
import { createStationUnit, readStationUnits } from './lib/station-units.js';
import { stationAuditLog } from './schema/audit.js';

/** The demo station with units (Parkhaus Lindenhof). */
export const DEMO_UNIT_STATION = {
  id: 'sta_demounits001',
  stationId: 'EM4-MASTER-01',
  siteId: 'sit_demogarage01',
  model: 'AC Master with Extenders',
  ocppProtocol: 'ocpp1.6',
  units: 8,
  evsesPerUnit: 2,
  connectorType: 'Type2',
  maxPowerKw: 22,
} as const;

/**
 * Creates the units of `stationId` (in order, each with its OCPP EVSE
 * numbers) while the station has none, and returns how many it created (0 on
 * a rerun or when the station is missing). EVSE numbers the station does not
 * have are left out.
 */
export async function seedDemoStationUnitsOf(
  sql: postgres.Sql,
  stationId: string,
  units: ReadonlyArray<{ name: string; evseIds: readonly number[] }>,
  actorUserId: string | null,
): Promise<number> {
  const [station] = await sql<{ id: string }[]>`
    SELECT id FROM charging_stations WHERE id = ${stationId}`;
  if (station == null) return 0;
  if ((await readStationUnits(stationId)).length > 0) return 0;
  const rows = await sql<{ id: string; evse_id: number }[]>`
    SELECT id, evse_id FROM evses WHERE station_id = ${stationId}`;
  const byNumber = new Map(rows.map((r) => [r.evse_id, r.id]));
  let created = 0;
  for (const unit of units) {
    const evseIds = unit.evseIds.flatMap((n) => {
      const id = byNumber.get(n);
      return id == null ? [] : [id];
    });
    const result = await createStationUnit(stationId, { name: unit.name, evseIds });
    if (!result.ok) continue;
    created++;
    await writeAudit(
      { table: stationAuditLog, idColumn: 'station_id' },
      {
        entityId: stationId,
        entityIdSnapshot: stationId,
        action: 'unit_changed',
        actor: actorUserId != null ? 'operator' : 'system',
        actorUserId,
        before: null,
        after: { unit: result.after },
        notes: 'Demo data: unit created',
      },
    );
  }
  return created;
}
