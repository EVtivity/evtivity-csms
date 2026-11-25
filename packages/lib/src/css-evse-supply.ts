// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CssConnectorType } from './css-connector-types.js';

/**
 * The AC supply of a simulated EVSE (`css_evses.phases` and `voltage`): the
 * simulator converts limits and meter values with W = A x voltage x phases,
 * so `voltage` is the voltage across each phase it charges on.
 */
export interface CssEvseSupply {
  phases: number;
  voltage: number;
}

const NORTH_AMERICA = new Set(['US', 'USA', 'UNITED STATES', 'CA', 'CAN', 'CANADA', 'MX', 'MEX']);

/** True for a site country of the 60 Hz North American systems (sites store ISO codes or names). */
export function isNorthAmericanCountry(country: string | null | undefined): boolean {
  return country != null && NORTH_AMERICA.has(country.trim().toUpperCase());
}

/**
 * North American AC Level 2: one 2-pole 208 V branch circuit of a 208Y/120 V
 * panelboard (NFPA 70 (NEC) 2023, 625.40 and 220.5(A) nominal voltages).
 */
export const NA_LEVEL_2_SUPPLY: CssEvseSupply = { phases: 1, voltage: 208 };
/** North American DC fast charger input: 480Y/277 V three-phase, per phase 277 V. */
export const NA_DC_SUPPLY: CssEvseSupply = { phases: 3, voltage: 277 };
/** IEC 60038:2009 Table 1: the 230/400 V three-phase system, per phase 230 V. */
export const IEC_THREE_PHASE_SUPPLY: CssEvseSupply = { phases: 3, voltage: 230 };
/** IEC 60038:2009 Table 1: one phase of the 230/400 V system. */
export const IEC_SINGLE_PHASE_SUPPLY: CssEvseSupply = { phases: 1, voltage: 230 };

/**
 * The default supply of a simulated EVSE by its plug and its site's country.
 * North America: AC on a single-phase 208 V circuit, DC on 480Y/277 V.
 * Elsewhere: Type 2 and DC on three-phase 230/400 V, Type 1 on one phase of it.
 */
export function cssEvseSupply(
  type: CssConnectorType,
  country: string | null | undefined,
): CssEvseSupply {
  const northAmerica = isNorthAmericanCountry(country);
  if (type === 'ac_type1') return northAmerica ? NA_LEVEL_2_SUPPLY : IEC_SINGLE_PHASE_SUPPLY;
  if (type === 'ac_type2') return northAmerica ? NA_LEVEL_2_SUPPLY : IEC_THREE_PHASE_SUPPLY;
  return northAmerica ? NA_DC_SUPPLY : IEC_THREE_PHASE_SUPPLY;
}
