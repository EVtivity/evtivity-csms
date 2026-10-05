// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach } from 'vitest';
import type postgres from 'postgres';
import {
  applyConnectorStatus,
  applyEvseChargingState,
  clearStationFirmwareInstalling,
  recomputeStationAvailability,
  setStationDisabled,
  setStationReportedStatus,
  startStatusOrderingEpoch,
  statusReportedAt,
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

  describe('statusReportedAt', () => {
    const now = new Date('2026-10-04T12:00:00Z');

    it('uses the station timestamp', () => {
      expect(statusReportedAt('2026-10-04T11:59:00Z', now)?.toISOString()).toBe(
        '2026-10-04T11:59:00.000Z',
      );
    });

    it('clamps a timestamp in the future to the receipt time', () => {
      expect(statusReportedAt('2027-01-01T00:00:00Z', now)).toEqual(now);
    });

    it('returns null for a missing or unreadable timestamp', () => {
      expect(statusReportedAt(undefined, now)).toBeNull();
      expect(statusReportedAt(null, now)).toBeNull();
      expect(statusReportedAt('not a time', now)).toBeNull();
      expect(statusReportedAt(42, now)).toBeNull();
    });
  });

  describe('applyConnectorStatus ordering', () => {
    const input = {
      stationUuid: 'sta_1',
      evseId: 1,
      connectorId: 1,
      status: 'occupied',
      timestamp: '2026-10-04T10:00:00Z',
    };

    it('writes behind the timestamp guard and the row lock in one statement', async () => {
      results = [[{ id: 'evs_1' }], [{ previous_status: 'available', applied: true }]];
      const result = await applyConnectorStatus(sql, input);

      expect(result).toMatchObject({
        stationExists: true,
        applied: true,
        previousStatus: 'available',
      });
      const write = calls[1];
      expect(write?.text).toContain('FOR UPDATE');
      expect(write?.text).toMatch(
        /c\.status_reported_at IS NULL OR \?::timestamptz IS NULL\s+OR \?::timestamptz >= c\.status_reported_at/,
      );
      expect(write?.values).toContainEqual(new Date('2026-10-04T10:00:00Z'));
      expect(calls[2]?.text).toContain('INSERT INTO port_status_log');
    });

    it('a report older than the stored one writes nothing else', async () => {
      results = [[{ id: 'evs_1' }], [{ previous_status: 'available', applied: false }]];
      const result = await applyConnectorStatus(sql, input);

      expect(result).toMatchObject({
        stationExists: true,
        applied: false,
        availabilityChanged: false,
      });
      // No port_status_log row and no availability recompute.
      expect(calls).toHaveLength(2);
    });

    it('a report without a timestamp is written with a NULL timestamp', async () => {
      results = [[{ id: 'evs_1' }], [{ previous_status: 'available', applied: true }]];
      await applyConnectorStatus(sql, { ...input, timestamp: null });
      expect(calls[1]?.values.filter((v) => v === null).length).toBeGreaterThanOrEqual(3);
    });

    it('creates a missing connector through the same guard on conflict', async () => {
      results = [[{ id: 'evs_1' }], [], [{ id: 'con_1' }]];
      const result = await applyConnectorStatus(sql, input);

      expect(result).toMatchObject({ applied: true, autoCreated: true });
      expect(calls[2]?.text).toContain('ON CONFLICT (evse_id, connector_id) DO UPDATE');
      expect(calls[2]?.text).toContain(
        'EXCLUDED.status_reported_at >= connectors.status_reported_at',
      );
      expect(calls[3]?.text).toContain('INSERT INTO port_status_log');
    });

    it('a concurrent newer report wins the connector insert race', async () => {
      results = [[{ id: 'evs_1' }], [], []];
      const result = await applyConnectorStatus(sql, input);
      expect(result).toMatchObject({ applied: false, autoCreated: false });
      expect(calls).toHaveLength(3);
    });
  });

  describe('setStationReportedStatus ordering', () => {
    it('applies a newer report and logs the change as EVSE 0', async () => {
      results = [[{ previous_status: 'available', applied: true }], [], [], []];
      const change = await setStationReportedStatus(
        sql,
        'sta_1',
        'unavailable',
        '2026-10-04T10:00:00Z',
      );

      expect(change.applied).toBe(true);
      expect(calls[0]?.text).toContain('FOR UPDATE');
      expect(calls[0]?.text).toContain('reported_status_at = ?::timestamptz');
      expect(calls[0]?.text).toContain('>= cs.reported_status_at');
      expect(calls[1]?.text).toContain('INSERT INTO port_status_log');
    });

    it('ignores an older report', async () => {
      results = [[{ previous_status: 'available', applied: false }]];
      const change = await setStationReportedStatus(
        sql,
        'sta_1',
        'faulted',
        '2026-10-04T09:00:00Z',
      );
      expect(change).toEqual({ applied: false, availabilityChanged: false });
      expect(calls).toHaveLength(1);
    });

    it('does nothing for a station that no longer exists', async () => {
      results = [[]];
      const change = await setStationReportedStatus(sql, 'sta_gone', 'available', null);
      expect(change.applied).toBe(false);
      expect(calls).toHaveLength(1);
    });
  });

  describe('startStatusOrderingEpoch', () => {
    it('forgets the report timestamps of the station and its connectors, not the statuses', async () => {
      await startStatusOrderingEpoch(sql, 'sta_1');

      expect(calls).toHaveLength(1);
      const text = calls[0]?.text ?? '';
      expect(text).toContain('UPDATE connectors c SET status_reported_at = NULL');
      expect(text).toContain('e.station_id = ?');
      expect(text).toContain('UPDATE charging_stations SET reported_status_at = NULL');
      expect(text).not.toMatch(/SET status =|reported_status =/);
      expect(calls[0]?.values).toEqual(['sta_1', 'sta_1']);
    });
  });

  describe('applyEvseChargingState', () => {
    it('keeps faulted and unavailable connectors and orders by the event timestamp', async () => {
      results = [[{ id: 'con_1' }]];
      const changed = await applyEvseChargingState(
        sql,
        'evs_1',
        'charging',
        '2026-10-04T10:00:00Z',
      );

      expect(changed).toBe(true);
      expect(calls[0]?.text).toContain("status NOT IN ('faulted', 'unavailable')");
      expect(calls[0]?.text).toContain('?::timestamptz >= status_reported_at');
      expect(calls[0]?.values).toContainEqual(new Date('2026-10-04T10:00:00Z'));
    });

    it('reports no change when every connector holds a newer or sticky status', async () => {
      results = [[]];
      expect(await applyEvseChargingState(sql, 'evs_1', 'charging', null)).toBe(false);
    });
  });
});
