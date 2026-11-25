// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The simulator EVSEs of the North American demo stations on the supply of
// their circuit (`cssEvseSupply`): AC Level 2 on one 2-pole 208 V circuit,
// DC on 480Y/277 V. Earlier seeds left the base demo rows at the column
// default 3 x 230 V, gave the free vend 1.6 station 1 x 240 V and the layout
// demo DC chargers 3 x 400 V.
//
// Rerun-safe: a row of a demo station (CS-0003 to CS-3999, never a
// conformance station) at a North American site changes only while it still
// holds the value the earlier seed wrote for that station and connector
// (`earlierDemoCssSupply`); any other supply is an operator's and stays. The simulator's stored `Connector[e,c].SupplyPhases`
// follows only while it still holds the earlier phase count. One station
// audit row per station changed.

import type postgres from 'postgres';
import { cssEvseSupply, isNorthAmericanCountry } from '@evtivity/lib';
import type { CssConnectorType } from '@evtivity/lib';
import { writeAudit } from './lib/audit.js';
import { stationAuditLog } from './schema/audit.js';
import type { DemoFeatureContext } from './seed-demo-features.js';

/**
 * The phases and voltage the earlier demo seed wrote for a demo station's
 * connector: the column default 3 x 230 V for the base demo (CS-0003 to
 * CS-2003), 1 x 240 V for the free vend 1.6 station CS-2004, 3 x 400 V for a
 * site layout demo DC charger (CS-3001 on; its AC chargers were already
 * 1 x 208 V). Null when the earlier seed wrote nothing to correct.
 */
export function earlierDemoCssSupply(
  stationId: string,
  connectorType: CssConnectorType,
): { phases: number; voltage: number } | null {
  if (!isDemoCssStationId(stationId)) return null;
  const n = Number(stationId.slice(3));
  if (n <= 2003) return { phases: 3, voltage: 230 };
  if (n === 2004) return { phases: 1, voltage: 240 };
  if (n >= 3001 && connectorType.startsWith('dc_')) return { phases: 3, voltage: 400 };
  return null;
}

/** The demo station ids: the base demo (CS-0003 to CS-2004) and the site layout demo (CS-3001 on). */
export function isDemoCssStationId(stationId: string): boolean {
  const match = /^CS-(\d{4})$/.exec(stationId);
  if (match == null) return false;
  const n = Number(match[1]);
  return n >= 3 && n <= 3999;
}

interface SupplyRow {
  id: string;
  css_station_id: string;
  station_db_id: string;
  station_id: string;
  country: string | null;
  evse_id: number;
  connector_id: number;
  connector_type: CssConnectorType;
  phases: number;
  voltage: number;
}

/** The supply a demo row moves to, or null when it keeps its own. */
export function correctedCssSupply(row: {
  stationId: string;
  country: string | null;
  connectorType: CssConnectorType;
  phases: number;
  voltage: number;
}): { phases: number; voltage: number } | null {
  if (!isNorthAmericanCountry(row.country)) return null;
  const earlier = earlierDemoCssSupply(row.stationId, row.connectorType);
  if (earlier == null || earlier.phases !== row.phases || earlier.voltage !== row.voltage) {
    return null;
  }
  const to = cssEvseSupply(row.connectorType, row.country);
  return to.phases === row.phases && to.voltage === row.voltage ? null : to;
}

/** Moves the demo simulator EVSEs off an earlier seeded supply; returns the rows changed. */
export async function seedDemoCssSupply(
  sql: postgres.Sql,
  ctx: DemoFeatureContext,
): Promise<number> {
  const rows = await sql<SupplyRow[]>`
    SELECT ce.id, ce.css_station_id, st.id AS station_db_id, st.station_id, s.country,
      ce.evse_id, ce.connector_id, ce.connector_type::text AS connector_type, ce.phases, ce.voltage
    FROM css_evses ce
    JOIN css_stations cs ON cs.id = ce.css_station_id
    JOIN charging_stations st ON st.station_id = cs.station_id
    JOIN sites s ON s.id = st.site_id
    WHERE NOT st.is_conformance AND st.station_id ~ '^CS-[0-9]{4}$'
    ORDER BY st.id, ce.evse_id, ce.connector_id
  `;
  const changes = new Map<
    string,
    {
      stationId: string;
      before: Array<Record<string, number>>;
      after: Array<Record<string, number>>;
    }
  >();
  let changed = 0;
  for (const row of rows) {
    const to = correctedCssSupply({
      stationId: row.station_id,
      country: row.country,
      connectorType: row.connector_type,
      phases: row.phases,
      voltage: row.voltage,
    });
    if (to == null) continue;
    const updated = await sql`
      UPDATE css_evses SET phases = ${to.phases}, voltage = ${to.voltage}
      WHERE id = ${row.id} AND phases = ${row.phases} AND voltage = ${row.voltage}
      RETURNING id
    `;
    if (updated.length === 0) continue;
    changed++;
    await sql`
      UPDATE css_config_variables SET value = ${String(to.phases)}
      WHERE css_station_id = ${row.css_station_id}
        AND key = ${`Connector[${String(row.evse_id)},${String(row.connector_id)}].SupplyPhases`}
        AND value = ${String(row.phases)}
    `;
    const entry = changes.get(row.station_db_id) ?? {
      stationId: row.station_id,
      before: [],
      after: [],
    };
    const at = { evseId: row.evse_id, connectorId: row.connector_id };
    entry.before.push({ ...at, phases: row.phases, voltage: row.voltage });
    entry.after.push({ ...at, ...to });
    changes.set(row.station_db_id, entry);
  }
  for (const [stationDbId, entry] of changes) {
    await writeAudit(
      { table: stationAuditLog, idColumn: 'station_id' },
      {
        entityId: stationDbId,
        entityIdSnapshot: entry.stationId,
        action: 'updated',
        ...(ctx.actorUserId != null
          ? { actor: 'operator' as const, actorUserId: ctx.actorUserId }
          : { actor: 'system' as const, actorLabel: 'seed' }),
        before: { simulatorSupply: entry.before },
        after: { simulatorSupply: entry.after },
        notes: 'Demo data: simulator EVSEs on the supply of their circuit',
      },
    );
  }
  return changed;
}
