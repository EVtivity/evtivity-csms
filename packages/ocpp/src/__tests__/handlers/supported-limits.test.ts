// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
  limitToSupported,
  parseSupportedLimits,
  stationSupportedLimits,
} from '../../handlers/supported-limits.js';

function sqlReturning(rows: Record<string, unknown>[]): {
  sql: postgres.Sql;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const fn = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push([strings.join('?'), ...values]);
    return Promise.resolve(rows);
  });
  return { sql: fn as unknown as postgres.Sql, calls };
}

describe('parseSupportedLimits', () => {
  it('reads the members without case and ignores unknown ones', () => {
    expect([...parseSupportedLimits('MaxEnergy, maxTime,MAXCOST,maxSoC,maxFoo')].sort()).toEqual([
      'maxCost',
      'maxEnergy',
      'maxSoC',
      'maxTime',
    ]);
  });

  it('returns no limits for an empty or null value', () => {
    expect(parseSupportedLimits('').size).toBe(0);
    expect(parseSupportedLimits(null).size).toBe(0);
  });
});

describe('limitToSupported', () => {
  it('keeps only the supported limits', () => {
    expect(
      limitToSupported({ maxCost: 10, maxEnergy: 5000, maxTime: 60 }, new Set(['maxCost'])),
    ).toEqual({ maxCost: 10 });
  });

  it('returns null when no limit is supported', () => {
    expect(limitToSupported({ maxCost: 10 }, new Set(['maxEnergy']))).toBeNull();
    expect(limitToSupported({ maxCost: 10 }, new Set())).toBeNull();
  });

  it('keeps the limit unchanged when the supported limits are not known', () => {
    const limit = { maxCost: 10, maxSoC: 80 };
    expect(limitToSupported(limit, null)).toBe(limit);
  });
});

describe('stationSupportedLimits', () => {
  it('returns null when the station has not reported the variable', async () => {
    const { sql } = sqlReturning([]);
    expect(await stationSupportedLimits(sql, 'sta_1', 1)).toBeNull();
  });

  it('parses the reported value', async () => {
    const { sql, calls } = sqlReturning([{ value: 'MaxEnergy,MaxTime,MaxCost', evse_id: null }]);
    const supported = await stationSupportedLimits(sql, 'sta_1', 1);
    expect([...(supported ?? [])].sort()).toEqual(['maxCost', 'maxEnergy', 'maxTime']);
    expect(calls[0]).toEqual(expect.arrayContaining(['sta_1', 1]));
    expect(calls[0]?.[0]).toContain("variable = 'SupportedLimits'");
  });

  it('treats a reported empty value as no supported limits', async () => {
    const { sql } = sqlReturning([{ value: null, evse_id: null }]);
    expect((await stationSupportedLimits(sql, 'sta_1', null))?.size).toBe(0);
  });
});
