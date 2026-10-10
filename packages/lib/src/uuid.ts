// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A random RFC 9562 version 4 UUID, safe for browser code.
 *
 * `crypto.randomUUID()` exists only in a secure context (HTTPS or localhost), so a
 * dashboard opened over plain HTTP at a LAN address or host name has no such function.
 * `crypto.getRandomValues()` is available in every context and gives the same 122
 * random bits.
 */
export function randomUuidV4(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // Version 4 in the high nibble of byte 6, variant 10xx in the high bits of byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
