// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The pure parts of the recovery codes. The stored hashes, single use and
// regeneration run against the real database in the users and portal driver
// integration tests.

import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  normalizeRecoveryCode,
} from '../services/mfa-factor.service.js';

describe('recovery codes', () => {
  it('are ten per account', () => {
    expect(RECOVERY_CODE_COUNT).toBe(10);
  });

  it('read as two groups of five without look-alike characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRecoveryCode()).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
    }
  });

  it('are random', () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(1000);
  });

  it('compare without case, dashes or spaces', () => {
    expect(normalizeRecoveryCode(' ABCDE-fghjk ')).toBe('abcdefghjk');
    expect(normalizeRecoveryCode('abcde fghjk')).toBe('abcdefghjk');
  });
});
