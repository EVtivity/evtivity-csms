// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site layout demo (seed-demo-layout-plan.ts): two sites whose 3D layout
// shows every feature at once. Harbor Point Charging Hub is a parking lot of
// DC fast chargers (2 rows of 6 spots, two named transformers on the grass),
// Lakeside Retail Park an office or retail site of AC wall boxes along the
// building (one row of 12 spots, turned 90 degrees). Both are load managed
// with panels, a sub-panel and circuits, so the panels and their links show.
// Harbor Point has a cellular station, a station under a maintenance event,
// a faulted station without a simulator with an open AI insight on it, a
// battery and a solar carport canopy, and two card readers on DC chargers (a
// VP6825 online on a connector, a VP7200 offline on the whole station);
// Lakeside has a cellular station and one without a simulator (offline). The other stations run on the fleet
// simulator, which charges, reserves and faults them like the other demo
// stations.
//
// Every row has a fixed id and is inserted ON CONFLICT DO NOTHING (P7). The
// layout settings and positions go through saveSiteLayout, the one writer,
// and only while the site has no settings or still has the settings the
// earlier plan seeded, so an operator's later edit stays. A rerun over the
// earlier plan (DC and AC chargers on both sites) moves its stations, renames
// its panels and circuits and pairs its card reader again, each guarded on
// the row still holding what that plan wrote.

import type postgres from 'postgres';
import argon2 from 'argon2';
import { STATION_PASSWORD_HASH_OPTIONS } from '@evtivity/lib';
import { bayToPosition, sameLayoutSettings } from '@evtivity/lib/site-layout';
import { db } from './config.js';
import { writeAudit } from './lib/audit.js';
import { paymentTerminalAuditLog, siteAuditLog, stationAuditLog } from './schema/audit.js';
import {
  createTerminal,
  pairTerminal,
  recordTerminalDeviceStatus,
} from './lib/payment-terminals.js';
import {
  LayoutGridTooSmallError,
  readStoredLayoutSettings,
  saveSiteLayout,
} from './lib/station-layout.js';
import { ensureSiteElectricityRates } from './seed-electricity-rates.js';
import { seedStationFaultInsight } from './seed-ai-insights.js';
import type { DemoFeatureContext } from './seed-demo-features.js';
import {
  LAYOUT_DEMO,
  LAYOUT_DEMO_PREVIOUS_SETTINGS,
  type LayoutDemoSite,
} from './seed-demo-layout-plan.js';

const DAY_MS = 86_400_000;

function auditActor(ctx: DemoFeatureContext) {
  return {
    actor: ctx.actorUserId != null ? ('operator' as const) : ('system' as const),
    actorUserId: ctx.actorUserId,
  };
}

async function seedSite(
  sql: postgres.Sql,
  site: LayoutDemoSite,
  vendorId: string | null,
  passwordHash: string,
  createdAt: Date,
  ctx: DemoFeatureContext,
): Promise<{ present: string[]; inserted: number; moved: number }> {
  await sql`
    INSERT INTO sites (id, name, address, city, state, postal_code, country, latitude, longitude,
      timezone, hours_of_operation, created_at, updated_at)
    VALUES (${site.id}, ${site.name}, ${site.address}, ${site.city}, 'NY', '12207', 'US',
      ${site.latitude}, ${site.longitude}, 'America/New_York', '24/7', ${createdAt}, ${createdAt})
    ON CONFLICT (id) DO NOTHING
  `;
  await ensureSiteElectricityRates(db, site.id);
  await sql`
    INSERT INTO site_load_management (site_id, strategy, is_enabled)
    VALUES (${site.id}, 'equal_share', true)
    ON CONFLICT (site_id) DO NOTHING
  `;
  for (const [order, panel] of site.panels.entries()) {
    await sql`
      INSERT INTO panels (id, site_id, parent_panel_id, name, breaker_rating_amps, voltage_v,
        phases, max_continuous_kw, safety_margin_kw, sort_order)
      VALUES (${panel.id}, ${site.id}, ${panel.parentPanelId}, ${panel.name},
        ${panel.breakerRatingAmps}, ${panel.voltageV}, ${panel.phases},
        ${String(panel.maxContinuousKw)}, '0', ${order})
      ON CONFLICT (id) DO NOTHING
    `;
    // A panel of the earlier plan under its old name takes the new name and ratings.
    if (panel.renamedFrom != null) {
      await sql`
        UPDATE panels SET name = ${panel.name}, breaker_rating_amps = ${panel.breakerRatingAmps},
          voltage_v = ${panel.voltageV}, phases = ${panel.phases},
          max_continuous_kw = ${String(panel.maxContinuousKw)}, updated_at = now()
        WHERE id = ${panel.id} AND site_id = ${site.id} AND name = ${panel.renamedFrom}
      `;
    }
  }
  for (const panel of site.panels) {
    for (const [circuitOrder, circuit] of panel.circuits.entries()) {
      await sql`
        INSERT INTO circuits (id, panel_id, name, breaker_rating_amps, max_continuous_kw,
          sort_order)
        VALUES (${circuit.id}, ${panel.id}, ${circuit.name}, ${circuit.breakerRatingAmps},
          ${String(circuit.maxContinuousKw)}, ${circuitOrder})
        ON CONFLICT (id) DO NOTHING
      `;
      // A circuit of the earlier plan, still under its old name and panel, moves here.
      if (circuit.renamedFrom != null) {
        await sql`
          UPDATE circuits SET name = ${circuit.name}, panel_id = ${panel.id},
            breaker_rating_amps = ${circuit.breakerRatingAmps},
            max_continuous_kw = ${String(circuit.maxContinuousKw)}, updated_at = now()
          WHERE id = ${circuit.id} AND name = ${circuit.renamedFrom.name}
            AND panel_id = ${circuit.renamedFrom.panelId}
        `;
      }
    }
  }

  const ocppWsUrl = process.env['SEED_CSS_TARGET_URL'] ?? 'ws://ocpp:7103';
  const seeded: string[] = [];
  let inserted = 0;
  let moved = 0;
  for (const station of site.stations) {
    const n = station.id.slice(-2);
    const isDc = station.kind === 'dc';
    const created = await sql`
      INSERT INTO charging_stations (id, station_id, site_id, vendor_id, model, serial_number,
        firmware_version, onboarding_status, availability, is_online, security_profile,
        ocpp_protocol, basic_auth_password_hash, is_simulator, circuit_id, data_plan, created_at,
        updated_at)
      VALUES (${station.id}, ${station.stationId}, ${site.id}, ${vendorId},
        ${isDc ? 'Terra 184' : 'Pulsar Plus'}, ${`SN-LY-00${n}`}, '2.4.1', 'accepted',
        'available', false, 1, 'ocpp2.1', ${passwordHash}, true, ${station.circuitId},
        ${station.cellular === true ? 'cellular' : null}, ${createdAt}, ${createdAt})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    inserted += created.length;
    // A station of the earlier plan, still at its site and circuit there, moves here.
    if (created.length === 0 && station.movedFrom != null) {
      const from = station.movedFrom;
      const movedRows = await sql`
        UPDATE charging_stations SET site_id = ${site.id}, circuit_id = ${station.circuitId},
          updated_at = now()
        WHERE id = ${station.id} AND site_id = ${from.siteId} AND circuit_id = ${from.circuitId}
        RETURNING id
      `;
      if (movedRows.length > 0) {
        moved++;
        await writeAudit(
          { table: stationAuditLog, idColumn: 'station_id' },
          {
            entityId: station.id,
            entityIdSnapshot: station.stationId,
            action: 'updated',
            ...auditActor(ctx),
            before: { siteId: from.siteId, circuitId: from.circuitId },
            after: { siteId: site.id, circuitId: station.circuitId },
            notes: 'Site layout demo: moved to the site of its charger type',
          },
        );
      }
    }
    // Another station holding the station id (an operator's own CS-3001), or a
    // demo station an operator moved to another site, keeps it.
    const [own] = await sql`
      SELECT 1 FROM charging_stations WHERE id = ${station.id} AND site_id = ${site.id}
    `;
    if (own == null) {
      console.log(
        `  Site layout demo station ${station.stationId} skipped: the id is taken or it is at another site.`,
      );
      continue;
    }
    seeded.push(station.id);
    const evseCount = isDc ? 2 : 1;
    for (let e = 1; e <= evseCount; e++) {
      await sql`
        INSERT INTO evses (id, station_id, evse_id)
        VALUES (${`evs_demolayout${n}${String(e)}`}, ${station.id}, ${e})
        ON CONFLICT DO NOTHING
      `;
      await sql`
        INSERT INTO connectors (id, evse_id, connector_id, status, connector_type, max_power_kw,
          max_current_amps)
        VALUES (${`con_demolayout${n}${String(e)}`}, ${`evs_demolayout${n}${String(e)}`}, 1,
          'unavailable', ${isDc ? 'CCS2' : 'Type2'}, ${isDc ? '150' : '22'}, ${isDc ? 300 : 32})
        ON CONFLICT DO NOTHING
      `;
    }
    // The fleet simulator runs every station but the offline one.
    const cssId = `css_demolayout${n}`;
    await sql`
      INSERT INTO css_stations (id, station_id, target_url, password, source_type, enabled)
      VALUES (${cssId}, ${station.stationId}, ${ocppWsUrl}, 'password', 'seed',
        ${station.offline !== true})
      ON CONFLICT DO NOTHING
    `;
    for (let e = 1; e <= evseCount; e++) {
      await sql`
        INSERT INTO css_evses (id, css_station_id, evse_id, connector_id, connector_type,
          max_power_w, phases, voltage)
        VALUES (${`cev_demolayout${n}${String(e)}`}, ${cssId}, ${e}, 1,
          ${isDc ? 'dc_ccs2' : 'ac_type2'}, ${isDc ? 150000 : 22000}, 3, ${isDc ? 400 : 230})
        ON CONFLICT DO NOTHING
      `;
    }
  }
  return { present: seeded, inserted, moved };
}

/**
 * Layout settings and positions through the one writer: for a site that has
 * none yet, or one that still has the settings the earlier plan seeded (then
 * audited, as a layout Save is). Returns whether it wrote them.
 */
async function seedLayout(
  site: LayoutDemoSite,
  seeded: readonly string[],
  ctx: DemoFeatureContext,
): Promise<boolean> {
  const stored = await readStoredLayoutSettings(site.id);
  const previous = LAYOUT_DEMO_PREVIOUS_SETTINGS[site.id] ?? [];
  const replacing = stored != null;
  if (stored != null && !previous.some((p) => sameLayoutSettings(stored, p))) return false;
  const positions = site.stations
    .filter((s) => seeded.includes(s.id))
    .map((s) => {
      const p = bayToPosition({ col: s.col, row: s.row });
      return { stationId: s.id, positionX: p.x, positionY: p.y };
    });
  try {
    const saved = await db.transaction((tx) =>
      saveSiteLayout(tx, site.id, positions, site.settings),
    );
    if (replacing && saved.settingsChanged) {
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: site.id,
          entityIdSnapshot: site.id,
          action: 'updated',
          ...auditActor(ctx),
          before: { layoutSettings: saved.settingsBefore },
          after: { layoutPositions: positions, layoutSettings: saved.settingsAfter },
          notes: 'Site layout demo: station layout and layout settings updated',
        },
      );
    }
  } catch (err) {
    // An operator added stations the new lot cannot hold: the layout stays as it is.
    if (err instanceof LayoutGridTooSmallError) {
      console.log(`  Site layout demo layout of ${site.name} kept: ${err.message}`);
      return false;
    }
    throw err;
  }
  return true;
}

/**
 * A card reader the earlier plan paired to another station (now on the other
 * site), still paired there, pairs again to its station of this plan.
 */
async function repairTerminal(
  sql: postgres.Sql,
  demo: (typeof LAYOUT_DEMO.terminals)[number],
  evseId: string | null,
  ctx: DemoFeatureContext,
): Promise<void> {
  if (demo.pairedBefore == null) return;
  const [row] = await sql<Array<{ id: string }>>`
    SELECT id FROM payment_terminals
    WHERE provider = 'simulated' AND provider_device_id = ${demo.providerDeviceId}
      AND station_id = ${demo.pairedBefore}
  `;
  if (row == null) return;
  const result = await pairTerminal(row.id, { stationId: demo.stationId, evseId });
  if (result.kind !== 'paired') return;
  await writeAudit(
    { table: paymentTerminalAuditLog, idColumn: 'payment_terminal_id' },
    {
      entityId: row.id,
      entityIdSnapshot: row.id,
      action: 'paired',
      ...auditActor(ctx),
      before: {
        stationId: result.before.stationId,
        evseId: result.before.evseId,
        siteId: result.before.siteId,
        auditSiteId: result.before.siteId,
      },
      after: {
        stationId: result.after.stationId,
        evseId: result.after.evseId,
        siteId: result.after.siteId,
        auditSiteId: result.after.siteId,
      },
      notes: 'Site layout demo: paired to a DC charger',
    },
  );
}

/** The two card readers on DC chargers of Harbor Point, through the terminal writer. */
async function seedTerminals(sql: postgres.Sql, ctx: DemoFeatureContext): Promise<number> {
  let created = 0;
  for (const demo of LAYOUT_DEMO.terminals) {
    let evseId: string | null = null;
    if (demo.evseNumber != null) {
      const [evse] = await sql<Array<{ id: string }>>`
        SELECT id FROM evses WHERE station_id = ${demo.stationId} AND evse_id = ${demo.evseNumber}
      `;
      if (evse == null) continue;
      evseId = evse.id;
    }
    await repairTerminal(sql, demo, evseId, ctx);
    const result = await createTerminal({
      provider: 'simulated',
      integrationMode: 'cloud',
      providerDeviceId: demo.providerDeviceId,
      label: demo.label,
      vendor: demo.vendor,
      model: demo.model,
      serialNumber: demo.serialNumber,
      firmwareVersion: demo.firmwareVersion,
      siteId: null,
      pairing: { stationId: demo.stationId, evseId },
      createdBy: ctx.actorUserId,
    });
    if (result.kind !== 'created') continue;
    created++;
    await recordTerminalDeviceStatus(
      result.terminal.id,
      {
        online: demo.online,
        lastSeenAt: demo.online ? ctx.now : new Date(ctx.now.getTime() - DAY_MS),
        firmwareVersion: demo.firmwareVersion,
      },
      ctx.now,
    );
    await writeAudit(
      { table: paymentTerminalAuditLog, idColumn: 'payment_terminal_id' },
      {
        entityId: result.terminal.id,
        entityIdSnapshot: result.terminal.id,
        action: 'created',
        actor: ctx.actorUserId != null ? 'operator' : 'system',
        actorUserId: ctx.actorUserId,
        after: {
          label: demo.label,
          provider: 'simulated',
          integrationMode: 'cloud',
          model: demo.model,
          serialNumber: demo.serialNumber,
          siteId: result.terminal.siteId,
          stationId: demo.stationId,
          evseId,
          status: 'active',
          auditSiteId: result.terminal.siteId,
        },
      },
    );
  }
  return created;
}

export interface LayoutDemoCounts {
  stations: number;
  /** Stations of the earlier plan moved to the site of their charger type. */
  moved: number;
  layouts: number;
  terminals: number;
  /** Open AI insights created on the faulted demo stations. */
  faultInsights: number;
}

/** Seeds the site layout demo; a rerun adds nothing. */
export async function seedLayoutDemo(
  sql: postgres.Sql,
  ctx: DemoFeatureContext,
  vendorId: string | null,
): Promise<LayoutDemoCounts> {
  const createdAt = new Date(ctx.now.getTime() - 60 * DAY_MS);
  const passwordHash = await argon2.hash('password', { ...STATION_PASSWORD_HASH_OPTIONS });
  let stations = 0;
  let moved = 0;
  let layouts = 0;
  const present = new Map<string, string[]>();
  for (const site of LAYOUT_DEMO.sites) {
    const seeded = await seedSite(sql, site, vendorId, passwordHash, createdAt, ctx);
    stations += seeded.inserted;
    moved += seeded.moved;
    present.set(site.id, seeded.present);
  }
  // After every move, so each site's save sees only its own stations.
  for (const site of LAYOUT_DEMO.sites) {
    if (await seedLayout(site, present.get(site.id) ?? [], ctx)) layouts++;
  }
  // The maintenance event of Harbor Point: active, on one station.
  const harbor = LAYOUT_DEMO.sites[0];
  const inMaintenance = harbor?.stations.filter((s) => s.maintenance === true) ?? [];
  if (harbor != null && inMaintenance.length > 0) {
    await sql`
      INSERT INTO maintenance_events (id, site_id, event_type, status, planned_start_at,
        planned_end_at, started_at, affected_station_ids, reason, created_by_user_id)
      VALUES (${LAYOUT_DEMO.maintenanceEventId}, ${harbor.id}, 'one_off', 'active',
        ${new Date(ctx.now.getTime() - DAY_MS)}, ${new Date(ctx.now.getTime() + 30 * DAY_MS)},
        ${new Date(ctx.now.getTime() - DAY_MS)}, ${inMaintenance.map((s) => s.id)},
        'Cable replacement', ${ctx.actorUserId})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  const terminals = await seedTerminals(sql, ctx);
  // The faulted stations (no simulator): a faulted connector and an open AI insight on it.
  let faultInsights = 0;
  for (const site of LAYOUT_DEMO.sites) {
    for (const station of site.stations) {
      if (station.faulted !== true || !(present.get(site.id) ?? []).includes(station.id)) continue;
      const created = await seedStationFaultInsight(sql, {
        now: ctx.now,
        stationId: station.id,
        insightId: LAYOUT_DEMO.faultInsightId,
      });
      if (created) faultInsights++;
    }
  }
  return { stations, moved, layouts, terminals, faultInsights };
}
