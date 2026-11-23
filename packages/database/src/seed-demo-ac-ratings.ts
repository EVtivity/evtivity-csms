// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The base demo seed's AC connectors at a rating their 208 V circuit carries
// (`demoAcConnectorKw`, seed-station-defs.ts). An earlier seed rated them at 7 to
// 43 kW on 16 to 63 A, more than the circuit carries, so no panel ratio within the
// panel routes' range of 1 to 3 let every station back on its circuit.
//
// Rerun-safe: a connector of a base demo AC station model changes only while it
// still holds the rating an earlier seed wrote (`DEMO_AC_RATINGS_BEFORE`, type,
// kW and A), and its simulator row only while it still holds that power; an
// operator's value stays. One station audit row per station changed. The type
// stays Type1, so the connector stays AC for pricing.

import type postgres from 'postgres';
import { writeAudit } from './lib/audit.js';
import { stationAuditLog } from './schema/audit.js';
import { LAYOUT_DEMO } from './seed-demo-layout-plan.js';
import { DEMO_AC_RATINGS_BEFORE, STATION_MODELS, STATION_MODELS_16 } from './seed-station-defs.js';
import type { DemoFeatureContext } from './seed-demo-features.js';

/** The base demo station models with AC connectors. */
export const BASE_DEMO_AC_MODELS: readonly string[] = [...STATION_MODELS, ...STATION_MODELS_16]
  .filter((m) => m.type === 'Type1')
  .map((m) => m.model);

/** The rating a connector an earlier seed rated at `kw` and `amps` takes, or null. */
export function correctedAcRating(
  kw: number,
  amps: number | null,
): { kw: number; amps: number } | null {
  return DEMO_AC_RATINGS_BEFORE.find((r) => r.kw === kw && r.amps === amps)?.to ?? null;
}

interface ConnectorRow {
  id: string;
  station_db_id: string;
  station_id: string;
  evse_no: number;
  connector_id: number;
  max_power_kw: string | null;
  max_current_amps: string | null;
}

/** Corrects the AC ratings of the base demo connectors; returns the connectors changed. */
export async function seedDemoAcRatings(
  sql: postgres.Sql,
  ctx: DemoFeatureContext,
): Promise<number> {
  const layoutSites = LAYOUT_DEMO.sites.map((s) => s.id);
  const rows = await sql<ConnectorRow[]>`
    SELECT c.id, cs.id AS station_db_id, cs.station_id, e.evse_id AS evse_no, c.connector_id,
      c.max_power_kw::text AS max_power_kw, c.max_current_amps::text AS max_current_amps
    FROM connectors c
    JOIN evses e ON e.id = c.evse_id
    JOIN charging_stations cs ON cs.id = e.station_id
    WHERE c.connector_type = 'Type1'
      AND cs.model = ANY(${[...BASE_DEMO_AC_MODELS]})
      AND NOT cs.is_conformance
      AND (cs.site_id IS NULL OR cs.site_id <> ALL(${layoutSites}))
    ORDER BY cs.id, e.evse_id, c.connector_id
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
    const kw = Number(row.max_power_kw);
    const amps = row.max_current_amps == null ? null : Number(row.max_current_amps);
    const to = correctedAcRating(kw, amps);
    if (to == null) continue;
    const updated = await sql`
      UPDATE connectors SET max_power_kw = ${String(to.kw)}, max_current_amps = ${to.amps},
        updated_at = now()
      WHERE id = ${row.id} AND connector_type = 'Type1'
        AND max_power_kw = ${String(kw)} AND max_current_amps = ${String(amps)}
      RETURNING id
    `;
    if (updated.length === 0) continue;
    changed++;
    await sql`
      UPDATE css_evses SET max_power_w = ${Math.round(to.kw * 1000)}
      WHERE css_station_id IN (SELECT id FROM css_stations WHERE station_id = ${row.station_id})
        AND evse_id = ${row.evse_no} AND connector_id = ${row.connector_id}
        AND max_power_w = ${Math.round(kw * 1000)}
    `;
    const entry = changes.get(row.station_db_id) ?? {
      stationId: row.station_id,
      before: [],
      after: [],
    };
    const at = { evseId: row.evse_no, connectorId: row.connector_id };
    entry.before.push({ ...at, maxPowerKw: kw, maxCurrentAmps: amps ?? 0 });
    entry.after.push({ ...at, maxPowerKw: to.kw, maxCurrentAmps: to.amps });
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
        before: { connectors: entry.before },
        after: { connectors: entry.after },
        notes: 'Demo data: AC connectors rated at what their 208 V circuit carries',
      },
    );
  }
  return changed;
}
