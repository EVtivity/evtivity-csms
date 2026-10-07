// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearPrepaidAuthorizations,
  prepaidCacheExpiry,
  prepaidCredit,
  prepaidMaxCost,
  rememberPrepaidAuthorization,
} from '../../authorization/prepaid.js';

beforeEach(() => {
  clearPrepaidAuthorizations();
});

describe('prepaidCredit', () => {
  it('treats a null balance as a postpaid token', () => {
    expect(prepaidCredit(null)).toBe('not_prepaid');
    expect(prepaidCredit(undefined)).toBe('not_prepaid');
  });

  it('has credit only for a positive balance', () => {
    expect(prepaidCredit(1)).toBe('credit');
    expect(prepaidCredit(0)).toBe('no_credit');
    expect(prepaidCredit(-100)).toBe('no_credit');
  });
});

describe('prepaidMaxCost', () => {
  it('converts cents to major currency units', () => {
    expect(prepaidMaxCost(1234)).toBe(12.34);
    expect(prepaidMaxCost(5000)).toBe(50);
  });
});

describe('prepaid authorization time', () => {
  it('repeats the Authorize time for the same station and token', () => {
    const at = new Date('2026-10-02T10:00:00.000Z');
    const remembered = rememberPrepaidAuthorization('CS-1', 'TOKEN', at);
    expect(remembered).toBe('2026-10-02T10:00:00.000Z');
    expect(prepaidCacheExpiry('CS-1', 'TOKEN', new Date('2026-10-02T10:01:00.000Z'))).toBe(
      remembered,
    );
  });

  it('uses now for another station or token', () => {
    rememberPrepaidAuthorization('CS-1', 'TOKEN', new Date('2026-10-02T10:00:00.000Z'));
    const now = new Date('2026-10-02T10:01:00.000Z');
    expect(prepaidCacheExpiry('CS-2', 'TOKEN', now)).toBe(now.toISOString());
    expect(prepaidCacheExpiry('CS-1', 'OTHER', now)).toBe(now.toISOString());
  });

  it('uses now once the remembered decision is older than 10 minutes', () => {
    rememberPrepaidAuthorization('CS-1', 'TOKEN', new Date('2026-10-02T10:00:00.000Z'));
    const now = new Date('2026-10-02T10:10:00.001Z');
    expect(prepaidCacheExpiry('CS-1', 'TOKEN', now)).toBe(now.toISOString());
  });
});

describe('prepaid authorization memory bound', () => {
  const MAX = 10_000;
  const base = Date.parse('2026-10-02T10:00:00.000Z');

  it('drops expired entries when the memory is full', () => {
    for (let i = 0; i < MAX; i++) {
      rememberPrepaidAuthorization('CS-OLD', `T${String(i)}`, new Date(base));
    }
    // A second live entry made after the first ones expired.
    const later = new Date(base + 11 * 60 * 1000);
    rememberPrepaidAuthorization('CS-NEW', 'FRESH', later);
    rememberPrepaidAuthorization('CS-NEW', 'SECOND', later);

    // Both new decisions are remembered: the expired ones made room, so the
    // oldest-entry fallback did not drop FRESH.
    expect(prepaidCacheExpiry('CS-NEW', 'FRESH', later)).toBe(later.toISOString());
    expect(prepaidCacheExpiry('CS-NEW', 'SECOND', later)).toBe(later.toISOString());
    // The expired entries are gone even when asked about at their own time.
    const atBase = new Date(base + 1000);
    expect(prepaidCacheExpiry('CS-OLD', 'T0', atBase)).toBe(atBase.toISOString());
  });

  it('evicts the oldest entry when the memory is full of live entries', () => {
    for (let i = 0; i < MAX; i++) {
      rememberPrepaidAuthorization('CS', `T${String(i)}`, new Date(base + i));
    }
    const at = new Date(base + MAX);
    rememberPrepaidAuthorization('CS', 'NEXT', at);

    const check = new Date(base + MAX + 1);
    // The first entry made room; the second and the new one are still remembered.
    expect(prepaidCacheExpiry('CS', 'T0', check)).toBe(check.toISOString());
    expect(prepaidCacheExpiry('CS', 'T1', check)).toBe(new Date(base + 1).toISOString());
    expect(prepaidCacheExpiry('CS', 'NEXT', check)).toBe(at.toISOString());
  });
});
