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
// trucks and box trucks charges there (`seedDepotFleet`) and leaves on weekday
// departures the depot plans for (`seedDepotDepartures`). Every site is load managed
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
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { STATION_PASSWORD_HASH_OPTIONS } from '@evtivity/lib';
import { mapConnectorTypeToCss } from '@evtivity/lib';
import { localDateInZone, scheduleOccurrences } from '@evtivity/lib/departure-schedule';
import { bayToPosition, sameLayoutSettings } from '@evtivity/lib/site-layout';
import { db } from './config.js';
import { writeAudit } from './lib/audit.js';
import {
  paymentTerminalAuditLog,
  siteAuditLog,
  stationAuditLog,
  tokenAuditLog,
  vehicleAuditLog,
  vehicleDepartureAuditLog,
} from './schema/audit.js';
import { vehicleDepartureSchedules } from './schema/departures.js';
import { vehicles } from './schema/drivers.js';
import {
  futureScheduleOccurrences,
  insertDepartureSchedule,
  insertScheduleOccurrences,
  markSitePlanStale,
  updateDepartureSchedule,
  updateScheduledDeparture,
  type VehicleDepartureSchedule,
} from './lib/vehicle-departures.js';
import {
  createTerminal,
  pairTerminal,
  recordTerminalDeviceStatus,
} from './lib/payment-terminals.js';
import {
  createCircuit,
  createPanel,
  createTransformer,
  deleteTransformer,
  updateCircuit,
  updatePanel,
  updateTransformer,
  LoadTreeValidationError,
  type LoadTreeWriteContext,
} from './lib/load-management-tree.js';
import {
  createEnergyAsset,
  deleteEnergyAsset,
  recordEnergyAssetReading,
  updateEnergyAsset,
} from './lib/site-energy-assets.js';
import { layoutEquipmentRowId } from './lib/layout-equipment-id.js';
import {
  circuits,
  energyAssetReadings,
  panels,
  siteEnergyAssets,
  transformers,
} from './schema/load-management.js';
import {
  LayoutGridTooSmallError,
  LayoutSpotsOverlapError,
  readSiteLayoutPositions,
  readStoredLayoutSettings,
  saveSiteLayout,
} from './lib/station-layout.js';
import { seedDemoStationUnitsOf } from './seed-demo-station-units.js';
import { ensureSiteElectricityRates } from './seed-electricity-rates.js';
import { seedStationFaultInsight } from './seed-ai-insights.js';
import type { DemoFeatureContext } from './seed-demo-features.js';
import {
  LAYOUT_DEMO,
  LAYOUT_DEMO_MESSAGE_ID,
  LAYOUT_DEMO_PREVIOUS_SETTINGS,
  LEVEL_2_AMPS,
  DEPOT_BODY_TYPE_BATTERY_BEFORE,
  demoLayoutPositions,
  demoStepDowns,
  type DemoAssetElectrical,
  type DemoLayoutSettings,
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
/** Local dates of departures created ahead with a demo schedule, today included (the expand cron's window). */
const DEPOT_DEMO_EXPANSION_DAYS = 8;

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
    VALUES (${site.id}, ${site.name}, ${site.address}, ${site.city},
      ${site.state === undefined ? 'NY' : site.state}, ${site.postalCode ?? '12207'},
      ${site.country ?? 'US'}, ${site.latitude}, ${site.longitude},
      ${site.timezone ?? 'America/New_York'}, '24/7', ${createdAt}, ${createdAt})
    ON CONFLICT (id) DO NOTHING
  `;
  await ensureSiteElectricityRates(db, site.id);
  const strategy =
    site.id === LAYOUT_DEMO.fleet.siteId ? LAYOUT_DEMO.fleet.loadStrategy : 'equal_share';
  await sql`
    INSERT INTO site_load_management (site_id, strategy, is_enabled)
    VALUES (${site.id}, ${strategy}, true)
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
    const n = station.rowKey ?? station.id.slice(-2);
    const isDc = station.kind === 'dc';
    const model = station.model ?? (isDc ? 'Terra 184' : 'Pulsar Plus');
    const supply =
      station.acSupply ?? (isDc ? { phases: 3, voltage: 400 } : { phases: 1, voltage: 208 });
    const created = await sql`
      INSERT INTO charging_stations (id, station_id, site_id, vendor_id, model, serial_number,
        firmware_version, onboarding_status, availability, is_online, security_profile,
        ocpp_protocol, basic_auth_password_hash, is_simulator, circuit_id, data_plan, created_at,
        updated_at)
      VALUES (${station.id}, ${station.stationId}, ${site.id}, ${vendorId},
        ${model}, ${`SN-LY-00${n}`}, '2.4.1', 'accepted',
        'available', false, 1, ${station.ocppProtocol ?? 'ocpp2.1'}, ${passwordHash}, true,
        ${station.circuitId},
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
    const extra = (station.extraConnectorTypes ?? []).map((type, k) => ({
      connectorId: k + 2,
      type,
      css: mapConnectorTypeToCss(type),
    }));
    // EVSEs a rerun adds to a station seeded before with fewer (a one-port box made two-port).
    let addedEvses = 0;
    for (let e = 1; e <= evseCount; e++) {
      const addedEvse = await sql`
        INSERT INTO evses (id, station_id, evse_id)
        VALUES (${`evs_demolayout${n}${String(e)}`}, ${station.id}, ${e})
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (created.length === 0 && e >= 2) addedEvses += addedEvse.length;
      // OCPP 1.6 connector N is EVSE N / connector N (as in seed.ts), so the status a 1.6
      // station reports for connector N lands on this row instead of an auto-created one.
      const connectorNo = station.ocppProtocol === 'ocpp1.6' ? e : 1;
      await sql`
        INSERT INTO connectors (id, evse_id, connector_id, status, connector_type, max_power_kw,
          max_current_amps)
        VALUES (${`con_demolayout${n}${String(e)}`}, ${`evs_demolayout${n}${String(e)}`},
          ${connectorNo}, 'unavailable', ${connector.type}, ${String(connector.kw)},
          ${connector.amps})
        ON CONFLICT DO NOTHING
      `;
      // A second cable on the EVSE (a rerun adds it to a station seeded before).
      for (const c of extra) {
        await sql`
          INSERT INTO connectors (id, evse_id, connector_id, status, connector_type,
            max_power_kw, max_current_amps)
          VALUES (${`con_demolayout${n}${String(e)}_${String(c.connectorId)}`},
            ${`evs_demolayout${n}${String(e)}`}, ${c.connectorId}, 'unavailable', ${c.type},
            ${String(connector.kw)}, ${connector.amps})
          ON CONFLICT DO NOTHING
        `;
      }
    }
    if (addedEvses > 0) {
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: station.id,
          entityIdSnapshot: station.stationId,
          action: 'updated',
          ...auditActor(ctx),
          before: { evses: evseCount - addedEvses },
          after: { evses: evseCount },
          notes:
            station.kind === 'ac'
              ? 'Site layout demo: Level 2 charger with two ports'
              : 'Site layout demo: EVSE added',
        },
      );
    }
    // Connectors still at a power an earlier plan seeded take the plan's power.
    if (station.maxPowerKwBefore != null && station.maxPowerKwBefore.length > 0) {
      const earlier = station.maxPowerKwBefore.map(String);
      const earlierW = station.maxPowerKwBefore.map((kw) => Math.round(kw * 1000));
      await sql`
        UPDATE connectors SET max_power_kw = ${String(connector.kw)}, max_current_amps = ${connector.amps}
        WHERE evse_id IN (SELECT id FROM evses WHERE station_id = ${station.id})
          AND max_power_kw IN ${sql(earlier)}
      `;
      await sql`
        UPDATE css_evses SET max_power_w = ${Math.round(connector.kw * 1000)}
        WHERE css_station_id = ${`css_demolayout${n}`} AND max_power_w IN ${sql(earlierW)}
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
          ${connector.css}, ${Math.round(connector.kw * 1000)}, ${supply.phases},
          ${supply.voltage})
        ON CONFLICT DO NOTHING
      `;
      for (const c of extra) {
        await sql`
          INSERT INTO css_evses (id, css_station_id, evse_id, connector_id, connector_type,
            max_power_w, phases, voltage)
          VALUES (${`cev_demolayout${n}${String(e)}_${String(c.connectorId)}`}, ${cssId}, ${e},
            ${c.connectorId}, ${c.css}, ${Math.round(connector.kw * 1000)}, ${supply.phases},
            ${supply.voltage})
          ON CONFLICT DO NOTHING
        `;
      }
    }
  }
  return { present: seeded, inserted, moved };
}

/**
 * Whether this seed may store `simulated` battery and solar telemetry:
 * ENERGY_ASSETS_ALLOW_SIMULATED as the API and worker read it (owner decision
 * D13), on by default only under NODE_ENV development or test.
 */
export function seedAllowsSimulatedEnergyAssets(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['ENERGY_ASSETS_ALLOW_SIMULATED'];
  if (value != null && value !== '') return value === 'true';
  return ['development', 'test'].includes(env['NODE_ENV'] ?? '');
}

/** The `site_energy_assets` wiring columns of a demo asset's plan (`electrical`). */
function assetWiring(
  siteId: string,
  e: DemoAssetElectrical,
  allowSimulated: boolean,
): {
  inverterKw: string;
  maxDischargeKw: string | null;
  maxChargeKw: string | null;
  connectionTransformerId: string | null;
  connectionPanelId: string | null;
  telemetry: 'none' | 'api' | 'simulated';
} {
  return {
    inverterKw: String(e.inverterKw),
    maxDischargeKw: e.maxDischargeKw != null ? String(e.maxDischargeKw) : null,
    maxChargeKw: e.maxChargeKw != null ? String(e.maxChargeKw) : null,
    connectionTransformerId:
      'transformer' in e.connection
        ? layoutEquipmentRowId('tfm', siteId, e.connection.transformer)
        : null,
    connectionPanelId: 'panel' in e.connection ? e.connection.panel : null,
    telemetry: e.telemetry === 'api' ? 'api' : allowSimulated ? 'simulated' : 'none',
  };
}

/**
 * The power equipment rows of a demo site's plan, through the load
 * management writers (each audited): every transformer and energy asset
 * inserted while its id is free, an asset with its wiring (`electrical`;
 * the panel links follow in `seedPowerWiring`). When the stored settings are
 * an earlier plan's (`matched`), a row that still holds that plan's name and
 * rating takes the current ones, and a row of equipment the current plan no
 * longer has is deleted while it still holds what that plan wrote; an
 * operator's own change stays.
 */
async function seedLayoutEquipment(
  site: LayoutDemoSite,
  matched: DemoLayoutSettings | null,
  ctx: DemoFeatureContext,
): Promise<void> {
  const treeCtx: LoadTreeWriteContext = auditActor(ctx);
  const allowSimulated = seedAllowsSimulatedEnergyAssets();
  const assetOptions = { allowSimulated };
  const siteId = site.id;
  const plan = site.settings;
  for (const [i, t] of plan.transformers.entries()) {
    const id = layoutEquipmentRowId('tfm', siteId, t.id);
    const created = await createTransformer(
      { id, siteId, kind: 'service', name: t.name, ratedKva: String(t.ratedKva), sortOrder: i },
      treeCtx,
      { ifMissing: true },
    );
    const before = matched?.transformers.find((p) => p.id === t.id);
    if (
      created == null &&
      before != null &&
      (before.name !== t.name || before.ratedKva !== t.ratedKva)
    ) {
      await updateTransformer(
        {
          siteId,
          transformerId: id,
          set: { name: t.name, ratedKva: String(t.ratedKva) },
          onlyIf: and(
            eq(transformers.name, before.name),
            eq(transformers.ratedKva, String(before.ratedKva)),
          ),
        },
        treeCtx,
      );
    }
  }
  for (const a of plan.energyAssets ?? []) {
    const id = layoutEquipmentRowId('ena', siteId, a.id);
    const ratings =
      a.type === 'battery'
        ? { capacityKwh: a.capacityKwh, peakKwp: null }
        : { capacityKwh: null, peakKwp: a.capacityKwp };
    const created = await createEnergyAsset(
      {
        id,
        siteId,
        type: a.type,
        name: a.name,
        ...ratings,
        ...(a.electrical != null ? assetWiring(siteId, a.electrical, allowSimulated) : {}),
      },
      treeCtx,
      { ...assetOptions, ifMissing: true },
    );
    const before = matched?.energyAssets?.find((p) => p.id === a.id && p.type === a.type);
    const beforeRating =
      before == null ? null : before.type === 'battery' ? before.capacityKwh : before.capacityKwp;
    const rating = a.type === 'battery' ? a.capacityKwh : a.capacityKwp;
    if (created == null && before != null && (before.name !== a.name || beforeRating !== rating)) {
      const ratingColumn =
        a.type === 'battery' ? siteEnergyAssets.capacityKwh : siteEnergyAssets.peakKwp;
      await updateEnergyAsset(
        {
          siteId,
          assetId: id,
          set: { name: a.name, ...ratings },
          onlyIf: and(
            eq(siteEnergyAssets.name, before.name),
            beforeRating == null ? isNull(ratingColumn) : eq(ratingColumn, beforeRating),
          ),
        },
        treeCtx,
        assetOptions,
      );
    }
  }
  if (matched == null) return;
  for (const t of matched.transformers) {
    if (plan.transformers.some((c) => c.id === t.id)) continue;
    const [row] = await db
      .select()
      .from(transformers)
      .where(
        and(
          eq(transformers.id, layoutEquipmentRowId('tfm', siteId, t.id)),
          eq(transformers.siteId, siteId),
          eq(transformers.name, t.name),
          eq(transformers.ratedKva, String(t.ratedKva)),
        ),
      );
    if (row != null) await deleteTransformer({ siteId, transformer: row }, treeCtx);
  }
  for (const a of matched.energyAssets ?? []) {
    if ((plan.energyAssets ?? []).some((c) => c.id === a.id)) continue;
    const [row] = await db
      .select()
      .from(siteEnergyAssets)
      .where(
        and(
          eq(siteEnergyAssets.id, layoutEquipmentRowId('ena', siteId, a.id)),
          eq(siteEnergyAssets.siteId, siteId),
          eq(siteEnergyAssets.name, a.name),
        ),
      );
    if (row != null) await deleteEnergyAsset({ siteId, asset: row }, treeCtx);
  }
}

/**
 * The wiring of a demo site's power equipment, on every run and through the
 * load management writers (each audited), so a reseed of an install an
 * earlier plan seeded adds what is missing and a rerun writes nothing:
 *   - a service transformer still at a rating an earlier plan seeded
 *     (`ratedKvaBefore`) and its plan name takes the plan's rating;
 *   - the switchboard a transformer feeds (`feeds`) is linked to it while it
 *     has no link;
 *   - each 208Y/120 V panelboard under a 480Y/277 V switchboard gets its
 *     step-down transformer (`demoStepDowns`) and the link, while it has none;
 *   - an energy asset still as an earlier plan left it (plan name, no
 *     connection, telemetry `none`, its plan or an earlier rating) takes its
 *     rating and wiring;
 *   - an `api` asset without a reading gets one old reading, past its TTL,
 *     so it reads Stale.
 * Rows an operator deleted or changed are left alone (each step is guarded).
 */
async function seedPowerWiring(site: LayoutDemoSite, ctx: DemoFeatureContext): Promise<void> {
  const siteId = site.id;
  const treeCtx: LoadTreeWriteContext = {
    ...auditActor(ctx),
    notes: 'Site layout demo: power wiring',
  };
  const allowSimulated = seedAllowsSimulatedEnergyAssets();
  const plan = site.settings;
  const transformerRow = async (id: string) =>
    (
      await db
        .select()
        .from(transformers)
        .where(and(eq(transformers.id, id), eq(transformers.siteId, siteId)))
    )[0];

  for (const t of plan.transformers) {
    const id = layoutEquipmentRowId('tfm', siteId, t.id);
    if (t.ratedKvaBefore != null && t.ratedKvaBefore.length > 0) {
      await updateTransformer(
        {
          siteId,
          transformerId: id,
          set: { ratedKva: String(t.ratedKva) },
          onlyIf: and(
            eq(transformers.name, t.name),
            inArray(transformers.ratedKva, t.ratedKvaBefore.map(String)),
          ),
        },
        treeCtx,
      );
    }
    if (t.feeds == null) continue;
    const row = await transformerRow(id);
    if (row == null || row.kind !== 'service' || row.ratedKva == null) continue;
    const [board] = await db
      .select({ id: panels.id })
      .from(panels)
      .where(
        and(
          eq(panels.id, t.feeds),
          eq(panels.siteId, siteId),
          isNull(panels.parentPanelId),
          isNull(panels.transformerId),
        ),
      );
    if (board == null) continue;
    await updatePanel(
      {
        siteId,
        panelId: t.feeds,
        set: { transformerId: id },
        onlyIf: and(
          eq(panels.siteId, siteId),
          isNull(panels.transformerId),
          isNull(panels.parentPanelId),
        ),
      },
      treeCtx,
    );
  }

  for (const [k, sd] of demoStepDowns(site).entries()) {
    const [board] = await db
      .select({ id: panels.id, transformerId: panels.transformerId })
      .from(panels)
      .where(
        and(
          eq(panels.id, sd.panelId),
          eq(panels.siteId, siteId),
          eq(panels.parentPanelId, sd.fedFromPanelId),
        ),
      );
    if (board == null || board.transformerId != null) continue;
    await createTransformer(
      {
        id: sd.id,
        siteId,
        kind: 'step_down',
        name: sd.name,
        ratedKva: String(sd.ratedKva),
        phases: 3,
        secondaryVoltageV: 120,
        fedFromPanelId: sd.fedFromPanelId,
        sortOrder: plan.transformers.length + k,
      },
      treeCtx,
      { ifMissing: true },
    );
    const row = await transformerRow(sd.id);
    if (row?.kind !== 'step_down' || row.fedFromPanelId !== sd.fedFromPanelId) continue;
    if (row.ratedKva == null) continue;
    await updatePanel(
      {
        siteId,
        panelId: sd.panelId,
        set: { transformerId: sd.id },
        onlyIf: and(
          eq(panels.siteId, siteId),
          isNull(panels.transformerId),
          eq(panels.parentPanelId, sd.fedFromPanelId),
        ),
      },
      treeCtx,
    );
  }

  for (const a of plan.energyAssets ?? []) {
    const e = a.electrical;
    if (e == null) continue;
    const id = layoutEquipmentRowId('ena', siteId, a.id);
    const wiring = assetWiring(siteId, e, allowSimulated);
    if (wiring.connectionTransformerId != null) {
      if ((await transformerRow(wiring.connectionTransformerId)) == null) continue;
    }
    const rating = a.type === 'battery' ? a.capacityKwh : a.capacityKwp;
    const ratingColumn =
      a.type === 'battery' ? siteEnergyAssets.capacityKwh : siteEnergyAssets.peakKwp;
    const ratings = [rating, ...(e.ratingBefore ?? [])].filter((r): r is number => r != null);
    try {
      await updateEnergyAsset(
        {
          siteId,
          assetId: id,
          set: {
            ...(a.type === 'battery' ? { capacityKwh: a.capacityKwh } : { peakKwp: a.capacityKwp }),
            ...wiring,
          },
          onlyIf: and(
            eq(siteEnergyAssets.siteId, siteId),
            eq(siteEnergyAssets.name, a.name),
            isNull(siteEnergyAssets.connectionTransformerId),
            isNull(siteEnergyAssets.connectionPanelId),
            eq(siteEnergyAssets.telemetry, 'none'),
            ratings.length > 0 ? inArray(ratingColumn, ratings) : undefined,
          ),
        },
        treeCtx,
        { allowSimulated },
      );
    } catch (err) {
      // An operator removed the panel the plan connects it to: the asset stays as it is.
      if (!(err instanceof LoadTreeValidationError)) throw err;
      console.log(`  Site layout demo energy asset ${a.name} kept: ${err.message}`);
    }
    if (e.telemetry !== 'api') continue;
    const [asset] = await db
      .select({ telemetry: siteEnergyAssets.telemetry })
      .from(siteEnergyAssets)
      .where(and(eq(siteEnergyAssets.id, id), eq(siteEnergyAssets.siteId, siteId)));
    if (asset?.telemetry !== 'api') continue;
    const [reading] = await db
      .select({ assetId: energyAssetReadings.assetId })
      .from(energyAssetReadings)
      .where(eq(energyAssetReadings.assetId, id));
    if (reading != null) continue;
    const at = new Date(ctx.now.getTime() - (e.staleReadingMinutes ?? 15) * 60_000);
    await recordEnergyAssetReading({
      assetId: id,
      reportedAt: at,
      receivedAt: at,
      powerKw: e.staleReadingKw ?? 0,
      availableKw: null,
      socPercent: null,
      source: 'api',
      apiKeyId: null,
    });
  }
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
  // Stored settings are positions by id, the form the v0.1.50 migration wrote
  // over an earlier plan's settings.
  const matched =
    stored == null
      ? null
      : (previous.find((p) => sameLayoutSettings(stored, demoLayoutPositions(site.id, p))) ?? null);
  if (stored != null && matched == null) return false;
  await seedLayoutEquipment(site, matched, ctx);
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
      saveSiteLayout(tx, site.id, positions, demoLayoutPositions(site.id, site.settings)),
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
          : site.settings.siteType === 'office_retail' &&
              site.stations.some((s) => (s.evses ?? 1) >= 2 && s.kind === 'ac')
            ? 'Site layout demo: a two-port wall box between two spots'
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
  /** Units created on demo stations with units (a master and its extenders). */
  units: number;
  terminals: number;
  /** Active display messages created on demo stations. */
  messages: number;
  /** Open AI insights created on the faulted demo stations. */
  faultInsights: number;
  /** Drivers of the depot fleet created (each with its card and its vehicle). */
  fleetDrivers: number;
  /** Weekly departure schedules created for the depot vehicles. */
  departureSchedules: number;
  /** Station security events created on the demo layout sites (the dashboard card). */
  securityEvents: number;
}

type DepotDriver = (typeof LAYOUT_DEMO.fleet.drivers)[number];

/**
 * A depot vehicle an earlier demo seeded without battery data gets its
 * battery size and accepted power, only while both are unset, audited as the
 * vehicle writer audits a change.
 */
async function fillDepotVehicleBattery(
  sql: postgres.Sql,
  d: DepotDriver,
  ctx: DemoFeatureContext,
): Promise<void> {
  const v = d.vehicle;
  const updated = await sql`
    UPDATE vehicles SET battery_capacity_kwh = ${String(v.batteryCapacityKwh)},
      max_charge_power_kw = ${String(v.maxChargePowerKw)}, updated_at = now()
    WHERE id = ${v.id} AND driver_id = ${d.id}
      AND battery_capacity_kwh IS NULL AND max_charge_power_kw IS NULL
    RETURNING id
  `;
  if (updated.length > 0) {
    await writeAudit(
      { table: vehicleAuditLog, idColumn: 'vehicle_id' },
      {
        entityId: v.id,
        entityIdSnapshot: v.id,
        action: 'updated',
        ...auditActor(ctx),
        before: { batteryCapacityKwh: null, maxChargePowerKw: null },
        after: { batteryCapacityKwh: v.batteryCapacityKwh, maxChargePowerKw: v.maxChargePowerKw },
        notes: 'Demo data: vehicle battery size and charging power',
      },
    );
    return;
  }
  // A battery size an earlier demo seeded that no product offers moves to the
  // plan's, only while the vehicle still holds it and its accepted power.
  const earlier = DEPOT_BODY_TYPE_BATTERY_BEFORE[v.bodyType] ?? [];
  if (earlier.length === 0) return;
  const moved = await sql<Array<{ before: string }>>`
    UPDATE vehicles SET battery_capacity_kwh = ${String(v.batteryCapacityKwh)}, updated_at = now()
    WHERE id = ${v.id} AND driver_id = ${d.id}
      AND battery_capacity_kwh = ANY(${earlier.map(String)}::numeric[])
      AND max_charge_power_kw = ${String(v.maxChargePowerKw)}
    RETURNING (SELECT battery_capacity_kwh::text FROM vehicles WHERE id = ${v.id}) AS before
  `;
  if (moved.length === 0) return;
  await writeAudit(
    { table: vehicleAuditLog, idColumn: 'vehicle_id' },
    {
      entityId: v.id,
      entityIdSnapshot: v.id,
      action: 'updated',
      ...auditActor(ctx),
      before: { batteryCapacityKwh: Number(moved[0]?.before) },
      after: { batteryCapacityKwh: v.batteryCapacityKwh },
      notes: 'Demo data: vehicle battery size of a real product option',
    },
  );
}

/** A depot card an earlier demo seeded without a vehicle names the driver's vehicle, only while unset. */
async function linkDepotCardToVehicle(
  sql: postgres.Sql,
  d: DepotDriver,
  ctx: DemoFeatureContext,
): Promise<void> {
  const tokenId = `dtk_demodepot${d.id.slice(-3)}`;
  const updated = await sql`
    UPDATE driver_tokens SET vehicle_id = ${d.vehicle.id}, updated_at = now()
    WHERE id = ${tokenId} AND driver_id = ${d.id} AND vehicle_id IS NULL
      AND EXISTS (SELECT 1 FROM vehicles WHERE id = ${d.vehicle.id} AND driver_id = ${d.id})
    RETURNING id
  `;
  if (updated.length === 0) return;
  await writeAudit(
    { table: tokenAuditLog, idColumn: 'token_id' },
    {
      entityId: tokenId,
      entityIdSnapshot: tokenId,
      action: 'updated',
      ...auditActor(ctx),
      before: { vehicleId: null },
      after: { vehicleId: d.vehicle.id },
      notes: 'Demo data: card linked to its vehicle',
    },
  );
}

/**
 * A demo schedule an earlier plan seeded with an energy target past what
 * real fleets use (`targetEnergyKwhBefore`) takes the plan's target, with its
 * scheduled occurrences ahead that no person changed, through the departure
 * writer, only while the schedule is still the demo's (notes `Demo route`,
 * the earlier target) and audited `schedule_updated` as the departure
 * service audits an edit. Returns the schedules it moved.
 */
async function retargetDepotSchedules(ctx: DemoFeatureContext): Promise<number> {
  const fleet = LAYOUT_DEMO.fleet;
  let moved = 0;
  for (const d of fleet.drivers) {
    const before = d.departure.targetEnergyKwhBefore ?? [];
    if (before.length === 0) continue;
    const target = String(d.departure.targetEnergyKwh);
    const changed = await db.transaction(async (tx) => {
      const [schedule] = await tx
        .select()
        .from(vehicleDepartureSchedules)
        .where(
          and(
            eq(vehicleDepartureSchedules.vehicleId, d.vehicle.id),
            eq(vehicleDepartureSchedules.siteId, fleet.siteId),
            eq(vehicleDepartureSchedules.notes, 'Demo route'),
            eq(vehicleDepartureSchedules.targetKind, 'energy'),
            inArray(vehicleDepartureSchedules.targetEnergyKwh, before.map(String)),
          ),
        )
        .limit(1)
        .for('update');
      if (schedule == null) return null;
      const updated = await updateDepartureSchedule(schedule.id, { targetEnergyKwh: target }, tx);
      if (updated == null) return null;
      for (const o of await futureScheduleOccurrences(schedule.id, ctx.now, tx)) {
        if (
          o.targetKind !== 'energy' ||
          !before.map(String).includes(String(Number(o.targetEnergyKwh)))
        ) {
          continue;
        }
        await updateScheduledDeparture(o.id, { targetEnergyKwh: target }, tx);
      }
      return { before: schedule, after: updated };
    });
    if (changed == null) continue;
    moved++;
    await writeAudit(
      { table: vehicleDepartureAuditLog, idColumn: 'vehicle_departure_id' },
      {
        entityId: changed.after.id,
        entityIdSnapshot: changed.after.id,
        action: 'schedule_updated',
        ...auditActor(ctx),
        before: {
          entityKind: 'schedule',
          targetEnergyKwh: changed.before.targetEnergyKwh,
          auditSiteId: changed.before.siteId,
          auditSiteIds: [changed.before.siteId],
        },
        after: {
          entityKind: 'schedule',
          targetEnergyKwh: changed.after.targetEnergyKwh,
          auditSiteId: changed.after.siteId,
          auditSiteIds: [changed.after.siteId],
        },
        notes: 'Demo data: route energy inside what real fleets use',
      },
    );
  }
  return moved;
}

/**
 * The weekly departures of the depot vehicles, through the departure writer:
 * a vehicle gets its schedule (and the occurrences of the next days) only
 * while it has none, so a rerun adds nothing and an operator's schedule
 * stays. The run that creates the first
 * schedules also moves the depot from the strategy an earlier demo seeded to
 * Departure Aware. Each schedule is audited as the departure service audits it.
 */
async function seedDepotDepartures(sql: postgres.Sql, ctx: DemoFeatureContext): Promise<number> {
  const fleet = LAYOUT_DEMO.fleet;
  const [site] = await sql<Array<{ timezone: string }>>`
    SELECT timezone FROM sites WHERE id = ${fleet.siteId}
  `;
  if (site == null) return 0;
  const created: VehicleDepartureSchedule[] = [];
  for (const d of fleet.drivers) {
    const schedule = await db.transaction(async (tx) => {
      // The vehicle row lock keeps two seed runs from both creating a schedule.
      const [vehicle] = await tx
        .select({ id: vehicles.id })
        .from(vehicles)
        .where(and(eq(vehicles.id, d.vehicle.id), eq(vehicles.driverId, d.id)))
        .for('update');
      if (vehicle == null) return null;
      const [existing] = await tx
        .select({ id: vehicleDepartureSchedules.id })
        .from(vehicleDepartureSchedules)
        .where(eq(vehicleDepartureSchedules.vehicleId, d.vehicle.id))
        .limit(1);
      if (existing != null) return null;
      const dep = d.departure;
      const row = await insertDepartureSchedule(
        {
          vehicleId: d.vehicle.id,
          siteId: fleet.siteId,
          daysOfWeek: dep.daysOfWeek,
          departureTime: dep.departureTime,
          targetKind: 'energy',
          targetEnergyKwh: String(dep.targetEnergyKwh),
          targetSocPercent: null,
          priority: dep.priority,
          notes: 'Demo route',
        },
        tx,
      );
      const now = ctx.now.getTime();
      const occurrences = scheduleOccurrences(
        row,
        site.timezone,
        localDateInZone(now, site.timezone),
        DEPOT_DEMO_EXPANSION_DAYS,
      ).filter((o) => o.departureAtMs > now);
      await insertScheduleOccurrences(
        occurrences.map((o) => ({
          vehicleId: row.vehicleId,
          siteId: row.siteId,
          scheduleId: row.id,
          occurrenceDate: o.occurrenceDate,
          departureAt: new Date(o.departureAtMs),
          targetKind: row.targetKind,
          targetEnergyKwh: row.targetEnergyKwh,
          targetSocPercent: row.targetSocPercent,
          priority: row.priority,
          source: 'schedule' as const,
        })),
        tx,
      );
      return row;
    });
    if (schedule != null) created.push(schedule);
  }
  for (const s of created) {
    await writeAudit(
      { table: vehicleDepartureAuditLog, idColumn: 'vehicle_departure_id' },
      {
        entityId: s.id,
        entityIdSnapshot: s.id,
        action: 'schedule_created',
        ...auditActor(ctx),
        before: null,
        after: {
          entityKind: 'schedule',
          vehicleId: s.vehicleId,
          siteId: s.siteId,
          daysOfWeek: s.daysOfWeek,
          departureTime: s.departureTime,
          targetKind: s.targetKind,
          targetEnergyKwh: s.targetEnergyKwh,
          targetSocPercent: s.targetSocPercent,
          priority: s.priority,
          validFrom: s.validFrom,
          validTo: s.validTo,
          isActive: s.isActive,
          notes: s.notes,
          auditSiteId: s.siteId,
          auditSiteIds: [s.siteId],
        },
        notes: 'Demo data: weekly departure',
      },
    );
  }
  const retargeted = await retargetDepotSchedules(ctx);
  if (retargeted > 0 && created.length === 0) {
    await markSitePlanStale(fleet.siteId, 'demo_seed', undefined, { departureAwareOnly: true });
  }
  if (created.length > 0) {
    // A config change clears the sent allocations, so the next cycle sends again.
    await sql`
      UPDATE site_load_management SET strategy = ${fleet.loadStrategy},
        applied_allocations = NULL, applied_at = NULL, updated_at = now()
      WHERE site_id = ${fleet.siteId} AND strategy = 'equal_share'
    `;
    await markSitePlanStale(fleet.siteId, 'demo_seed', undefined, { departureAwareOnly: true });
  }
  return created.length;
}

/**
 * The fleet of Northgate Fleet Depot (`LAYOUT_DEMO.fleet`): the fleet, its
 * drivers with an RFID card, a saved simulated credit card and one vehicle
 * each (bus, semi truck or box truck in its color), the members and the
 * depot's stations as the fleet's stations, so the simulator charges them
 * with these drivers' cards and the layout draws their vehicles. Fixed ids,
 * ON CONFLICT DO NOTHING: a rerun adds nothing and an operator's change stays.
 */
async function seedDepotFleet(
  sql: postgres.Sql,
  stationIds: readonly string[],
  ctx: DemoFeatureContext,
): Promise<number> {
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
    const v = d.vehicle;
    await sql`
      INSERT INTO vehicles (id, driver_id, make, model, year, license_plate, color, body_type,
        battery_capacity_kwh, max_charge_power_kw)
      VALUES (${v.id}, ${d.id}, ${v.make}, ${v.model}, ${v.year}, ${v.licensePlate}, ${v.color},
        ${v.bodyType}, ${String(v.batteryCapacityKwh)}, ${String(v.maxChargePowerKw)})
      ON CONFLICT DO NOTHING
    `;
    await fillDepotVehicleBattery(sql, d, ctx);
    // The card names the vehicle, so a session on it binds to that vehicle.
    await sql`
      INSERT INTO driver_tokens (id, driver_id, id_token, token_type, is_active, vehicle_id)
      SELECT ${`dtk_demodepot${d.id.slice(-3)}`}, ${d.id}, ${d.idToken}, 'ISO14443', true,
        (SELECT id FROM vehicles WHERE id = ${v.id} AND driver_id = ${d.id})
      ON CONFLICT DO NOTHING
    `;
    await linkDepotCardToVehicle(sql, d, ctx);
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
/** The tech info of every demo security event: the marker a rerun checks. */
export const DEMO_SECURITY_EVENT_MARKER = 'demo-seed';
/** Stations per demo layout site that get the non-critical demo events. */
const DEMO_SECURITY_STATIONS_PER_SITE = 3;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The dashboard Security Events card demo: on each layout site two to three
 * stations report one event of each of high, medium, low and info, and one
 * station of the first site reports a critical tamper event (exactly one
 * critical station of the demo). Received inside the last 6 days, some inside
 * 24 hours, so the default 7-day range shows all of them. Raw inserts: the
 * security event table is station-reported log data with no audit table, as
 * in the base seed. Idempotent per station and type by the tech info marker.
 */
async function seedDemoSecurityEvents(
  sql: postgres.Sql,
  present: Map<string, string[]>,
  now: Date,
): Promise<number> {
  const events: Array<{ type: string; severity: string; ageMs: number }> = [
    { type: 'FailedToAuthenticateAtCsms', severity: 'high', ageMs: 4 * DAY_MS },
    { type: 'InvalidMessages', severity: 'medium', ageMs: 2 * DAY_MS },
    { type: 'ResetOrReboot', severity: 'low', ageMs: 30 * HOUR_MS },
    { type: 'FirmwareUpdated', severity: 'info', ageMs: 3 * HOUR_MS },
  ];
  const rows: Array<{ stationId: string; type: string; severity: string; at: Date }> = [];
  LAYOUT_DEMO.sites.forEach((site, siteIndex) => {
    const ids = [...(present.get(site.id) ?? [])].sort();
    const chosen = ids.slice(0, Math.min(DEMO_SECURITY_STATIONS_PER_SITE, ids.length));
    chosen.forEach((stationId, i) => {
      for (const e of events) {
        rows.push({
          stationId,
          type: e.type,
          severity: e.severity,
          at: new Date(now.getTime() - e.ageMs - i * HOUR_MS),
        });
      }
      if (siteIndex === 0 && i === 0) {
        rows.push({
          stationId,
          type: 'TamperDetectionActivated',
          severity: 'critical',
          at: new Date(now.getTime() - 5 * HOUR_MS),
        });
      }
    });
  });
  let created = 0;
  for (const row of rows) {
    const inserted = await sql`
      INSERT INTO security_events (station_id, type, severity, timestamp, tech_info, created_at)
      SELECT ${row.stationId}, ${row.type}, ${row.severity}, ${row.at}, ${DEMO_SECURITY_EVENT_MARKER}, ${row.at}
      WHERE NOT EXISTS (
        SELECT 1 FROM security_events
        WHERE station_id = ${row.stationId} AND type = ${row.type}
          AND tech_info = ${DEMO_SECURITY_EVENT_MARKER}
      )
      RETURNING id
    `;
    created += inserted.length;
  }
  return created;
}

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
  // The units of the stations with units (a master and its extenders), before
  // the layout save, so each such station holds its run of unit spots.
  let units = 0;
  for (const site of LAYOUT_DEMO.sites) {
    for (const station of site.stations) {
      if (station.units == null || !(present.get(site.id) ?? []).includes(station.id)) continue;
      units += await seedDemoStationUnitsOf(sql, station.id, station.units, ctx.actorUserId);
    }
  }
  // After every move, so each site's save sees only its own stations.
  for (const site of LAYOUT_DEMO.sites) {
    const seeded = present.get(site.id) ?? [];
    if (await seedLayout(site, seeded, ctx)) layouts++;
    else if (await regroupLayout(site, seeded, ctx)) layouts++;
    await seedPowerWiring(site, ctx);
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
  const fleetDrivers = await seedDepotFleet(sql, present.get(LAYOUT_DEMO.fleet.siteId) ?? [], ctx);
  const departureSchedules = await seedDepotDepartures(sql, ctx);
  const securityEvents = await seedDemoSecurityEvents(sql, present, ctx.now);
  return {
    stations,
    moved,
    layouts,
    units,
    terminals,
    faultInsights,
    messages,
    fleetDrivers,
    departureSchedules,
    securityEvents,
  };
}
