// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach } from 'vitest';
import type postgres from 'postgres';
import {
  clearStationFirmwareInstalling,
  recomputeStationAvailability,
  setStationDisabled,
} from '../lib/station-status.js';

interface Call {
  text: string;
  values: unknown[];
  inTransaction: boolean;
}

let calls: Call[] = [];
let results: unknown[][] = [];
let inTransaction = false;

function createSqlMock(): postgres.Sql {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    calls.push({ text: strings.join('?'), values, inTransaction });
    return Promise.resolve(results.shift() ?? []);
  };
  const mock = sqlFn as unknown as Record<string, unknown>;
  mock['unsafe'] = (text: string) => text;
  mock['begin'] = async (fn: (tx: unknown) => Promise<unknown>) => {
    inTransaction = true;
    try {
      return await fn(sqlFn);
    } finally {
      inTransaction = false;
    }
  };
  return sqlFn as unknown as postgres.Sql;
}

describe('station status entry point', () => {
  let sql: postgres.Sql;

  beforeEach(() => {
    calls = [];
    results = [];
    sql = createSqlMock();
  });

  describe('recomputeStationAvailability', () => {
    it('locks the station row, then computes and writes in a later statement', async () => {
      results = [[], [{ id: 'sta_1' }]];
      const change = await recomputeStationAvailability(sql, 'sta_1');

      expect(change.availabilityChanged).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c.inTransaction)).toBe(true);
      expect(calls[0]?.text).toContain('FOR UPDATE');
      expect(calls[0]?.values).toEqual(['sta_1']);
      // The availability rule is computed by the UPDATE itself, so it reads the
      // inputs as committed when the lock was granted.
      expect(calls[1]?.text).toMatch(/UPDATE charging_stations cs\s+SET availability = \?/);
      expect(calls[1]?.text).toContain('IS DISTINCT FROM ?');
      expect(calls[1]?.values).toContain('sta_1');
      expect(
        calls[1]?.values.filter((v) => typeof v === 'string' && v.includes('disabled_reason')),
      ).toHaveLength(2);
    });

    it('reports no change when the stored value is already correct', async () => {
      results = [[], []];
      const change = await recomputeStationAvailability(sql, 'sta_1');
      expect(change.availabilityChanged).toBe(false);
    });
  });

  describe('setStationDisabled', () => {
    it('enabling clears the disable and any firmware state, installing included', async () => {
      await setStationDisabled(sql, 'sta_1', null);

      const enable = calls[0];
      expect(enable?.inTransaction).toBe(false);
      expect(enable?.text).toContain('SET disabled_reason = NULL, firmware_state = NULL');
      expect(enable?.text).toContain('firmware_state IS NOT NULL');
      expect(enable?.text).not.toContain("'failed'");
      expect(calls.slice(1).every((c) => c.inTransaction)).toBe(true);
    });

    it('a security disable never replaces an existing disable', async () => {
      await setStationDisabled(sql, 'sta_1', 'security');
      expect(calls[0]?.text).toContain("SET disabled_reason = 'security'");
      expect(calls[0]?.text).toContain('disabled_reason IS NULL');
    });
  });

  describe('clearStationFirmwareInstalling', () => {
    it('clears only an install in progress, then recomputes', async () => {
      results = [[], [], [{ id: 'sta_1' }]];
      const change = await clearStationFirmwareInstalling(sql, 'sta_1');

      expect(calls[0]?.text).toContain('SET firmware_state = NULL');
      expect(calls[0]?.text).toContain("firmware_state = 'installing'");
      expect(calls[1]?.text).toContain('FOR UPDATE');
      expect(change.availabilityChanged).toBe(true);
    });
  });
});
