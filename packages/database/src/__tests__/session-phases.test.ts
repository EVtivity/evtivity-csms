// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { recordReportedPhaseCount, recordSessionPhases } from '../lib/session-phases.js';

interface Call {
  text: string;
  values: unknown[];
}

function makeSql(rows: Record<string, unknown>[] = []): { sql: postgres.Sql; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(rows);
  };
  return { sql: fn as unknown as postgres.Sql, calls };
}

describe('recordSessionPhases', () => {
  it('writes the phases of the matched session only when they differ', async () => {
    const { sql, calls } = makeSql([{ id: 'ses_1' }]);
    const changed = await recordSessionPhases(sql, {
      stationUuid: 'sta_1',
      sessionId: 'ses_1',
      evseUuid: 'evs_1',
      phases: 'L1',
    });
    expect(changed).toBe(true);
    expect(calls[0]?.text).toContain('SET ev_phases = ?');
    expect(calls[0]?.text).toContain('ev_phases IS DISTINCT FROM ?');
    expect(calls[0]?.text).toContain("status = 'active'");
    expect(calls[0]?.values).toEqual(['L1', 'sta_1', 'ses_1', 'ses_1', 'evs_1', 'L1']);
  });

  it('writes nothing without a session or an EVSE', async () => {
    const { sql, calls } = makeSql();
    expect(
      await recordSessionPhases(sql, {
        stationUuid: 'sta_1',
        sessionId: null,
        evseUuid: null,
        phases: 'L1',
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('recordReportedPhaseCount', () => {
  it('sets three phases only while the phases are unknown', async () => {
    const { sql, calls } = makeSql([{ id: 'ses_1' }]);
    expect(await recordReportedPhaseCount(sql, 'sta_1', 'tx-1', 3)).toBe(true);
    expect(calls[0]?.text).toContain('ev_phases IS NULL');
    expect(calls[0]?.values).toEqual(['L1L2L3', 'sta_1', 'tx-1']);
  });

  it('writes nothing for one or two phases', async () => {
    const { sql, calls } = makeSql();
    expect(await recordReportedPhaseCount(sql, 'sta_1', 'tx-1', 1)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
