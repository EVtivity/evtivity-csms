// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// AC or DC charging from the connector type, for the data plan charging values.

import type { ChargingKind } from './station-data-plan.js';

/** The connector types the CSMS stores (stations API, site import, CSMS select). */
export const CONNECTOR_TYPES = [
  'CCS1',
  'CCS2',
  'CHAdeMO',
  'Type2',
  'Type1',
  'GBT',
  'Tesla',
  'NACS',
] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

/** DC-only plug types. */
const DC_TYPES: ReadonlySet<string> = new Set(['CCS1', 'CCS2', 'CHAdeMO']);
/**
 * DC-only heavy vehicle couplers, any case: the Megawatt Charging System
 * (`MCS`, OCPP `cMCS`) and depot pantographs (`OppCharge`, `Pan`).
 */
const HEAVY_DC_TYPE = /^(c?mcs|oppcharge|pan)$/i;
/** Plug types that carry AC (up to 22 kW) and DC: DC above that power. */
const AC_OR_DC_TYPES: ReadonlySet<string> = new Set(['GBT', 'Tesla', 'NACS']);
/** AC tops at 22 kW on GB/T, Tesla and NACS plugs. */
export const AC_MAX_POWER_KW = 22;

/**
 * True for the plug types whose maximum power decides AC or DC (GB/T, Tesla,
 * NACS). An operator must give their maximum power (owner decision
 * 2026-11-13): without it `isDcConnector` reads AC, so a DC charger would be
 * priced with the AC tariffs. Station-reported connectors are not refused.
 */
export function connectorNeedsMaxPower(connectorType: string | null | undefined): boolean {
  return connectorType != null && AC_OR_DC_TYPES.has(connectorType);
}

/** The message a write refuses a missing maximum power with (field maxPowerKw). */
export const CONNECTOR_MAX_POWER_REQUIRED_MESSAGE =
  'Maximum power is required for NACS, GB/T and Tesla connectors: above 22 kW is DC, 22 kW or less is AC';

/**
 * Connector ratings an operator enters (stations API, site import, CSMS form):
 * maximum power in kW with at most 2 decimals (3.68, 7.4, 11.5) and maximum
 * current in A with at most 1 decimal (31.5), each at least 0.1.
 */
export const CONNECTOR_POWER_KW_DECIMALS = 2;
export const CONNECTOR_CURRENT_AMPS_DECIMALS = 1;
export const CONNECTOR_RATING_MIN = 0.1;

/**
 * True when `value` has at most `decimals` fraction digits. Compared on the
 * scaled value with a tolerance, so binary floating point (7.4 * 100 is
 * 740.0000000000001) does not refuse a value typed with that many digits.
 */
export function hasAtMostDecimals(value: number, decimals: number): boolean {
  if (!Number.isFinite(value)) return false;
  const scaled = value * 10 ** decimals;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

export interface ConnectorPowerInput {
  connectorType: string | null | undefined;
  maxPowerKw: number | string | null | undefined;
}

/**
 * The DC-only OCPP 2.1 ConnectorEnumType values a station may report, compared
 * lowercase without separators: CCS1, CCS2, CHAdeMO (cG105), ChaoJi,
 * Ultra-ChaoJi, the DC GB/T coupler (cGBT-DC) and LECCS.
 */
const REPORTED_DC_KEYS: ReadonlySet<string> = new Set([
  'cccs1',
  'cccs2',
  'cg105',
  'cg1052019',
  'cchaoji',
  'cultrachaoji',
  'cgbtdc',
  'cleccs',
]);
/** Reported AC and DC couplers whose maximum power decides (Tesla, NACS). */
const REPORTED_AC_OR_DC_KEYS: ReadonlySet<string> = new Set(['ctesla', 'cnacs']);

function reportedKey(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A connector is DC when its type is CCS1, CCS2 or CHAdeMO, or GBT, Tesla or
 * NACS with a maximum power above 22 kW. The heavy vehicle couplers (MCS,
 * cMCS, OppCharge, Pan, any case) and the DC-only types a station reports in
 * OCPP spelling (cGBT-DC, cLECCS, cChaoJi, cUltraChaoJi) are DC. Type1, Type2,
 * unknown and missing types are AC.
 */
export function isDcConnector(connector: ConnectorPowerInput): boolean {
  const type = connector.connectorType ?? '';
  const key = reportedKey(type);
  if (DC_TYPES.has(type) || HEAVY_DC_TYPE.test(type) || REPORTED_DC_KEYS.has(key)) return true;
  if (!AC_OR_DC_TYPES.has(type) && !REPORTED_AC_OR_DC_KEYS.has(key)) return false;
  const power =
    typeof connector.maxPowerKw === 'string'
      ? Number(connector.maxPowerKw)
      : (connector.maxPowerKw ?? null);
  return power != null && Number.isFinite(power) && power > AC_MAX_POWER_KW;
}

/**
 * The station's charging kind: DC when any connector passed is DC. The caller
 * passes the connectors of in-service EVSEs only.
 */
export function stationChargingKind(connectors: readonly ConnectorPowerInput[]): ChargingKind {
  return connectors.some(isDcConnector) ? 'dc' : 'ac';
}

/**
 * The charging kind of one EVSE from its connectors (tariff charging types,
 * owner decision 2026-11-13): `ac` when every connector with a known type is
 * AC, `dc` when every one is DC, `mixed` when it holds both (for example
 * Type 2 and CCS2: the connector used decides), null when no connector has a
 * type. A 1.6 EVSE holds one connector, so it is never mixed.
 */
export function evseChargingKind(
  connectors: readonly ConnectorPowerInput[],
): ChargingKind | 'mixed' | null {
  let ac = false;
  let dc = false;
  for (const c of connectors) {
    if (c.connectorType == null || c.connectorType === '') continue;
    if (isDcConnector(c)) dc = true;
    else ac = true;
  }
  if (ac && dc) return 'mixed';
  if (dc) return 'dc';
  if (ac) return 'ac';
  return null;
}
