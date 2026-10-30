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
/** Plug types that carry AC (up to 22 kW) and DC: DC above that power. */
const AC_OR_DC_TYPES: ReadonlySet<string> = new Set(['GBT', 'Tesla', 'NACS']);
/** AC tops at 22 kW on GB/T, Tesla and NACS plugs. */
export const AC_MAX_POWER_KW = 22;

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
 * A connector is DC when its type is CCS1, CCS2 or CHAdeMO, or GBT, Tesla or
 * NACS with a maximum power above 22 kW. Type1, Type2, unknown and missing
 * types are AC.
 */
export function isDcConnector(connector: ConnectorPowerInput): boolean {
  const type = connector.connectorType ?? '';
  if (DC_TYPES.has(type)) return true;
  if (!AC_OR_DC_TYPES.has(type)) return false;
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
