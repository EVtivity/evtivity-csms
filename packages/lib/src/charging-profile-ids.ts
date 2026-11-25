// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A stable charging profile id for the TxProfile of one transaction. A
 * renegotiation (K16, K17) or a new depot plan sends the profile again with the
 * same id, so the station replaces it (K01.FR.05) instead of refusing a second
 * profile with the same stackLevel and transactionId (K01.FR.39). The id stays
 * in the upper half of the int32 range, away from the small ids of templates
 * and load management.
 */
export function chargingNeedsProfileId(stationOcppId: string, transactionId: string): number {
  // FNV-1a, 32 bit.
  let hash = 0x811c9dc5;
  for (const ch of `${stationOcppId}:${transactionId}`) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const half = 0x40000000;
  return half + (hash % (0x7fffffff - half));
}

/**
 * The id of the TxDefaultProfile load management sends on one EVSE of a unit
 * box: above the station's load management profile id (`stationProfileId`)
 * and its credit profile id (one above it), one per EVSE, so a new value
 * replaces the EVSE's own default (K01.FR.05) and stays above the station's
 * MaxExternalConstraintsId (K01.FR.80). Null when it would leave the int32
 * range: no default can be sent and the EVSE counts at its rating.
 */
export function loadManagementDefaultProfileId(
  stationProfileId: number,
  evseNumber: number,
): number | null {
  const id = stationProfileId + 1 + evseNumber;
  return evseNumber >= 1 && Number.isSafeInteger(id) && id <= 0x7fffffff ? id : null;
}
