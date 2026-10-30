// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site layout demo (seed-demo-layout-plan.ts): two sites whose 3D layout
// shows every feature at once. Harbor Point Charging Hub on the default lot
// of 2 rows of 10 spots with two named transformers, Lakeside Retail Park on
// a configured lot (3 rows of 6 wide spots, a 7 m lane, turned 90 degrees).
// Both are load managed with panels and circuits, so the links and their
// limits show. Harbor Point has a cellular station, a station under a
// maintenance event, one without a simulator (offline) and two card readers
// (a VP6825 online on a connector, a VP7200 offline on the whole station).
// The other stations run on the fleet simulator, which charges, reserves and
// faults them like the other demo stations.
//
// Every row has a fixed id and is inserted ON CONFLICT DO NOTHING (P7). The
// layout settings and positions go through saveSiteLayout, the one writer,
// and only while the site has no settings, so an operator's later edit stays.

import type postgres from 'postgres';
import argon2 from 'argon2';
import { STATION_PASSWORD_HASH_OPTIONS } from '@evtivity/lib';
import { bayToPosition } from '@evtivity/lib/site-layout';
import { db } from './config.js';
import { writeAudit } from './lib/audit.js';
import { paymentTerminalAuditLog } from './schema/audit.js';
import { createTerminal, recordTerminalDeviceStatus } from './lib/payment-terminals.js';
import { readStoredLayoutSettings, saveSiteLayout } from './lib/station-layout.js';
import { ensureSiteElectricityRates } from './seed-electricity-rates.js';
import type { DemoFeatureContext } from './seed-demo-features.js';
import { LAYOUT_DEMO, type LayoutDemoSite } from './seed-demo-layout-plan.js';

const DAY_MS = 86_400_000;

async function seedSite(
  sql: postgres.Sql,
  site: LayoutDemoSite,
  vendorId: string | null,
  passwordHash: string,
  createdAt: Date,
): Promise<{ present: string[]; inserted: number }> {
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
    for (const [circuitOrder, circuit] of panel.circuits.entries()) {
      await sql`
        INSERT INTO circuits (id, panel_id, name, breaker_rating_amps, max_continuous_kw,
          sort_order)
        VALUES (${circuit.id}, ${panel.id}, ${circuit.name}, ${circuit.breakerRatingAmps},
          ${String(circuit.maxContinuousKw)}, ${circuitOrder})
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  const ocppWsUrl = process.env['SEED_CSS_TARGET_URL'] ?? 'ws://ocpp:7103';
  const seeded: string[] = [];
  let inserted = 0;
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
    // Another station holding the station id (an operator's own CS-3001) keeps it.
    const [own] = await sql`SELECT 1 FROM charging_stations WHERE id = ${station.id}`;
    if (own == null) {
      console.log(`  Site layout demo station ${station.stationId} skipped: the id is taken.`);
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
  return { present: seeded, inserted };
}

/** Layout settings and positions through the one writer, only for a site that has none yet. */
async function seedLayout(site: LayoutDemoSite, seeded: readonly string[]): Promise<boolean> {
  if ((await readStoredLayoutSettings(site.id)) != null) return false;
  const positions = site.stations
    .filter((s) => seeded.includes(s.id))
    .map((s) => {
      const p = bayToPosition({ col: s.col, row: s.row });
      return { stationId: s.id, positionX: p.x, positionY: p.y };
    });
  await db.transaction(async (tx) => {
    await saveSiteLayout(tx, site.id, positions, site.settings);
  });
  return true;
}

/** The two card readers of Harbor Point, through the terminal writer. */
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
  layouts: number;
  terminals: number;
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
  let layouts = 0;
  for (const site of LAYOUT_DEMO.sites) {
    const { present, inserted } = await seedSite(sql, site, vendorId, passwordHash, createdAt);
    stations += inserted;
    if (await seedLayout(site, present)) layouts++;
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
  return { stations, layouts, terminals };
}
