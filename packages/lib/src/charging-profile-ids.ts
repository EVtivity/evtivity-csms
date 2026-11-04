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
