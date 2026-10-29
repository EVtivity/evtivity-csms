// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import argon2 from 'argon2';
import {
  STATION_PASSWORD_HASH_OPTIONS,
  FREE_VEND_OCPP_16_KEYS,
  FREE_VEND_OCPP_21_VARIABLES,
  chargedCostBreakdown,
  freeVendRestoreKeys16,
  freeVendRestoreVariables21,
  isOcpp21,
  normalizeIccid,
} from '@evtivity/lib';
import type { ConfigTemplateVariable, TaxBasis } from '@evtivity/lib';
import { db } from './config.js';
import { writeAudit } from './lib/audit.js';
import { paymentTerminalAuditLog, simAuditLog } from './schema/audit.js';
import { createTerminal, recordTerminalDeviceStatus } from './lib/payment-terminals.js';
import { attachSimToPaymentTerminal } from './lib/sim-inventory.js';
import type { StoredSimStatus } from './lib/sim-inventory.js';
import { ensureSiteElectricityRates } from './seed-electricity-rates.js';
import { sessionSiteIdSql } from './lib/session-site.js';
import { loadDemoStationPlace } from './seed-fleet-billing.js';

// Demo data of four features that are off or empty in a fresh demo: Plug and
// Charge (ISO 15118 contracts and the sessions their eMAID tokens started),
// free vend (a site that charges without identification or payment), SIM
// providers (SIM inventory, confirmed attachments and the SIM history a
// Refresh stores) and payment terminals (two simulated card readers with
// their payments). The dashboard Plug & Charge and Free Vend charts, the
// driver contracts card, the site Free Vend tab, the SIMs pages and the
// station Connectivity timeline show data without a station, a model or a
// provider call. Every row has a fixed id or a natural key and is inserted
// ON CONFLICT DO NOTHING (P7); rows without one (attachments, coverage,
// audit) are written only with the first seed of their parent, so a rerun
// adds nothing. Plug and Charge and the SIM rows go on offline SP3 demo
// stations (simulators disabled, so no E2E or chaos run picks them, and a
// simulator report never meets the seeded configuration); the free vend site
// gets its own two stations with disabled simulators.

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** How far back the demo sessions of Plug and Charge and free vend go. */
export const DEMO_FEATURE_DAYS = 30;

/** The OCPP 2.1 SP3 demo stations (indices 976 and 977 of the demo seed) of Plug and Charge. */
export const PNC_DEMO_STATION_IDS = ['CS-0979', 'CS-0980'] as const;

/** The SP3 demo stations (indices 980 to 983) holding a confirmed demo SIM. */
export const SIM_DEMO_STATION_IDS = ['CS-0983', 'CS-0984', 'CS-0985', 'CS-0986'] as const;

export const PNC_DEMO = {
  contractCount: 4,
  /** The last contract is revoked: its token is inactive, its sessions stay. */
  revokedIndex: 3,
  sessionCount: 36,
} as const;

export const FREE_VEND_DEMO = {
  siteId: 'sit_demofreevnd1',
  siteName: 'Riverside Community Center',
  template21Id: 'ctm_demofreevnd1',
  template16Id: 'ctm_demofreevnd2',
  restore21Id: 'ctm_demofreevnd3',
  restore16Id: 'ctm_demofreevnd4',
  sessionCount: 30,
  stations: [
    {
      id: 'sta_demofreevnd1',
      stationId: 'CS-2003',
      ocppProtocol: 'ocpp2.1',
      model: 'BusinessLine',
      serialNumber: 'SN-FV-0001',
      evseDbId: 'evs_demofreevnd1',
      connectorDbId: 'con_demofreevnd1',
      cssStationId: 'css_demofreevnd1',
      cssEvseId: 'cev_demofreevnd1',
    },
    {
      id: 'sta_demofreevnd2',
      stationId: 'CS-2004',
      ocppProtocol: 'ocpp1.6',
      model: 'AV-30 (1.6)',
      serialNumber: 'SN-FV-0002',
      evseDbId: 'evs_demofreevnd2',
      connectorDbId: 'con_demofreevnd2',
      cssStationId: 'css_demofreevnd2',
      cssEvseId: 'cev_demofreevnd2',
    },
  ],
} as const;

export const SIM_DEMO = {
  /** Data sessions per attached SIM per day, over `sessionDays`. */
  sessionsPerDay: 3,
  sessionDays: 14,
  /** An inventory SIM never attached, and one an operator deactivated. */
  spare: { id: 'sim_demosim00091', iccid: '89014103000000000991', imsi: '310410000000991' },
  inactive: { id: 'sim_demosim00092', iccid: '89014103000000000992', imsi: '310410000000992' },
} as const;

/** A small deterministic generator, so a rerun plans the same rows. */
export function demoRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function between(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * The transaction id a station sends: a UUID on OCPP 2.x, an integer on 1.6.
 * `group` keeps the demo groups apart (one hex digit, never a seeded value).
 */
export function demoTransactionId(
  group: 'pnc' | 'freeVend' | 'terminal',
  n: number,
  ocpp16: boolean,
): string {
  const base = { pnc: 800_000, freeVend: 900_000, terminal: 700_000 }[group];
  const digit = { pnc: 'd', freeVend: 'f', terminal: 'a' }[group];
  if (ocpp16) return String(base + n);
  return `${digit}e300000-0000-4000-8000-${pad(n, 12)}`;
}

// ---------- Plug and Charge ----------

export interface PncContractPlan {
  tokenId: string;
  emaid: string;
  pcid: string;
  revoked: boolean;
  /** When the contract was made; a revoked one is revoked `revokedDaysAgo` before the seed. */
  createdAt: Date;
  revokedAt: Date | null;
}

export interface DemoSessionPlan {
  id: string;
  transactionNumber: number;
  stationIndex: number;
  startedAt: Date;
  endedAt: Date;
  energyWh: number;
  costCents: number;
}

/** The demo contracts: eMAID tokens in the local contract format (CC, PPP, C, 8 characters). */
export function pncContractPlan(now: Date): PncContractPlan[] {
  return Array.from({ length: PNC_DEMO.contractCount }, (_, i) => {
    const revoked = i === PNC_DEMO.revokedIndex;
    return {
      tokenId: `dtk_demopnc${pad(i + 1, 5)}`,
      emaid: `USEVTCDEMO${pad(i + 1, 4)}`,
      pcid: `WMIEVTDEMOPCID${pad(i + 1, 3)}`,
      revoked,
      createdAt: new Date(now.getTime() - (45 + i * 3) * DAY_MS),
      revokedAt: revoked ? new Date(now.getTime() - 5 * DAY_MS) : null,
    };
  });
}

/**
 * The Plug and Charge sessions over the last DEMO_FEATURE_DAYS days: DC
 * sessions of 15 to 60 kWh priced at 25 to 45 cents per kWh. A revoked
 * contract has no session after its revocation.
 */
export function pncSessionPlan(
  now: Date,
  stationCount: number,
  contracts: PncContractPlan[],
): Array<DemoSessionPlan & { contractIndex: number }> {
  const rand = demoRandom(15118);
  const plans: Array<DemoSessionPlan & { contractIndex: number }> = [];
  for (let i = 0; i < PNC_DEMO.sessionCount; i++) {
    const dayAgo = 1 + (i % DEMO_FEATURE_DAYS);
    const day = new Date(now.getTime() - dayAgo * DAY_MS);
    day.setUTCHours(0, 0, 0, 0);
    const startedAt = new Date(
      day.getTime() + between(rand, 7, 21) * HOUR_MS + between(rand, 0, 59) * MINUTE_MS,
    );
    const endedAt = new Date(startedAt.getTime() + between(rand, 20, 75) * MINUTE_MS);
    const energyWh = between(rand, 15_000, 60_000);
    const costCents = Math.round((energyWh / 1000) * between(rand, 25, 45));
    let contractIndex = i % contracts.length;
    const contract = contracts[contractIndex];
    if (contract?.revokedAt != null && endedAt.getTime() > contract.revokedAt.getTime()) {
      contractIndex = (contractIndex + 1) % contracts.length;
    }
    plans.push({
      id: `ses_demopnc${pad(i + 1, 5)}`,
      transactionNumber: i + 1,
      stationIndex: i % Math.max(stationCount, 1),
      startedAt,
      endedAt,
      energyWh,
      costCents,
      contractIndex,
    });
  }
  return plans;
}

/** The ISO 15118 configuration a Plug and Charge station reports (ISO15118Ctrlr, OCPP 2.1). */
export const PNC_STATION_CONFIGURATION: ReadonlyArray<{ variable: string; value: string }> = [
  { variable: 'PnCEnabled', value: 'true' },
  { variable: 'V2GCertificateInstallationEnabled', value: 'true' },
  { variable: 'ContractCertificateInstallationEnabled', value: 'true' },
  { variable: 'CentralContractValidationAllowed', value: 'true' },
  { variable: 'ContractValidationOffline', value: 'false' },
  {
    variable: 'ProtocolSupported',
    value: 'urn:iso:15118:2:2013:MsgDef,urn:iso:std:iso:15118:-20:DC',
  },
  { variable: 'CountryName', value: 'US' },
  { variable: 'OrganizationName', value: 'EVtivity' },
];

interface DemoStation {
  id: string;
  stationId: string;
  siteId: string | null;
  ocppProtocol: string;
  iccid: string | null;
  imsi: string | null;
  evseId: string | null;
}

async function loadStations(
  sql: postgres.Sql,
  stationIds: readonly string[],
): Promise<DemoStation[]> {
  const rows = await sql<
    Array<{
      id: string;
      station_id: string;
      site_id: string | null;
      ocpp_protocol: string;
      iccid: string | null;
      imsi: string | null;
      evse_id: string | null;
    }>
  >`
    SELECT cs.id, cs.station_id, cs.site_id, cs.ocpp_protocol, cs.iccid, cs.imsi,
      (SELECT e.id FROM evses e WHERE e.station_id = cs.id ORDER BY e.evse_id LIMIT 1) AS evse_id
    FROM charging_stations cs
    WHERE cs.station_id IN ${sql([...stationIds])}
    ORDER BY cs.station_id
  `;
  return rows.map((r) => ({
    id: r.id,
    stationId: r.station_id,
    siteId: r.site_id,
    ocppProtocol: r.ocpp_protocol,
    iccid: r.iccid,
    imsi: r.imsi,
    evseId: r.evse_id,
  }));
}

export interface DemoFeatureContext {
  now: Date;
  currency: string;
  taxBasis: TaxBasis;
  /** The admin who confirmed the SIMs and deactivated the inactive one; null when none. */
  actorUserId: string | null;
}

/**
 * Plug and Charge: the ISO 15118 configuration of the PnC stations, four
 * contracts (one revoked) of four demo drivers with their eMAID tokens, and
 * the sessions those tokens started, billed to the driver's card on file.
 * Returns the sessions inserted.
 */
export async function seedPncDemo(
  sql: postgres.Sql,
  ctx: DemoFeatureContext,
  driverIds: string[],
): Promise<number> {
  const stations = (await loadStations(sql, PNC_DEMO_STATION_IDS)).filter((s) =>
    isOcpp21(s.ocppProtocol),
  );
  if (stations.length === 0 || driverIds.length === 0) {
    console.log('  Plug and Charge demo skipped: no OCPP 2.1 demo station or no demo driver.');
    return 0;
  }

  for (const station of stations) {
    for (const entry of PNC_STATION_CONFIGURATION) {
      await sql`
        INSERT INTO station_configurations (station_id, component, variable, value, attribute_type, source)
        VALUES (${station.id}, 'ISO15118Ctrlr', ${entry.variable}, ${entry.value}, 'Actual', 'NotifyReport')
        ON CONFLICT DO NOTHING
      `;
    }
  }

  const contracts = pncContractPlan(ctx.now);
  for (const [i, contract] of contracts.entries()) {
    const driverId = driverIds[i % driverIds.length] ?? null;
    await sql`
      INSERT INTO driver_tokens (id, driver_id, id_token, token_type, is_active, deactivated_by,
        created_at, updated_at)
      VALUES (${contract.tokenId}, ${driverId}, ${contract.emaid}, 'eMAID', ${!contract.revoked},
        ${contract.revoked ? 'operator' : null}, ${contract.createdAt},
        ${contract.revokedAt ?? contract.createdAt})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO pnc_contracts (driver_token_id, pcid, status, revoked_at, created_at, updated_at)
      VALUES (${contract.tokenId}, ${contract.pcid}, ${contract.revoked ? 'revoked' : 'active'},
        ${contract.revokedAt}, ${contract.createdAt}, ${contract.revokedAt ?? contract.createdAt})
      ON CONFLICT (driver_token_id) DO NOTHING
    `;
  }
  // The driver of each token as stored, so a rerun keeps the first binding.
  const tokenDrivers = new Map(
    (
      await sql<Array<{ id: string; driver_id: string | null }>>`
        SELECT id, driver_id FROM driver_tokens WHERE id IN ${sql(contracts.map((c) => c.tokenId))}
      `
    ).map((r) => [r.id, r.driver_id]),
  );

  const places = new Map(
    await Promise.all(
      stations.map(async (s) => [s.id, await loadDemoStationPlace(sql, s.id)] as const),
    ),
  );
  let inserted = 0;
  for (const plan of pncSessionPlan(ctx.now, stations.length, contracts)) {
    const station = stations[plan.stationIndex];
    const contract = contracts[plan.contractIndex];
    if (station == null || contract == null) continue;
    const driverId = tokenDrivers.get(contract.tokenId) ?? null;
    const breakdown = chargedCostBreakdown(plan.costCents, 0, ctx.taxBasis);
    const electricityCostCents =
      places.get(station.id)?.electricityCostOf(plan.endedAt, plan.energyWh) ?? null;
    const rows = await sql`
      INSERT INTO charging_sessions (id, station_id, site_id, evse_id, driver_id, token_id,
        transaction_id, status, started_at, ended_at, meter_start, meter_stop,
        energy_delivered_wh, final_cost_cents, net_cents, tax_cents, cost_breakdown, currency,
        stopped_reason, electricity_cost_cents, created_at, updated_at)
      VALUES (${plan.id}, ${station.id}, ${sessionSiteIdSql(sql, station.id)}, ${station.evseId}, ${driverId},
        ${contract.tokenId}, ${demoTransactionId('pnc', plan.transactionNumber, false)}, 'completed',
        ${plan.startedAt}, ${plan.endedAt}, 0, ${plan.energyWh}, ${String(plan.energyWh)},
        ${plan.costCents}, ${breakdown.netCents}, ${breakdown.taxCents},
        ${sql.json(breakdown as unknown as postgres.JSONValue)}, ${ctx.currency}, 'EVDisconnected',
        ${electricityCostCents}, ${plan.startedAt}, ${plan.endedAt})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (rows.length === 0) continue;
    inserted++;
    // Charged to the driver's saved card, as the session end projection captures it.
    await sql`
      INSERT INTO payment_records (session_id, driver_id, provider, provider_payment_id,
        provider_customer_id, payment_source, currency, pre_auth_amount_cents,
        captured_amount_cents, refunded_amount_cents, status, created_at, updated_at)
      VALUES (${plan.id}, ${driverId}, 'simulated', ${`pi_sim_demopnc${pad(plan.transactionNumber, 5)}`},
        ${`cus_sim_demopnc${pad(plan.contractIndex + 1, 3)}`}, 'card_on_file', ${ctx.currency},
        5000, ${plan.costCents}, 0, 'captured', ${plan.startedAt}, ${plan.endedAt})
    `;
  }
  return inserted;
}

// ---------- Free vend ----------

/** The free vend sessions: AC sessions of 3 to 25 kWh, zero cost, no driver and no token. */
export function freeVendSessionPlan(now: Date, stationCount: number): DemoSessionPlan[] {
  const rand = demoRandom(4242);
  return Array.from({ length: FREE_VEND_DEMO.sessionCount }, (_, i) => {
    const dayAgo = 1 + (i % DEMO_FEATURE_DAYS);
    const day = new Date(now.getTime() - dayAgo * DAY_MS);
    day.setUTCHours(0, 0, 0, 0);
    const startedAt = new Date(
      day.getTime() + between(rand, 12, 23) * HOUR_MS + between(rand, 0, 59) * MINUTE_MS,
    );
    const endedAt = new Date(startedAt.getTime() + between(rand, 30, 180) * MINUTE_MS);
    return {
      id: `ses_demofv${pad(i + 1, 6)}`,
      transactionNumber: i + 1,
      stationIndex: i % Math.max(stationCount, 1),
      startedAt,
      endedAt,
      energyWh: between(rand, 3_000, 25_000),
      costCents: 0,
    };
  });
}

interface AutoTemplate {
  id: string;
  name: string;
  description: string;
  ocppVersion: '2.1' | '1.6';
  variables: ConfigTemplateVariable[];
}

/** The four templates free vend creates for a site (free vend.service.ts names and values). */
export function freeVendTemplates(siteName: string): AutoTemplate[] {
  return [
    {
      id: FREE_VEND_DEMO.template21Id,
      name: `Free Vend - ${siteName} (OCPP 2.1)`,
      description: `Auto generated. Free Vend configuration for ${siteName} (OCPP 2.1).`,
      ocppVersion: '2.1',
      variables: FREE_VEND_OCPP_21_VARIABLES,
    },
    {
      id: FREE_VEND_DEMO.template16Id,
      name: `Free Vend - ${siteName} (OCPP 1.6)`,
      description: `Auto generated. Free Vend configuration for ${siteName} (OCPP 1.6). OCPP 1.6 has no standard free-vend mechanism; these keys work with most stations but some vendors require vendor-specific keys (edit and re-push as needed).`,
      ocppVersion: '1.6',
      variables: FREE_VEND_OCPP_16_KEYS.map((k) => ({
        component: k.key,
        variable: k.key,
        value: k.value,
      })),
    },
    {
      id: FREE_VEND_DEMO.restore21Id,
      name: `Free Vend Off - ${siteName} (OCPP 2.1)`,
      description: `Auto generated. Restores authorization at ${siteName} when free vend is turned off (OCPP 2.1): the values the stations reported when free vend was turned on.`,
      ocppVersion: '2.1',
      variables: freeVendRestoreVariables21(null),
    },
    {
      id: FREE_VEND_DEMO.restore16Id,
      name: `Free Vend Off - ${siteName} (OCPP 1.6)`,
      description: `Auto generated. Restores authorization at ${siteName} when free vend is turned off (OCPP 1.6): the values the stations reported when free vend was turned on.`,
      ocppVersion: '1.6',
      variables: freeVendRestoreKeys16({}),
    },
  ];
}

/**
 * Free vend: the site Riverside Community Center with free vend on and its
 * four templates (as POST /v1/sites/:id/free-vend leaves them; no push, the
 * stations are offline), an OCPP 2.1 and an OCPP 1.6 station whose
 * simulators are seeded disabled (turn them on in the simulator list to see
 * live free vend sessions), and their past sessions: free_vend, no driver,
 * zero cost, the site's electricity cost. Returns the sessions inserted.
 */
export async function seedFreeVendDemo(
  sql: postgres.Sql,
  ctx: DemoFeatureContext,
  vendorId: string | null,
): Promise<number> {
  const demo = FREE_VEND_DEMO;
  const enabledAt = new Date(ctx.now.getTime() - (DEMO_FEATURE_DAYS + 5) * DAY_MS);
  await sql`
    INSERT INTO sites (id, name, address, city, state, postal_code, country, latitude, longitude,
      timezone, hours_of_operation, free_vend_enabled, created_at, updated_at)
    VALUES (${demo.siteId}, ${demo.siteName}, '75 Riverfront Plaza', 'Albany', 'NY', '12207', 'US',
      '42.652600', '-73.749500', 'America/New_York', '24/7', true, ${enabledAt}, ${enabledAt})
    ON CONFLICT (id) DO NOTHING
  `;
  for (const template of freeVendTemplates(demo.siteName)) {
    await sql`
      INSERT INTO config_templates (id, name, description, variables, ocpp_version, target_filter,
        created_at, updated_at)
      VALUES (${template.id}, ${template.name}, ${template.description},
        ${sql.json(template.variables as unknown as postgres.JSONValue)}, ${template.ocppVersion},
        ${sql.json({ siteId: demo.siteId })}, ${enabledAt}, ${enabledAt})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  // Links only templates that exist and only while the site has none, so an
  // operator's later switch (which keeps or replaces them) is never undone.
  await sql`
    UPDATE sites SET
      free_vend_template_id_21 = ${demo.template21Id},
      free_vend_template_id_16 = ${demo.template16Id},
      free_vend_restore_template_id_21 = ${demo.restore21Id},
      free_vend_restore_template_id_16 = ${demo.restore16Id}
    WHERE id = ${demo.siteId} AND free_vend_template_id_21 IS NULL
      AND free_vend_template_id_16 IS NULL
  `;
  await ensureSiteElectricityRates(db, demo.siteId);

  const passwordHash = await argon2.hash('password', { ...STATION_PASSWORD_HASH_OPTIONS });
  const ocppWsUrl = process.env['SEED_CSS_TARGET_URL'] ?? 'ws://ocpp:7103';
  const stations: Array<(typeof demo.stations)[number]> = [];
  for (const station of demo.stations) {
    const ocpp16 = station.ocppProtocol === 'ocpp1.6';
    await sql`
      INSERT INTO charging_stations (id, station_id, site_id, vendor_id, model, serial_number,
        firmware_version, onboarding_status, availability, is_online, security_profile,
        ocpp_protocol, basic_auth_password_hash, is_simulator, created_at, updated_at)
      VALUES (${station.id}, ${station.stationId}, ${demo.siteId}, ${vendorId}, ${station.model},
        ${station.serialNumber}, '2.4.1', 'accepted', 'available', false, 1,
        ${station.ocppProtocol}, ${passwordHash}, true, ${enabledAt}, ${enabledAt})
      ON CONFLICT DO NOTHING
    `;
    // Another station holding the station id (an operator's own CS-2003) keeps it.
    const [own] = await sql`SELECT 1 FROM charging_stations WHERE id = ${station.id}`;
    if (own == null) {
      console.log(`  Free vend demo station ${station.stationId} skipped: the id is taken.`);
      continue;
    }
    stations.push(station);
    await sql`
      INSERT INTO evses (id, station_id, evse_id) VALUES (${station.evseDbId}, ${station.id}, 1)
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO connectors (id, evse_id, connector_id, status, connector_type, max_power_kw,
        max_current_amps)
      VALUES (${station.connectorDbId}, ${station.evseDbId}, 1, 'unavailable', 'Type1', '22', 32)
      ON CONFLICT DO NOTHING
    `;
    // Disabled like the SP3 simulators: no E2E or chaos run picks a free vend station.
    await sql`
      INSERT INTO css_stations (id, station_id, target_url, password, source_type, enabled)
      VALUES (${station.cssStationId}, ${station.stationId}, ${ocppWsUrl}, 'password', 'seed', false)
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO css_evses (id, css_station_id, evse_id, connector_id, connector_type, max_power_w,
        phases, voltage)
      VALUES (${station.cssEvseId}, ${station.cssStationId}, 1, 1, 'ac_type1', 22000,
        ${ocpp16 ? 1 : 3}, ${ocpp16 ? 240 : 230})
      ON CONFLICT DO NOTHING
    `;
  }

  const first = stations[0];
  if (first == null) return 0;
  const place = await loadDemoStationPlace(sql, first.id);
  const breakdown = chargedCostBreakdown(0, 0, ctx.taxBasis);
  let inserted = 0;
  for (const plan of freeVendSessionPlan(ctx.now, stations.length)) {
    const station = stations[plan.stationIndex] ?? first;
    const rows = await sql`
      INSERT INTO charging_sessions (id, station_id, site_id, evse_id, driver_id, token_id,
        transaction_id, status, started_at, ended_at, meter_start, meter_stop,
        energy_delivered_wh, current_cost_cents, final_cost_cents, net_cents, tax_cents,
        cost_breakdown, currency, stopped_reason, free_vend, electricity_cost_cents, created_at,
        updated_at)
      VALUES (${plan.id}, ${station.id}, ${sessionSiteIdSql(sql, station.id)}, ${station.evseDbId}, NULL, NULL,
        ${demoTransactionId('freeVend', plan.transactionNumber, station.ocppProtocol === 'ocpp1.6')},
        'completed', ${plan.startedAt}, ${plan.endedAt}, 0, ${plan.energyWh},
        ${String(plan.energyWh)}, 0, 0, 0, 0,
        ${sql.json(breakdown as unknown as postgres.JSONValue)}, ${ctx.currency}, 'EVDisconnected',
        true, ${place.electricityCostOf(plan.endedAt, plan.energyWh)}, ${plan.startedAt},
        ${plan.endedAt})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    inserted += rows.length;
  }
  return inserted;
}

// ---------- SIM providers ----------

const SIM_NETWORKS = ['T-Mobile', 'AT&T', 'Verizon'] as const;

export interface SimSessionPlan {
  providerSessionId: string;
  startedAt: Date;
  endedAt: Date;
  bytes: number;
  networkName: string;
  radioAccessTechnology: string;
  cellId: string;
}

/**
 * The closed data sessions of demo SIM `simNumber` (1-based) over the last
 * SIM_DEMO.sessionDays days, oldest first, none inside the provider's
 * reporting delay (the last 6 hours). Ids are unique per SIM and increase
 * with time, like Hologram record ids.
 */
export function simSessionPlan(now: Date, simNumber: number): SimSessionPlan[] {
  const rand = demoRandom(4000 + simNumber);
  const network = SIM_NETWORKS[(simNumber - 1) % SIM_NETWORKS.length] ?? 'T-Mobile';
  const plans: SimSessionPlan[] = [];
  const latest = now.getTime() - 7 * HOUR_MS;
  const days: number = SIM_DEMO.sessionDays;
  for (let d = days; d >= 1; d--) {
    const dayStart = now.getTime() - d * DAY_MS;
    for (let s = 0; s < SIM_DEMO.sessionsPerDay; s++) {
      const startedAt = dayStart + s * 8 * HOUR_MS + between(rand, 0, 120) * MINUTE_MS;
      const endedAt = startedAt + between(rand, 60, 360) * MINUTE_MS;
      if (endedAt > latest) continue;
      plans.push({
        providerSessionId: `demo-${pad(simNumber, 2)}${pad(plans.length + 1, 5)}`,
        startedAt: new Date(startedAt),
        endedAt: new Date(endedAt),
        bytes: between(rand, 40_000, 4_000_000),
        networkName: network,
        radioAccessTechnology: rand() < 0.8 ? 'LTE' : 'LTE-M',
        cellId: String(between(rand, 10_000_000, 99_999_999)),
      });
    }
  }
  return plans;
}

/** The status a Refresh stored for demo SIM `simNumber`; the second SIM is near its data limit. */
export function simStatusOf(
  now: Date,
  simNumber: number,
  lastSessionAt: Date | null,
): StoredSimStatus {
  const limitBytes = 500 * 1024 * 1024;
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const inSession = simNumber % 2 === 1;
  return {
    state: 'active',
    providerState: 'LIVE',
    inSession,
    openSessionBeganAt: inSession ? new Date(now.getTime() - 3 * HOUR_MS).toISOString() : null,
    apn: 'hologram',
    profileName: 'Hologram Global',
    lastSessionAt: lastSessionAt?.toISOString() ?? null,
    usage: {
      bytes: simNumber === 2 ? Math.round(limitBytes * 0.86) : (60 + simNumber * 35) * 1024 * 1024,
      periodEnd: periodEnd.toISOString(),
      limitBytes,
    },
  };
}

/** The SIM alerts of demo SIM `simNumber`: the first device, and a data warning on the second. */
export function simAlertPlan(
  now: Date,
  simNumber: number,
): Array<{ providerAlertId: string; kind: string; receivedAt: Date }> {
  const alerts = [
    {
      providerAlertId: `demo-alert-${pad(simNumber, 2)}1`,
      kind: 'first_device',
      receivedAt: new Date(now.getTime() - (SIM_DEMO.sessionDays + 10) * DAY_MS),
    },
  ];
  if (simNumber === 2) {
    alerts.push({
      providerAlertId: `demo-alert-${pad(simNumber, 2)}2`,
      kind: 'data_warning',
      receivedAt: new Date(now.getTime() - 2 * DAY_MS),
    });
  }
  if (simNumber === 3) {
    alerts.push({
      providerAlertId: `demo-alert-${pad(simNumber, 2)}2`,
      kind: 'device_changed',
      receivedAt: new Date(now.getTime() - 9 * DAY_MS),
    });
  }
  return alerts;
}

/**
 * SIM providers: one Hologram SIM per SIM demo station, with the station's
 * own ICCID and IMSI, imported and confirmed by an all-site admin (never
 * attached elsewhere, so no history floor), the status, sessions, alerts
 * and fetched range of a Refresh two hours ago; plus a spare SIM and a
 * deactivated one in the inventory. The provider ids are `demo-*`, which no
 * provider knows, and no provider credential is seeded, so nothing calls a
 * provider. Returns the SIMs inserted.
 */
export async function seedSimDemo(sql: postgres.Sql, ctx: DemoFeatureContext): Promise<number> {
  const stations = (await loadStations(sql, SIM_DEMO_STATION_IDS)).filter(
    (s) => normalizeIccid(s.iccid) != null,
  );
  const fetchedAt = new Date(ctx.now.getTime() - 2 * HOUR_MS);
  const attachedAt = new Date(ctx.now.getTime() - (SIM_DEMO.sessionDays + 10) * DAY_MS);
  let inserted = 0;

  for (const [i, station] of stations.entries()) {
    const simNumber = i + 1;
    const simId = `sim_demosim${pad(simNumber, 5)}`;
    const iccid = normalizeIccid(station.iccid) ?? '';
    const sessions = simSessionPlan(ctx.now, simNumber);
    const newest = sessions.at(-1) ?? null;
    const status = simStatusOf(ctx.now, simNumber, newest?.endedAt ?? null);
    const providerRef = `demo-${pad(simNumber, 4)}`;
    const created = await sql`
      INSERT INTO sims (id, iccid, imsi, provider, provider_ref, provider_meta, label, last_status,
        status_fetched_at, open_session_began_at, last_record_id, sessions_synced_at,
        alerts_synced_at, status, created_by, created_at, updated_at)
      VALUES (${simId}, ${iccid}, ${station.imsi}, 'hologram', ${providerRef},
        ${sql.json({ linkId: `${providerRef}-link`, simcardId: `${providerRef}-card` })},
        ${`${station.stationId} modem`}, ${sql.json(status as unknown as postgres.JSONValue)},
        ${fetchedAt}, ${status.openSessionBeganAt}, ${newest?.providerSessionId ?? null},
        ${fetchedAt}, ${fetchedAt}, 'active', ${ctx.actorUserId}, ${attachedAt}, ${fetchedAt})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (created.length === 0) continue;
    inserted++;
    // A station that already holds a SIM keeps it: the demo SIM stays unattached.
    const [attachment] = await sql<Array<{ id: number }>>`
      INSERT INTO sim_attachments (sim_id, station_id, source, attached_at, attached_by,
        attached_with_all_sites, confirmed_at, confirmed_by)
      SELECT ${simId}, ${station.id}, 'imported', ${attachedAt}, ${ctx.actorUserId}, true,
        ${attachedAt}, ${ctx.actorUserId}
      WHERE NOT EXISTS (SELECT 1 FROM sim_attachments WHERE sim_id = ${simId})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    for (const s of sessions) {
      await sql`
        INSERT INTO sim_sessions (sim_id, provider, provider_session_id, started_at, ended_at, bytes,
          network_name, radio_access_technology, cell_id, apn, fetched_at)
        VALUES (${simId}, 'hologram', ${s.providerSessionId}, ${s.startedAt}, ${s.endedAt},
          ${s.bytes}, ${s.networkName}, ${s.radioAccessTechnology}, ${s.cellId}, 'hologram',
          ${fetchedAt})
        ON CONFLICT DO NOTHING
      `;
    }
    for (const a of simAlertPlan(ctx.now, simNumber)) {
      await sql`
        INSERT INTO sim_alerts (sim_id, provider, provider_alert_id, kind, received_at, fetched_at)
        VALUES (${simId}, 'hologram', ${a.providerAlertId}, ${a.kind}, ${a.receivedAt}, ${fetchedAt})
        ON CONFLICT DO NOTHING
      `;
    }
    await sql`
      INSERT INTO sim_fetch_coverage (sim_id, provider, covered_from, covered_to, fetched_at)
      SELECT ${simId}, 'hologram', ${new Date(ctx.now.getTime() - SIM_DEMO.sessionDays * DAY_MS)},
        ${fetchedAt}, ${fetchedAt}
      WHERE NOT EXISTS (SELECT 1 FROM sim_fetch_coverage WHERE sim_id = ${simId})
    `;
    await writeAudit(
      { table: simAuditLog, idColumn: 'sim_id' },
      {
        entityId: simId,
        entityIdSnapshot: simId,
        action: 'created',
        actor: ctx.actorUserId != null ? 'operator' : 'system',
        actorUserId: ctx.actorUserId,
        after: {
          label: `${station.stationId} modem`,
          notes: null,
          provider: 'hologram',
          status: 'active',
        },
        notes: 'CSV import',
      },
    );
    if (attachment != null) {
      await writeAudit(
        { table: simAuditLog, idColumn: 'sim_id' },
        {
          entityId: simId,
          entityIdSnapshot: simId,
          action: 'attached',
          actor: ctx.actorUserId != null ? 'operator' : 'system',
          actorUserId: ctx.actorUserId,
          after: {
            attachment: {
              attachmentId: attachment.id,
              simId,
              stationId: station.id,
              source: 'imported',
              confirmed: true,
              detachReason: null,
            },
          },
          notes: 'CSV import',
        },
      );
    }
  }

  // The spare SIM (in stock, never looked up) and a deactivated one.
  const spare = await sql`
    INSERT INTO sims (id, iccid, imsi, label, notes, status, created_by, created_at, updated_at)
    VALUES (${SIM_DEMO.spare.id}, ${SIM_DEMO.spare.iccid}, ${SIM_DEMO.spare.imsi}, 'Spare modem SIM',
      'In stock for a replacement modem.', 'active', ${ctx.actorUserId}, ${ctx.now}, ${ctx.now})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  const deactivatedAt = new Date(ctx.now.getTime() - 3 * DAY_MS);
  const inactive = await sql`
    INSERT INTO sims (id, iccid, imsi, label, notes, status, deactivated_at, deactivated_by,
      created_by, created_at, updated_at)
    VALUES (${SIM_DEMO.inactive.id}, ${SIM_DEMO.inactive.iccid}, ${SIM_DEMO.inactive.imsi},
      'Damaged SIM', 'Card damaged during a modem swap.', 'inactive', ${deactivatedAt},
      ${ctx.actorUserId}, ${ctx.actorUserId}, ${new Date(ctx.now.getTime() - 20 * DAY_MS)},
      ${deactivatedAt})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return inserted + spare.length + inactive.length;
}

// ---------- Payment terminals ----------

/**
 * The demo payment terminals: two simulated ID TECH readers in cloud mode, on
 * simulated devices only the demo uses (`sim_term_4`, `sim_term_5`), so the
 * status poll keeps them online and no test registers the same device. The
 * VP6825 is paired to the first EVSE of its station and carries a confirmed
 * Hologram SIM (its LTE modem); the VP7200 (no screen) is paired to a whole
 * station at another site. Vendor, serial number and firmware are what the
 * simulated devices report (fictional values, `SIMULATED_DEVICES` in
 * `@evtivity/payment-terminals`; an API test keeps the two lists equal).
 */
export const TERMINAL_DEMO = {
  /** The VP6825 takes the first station found, the VP7200 the next one at another site. */
  stationIds: ['CS-0981', 'CS-0982', 'CS-0987', 'CS-0988', 'CS-0989'],
  devices: {
    vp6825: {
      providerDeviceId: 'sim_term_4',
      label: 'Lobby Card Reader',
      vendor: 'ID TECH',
      model: 'VP6825',
      serialNumber: '6825SIM000004',
      firmwareVersion: '1.01.106',
    },
    vp7200: {
      providerDeviceId: 'sim_term_5',
      label: 'Garage Entrance Card Reader',
      vendor: 'ID TECH',
      model: 'VP7200',
      serialNumber: '7200SIM000005',
      firmwareVersion: '1.00.042',
    },
  },
  /** The SIM of the VP6825 LTE modem, attached and confirmed by the admin. */
  sim: {
    id: 'sim_demosim00093',
    iccid: '89014103000000000993',
    imsi: '310410000000993',
    simNumber: 9,
  },
} as const;

export type TerminalDemoDevice = keyof typeof TERMINAL_DEMO.devices;

export interface TerminalTxnPlan {
  n: number;
  terminal: TerminalDemoDevice;
  state: 'captured' | 'voided' | 'refunded';
  /** The OCPP EVSE number of the session (the VP7200 is station-wide: the driver picked one). */
  evseNumber: number;
  daysAgo: number;
  hour: number;
  requestedCents: number;
  energyWh: number;
  costCents: number;
  card: { last4: string; bin: string; brand: string };
}

/** Public test card numbers of the card networks (last 4 digits and BIN only). */
const DEMO_CARDS = {
  visa: { last4: '4242', bin: '424242', brand: 'visa' },
  mastercard: { last4: '5454', bin: '545454', brand: 'mastercard' },
  amex: { last4: '0005', bin: '378282', brand: 'amex' },
} as const;

/**
 * The terminal payments, each paying one completed demo session: a captured
 * payment took the session cost, a voided one released the hold of a session
 * that delivered nothing (`no_cost`), the refunded one was captured and then
 * refunded in full.
 */
export function terminalTxnPlan(): TerminalTxnPlan[] {
  const plan = (
    n: number,
    terminal: TerminalDemoDevice,
    state: TerminalTxnPlan['state'],
    evseNumber: number,
    daysAgo: number,
    hour: number,
    energyWh: number,
    card: TerminalTxnPlan['card'],
  ): TerminalTxnPlan => ({
    n,
    terminal,
    state,
    evseNumber,
    daysAgo,
    hour,
    requestedCents: terminal === 'vp6825' ? 5000 : 7500,
    energyWh,
    costCents: Math.round((energyWh / 1000) * 40),
    card,
  });
  return [
    plan(1, 'vp6825', 'captured', 1, 3, 9, 14_200, DEMO_CARDS.visa),
    plan(2, 'vp6825', 'voided', 1, 2, 14, 0, DEMO_CARDS.mastercard),
    plan(3, 'vp6825', 'refunded', 1, 6, 17, 21_500, DEMO_CARDS.amex),
    plan(4, 'vp7200', 'captured', 2, 5, 8, 38_400, DEMO_CARDS.mastercard),
    plan(5, 'vp7200', 'captured', 1, 1, 12, 26_900, DEMO_CARDS.visa),
    plan(6, 'vp7200', 'voided', 1, 4, 19, 0, DEMO_CARDS.visa),
  ];
}

function demoHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/** The simulated provider's reference format (`ptx_sim_<authorized cents>_<24 hex>`), so a later refund works. */
export function demoTerminalTxnRef(n: number, authorizedCents: number): string {
  return `ptx_sim_${String(authorizedCents)}_${demoHash(`demo-terminal-txn-${String(n)}`, 24)}`;
}

interface TerminalStation {
  id: string;
  stationId: string;
  siteId: string | null;
  ocppProtocol: string;
  /** OCPP EVSE number to the EVSE record id. */
  evses: Map<number, string>;
}

async function loadTerminalStations(sql: postgres.Sql): Promise<TerminalStation[]> {
  const rows = await sql<
    Array<{ id: string; station_id: string; site_id: string | null; ocpp_protocol: string }>
  >`
    SELECT id, station_id, site_id, ocpp_protocol FROM charging_stations
    WHERE station_id IN ${sql([...TERMINAL_DEMO.stationIds])}
  `;
  const out: TerminalStation[] = [];
  for (const stationId of TERMINAL_DEMO.stationIds) {
    const row = rows.find((r) => r.station_id === stationId);
    if (row == null) continue;
    const evseRows = await sql<Array<{ id: string; evse_id: number }>>`
      SELECT id, evse_id FROM evses WHERE station_id = ${row.id} ORDER BY evse_id
    `;
    out.push({
      id: row.id,
      stationId: row.station_id,
      siteId: row.site_id,
      ocppProtocol: row.ocpp_protocol,
      evses: new Map(evseRows.map((e) => [e.evse_id, e.id])),
    });
  }
  return out;
}

const auditActor = (ctx: DemoFeatureContext): 'operator' | 'system' =>
  ctx.actorUserId != null ? 'operator' : 'system';

/** The terminal of a demo device: created through the terminal writer, or the one already registered. */
async function demoTerminal(
  sql: postgres.Sql,
  key: TerminalDemoDevice,
  station: TerminalStation,
  evseId: string | null,
  ctx: DemoFeatureContext,
): Promise<{ id: string; created: boolean } | null> {
  const device = TERMINAL_DEMO.devices[key];
  const result = await createTerminal({
    provider: 'simulated',
    integrationMode: 'cloud',
    providerDeviceId: device.providerDeviceId,
    label: device.label,
    vendor: device.vendor,
    model: device.model,
    serialNumber: device.serialNumber,
    firmwareVersion: device.firmwareVersion,
    siteId: null,
    pairing: { stationId: station.id, evseId },
    createdBy: ctx.actorUserId,
  });
  if (result.kind === 'created') {
    await recordTerminalDeviceStatus(
      result.terminal.id,
      { online: true, lastSeenAt: ctx.now, firmwareVersion: device.firmwareVersion },
      ctx.now,
    );
    await writeAudit(
      { table: paymentTerminalAuditLog, idColumn: 'payment_terminal_id' },
      {
        entityId: result.terminal.id,
        entityIdSnapshot: result.terminal.id,
        action: 'created',
        actor: auditActor(ctx),
        actorUserId: ctx.actorUserId,
        after: {
          label: device.label,
          provider: 'simulated',
          integrationMode: 'cloud',
          model: device.model,
          serialNumber: device.serialNumber,
          siteId: station.siteId,
          stationId: station.id,
          evseId,
          status: 'active',
          auditSiteId: station.siteId,
        },
      },
    );
    return { id: result.terminal.id, created: true };
  }
  if (result.kind !== 'device_taken') {
    console.log(`  Demo terminal ${device.providerDeviceId} skipped (${result.kind}).`);
    return null;
  }
  const [existing] = await sql<Array<{ id: string }>>`
    SELECT id FROM payment_terminals
    WHERE provider = 'simulated' AND provider_device_id = ${device.providerDeviceId}
  `;
  return existing != null ? { id: existing.id, created: false } : null;
}

/** The VP6825's own SIM: imported with the history of a Refresh, then attached to the terminal and confirmed. */
async function seedTerminalSim(
  sql: postgres.Sql,
  terminalId: string,
  siteId: string | null,
  ctx: DemoFeatureContext,
): Promise<void> {
  const { id: simId, iccid, imsi, simNumber } = TERMINAL_DEMO.sim;
  const fetchedAt = new Date(ctx.now.getTime() - 2 * HOUR_MS);
  const createdAt = new Date(ctx.now.getTime() - (SIM_DEMO.sessionDays + 10) * DAY_MS);
  const sessions = simSessionPlan(ctx.now, simNumber);
  const newest = sessions.at(-1) ?? null;
  const status = simStatusOf(ctx.now, simNumber, newest?.endedAt ?? null);
  const providerRef = `demo-${pad(93, 4)}`;
  const label = 'VP6825 LTE modem';
  const created = await sql`
    INSERT INTO sims (id, iccid, imsi, provider, provider_ref, provider_meta, label, last_status,
      status_fetched_at, open_session_began_at, last_record_id, sessions_synced_at,
      alerts_synced_at, status, created_by, created_at, updated_at)
    VALUES (${simId}, ${iccid}, ${imsi}, 'hologram', ${providerRef},
      ${sql.json({ linkId: `${providerRef}-link`, simcardId: `${providerRef}-card` })},
      ${label}, ${sql.json(status as unknown as postgres.JSONValue)}, ${fetchedAt},
      ${status.openSessionBeganAt}, ${newest?.providerSessionId ?? null}, ${fetchedAt},
      ${fetchedAt}, 'active', ${ctx.actorUserId}, ${createdAt}, ${fetchedAt})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (created.length === 0) return;
  for (const s of sessions) {
    await sql`
      INSERT INTO sim_sessions (sim_id, provider, provider_session_id, started_at, ended_at, bytes,
        network_name, radio_access_technology, cell_id, apn, fetched_at)
      VALUES (${simId}, 'hologram', ${s.providerSessionId}, ${s.startedAt}, ${s.endedAt},
        ${s.bytes}, ${s.networkName}, ${s.radioAccessTechnology}, ${s.cellId}, 'hologram',
        ${fetchedAt})
      ON CONFLICT DO NOTHING
    `;
  }
  await sql`
    INSERT INTO sim_fetch_coverage (sim_id, provider, covered_from, covered_to, fetched_at)
    SELECT ${simId}, 'hologram', ${new Date(ctx.now.getTime() - SIM_DEMO.sessionDays * DAY_MS)},
      ${fetchedAt}, ${fetchedAt}
    WHERE NOT EXISTS (SELECT 1 FROM sim_fetch_coverage WHERE sim_id = ${simId})
  `;
  await writeAudit(
    { table: simAuditLog, idColumn: 'sim_id' },
    {
      entityId: simId,
      entityIdSnapshot: simId,
      action: 'created',
      actor: auditActor(ctx),
      actorUserId: ctx.actorUserId,
      after: { label, notes: null, provider: 'hologram', status: 'active' },
      notes: 'CSV import',
    },
  );
  // The attachment rules of the terminal SIM Card tab: an all-site admin
  // entered the ICCID, so it is confirmed at once.
  const attached = await attachSimToPaymentTerminal({
    simId,
    paymentTerminalId: terminalId,
    source: 'entered',
    by: ctx.actorUserId,
    withAllSites: true,
    confirm: true,
  });
  if (attached.kind !== 'attached' || !attached.created) return;
  const attachment = attached.attachment;
  await writeAudit(
    { table: simAuditLog, idColumn: 'sim_id' },
    {
      entityId: simId,
      entityIdSnapshot: simId,
      action: 'attached',
      actor: auditActor(ctx),
      actorUserId: ctx.actorUserId,
      after: {
        attachment: {
          attachmentId: attachment.id,
          simId,
          stationId: null,
          paymentTerminalId: terminalId,
          source: 'entered',
          confirmed: true,
          detachReason: null,
        },
      },
    },
  );
  await writeAudit(
    { table: paymentTerminalAuditLog, idColumn: 'payment_terminal_id' },
    {
      entityId: terminalId,
      entityIdSnapshot: terminalId,
      action: 'sim_attached',
      actor: auditActor(ctx),
      actorUserId: ctx.actorUserId,
      after: {
        attachmentId: attachment.id,
        source: 'entered',
        confirmed: true,
        auditSiteId: siteId,
      },
    },
  );
}

/**
 * One terminal payment and the session it paid: the guest session the
 * terminal start stores (`payment_terminal`), the completed charging session,
 * the payment record of a capture (`payment_source = 'terminal'`) and the
 * terminal transaction. Returns whether the transaction was inserted.
 */
async function seedTerminalPayment(
  sql: postgres.Sql,
  plan: TerminalTxnPlan,
  terminalId: string,
  station: TerminalStation,
  ctx: DemoFeatureContext,
): Promise<boolean> {
  const evseDbId = station.evses.get(plan.evseNumber) ?? null;
  const day = new Date(ctx.now.getTime() - plan.daysAgo * DAY_MS);
  day.setUTCHours(0, 0, 0, 0);
  const requestedAt = new Date(day.getTime() + plan.hour * HOUR_MS + 7 * MINUTE_MS);
  const authorizedAt = new Date(requestedAt.getTime() + 12_000);
  const startedAt = new Date(authorizedAt.getTime() + 40_000);
  const endedAt = new Date(
    startedAt.getTime() + (plan.energyWh > 0 ? (plan.energyWh / 250) * MINUTE_MS : 4 * MINUTE_MS),
  );
  const settledAt = new Date(endedAt.getTime() + 30_000);
  const authorized = plan.requestedCents;
  const ref = demoTerminalTxnRef(plan.n, authorized);
  const sessionId = `ses_demotrm${pad(plan.n, 5)}`;
  const txnId = `ptx_demotrx${pad(plan.n, 5)}`;
  const captured = plan.state === 'voided' ? null : plan.costCents;
  const refunded = plan.state === 'refunded' ? plan.costCents : 0;

  const [exists] = await sql`SELECT 1 FROM payment_terminal_transactions WHERE id = ${txnId}`;
  if (exists != null) return false;

  const token = demoHash(`demo-terminal-guest-${String(plan.n)}`, 20);
  const breakdown = chargedCostBreakdown(plan.costCents, 0, ctx.taxBasis);
  await sql`
    INSERT INTO charging_sessions (id, station_id, site_id, evse_id, transaction_id, status,
      started_at, ended_at, meter_start, meter_stop, energy_delivered_wh, final_cost_cents,
      net_cents, tax_cents, cost_breakdown, currency, cost_ceiling_cents, stopped_reason,
      created_at, updated_at)
    VALUES (${sessionId}, ${station.id}, ${sessionSiteIdSql(sql, station.id)}, ${evseDbId},
      ${demoTransactionId('terminal', plan.n, station.ocppProtocol === 'ocpp1.6')}, 'completed',
      ${startedAt}, ${endedAt}, 0, ${plan.energyWh}, ${String(plan.energyWh)}, ${plan.costCents},
      ${breakdown.netCents}, ${breakdown.taxCents},
      ${sql.json(breakdown as unknown as postgres.JSONValue)}, ${ctx.currency}, ${authorized},
      'EVDisconnected', ${startedAt}, ${endedAt})
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO guest_sessions (station_ocpp_id, evse_id, charging_session_id, guest_email,
      pre_auth_amount_cents, status, session_token, expires_at, max_cost_cents, payment_terminal,
      start_requested_at, created_at, updated_at)
    VALUES (${station.stationId}, ${plan.evseNumber}, ${sessionId}, '', ${authorized}, 'completed',
      ${token}, ${new Date(requestedAt.getTime() + HOUR_MS)}, ${authorized}, true, ${authorizedAt},
      ${requestedAt}, ${settledAt})
    ON CONFLICT DO NOTHING
  `;
  const [guest] = await sql<Array<{ id: number }>>`
    SELECT id FROM guest_sessions WHERE session_token = ${token}
  `;

  let paymentRecordId: number | null = null;
  if (captured != null) {
    const ledger =
      plan.state === 'refunded'
        ? [
            {
              refundId: `rf_sim_${demoHash(`demo-terminal-refund-${String(plan.n)}`, 24)}`,
              paymentId: ref,
              amountCents: refunded,
              state: 'succeeded',
              requestedAt: new Date(settledAt.getTime() + DAY_MS).toISOString(),
              settledAt: new Date(settledAt.getTime() + DAY_MS).toISOString(),
            },
          ]
        : [];
    await sql`
      INSERT INTO payment_records (session_id, provider, provider_payment_id, payment_source,
        currency, pre_auth_amount_cents, captured_amount_cents, refunded_amount_cents, status,
        provider_refunds, created_at, updated_at)
      VALUES (${sessionId}, 'simulated', ${ref}, 'terminal', ${ctx.currency}, ${authorized},
        ${captured}, ${refunded}, ${plan.state === 'refunded' ? 'refunded' : 'captured'},
        ${sql.json(ledger)}, ${settledAt}, ${plan.state === 'refunded' ? new Date(settledAt.getTime() + DAY_MS) : settledAt})
      ON CONFLICT DO NOTHING
    `;
    const [record] = await sql<Array<{ id: number }>>`
      SELECT id FROM payment_records WHERE provider = 'simulated' AND provider_payment_id = ${ref}
    `;
    paymentRecordId = record?.id ?? null;
  }

  const inserted = await sql`
    INSERT INTO payment_terminal_transactions (id, payment_terminal_id, provider, provider_txn_ref,
      site_id, station_id, evse_number, guest_session_id, session_id, payment_record_id, state,
      currency, requested_cents, authorized_cents, captured_cents, refunded_cents, card_last4,
      card_bin, card_brand, failure_reason, requested_at, authorized_at, captured_at, voided_at,
      expires_at, created_at, updated_at)
    VALUES (${txnId}, ${terminalId}, 'simulated', ${ref}, ${station.siteId}, ${station.id},
      ${plan.evseNumber}, ${guest?.id ?? null}, ${sessionId}, ${paymentRecordId}, ${plan.state},
      ${ctx.currency}, ${plan.requestedCents}, ${authorized}, ${captured}, ${refunded},
      ${plan.card.last4}, ${plan.card.bin}, ${plan.card.brand},
      ${plan.state === 'voided' ? 'no_cost' : null}, ${requestedAt}, ${authorizedAt},
      ${captured != null ? settledAt : null}, ${plan.state === 'voided' ? settledAt : null},
      ${new Date(requestedAt.getTime() + 15 * MINUTE_MS)}, ${requestedAt}, ${settledAt})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 0) return false;
  await writeAudit(
    { table: paymentTerminalAuditLog, idColumn: 'payment_terminal_id' },
    {
      entityId: terminalId,
      entityIdSnapshot: terminalId,
      action: 'payment_started',
      actor: 'system',
      actorUserId: null,
      actorLabel: 'payment-terminal',
      after: {
        transactionId: txnId,
        requestedCents: plan.requestedCents,
        auditSiteId: station.siteId,
      },
    },
  );
  return true;
}

/**
 * Payment terminals: the two demo terminals, the VP6825's SIM and six
 * terminal payments (four captured, one of them refunded, and two voided).
 * Returns the terminal payments inserted; a rerun adds nothing.
 */
export async function seedPaymentTerminalDemo(
  sql: postgres.Sql,
  ctx: DemoFeatureContext,
): Promise<number> {
  const stations = (await loadTerminalStations(sql)).filter((s) => s.evses.size > 0);
  const first = stations[0];
  if (first == null) {
    console.log('  Payment terminal demo skipped: no demo station for the terminals.');
    return 0;
  }
  const second =
    stations.find((s) => s.id !== first.id && s.siteId !== first.siteId) ??
    stations.find((s) => s.id !== first.id) ??
    null;
  const placed: Array<{
    key: TerminalDemoDevice;
    station: TerminalStation;
    evseId: string | null;
  }> = [{ key: 'vp6825', station: first, evseId: first.evses.get(1) ?? null }];
  if (second != null) placed.push({ key: 'vp7200', station: second, evseId: null });

  let inserted = 0;
  for (const { key, station, evseId } of placed) {
    const terminal = await demoTerminal(sql, key, station, evseId, ctx);
    if (terminal == null) continue;
    if (key === 'vp6825') await seedTerminalSim(sql, terminal.id, station.siteId, ctx);
    for (const plan of terminalTxnPlan().filter((p) => p.terminal === key)) {
      if (!station.evses.has(plan.evseNumber)) continue;
      if (await seedTerminalPayment(sql, plan, terminal.id, station, ctx)) inserted++;
    }
  }
  return inserted;
}

// ---------- All four ----------

/**
 * Turns the demo features on: Plug and Charge (`pnc.enabled`, provider kept,
 * so no contract certificate is issued without a CA the operator creates)
 * and Hologram (`sim.hologram.enabled` without an organization or API key, so
 * the SIM pages show the stored data and no Refresh reaches a provider).
 */
export async function enableDemoFeatureSettings(sql: postgres.Sql): Promise<void> {
  for (const key of ['pnc.enabled', 'sim.hologram.enabled']) {
    await sql`
      INSERT INTO settings (key, value) VALUES (${key}, 'true'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = now()
    `;
  }
}

export interface DemoFeatureCounts {
  pncSessions: number;
  freeVendSessions: number;
  sims: number;
  terminalPayments: number;
}

/**
 * Seeds the Plug and Charge, free vend, SIM and payment terminal demo and turns the two
 * features on. Picks the demo drivers and the EVtivity vendor itself, so the
 * demo seed and the run script on an existing demo database do the same.
 */
export async function seedDemoFeatures(
  sql: postgres.Sql,
  ctx: DemoFeatureContext,
): Promise<DemoFeatureCounts> {
  // Four demo drivers past the ones the fleet, re-bill and insight demos use.
  const drivers = await sql<Array<{ id: string }>>`
    SELECT id FROM drivers
    WHERE is_active AND erased_at IS NULL AND email IS NOT NULL AND id NOT LIKE 'drv_demo%'
    ORDER BY created_at, id
    OFFSET 3 LIMIT ${PNC_DEMO.contractCount}
  `;
  const [vendor] = await sql<Array<{ id: string }>>`
    SELECT id FROM vendors WHERE name = 'EVtivity' ORDER BY id LIMIT 1
  `;
  const pncSessions = await seedPncDemo(
    sql,
    ctx,
    drivers.map((d) => d.id),
  );
  const freeVendSessions = await seedFreeVendDemo(sql, ctx, vendor?.id ?? null);
  const sims = await seedSimDemo(sql, ctx);
  const terminalPayments = await seedPaymentTerminalDemo(sql, ctx);
  await enableDemoFeatureSettings(sql);
  return { pncSessions, freeVendSessions, sims, terminalPayments };
}
