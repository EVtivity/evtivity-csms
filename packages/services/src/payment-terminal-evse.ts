// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The EVSE a terminal payment starts on (security case 269): the paired EVSE,
 * else the one the driver picked on the terminal screen when it is an EVSE of
 * the paired station in service, else the station's only one, else 0 (the
 * station starts on the connector the driver plugs in). A pick that names
 * another station's connector, or one out of service, never counts.
 */
export function terminalStartEvse(
  pairedEvse: number | null,
  picked: number | null,
  stationEvses: readonly number[],
): number {
  if (pairedEvse != null) return pairedEvse;
  if (picked != null && stationEvses.includes(picked)) return picked;
  return stationEvses.length === 1 ? (stationEvses[0] ?? 0) : 0;
}
