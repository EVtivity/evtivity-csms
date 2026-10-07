// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import type { TransactionLimitType } from '../generated/v2_1/types/common/TransactionLimitType.js';

/**
 * Transaction limits a station supports (OCPP 2.1 `TxCtrlr.SupportedLimits`,
 * a MemberList of "maxCost, maxEnergy, maxTime, maxSoC"). The CSMS sends
 * only these in a TransactionEventResponse (E16.FR.12).
 */
export type TransactionLimitKind = 'maxCost' | 'maxEnergy' | 'maxTime' | 'maxSoC';

const LIMIT_KINDS: readonly TransactionLimitKind[] = ['maxCost', 'maxEnergy', 'maxTime', 'maxSoC'];

/**
 * Parses a reported SupportedLimits value. Members are matched without case
 * (stations report `MaxCost` as well as `maxCost`). An empty value means no
 * limits are supported (device model 2.7.12).
 */
export function parseSupportedLimits(value: string | null): Set<TransactionLimitKind> {
  const supported = new Set<TransactionLimitKind>();
  if (value == null) return supported;
  for (const member of value.split(',')) {
    const name = member.trim().toLowerCase();
    const kind = LIMIT_KINDS.find((k) => k.toLowerCase() === name);
    if (kind != null) supported.add(kind);
  }
  return supported;
}

/**
 * The limits the station reported in `TxCtrlr.SupportedLimits` (Actual), for
 * the EVSE when the station reported a per-EVSE value, else the station-wide
 * one. Null when the station has not reported the variable: the CSMS reads
 * the device model only through NotifyReport, GetVariables and GetBaseReport,
 * so a missing row means not known, not "the variable does not exist".
 */
export async function stationSupportedLimits(
  sql: postgres.Sql,
  stationUuid: string,
  evseId: number | null,
): Promise<Set<TransactionLimitKind> | null> {
  const rows = await sql<Array<{ value: string | null; evse_id: number | null }>>`
    SELECT value, evse_id FROM station_configurations
    WHERE station_id = ${stationUuid}
      AND component = 'TxCtrlr'
      AND variable = 'SupportedLimits'
      AND attribute_type = 'Actual'
      AND (evse_id IS NULL OR evse_id = ${evseId})
    ORDER BY evse_id NULLS LAST
    LIMIT 1
  `;
  const row = rows[0];
  if (row == null) return null;
  return parseSupportedLimits(row.value);
}

/**
 * Keeps only the limits in `supported`. Returns null when none is left.
 * `supported` null (not reported) keeps the limit unchanged.
 */
export function limitToSupported(
  limit: TransactionLimitType,
  supported: Set<TransactionLimitKind> | null,
): TransactionLimitType | null {
  if (supported == null) return limit;
  const kept: TransactionLimitType = {};
  for (const kind of LIMIT_KINDS) {
    const value = limit[kind];
    if (value != null && supported.has(kind)) kept[kind] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}
