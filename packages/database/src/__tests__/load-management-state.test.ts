// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { clearEvseLimitsRefused, markEvseLimitsRefused } from '../lib/load-management-state.js';

interface Call {
  text: string;
  values: unknown[];
}

function makeSql(result: unknown): { sql: postgres.Sql; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(result);
  };
  return { sql: fn as unknown as postgres.Sql, calls };
}

describe('markEvseLimitsRefused', () => {
  it('marks the station only for a transaction in its stored EVSE limits and resends the site', async () => {
    const { sql, calls } = makeSql([{ marked: 1 }]);
    expect(await markEvseLimitsRefused(sql, 'sta_1', 'tx-1')).toBe(true);
    const text = calls[0]?.text ?? '';
    expect(text).toContain('SET evse_limits_refused_at = now()');
    expect(text).toContain('cs.evse_limits_refused_at IS NULL');
    expect(text).toContain("v.x ->> 'transactionId' = ?");
    expect(text).toContain('SET applied_at = NULL');
    expect(calls[0]?.values).toEqual(['sta_1', 'tx-1']);
  });

  it('reports nothing marked when no row matched', async () => {
    const { sql } = makeSql([{ marked: 0 }]);
    expect(await markEvseLimitsRefused(sql, 'sta_1', 'tx-9')).toBe(false);
  });
});

describe('clearEvseLimitsRefused', () => {
  it('clears a stored refusal only', async () => {
    const { sql, calls } = makeSql({ count: 1 });
    expect(await clearEvseLimitsRefused(sql, 'sta_1')).toBe(true);
    expect(calls[0]?.text).toContain('SET evse_limits_refused_at = NULL');
    expect(calls[0]?.text).toContain('evse_limits_refused_at IS NOT NULL');
    const none = makeSql({ count: 0 });
    expect(await clearEvseLimitsRefused(none.sql, 'sta_1')).toBe(false);
  });
});
