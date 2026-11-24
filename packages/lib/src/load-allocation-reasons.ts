// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export const LOAD_ALLOCATION_REASONS = [
  'tariff_limit',
  'unit_budget',
  'station_share',
  'circuit_limit',
  'panel_limit',
  'transformer_limit',
  'ac_min_pause',
  'min_power_stop',
  'depot_plan',
  'station_max',
  'connector_max',
  'reserved',
] as const;

export type LoadAllocationReason = (typeof LOAD_ALLOCATION_REASONS)[number];

const REASONS: ReadonlySet<string> = new Set(LOAD_ALLOCATION_REASONS);

export function isLoadAllocationReason(value: string): value is LoadAllocationReason {
  return REASONS.has(value);
}
