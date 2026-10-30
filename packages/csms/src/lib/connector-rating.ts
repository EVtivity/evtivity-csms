// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  CONNECTOR_CURRENT_AMPS_DECIMALS,
  CONNECTOR_POWER_KW_DECIMALS,
} from '@evtivity/lib/connector-power';
import { formatNumberUpTo } from '@/lib/formatting';

/**
 * A connector rating as the canonical form value (DecimalInput), rounded to the
 * decimals the API takes: a rating a station reported can carry more.
 */
export function ratingField(value: number | null, decimals: number): string {
  return value != null ? String(Number(value.toFixed(decimals))) : '';
}

/** Connector maximum power in the UI language, at most 2 decimals: "7.4" (en), "7,4" (de). */
export function formatConnectorPowerKw(value: number): string {
  return formatNumberUpTo(value, CONNECTOR_POWER_KW_DECIMALS);
}

/** Connector maximum current in the UI language, at most 1 decimal: "31.5" (en), "31,5" (de). */
export function formatConnectorCurrentAmps(value: number): string {
  return formatNumberUpTo(value, CONNECTOR_CURRENT_AMPS_DECIMALS);
}
