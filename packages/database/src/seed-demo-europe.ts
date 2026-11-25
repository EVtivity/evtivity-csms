// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A European demo site on the 230/400 V system: three-phase Type 2 at 22 and
// 11 kW, single-phase Type 2 at 7.4 kW, one CCS2 DC charger, each on its own
// circuit of one main distribution board under one distribution transformer,
// written through the load management tree writer. Two EVSEs report that they
// can switch the phase of a single-phase car (OCPP 2.x K01.FR.20).
//
// Rerun-safe: fixed ids, inserted only while missing (ON CONFLICT DO NOTHING,
// the tree writer's ifMissing), so an operator's change stays. The station
// simulators are seeded disabled like the free vend demo, so no E2E, chaos or
// OCTT run picks them; enable them in the simulator list for live sessions.

import type postgres from 'postgres';
import argon2 from 'argon2';
import {
  computeMaxContinuousKw,
  IEC_SINGLE_PHASE_SUPPLY,
  IEC_THREE_PHASE_SUPPLY,
  STATION_PASSWORD_HASH_OPTIONS,
} from '@evtivity/lib';
import type { CssEvseSupply } from '@evtivity/lib';
import { createCircuit, createPanel, createTransformer } from './lib/load-management-tree.js';
import type { LoadTreeWriteContext } from './lib/load-management-tree.js';
import { db } from './config.js';
import { ensureSiteElectricityRates } from './seed-electricity-rates.js';
import type { DemoFeatureContext } from './seed-demo-features.js';

/**
 * IEC 60038:2009 Table 1, the 230/400 V system: panels and circuits store
 * the phase to neutral voltage (230), as the load management formulas expect.
 */
const V230 = IEC_THREE_PHASE_SUPPLY.voltage;

/**
 * A Mode 3 charging point's continuous current (IEC 61851-1). The ABB Terra
 * AC wallbox IEC range is a typical product set: 7.4 kW single-phase at 32 A,
 * 11 kW three-phase at 16 A, 22 kW three-phase at 32 A
 * (https://new.abb.com/ev-charging/terra-ac-wallbox/terra-ac-wallbox-complying-with-iec-standards,
 * read 2026-11-24). Each sits on its own final circuit with its own RCD
 * (IEC 60364-7-722:2018, 722.311 and 722.531.3).
 */
export const EU_AC_RATINGS = {
  /** 32 A x 3 x 230 V = 22.08 kW, rated 22 kW. */
  ac22: { amps: 32, phases: 3, kw: 22 },
  /** 16 A x 3 x 230 V = 11.04 kW, rated 11 kW. */
  ac11: { amps: 16, phases: 3, kw: 11 },
  /** 32 A x 230 V = 7.36 kW, sold as 7.4 kW. */
  ac7: { amps: 32, phases: 1, kw: 7.36 },
} as const;

/**
 * The protective device of each final circuit: the next rating above the
 * charger's continuous current at 125 percent, the 80 percent continuous rule
 * the load management capacity applies (`computeMaxContinuousKw`), so the
 * circuit carries the charger. EN 60898-1 rated currents (16, 20, 25, 32, 40,
 * 50, 63 A); Schneider Electric's Electrical Installation Guide gives a 40 A
 * device for a 32 A charger
 * (https://www.electrical-installation.org/enwiki/EV_charging_-_electrical_installation_design,
 * read 2026-11-24).
 */
const AC_BREAKER_AMPS = { 32: 40, 16: 20 } as const;

/**
 * The DC charger: 150 kW output, CCS2. No datasheet input, so its input is
 * derived like the base seed's DC models without one: 0.96 efficiency and
 * 0.96 power factor, 150 / 0.96 / 0.96 = 162.8 kVA, 235 A at 400 V; at
 * 125 percent 294 A, so a 315 A device (IEC 60059 R10 preferred rating).
 */
export const EU_DC = {
  kw: 150,
  inputKva: 162.8,
  breakerAmps: 315,
} as const;

/**
 * The main distribution board: 81 kVA of AC chargers and 162.8 kVA of DC,
 * 243.8 kVA, 352 A at 400 V; at 125 percent 440 A, so a 500 A board (IEC
 * 60059 R10), 70 percent of its rating, under the 80 percent limit.
 */
const MAIN_BOARD_AMPS = 500;

/**
 * The distribution transformer: the smallest rated power of Regulation (EU)
 * No 548/2014, Annex I, Table I.1 (25, 50, 100, 160, 250, 315, 400, 630 kVA,
 * ...) of at least the connected 243.8 kVA, compared without a power factor
 * like the base seed (`seed-site-power-plan.ts`).
 */
export const EU_TRANSFORMER_KVA = 250;

interface EuropeStation {
  id: string;
  stationId: string;
  ocppProtocol: 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1';
  model: string;
  connectorType: 'Type2' | 'CCS2';
  kw: number;
  amps: number;
  supply: CssEvseSupply;
  circuit: { id: string; name: string; breakerAmps: number; phaseConnections: string | null };
  /** The EVSE reports SmartChargingCtrlr.ACPhaseSwitchingSupported true (OCPP 2.x). */
  phaseSwitching: boolean;
}

function acStation(
  n: number,
  protocol: EuropeStation['ocppProtocol'],
  model: string,
  rating: (typeof EU_AC_RATINGS)[keyof typeof EU_AC_RATINGS],
  phaseConnections: string | null,
  phaseSwitching = false,
): EuropeStation {
  const nn = String(n).padStart(2, '0');
  return {
    id: `sta_demoeu0000${nn}`,
    stationId: `CS-40${nn}`,
    ocppProtocol: protocol,
    model,
    connectorType: 'Type2',
    kw: rating.kw,
    amps: rating.amps,
    supply: rating.phases === 3 ? IEC_THREE_PHASE_SUPPLY : IEC_SINGLE_PHASE_SUPPLY,
    circuit: {
      id: `cir_demoeu0000${nn}`,
      name: `CS-40${nn} ${String(rating.kw)} kW`,
      breakerAmps: AC_BREAKER_AMPS[rating.amps],
      phaseConnections,
    },
    phaseSwitching,
  };
}

export const EUROPE_DEMO = {
  siteId: 'sit_demoeurope01',
  siteName: 'Laadplein Papendorp',
  transformerId: 'tfm_demoeurope01',
  panelId: 'pnl_demoeurope01',
  stations: [
    acStation(1, 'ocpp2.1', 'AC Wallbox 22', EU_AC_RATINGS.ac22, null, true),
    acStation(2, 'ocpp2.1', 'AC Wallbox 22', EU_AC_RATINGS.ac22, null),
    acStation(3, 'ocpp2.0.1', 'AC Wallbox 11', EU_AC_RATINGS.ac11, null, true),
    acStation(4, 'ocpp2.0.1', 'AC Wallbox 11', EU_AC_RATINGS.ac11, null),
    // The two single-phase chargers on different phases, so the board stays balanced.
    acStation(5, 'ocpp1.6', 'AC Wallbox 7.4 (1.6)', EU_AC_RATINGS.ac7, 'L1'),
    acStation(6, 'ocpp1.6', 'AC Wallbox 7.4 (1.6)', EU_AC_RATINGS.ac7, 'L2'),
    {
      id: 'sta_demoeu000007',
      stationId: 'CS-4007',
      ocppProtocol: 'ocpp2.1',
      model: 'DC Charger 150',
      connectorType: 'CCS2',
      kw: EU_DC.kw,
      amps: 375,
      supply: IEC_THREE_PHASE_SUPPLY,
      circuit: {
        id: 'cir_demoeu000007',
        name: 'CS-4007 DC 150 kW',
        breakerAmps: EU_DC.breakerAmps,
        phaseConnections: null,
      },
      phaseSwitching: false,
    },
  ] satisfies readonly EuropeStation[],
} as const;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The continuous capacity of a circuit on the three-phase board. */
export function europeCircuitKw(station: EuropeStation): number {
  const phases = station.circuit.phaseConnections == null ? 3 : 1;
  return round2(computeMaxContinuousKw(station.circuit.breakerAmps, V230, phases));
}

/** The continuous capacity of the main distribution board. */
export function europeBoardKw(): number {
  return round2(computeMaxContinuousKw(MAIN_BOARD_AMPS, V230, 3));
}

/** Seeds the European demo site; returns the stations it inserted. */
export async function seedEuropeDemo(
  sql: postgres.Sql,
  ctx: DemoFeatureContext,
  vendorId: string | null,
): Promise<number> {
  const demo = EUROPE_DEMO;
  const at = ctx.now;
  await sql`
    INSERT INTO sites (id, name, address, city, state, postal_code, country, latitude, longitude,
      timezone, hours_of_operation, created_at, updated_at)
    VALUES (${demo.siteId}, ${demo.siteName}, 'Laadplein 1', 'Utrecht', NULL, '3528', 'NL',
      '52.077500', '5.087000', 'Europe/Amsterdam', '24/7', ${at}, ${at})
    ON CONFLICT (id) DO NOTHING
  `;
  await ensureSiteElectricityRates(db, demo.siteId);
  await sql`
    INSERT INTO site_load_management (site_id, strategy, is_enabled)
    VALUES (${demo.siteId}, 'equal_share', false)
    ON CONFLICT (site_id) DO NOTHING
  `;

  const treeCtx: LoadTreeWriteContext = {
    ...(ctx.actorUserId != null
      ? { actor: 'operator' as const, actorUserId: ctx.actorUserId }
      : { actor: 'system' as const, actorLabel: 'seed' }),
    notes: 'European demo site: power equipment on the 230/400 V system',
  };
  await createTransformer(
    {
      id: demo.transformerId,
      siteId: demo.siteId,
      kind: 'service',
      name: 'Distribution Transformer',
      ratedKva: String(EU_TRANSFORMER_KVA),
      phases: 3,
      secondaryVoltageV: V230,
      sortOrder: 0,
    },
    treeCtx,
    { ifMissing: true },
  );
  await createPanel(
    {
      id: demo.panelId,
      siteId: demo.siteId,
      parentPanelId: null,
      name: 'Main Distribution Board',
      breakerRatingAmps: MAIN_BOARD_AMPS,
      voltageV: V230,
      phases: 3,
      maxContinuousKw: String(europeBoardKw()),
      safetyMarginKw: '0',
      transformerId: demo.transformerId,
      sortOrder: 0,
    },
    treeCtx,
    { ifMissing: true },
  );

  const passwordHash = await argon2.hash('password', { ...STATION_PASSWORD_HASH_OPTIONS });
  const ocppWsUrl = process.env['SEED_CSS_TARGET_URL'] ?? 'ws://ocpp:7103';
  let inserted = 0;
  for (const [i, station] of demo.stations.entries()) {
    const nn = station.id.slice(-2);
    await createCircuit(
      demo.siteId,
      {
        id: station.circuit.id,
        panelId: demo.panelId,
        name: station.circuit.name,
        breakerRatingAmps: station.circuit.breakerAmps,
        maxContinuousKw: String(europeCircuitKw(station)),
        phaseConnections: station.circuit.phaseConnections,
        sortOrder: i,
      },
      treeCtx,
      { ifMissing: true },
    );
    const rows = await sql`
      INSERT INTO charging_stations (id, station_id, site_id, vendor_id, model, serial_number,
        firmware_version, onboarding_status, availability, is_online, security_profile,
        ocpp_protocol, basic_auth_password_hash, is_simulator, circuit_id, created_at, updated_at)
      VALUES (${station.id}, ${station.stationId}, ${demo.siteId}, ${vendorId}, ${station.model},
        ${`SN-EU-00${nn}`}, '2.4.1', 'accepted', 'available', false, 1, ${station.ocppProtocol},
        ${passwordHash}, true, ${station.circuit.id}, ${at}, ${at})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    // Another station holding the station id (an operator's own CS-4001) keeps it.
    const [own] = await sql`SELECT 1 FROM charging_stations WHERE id = ${station.id}`;
    if (own == null) {
      console.log(`  European demo station ${station.stationId} skipped: the id is taken.`);
      continue;
    }
    inserted += rows.length;
    const evseDbId = `evs_demoeu0000${nn}`;
    const cssStationId = `css_demoeu0000${nn}`;
    await sql`
      INSERT INTO evses (id, station_id, evse_id) VALUES (${evseDbId}, ${station.id}, 1)
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO connectors (id, evse_id, connector_id, status, connector_type, max_power_kw,
        max_current_amps)
      VALUES (${`con_demoeu0000${nn}`}, ${evseDbId}, 1, 'unavailable', ${station.connectorType},
        ${String(station.kw)}, ${station.amps})
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO css_stations (id, station_id, target_url, password, source_type, enabled)
      VALUES (${cssStationId}, ${station.stationId}, ${ocppWsUrl}, 'password', 'seed', false)
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO css_evses (id, css_station_id, evse_id, connector_id, connector_type, max_power_w,
        phases, voltage)
      VALUES (${`cev_demoeu0000${nn}`}, ${cssStationId}, 1, 1,
        ${station.connectorType === 'CCS2' ? 'dc_ccs2' : 'ac_type2'},
        ${Math.round(station.kw * 1000)}, ${station.supply.phases}, ${station.supply.voltage})
      ON CONFLICT DO NOTHING
    `;
    if (station.ocppProtocol === 'ocpp1.6') continue;
    // What the station reports in its device model: the simulator's stored value, and the
    // configuration the CSMS stored from its report, so load management knows it before a boot.
    if (station.phaseSwitching) {
      await sql`
        INSERT INTO css_config_variables (id, css_station_id, key, value, readonly)
        VALUES (${`ccv_demoeu0000${nn}`}, ${cssStationId},
          'SmartChargingCtrlr.ACPhaseSwitchingSupported', 'true', true)
        ON CONFLICT DO NOTHING
      `;
      await sql`
        INSERT INTO station_configurations (station_id, component, evse_id, variable, value,
          attribute_type, source)
        VALUES (${station.id}, 'SmartChargingCtrlr', 1, 'ACPhaseSwitchingSupported', 'true',
          'Actual', 'NotifyReport')
        ON CONFLICT DO NOTHING
      `;
    }
    if (station.connectorType === 'Type2') {
      await sql`
        INSERT INTO station_configurations (station_id, component, evse_id, variable, value,
          attribute_type, source)
        VALUES (${station.id}, 'EVSE', 1, 'SupplyPhases', ${String(station.supply.phases)},
          'Actual', 'NotifyReport')
        ON CONFLICT DO NOTHING
      `;
    }
  }
  return inserted;
}
