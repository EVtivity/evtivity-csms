// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ db: {} }));

import { compareRecordIds } from '../lib/station-sim-match.js';

describe('compareRecordIds', () => {
  it('compares integer ids by value, not as text', () => {
    expect(compareRecordIds('9', '10')).toBe(-1);
    expect(compareRecordIds('10', '9')).toBe(1);
    expect(compareRecordIds('100', '100')).toBe(0);
  });

  it('compares ids beyond the safe integer range exactly', () => {
    expect(compareRecordIds('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareRecordIds('18446744073709551615', '18446744073709551616')).toBe(-1);
  });

  it('treats leading zeros as the same number', () => {
    expect(compareRecordIds('007', '7')).toBe(0);
  });

  it('falls back to text order when either id is not an integer', () => {
    expect(compareRecordIds('a9', 'a10')).toBe(1);
    expect(compareRecordIds('10', 'abc')).toBe(-1);
    expect(compareRecordIds('-1', '2')).toBe(-1);
    expect(compareRecordIds('x', 'x')).toBe(0);
  });
});
