// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { totpV1, totpV1ForInterval, verifyTotpV1 } from '../web-payment-totp.js';

// Expected values computed independently from the OCPP 2.1 C25 "TOTP algorithm,
// version 1" pseudocode (HMAC-SHA256 over the big-endian 64-bit interval).
const PARAMS = { sharedSecret: 'MySharedSecret', validitySeconds: 30, length: 8 };

describe('TOTP v1 (OCPP 2.1 C25)', () => {
  it('matches the spec algorithm for known intervals', () => {
    expect(totpV1ForInterval(PARAMS, 59_000_000n)).toBe('5AViTp52');
    expect(totpV1ForInterval(PARAMS, 59_000_001n)).toBe('8M9BjBLF');
    expect(
      totpV1ForInterval({ sharedSecret: 'ABCDEFGH12345678', validitySeconds: 60, length: 6 }, 1n),
    ).toBe('gXEOrp');
  });

  it('uses floor(Unix seconds / ValidityTime) as the interval', () => {
    const atMs = 59_000_000 * 30 * 1000 + 29_999;
    expect(totpV1(PARAMS, atMs)).toBe('5AViTp52');
  });

  it('accepts the current, previous, and next interval only', () => {
    const atMs = 59_000_001 * 30 * 1000;
    expect(verifyTotpV1('8M9BjBLF', PARAMS, atMs)).toBe(true); // current
    expect(verifyTotpV1('5AViTp52', PARAMS, atMs)).toBe(true); // previous
    expect(verifyTotpV1(totpV1ForInterval(PARAMS, 59_000_002n), PARAMS, atMs)).toBe(true);
    expect(verifyTotpV1(totpV1ForInterval(PARAMS, 59_000_003n), PARAMS, atMs)).toBe(false);
    expect(verifyTotpV1(totpV1ForInterval(PARAMS, 58_999_999n), PARAMS, atMs)).toBe(false);
  });

  it('rejects a wrong secret, a wrong length, and an empty value', () => {
    const atMs = 59_000_001 * 30 * 1000;
    expect(verifyTotpV1('8M9BjBLF', { ...PARAMS, sharedSecret: 'other' }, atMs)).toBe(false);
    expect(verifyTotpV1('8M9BjBL', PARAMS, atMs)).toBe(false);
    expect(verifyTotpV1('', PARAMS, atMs)).toBe(false);
  });
});
