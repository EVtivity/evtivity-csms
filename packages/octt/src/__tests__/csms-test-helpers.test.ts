// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { newTransactionId } from '../csms-test-helpers.js';

describe('newTransactionId', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('differs for tests that start in the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T06:23:38.273Z'));
    const ids = new Set(Array.from({ length: 50 }, () => newTransactionId('OCTT-TX')));
    expect(ids.size).toBe(50);
  });

  it('keeps the prefix and fits CiString36 for the longest prefix', () => {
    const id = newTransactionId('UNKNOWN-TX');
    expect(id).toMatch(/^UNKNOWN-TX-\d{13}-[0-9a-f]{6}$/);
    expect(id.length).toBeLessThanOrEqual(36);
  });
});
