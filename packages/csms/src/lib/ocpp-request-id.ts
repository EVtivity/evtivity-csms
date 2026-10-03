// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** Largest OCPP request ID: stations store `requestId` (an OCPP integer) as a signed 32-bit value. */
export const MAX_OCPP_REQUEST_ID = 2_147_483_647;

/**
 * A random request ID for a CSMS-initiated OCPP request (UpdateFirmware,
 * SignedUpdateFirmware), from 1 to 2^31 - 1, so it fits a 32-bit integer.
 * Date.now() does not (it is about 1.8e12). The top bit is dropped and 0 is
 * redrawn, so every ID in the range is equally likely.
 */
export function newOcppRequestId(): number {
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = (buffer[0] ?? 0) >>> 1;
    if (value !== 0) return value;
  }
}
