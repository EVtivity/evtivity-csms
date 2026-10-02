// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearPrepaidAuthorizations,
  prepaidCacheExpiry,
  prepaidCredit,
  prepaidMaxCost,
  rememberPrepaidAuthorization,
} from '../../handlers/prepaid.js';

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
