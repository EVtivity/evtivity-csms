// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The site layout demo (seed-demo-layout-plan.ts): five sites whose 3D layout
// shows every feature at once. Harbor Point Charging Hub is a parking lot of
// DC fast chargers (2 rows of 6 spots, two named transformers on the grass),
// Lakeside Retail Park an office or retail site of AC wall boxes on the
// building facade (12 charger positions), Riverside Medical Offices an office
// or retail site of AC posts at the head of each spot, and Maple Street a
// curbside site of AC posts on both curbs (4 + 4), and Willow Creek Park and
// Ride a custom site whose stations stand freely along a curved access road
// (one DC charger shows an active display message), and Northgate Fleet Depot a
// custom site of bus bays (depot pantograph masts and plug-in dispensers) and
// truck pull-through lanes (megawatt dispensers) whose fleet of buses, semi
// trucks and box trucks charges there (`seedDepotFleet`). Every site is load managed
// (panels, a sub-panel and circuits); the parking lot draws its panels and
// their links, the others show the allocated limit in the station popup.
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
import { mapConnectorTypeToCss } from '@evtivity/lib';
import { bayToPosition, sameLayoutSettings } from '@evtivity/lib/site-layout';
import { and, eq } from 'drizzle-orm';
import { db } from './config.js';
import { writeAudit } from './lib/audit.js';
import { paymentTerminalAuditLog, siteAuditLog, stationAuditLog } from './schema/audit.js';
import {
  createTerminal,
  pairTerminal,
  recordTerminalDeviceStatus,
} from './lib/payment-terminals.js';
import {
  createCircuit,
  createPanel,
  updateCircuit,
  updatePanel,
} from './lib/load-management-tree.js';
import { circuits, panels } from './schema/load-management.js';
import {
  LayoutGridTooSmallError,
  LayoutSpotsOverlapError,
  readSiteLayoutPositions,
  readStoredLayoutSettings,
  saveSiteLayout,
} from './lib/station-layout.js';
import { ensureSiteElectricityRates } from './seed-electricity-rates.js';
import { seedStationFaultInsight } from './seed-ai-insights.js';
import type { DemoFeatureContext } from './seed-demo-features.js';
import {
  LAYOUT_DEMO,
  LAYOUT_DEMO_MESSAGE_ID,
  LAYOUT_DEMO_PREVIOUS_SETTINGS,
  LEVEL_2_AMPS,
  type LayoutDemoSite,
  type LayoutDemoStation,
} from './seed-demo-layout-plan.js';

/**
 * The connectors of a demo station: its type, power and current (DC about
 * 500 V, megawatt about 750 V). The sites are in New York, so the defaults are
 * the North American plugs: CCS1 for DC, and for AC a J1772 (Type1) Level 2
 * charger of 32 A at 208 V (6.66 kW), the current its 40 A circuit is sized for.
 */
function demoConnector(station: LayoutDemoStation): {
  type: string;
  kw: number;
  amps: number;
  css: ReturnType<typeof mapConnectorTypeToCss>;
} {
  const isDc = station.kind === 'dc';
  const type = station.connectorType ?? (isDc ? 'CCS1' : 'Type1');
  const kw = station.maxPowerKw ?? (isDc ? 150 : DEMO_AC_KW);
  const amps = isDc ? Math.round((kw * 1000) / (kw >= 400 ? 750 : 500)) : LEVEL_2_AMPS;
  // The simulator knows the plug types only: a pantograph or megawatt
  // connector charges as CCS1 there (the connector row keeps its own type).
  const known = mapConnectorTypeToCss(type);
  const css = isDc && known === 'ac_type2' ? 'dc_ccs1' : known;
  return { type, kw, amps, css };
}

const DAY_MS = 86_400_000;

/** The demo Level 2 charger: 32 A at 208 V. */
const DEMO_AC_KW = Math.round((LEVEL_2_AMPS * 208) / 10) / 100;

/**
 * The connector defaults of the plan before the North American plugs: a
 * rerun moves a demo connector from them to this plan's only while it still
 * holds them (an operator's own change stays).
 */
const EARLIER_CONNECTOR_DEFAULTS = {
  dc: { type: 'CCS2', css: 'dc_ccs2' },
  ac: { type: 'Type2', kw: 22, css: 'ac_type2', powerW: 22000, voltage: 230, phases: 3 },
} as const;

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
  // Panels and circuits go through the load management tree writer (P3),
  // which audits each row it inserts or moves.
  const treeCtx = auditActor(ctx);
  for (const [order, panel] of site.panels.entries()) {
    await createPanel(
      {
        id: panel.id,
        siteId: site.id,
        parentPanelId: panel.parentPanelId,
        name: panel.name,
        breakerRatingAmps: panel.breakerRatingAmps,
        voltageV: panel.voltageV,
        phases: panel.phases,
        maxContinuousKw: String(panel.maxContinuousKw),
        safetyMarginKw: '0',
        sortOrder: order,
      },
      treeCtx,
      { ifMissing: true },
    );
    // A panel of an earlier plan, still as that plan seeded it, takes this
    // plan's name, ratings and parent.
    for (const before of panel.renamedFrom ?? []) {
      await updatePanel(
        {
          siteId: site.id,
          panelId: panel.id,
          set: {
            name: panel.name,
            breakerRatingAmps: panel.breakerRatingAmps,
            voltageV: panel.voltageV,
            phases: panel.phases,
            parentPanelId: panel.parentPanelId,
            maxContinuousKw: String(panel.maxContinuousKw),
          },
          onlyIf: and(
            eq(panels.siteId, site.id),
            eq(panels.name, before.name),
            before.amps != null ? eq(panels.breakerRatingAmps, before.amps) : undefined,
          ),
        },
        { ...treeCtx, notes: 'Site layout demo: panel moved to the current plan' },
      );
    }
  }
  for (const panel of site.panels) {
    for (const [circuitOrder, circuit] of panel.circuits.entries()) {
      await createCircuit(
        site.id,
        {
          id: circuit.id,
          panelId: panel.id,
          name: circuit.name,
          breakerRatingAmps: circuit.breakerRatingAmps,
          maxContinuousKw: String(circuit.maxContinuousKw),
          phaseConnections: circuit.phaseConnections,
          sortOrder: circuitOrder,
        },
        treeCtx,
        { ifMissing: true },
      );
      // A circuit of an earlier plan, still as that plan seeded it, becomes
      // this station's own circuit on this panel.
      for (const before of circuit.renamedFrom ?? []) {
        await updateCircuit(
          {
            siteId: site.id,
            circuitId: circuit.id,
            set: {
              name: circuit.name,
              panelId: panel.id,
              breakerRatingAmps: circuit.breakerRatingAmps,
              phaseConnections: circuit.phaseConnections,
              maxContinuousKw: String(circuit.maxContinuousKw),
              sortOrder: circuitOrder,
            },
            onlyIf: and(
              eq(circuits.name, before.name),
              eq(circuits.panelId, before.panelId),
              before.amps != null ? eq(circuits.breakerRatingAmps, before.amps) : undefined,
            ),
          },
          { ...treeCtx, notes: 'Site layout demo: circuit moved to the current plan' },
        );
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
    // A station still on the shared circuit of the plan before moves to its own.
    if (station.circuitFrom != null) {
      const rehung = await sql`
        UPDATE charging_stations SET circuit_id = ${station.circuitId}, updated_at = now()
        WHERE id = ${station.id} AND site_id = ${site.id} AND circuit_id = ${station.circuitFrom}
        RETURNING id
      `;
      if (rehung.length > 0) {
        await writeAudit(
          { table: stationAuditLog, idColumn: 'station_id' },
          {
            entityId: station.id,
            entityIdSnapshot: station.stationId,
            action: 'updated',
            ...auditActor(ctx),
            before: { circuitId: station.circuitFrom },
            after: { circuitId: station.circuitId },
            notes: 'Site layout demo: moved to its own circuit',
          },
        );
      }
    }
    const evseCount = station.evses ?? (isDc ? 2 : 1);
    const connector = demoConnector(station);
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
          'unavailable', ${connector.type}, ${String(connector.kw)}, ${connector.amps})
        ON CONFLICT DO NOTHING
      `;
    }
    // Connectors still on the earlier European defaults take the North American plugs.
    if (station.connectorType == null && station.maxPowerKw == null) {
      for (let e = 1; e <= evseCount; e++) {
        const conId = `con_demolayout${n}${String(e)}`;
        const cevId = `cev_demolayout${n}${String(e)}`;
        if (isDc) {
          await sql`
            UPDATE connectors SET connector_type = ${connector.type}
            WHERE id = ${conId} AND connector_type = ${EARLIER_CONNECTOR_DEFAULTS.dc.type}
          `;
          await sql`
            UPDATE css_evses SET connector_type = ${connector.css}
            WHERE id = ${cevId} AND connector_type = ${EARLIER_CONNECTOR_DEFAULTS.dc.css}
          `;
        } else {
          const ac = EARLIER_CONNECTOR_DEFAULTS.ac;
          await sql`
            UPDATE connectors SET connector_type = ${connector.type},
              max_power_kw = ${String(connector.kw)}, max_current_amps = ${connector.amps}
            WHERE id = ${conId} AND connector_type = ${ac.type} AND max_power_kw = ${ac.kw}
          `;
          await sql`
            UPDATE css_evses SET connector_type = ${connector.css},
              max_power_w = ${Math.round(connector.kw * 1000)}, phases = 1, voltage = 208
            WHERE id = ${cevId} AND connector_type = ${ac.css} AND max_power_w = ${ac.powerW}
              AND phases = ${ac.phases} AND voltage = ${ac.voltage}
          `;
        }
      }
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
          ${connector.css}, ${Math.round(connector.kw * 1000)}, ${isDc ? 3 : 1},
          ${isDc ? 400 : 208})
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
      // A custom site's station also stands at its free position.
      return {
        stationId: s.id,
        positionX: p.x,
        positionY: p.y,
        ...(s.free != null ? { free: s.free } : {}),
      };
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
 * A site whose stations this plan moved (`before`): when every such station
 * still stands where the earlier plan put it (grid slot and, on a custom
 * site, free position), they move to this plan's positions in one layout
 * Save through the one writer, audited as a layout Save is. An operator who
 * moved any of them keeps the layout. Returns whether it moved them.
 */
async function regroupLayout(
  site: LayoutDemoSite,
  seeded: readonly string[],
  ctx: DemoFeatureContext,
): Promise<boolean> {
  const planned = site.stations.filter((s) => s.before != null && seeded.includes(s.id));
  if (planned.length === 0) return false;
  const stored = new Map((await readSiteLayoutPositions(site.id)).map((p) => [p.stationId, p]));
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
  const atBefore = planned.every((s) => {
    const p = stored.get(s.id);
    const before = s.before;
    if (p == null || before == null) return false;
    const slot = bayToPosition({ col: before.col, row: before.row });
    if (!same(p.positionX, slot.x) || !same(p.positionY, slot.y)) return false;
    // A grid site's station has no free position.
    if (before.free == null) return p.free == null;
    return (
      p.free != null &&
      same(p.free.x, before.free.x) &&
      same(p.free.z, before.free.z) &&
      same(p.free.rotationDeg, before.free.rotationDeg)
    );
  });
  if (!atBefore) return false;
  // Already where this plan stands them (a rerun after the move): nothing to do.
  if (planned.every((s) => s.col === s.before?.col && s.row === s.before.row)) return false;
  const positions = planned.map((s) => {
    const slot = bayToPosition({ col: s.col, row: s.row });
    return {
      stationId: s.id,
      positionX: slot.x,
      positionY: slot.y,
      ...(s.free != null ? { free: s.free } : {}),
    };
  });
  const previous = planned.flatMap((s) => {
    const p = stored.get(s.id);
    return p == null ? [] : [p];
  });
  try {
    await db.transaction((tx) => saveSiteLayout(tx, site.id, positions));
  } catch (err) {
    // An operator placed another station where one of these would go.
    if (err instanceof LayoutSpotsOverlapError) {
      console.log(`  Site layout demo positions of ${site.name} kept: ${err.message}`);
      return false;
    }
    throw err;
  }
  await writeAudit(
    { table: siteAuditLog, idColumn: 'site_id' },
    {
      entityId: site.id,
      entityIdSnapshot: site.id,
      action: 'updated',
      ...auditActor(ctx),
      before: { layoutPositions: previous },
      after: { layoutPositions: positions },
      notes:
        site.settings.siteType === 'custom'
          ? 'Site layout demo: AC and DC chargers grouped'
          : planned.some((s) => (s.evses ?? 1) >= 2 && s.kind === 'ac')
            ? 'Site layout demo: dual-port Level 2 pedestals between two spots'
            : 'Site layout demo: chargers moved into one continuous run',
    },
  );
  return true;
}

/**
 * A card reader the earlier plan paired to another station (now on the other
 * site) or to one EVSE of its station, still paired there, pairs again to its
 * station and EVSE of this plan.
 */
async function repairTerminal(
  sql: postgres.Sql,
  demo: (typeof LAYOUT_DEMO.terminals)[number],
  evseId: string | null,
  ctx: DemoFeatureContext,
): Promise<void> {
  if (demo.pairedBefore == null && demo.evseBefore == null) return;
  const stationBefore = demo.pairedBefore ?? demo.stationId;
  const evseBefore = demo.evseBefore ?? null;
  const [row] = await sql<Array<{ id: string }>>`
    SELECT t.id FROM payment_terminals t
    LEFT JOIN evses e ON e.id = t.evse_id
    WHERE t.provider = 'simulated' AND t.provider_device_id = ${demo.providerDeviceId}
      AND t.station_id = ${stationBefore}
      AND (${evseBefore}::int IS NULL OR e.evse_id = ${evseBefore})
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
      notes:
        demo.evseBefore != null
          ? 'Site layout demo: paired to the whole DC charger'
          : 'Site layout demo: paired to a DC charger',
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
  /** Active display messages created on demo stations. */
  messages: number;
  /** Open AI insights created on the faulted demo stations. */
  faultInsights: number;
  /** Drivers of the depot fleet created (each with its card and its vehicle). */
  fleetDrivers: number;
}

/**
 * The fleet of Northgate Fleet Depot (`LAYOUT_DEMO.fleet`): the fleet, its
 * drivers with an RFID card, a saved simulated credit card and one vehicle
 * each (bus, semi truck or box truck in its color), the members and the
 * depot's stations as the fleet's stations, so the simulator charges them
 * with these drivers' cards and the layout draws their vehicles. Fixed ids,
 * ON CONFLICT DO NOTHING: a rerun adds nothing and an operator's change stays.
 */
async function seedDepotFleet(sql: postgres.Sql, stationIds: readonly string[]): Promise<number> {
  const fleet = LAYOUT_DEMO.fleet;
  await sql`
    INSERT INTO fleets (id, name, description)
    VALUES (${fleet.id}, ${fleet.name}, ${fleet.description})
    ON CONFLICT (id) DO NOTHING
  `;
  let created = 0;
  for (const d of fleet.drivers) {
    const rows = await sql`
      INSERT INTO drivers (id, first_name, last_name, email, email_verified, registration_source)
      VALUES (${d.id}, ${d.firstName}, ${d.lastName}, ${d.email}, true, 'admin')
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    // Another driver holding the email (an operator's own) keeps it: nothing else for this one.
    const [own] = await sql`SELECT 1 FROM drivers WHERE id = ${d.id}`;
    if (own == null) continue;
    created += rows.length;
    const n = d.id.slice(-2);
    await sql`
      INSERT INTO driver_tokens (id, driver_id, id_token, token_type, is_active)
      VALUES (${`dtk_demodepot${n}`}, ${d.id}, ${d.idToken}, 'ISO14443', true)
      ON CONFLICT DO NOTHING
    `;
    const v = d.vehicle;
    await sql`
      INSERT INTO vehicles (id, driver_id, make, model, year, license_plate, color, body_type)
      VALUES (${v.id}, ${d.id}, ${v.make}, ${v.model}, ${v.year}, ${v.licensePlate}, ${v.color},
        ${v.bodyType})
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO driver_payment_customers (driver_id, provider, provider_customer_id)
      VALUES (${d.id}, 'simulated', ${`cus_sim_depot${n}`})
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO driver_payment_methods (driver_id, provider, provider_customer_id,
        provider_payment_method_id, card_brand, card_last4, is_default)
      SELECT ${d.id}, 'simulated', ${`cus_sim_depot${n}`}, ${`pm_sim_depot${n}`}, 'visa', '4242', true
      WHERE NOT EXISTS (SELECT 1 FROM driver_payment_methods WHERE driver_id = ${d.id})
    `;
    await sql`
      INSERT INTO fleet_drivers (fleet_id, driver_id)
      VALUES (${fleet.id}, ${d.id})
      ON CONFLICT DO NOTHING
    `;
  }
  for (const stationId of stationIds) {
    await sql`
      INSERT INTO fleet_stations (fleet_id, station_id)
      VALUES (${fleet.id}, ${stationId})
      ON CONFLICT DO NOTHING
    `;
  }
  return created;
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
    const seeded = present.get(site.id) ?? [];
    if (await seedLayout(site, seeded, ctx)) layouts++;
    else if (await regroupLayout(site, seeded, ctx)) layouts++;
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
  // An active display message the station accepted (shown on its charger screen in 3D).
  let messages = 0;
  for (const site of LAYOUT_DEMO.sites) {
    for (const station of site.stations) {
      if (station.message == null || !(present.get(site.id) ?? []).includes(station.id)) continue;
      const rows = await sql`
        INSERT INTO display_messages (station_id, ocpp_message_id, priority, status, format,
          language, content, created_at, updated_at)
        VALUES (${station.id}, ${LAYOUT_DEMO_MESSAGE_ID}, 'NormalCycle', 'accepted', 'UTF8', 'en',
          ${station.message}, ${ctx.now}, ${ctx.now})
        ON CONFLICT (station_id, ocpp_message_id) DO NOTHING
        RETURNING id
      `;
      messages += rows.length;
    }
  }
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
  const fleetDrivers = await seedDepotFleet(sql, present.get(LAYOUT_DEMO.fleet.siteId) ?? []);
  return { stations, moved, layouts, terminals, faultInsights, messages, fleetDrivers };
}
