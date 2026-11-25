// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  applyStationLimitEvent,
  clearEvseLimitsRefused,
  EVSE_LIMIT_REFUSAL_WINDOW_MS,
  markEvseLimitsRefused,
  stationEntryAfterEvent,
  writeLoadManagementRecords,
  allocationsAfterStationEvent,
} from '../lib/load-management-state.js';
import { runWithLoadManagementFence } from '../lib/load-management-fence.js';

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
  it('counts a refusal of a live transaction in its stored EVSE limits and falls back after three', async () => {
    const { sql, calls } = makeSql([{ marked: 1 }]);
    expect(await markEvseLimitsRefused(sql, 'sta_1', 'tx-1')).toBe(true);
    const text = calls[0]?.text ?? '';
    expect(text).toContain('SET evse_limit_refusals = CASE');
    expect(text).toContain('THEN now()');
    expect(text).toContain('cs.evse_limits_refused_at IS NULL');
    expect(text).toContain("s.status = 'active'");
    expect(text).toContain("v.x ->> 'transactionId' = ?");
    expect(text).toContain('SET applied_at = NULL');
    // Every counted refusal resends, not only the fallback.
    expect(text).toContain('FROM counted');
    // Refusals count only within the window since the last one (24 h).
    expect(text).toContain('cs.evse_limit_refusal_at < now() - make_interval');
    expect(text).toContain('evse_limit_refusal_at = now()');
    expect(EVSE_LIMIT_REFUSAL_WINDOW_MS).toBe(86_400_000);
    expect(calls[0]?.values).toEqual([86400, 3, 86400, 86400, 3, 'sta_1', 3600, 'tx-1', 'tx-1']);
  });

  it('never counts a refusal for a transaction the station no longer has (TxNotFound)', async () => {
    const { sql, calls } = makeSql([{ marked: 1 }]);
    expect(await markEvseLimitsRefused(sql, 'sta_1', 'tx-1', 'TxNotFound')).toBe(false);
    expect(calls).toHaveLength(0);
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

describe('writeLoadManagementRecords', () => {
  function lockedSql(row: Record<string, unknown> | undefined): {
    sql: postgres.Sql;
    calls: Call[];
  } {
    const calls: Call[] = [];
    const tx = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
        calls.push({ text: strings.join('?'), values });
        const locking = strings.join('?').includes('FOR UPDATE');
        return Promise.resolve(locking && row != null ? [row] : []);
      },
      { json: (v: unknown) => v },
    );
    const sql = { begin: (fn: (t: unknown) => unknown) => fn(tx) } as unknown as postgres.Sql;
    return { sql, calls };
  }
  const locked = [{ stationDbId: 'sta_1', allocatedKw: 10 }];

  it('builds from the locked row and nulls applied_at while load management is on', async () => {
    const { sql, calls } = lockedSql({
      applied_allocations: locked,
      cycle_fence: 3,
      is_enabled: true,
    });
    const seen: unknown[] = [];
    const wrote = await writeLoadManagementRecords(
      sql,
      'sit_1',
      (row) => {
        seen.push(row);
        return [{ stationDbId: 'sta_1', allocatedKw: 5 }];
      },
      { nullAppliedAt: true },
    );
    expect(wrote).toBe(true);
    expect(seen).toEqual([locked]);
    expect(calls[0]?.text).toContain('FOR UPDATE');
    expect(calls[1]?.text).toContain('applied_at = NULL');
    expect(calls[1]?.values[0]).toEqual([{ stationDbId: 'sta_1', allocatedKw: 5 }]);
  });

  it('keeps applied_at for the record of the raises', async () => {
    const { sql, calls } = lockedSql({
      applied_allocations: locked,
      cycle_fence: 3,
      is_enabled: true,
    });
    expect(await writeLoadManagementRecords(sql, 'sit_1', () => [])).toBe(true);
    expect(calls[1]?.text).not.toContain('applied_at');
  });

  it('writes nothing once load management is off or a newer holder raised the fence', async () => {
    const off = lockedSql({ applied_allocations: locked, cycle_fence: 3, is_enabled: false });
    expect(await writeLoadManagementRecords(off.sql, 'sit_1', () => [])).toBe(false);
    expect(off.calls).toHaveLength(1);
    const gone = lockedSql(undefined);
    expect(await writeLoadManagementRecords(gone.sql, 'sit_1', () => [])).toBe(false);
    const moved = lockedSql({ applied_allocations: locked, cycle_fence: 4, is_enabled: true });
    const stale = await runWithLoadManagementFence({ siteId: 'sit_1', fence: 3 }, () =>
      writeLoadManagementRecords(moved.sql, 'sit_1', () => []),
    );
    expect(stale).toBe(false);
    expect(moved.calls).toHaveLength(1);
    const held = lockedSql({ applied_allocations: locked, cycle_fence: 3, is_enabled: true });
    const current = await runWithLoadManagementFence({ siteId: 'sit_1', fence: 3 }, () =>
      writeLoadManagementRecords(held.sql, 'sit_1', () => []),
    );
    expect(current).toBe(true);
  });
});

describe('stationEntryAfterEvent', () => {
  const awaiting = { state: 'awaiting', commandId: 'c2', sentKw: 8, mightKw: 20 };
  const base = { stationId: 'CS-1', stationDbId: 'sta_1', allocatedKw: 8, limit: awaiting };

  it('accepts only the reply to the command the record waits on', () => {
    const old = stationEntryAfterEvent(base, {
      type: 'reply',
      accepted: true,
      commandId: 'c1',
      unit: 'W',
    });
    expect(old['limit']).toEqual(awaiting);
    const ok = stationEntryAfterEvent(
      { ...base, rejectedUnits: ['W'] },
      { type: 'reply', accepted: true, commandId: 'c2', unit: 'W' },
    );
    expect(ok['limit']).toEqual({ state: 'accepted', commandId: 'c2', sentKw: 8, mightKw: 8 });
    expect(ok['rejectedUnits']).toBeUndefined();
    // Every accepted reply records its unit: a station that accepted A stays on A limits.
    expect(ok['acceptedUnits']).toEqual(['W']);
    const both = stationEntryAfterEvent(
      { ...base, acceptedUnits: ['W'] },
      { type: 'reply', accepted: true, commandId: 'c2', unit: 'A' },
    );
    expect(both['acceptedUnits']).toEqual(['W', 'A']);
    const refused = stationEntryAfterEvent(base, {
      type: 'reply',
      accepted: false,
      commandId: 'c2',
      unit: 'A',
    });
    expect(refused['acceptedUnits']).toBeUndefined();
    // No command id (a reply of an earlier release): the record does not move.
    const none = stationEntryAfterEvent(base, {
      type: 'reply',
      accepted: true,
      commandId: null,
      unit: 'W',
    });
    expect(none['limit']).toEqual(awaiting);
  });

  it('refuses on a rejection and adds the unit', () => {
    const out = stationEntryAfterEvent(base, {
      type: 'reply',
      accepted: false,
      commandId: 'c2',
      unit: 'A',
    });
    expect(out['limit']).toMatchObject({ state: 'refused', mightKw: null });
    expect(out['rejectedUnits']).toEqual(['A']);
  });

  it('loses an unanswered send at the higher of sent and held, and leaves other commands', () => {
    const lost = stationEntryAfterEvent(base, {
      type: 'notSent',
      commandId: 'c2',
      transactionId: null,
    });
    expect(lost['limit']).toMatchObject({ state: 'lost', mightKw: 20 });
    // A lost raise counts at the raise: the station may have taken it.
    const raised = stationEntryAfterEvent(
      { ...base, limit: { state: 'awaiting', commandId: 'r', sentKw: 25, mightKw: 20 } },
      { type: 'notSent', commandId: 'r', transactionId: null },
    );
    expect(raised['limit']).toMatchObject({ state: 'lost', mightKw: 25 });
    const other = stationEntryAfterEvent(base, {
      type: 'notSent',
      commandId: 'c9',
      transactionId: null,
    });
    expect(other['limit']).toEqual(awaiting);
  });

  it('makes a boot and a clear unknown; a boot also ends the EVSE records', () => {
    const evse = {
      transactionId: 't1',
      limitKw: 4,
      limit: { state: 'accepted', commandId: 'e', sentKw: 4, mightKw: null },
    };
    const booted = stationEntryAfterEvent({ ...base, evses: [evse] }, { type: 'boot' });
    expect(booted['limit']).toEqual({ state: 'unknown', mightKw: null });
    expect((booted['evses'] as Array<Record<string, unknown>>)[0]?.['limit']).toEqual({
      state: 'unknown',
      mightKw: null,
    });
    const cleared = stationEntryAfterEvent({ ...base, evses: [evse] }, { type: 'cleared' });
    expect(cleared['limit']).toEqual({ state: 'unknown', mightKw: null });
    expect((cleared['evses'] as Array<Record<string, unknown>>)[0]?.['limit']).toEqual(evse.limit);
  });

  it('moves the EVSE record of a transaction, records an ISO 15118 send and drops a gone one', () => {
    const evse = {
      transactionId: 't1',
      limitKw: 4,
      limit: { state: 'accepted', commandId: 'e1', sentKw: 4, mightKw: null },
    };
    const entry = { ...base, evses: [evse] };
    const iso = stationEntryAfterEvent(entry, {
      type: 'evseSend',
      transactionId: 't1',
      commandId: 'iso',
      kw: 7,
    });
    const isoLimit = (iso['evses'] as Array<Record<string, unknown>>)[0]?.['limit'];
    expect(isoLimit).toEqual({ state: 'awaiting', commandId: 'iso', sentKw: 7, mightKw: 4 });
    const answered = stationEntryAfterEvent(iso, {
      type: 'evseReply',
      accepted: true,
      commandId: 'iso',
      transactionId: 't1',
    });
    expect((answered['evses'] as Array<Record<string, unknown>>)[0]?.['limit']).toEqual({
      state: 'accepted',
      commandId: 'iso',
      sentKw: 7,
      mightKw: 7,
    });
    const gone = stationEntryAfterEvent(iso, { type: 'evseGone', transactionId: 't1' });
    expect(gone['evses']).toBeUndefined();
    // A send for a transaction without a record changes nothing.
    expect(
      stationEntryAfterEvent(entry, {
        type: 'evseSend',
        transactionId: 'tx',
        commandId: 'x',
        kw: 1,
      }),
    ).toEqual(entry);
  });

  it('keeps what a refused credit profile left the station holding', () => {
    const credit = {
      limit: { state: 'awaiting', commandId: 'cr', sentKw: 30, mightKw: 25 },
      until: '2026-11-24T12:00:00.000Z',
    };
    const out = stationEntryAfterEvent(
      { ...base, credit },
      { type: 'creditReply', accepted: false, commandId: 'cr' },
    );
    expect((out['credit'] as Record<string, unknown>)['limit']).toEqual({
      state: 'lost',
      mightKw: 30,
    });
  });
});

describe('applyStationLimitEvent', () => {
  function stationSql(
    rows: Array<Record<string, unknown>>,
    storedLimit = false,
  ): { sql: postgres.Sql; calls: Call[] } {
    const calls: Call[] = [];
    const tx = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
        const text = strings.join('?');
        calls.push({ text, values });
        if (text.includes('FOR UPDATE')) return Promise.resolve(rows);
        if (text.includes('FROM charging_profiles')) {
          return Promise.resolve(storedLimit ? [{ found: 1 }] : []);
        }
        return Promise.resolve({ count: 1 });
      },
      { json: (v: unknown) => v },
    );
    const sql = { begin: (fn: (t: unknown) => unknown) => fn(tx) } as unknown as postgres.Sql;
    return { sql, calls };
  }
  const entry = {
    stationId: 'CS-1',
    stationDbId: 'sta_1',
    allocatedKw: 8,
    limit: { state: 'awaiting', commandId: 'c1', sentKw: 8, mightKw: 20 },
  };

  it('writes the moved record under the row lock and nothing when unchanged', async () => {
    const { sql, calls } = stationSql([
      { site_id: 'sit_1', applied_allocations: [entry], station_id: 'CS-1', on_circuit: true },
    ]);
    expect(
      await applyStationLimitEvent(sql, 'sta_1', {
        type: 'reply',
        accepted: true,
        commandId: 'c1',
        unit: 'W',
      }),
    ).toBe(true);
    expect(calls[0]?.text).toContain('FOR UPDATE OF slm');
    expect(calls[0]?.text).toContain('is_enabled = true');
    expect(calls[1]?.text).not.toContain('applied_at');
    calls.length = 0;
    const again = await applyStationLimitEvent(sql, 'sta_1', {
      type: 'reply',
      accepted: true,
      commandId: 'other',
      unit: 'W',
    });
    expect(again).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('sends again at once after a refusal in a new unit, a lost send, a boot or a clear', async () => {
    const events = [
      { type: 'reply', accepted: false, commandId: 'c1', unit: 'W' },
      { type: 'notSent', commandId: 'c1', transactionId: null },
      { type: 'boot' },
      { type: 'cleared' },
    ] as const;
    for (const event of events) {
      const { sql, calls } = stationSql([
        { site_id: 'sit_1', applied_allocations: [entry], station_id: 'CS-1', on_circuit: true },
      ]);
      expect(await applyStationLimitEvent(sql, 'sta_1', event)).toBe(true);
      expect(calls[1]?.text).toContain('applied_at = NULL');
    }
  });

  it('adds an unknown entry for a managed station that boots without one over a stored limit', async () => {
    const { sql, calls } = stationSql(
      [{ site_id: 'sit_1', applied_allocations: null, station_id: 'CS-1', on_circuit: true }],
      true,
    );
    expect(await applyStationLimitEvent(sql, 'sta_1', { type: 'boot' })).toBe(true);
    expect(calls[1]?.text).toContain('FROM charging_profiles');
    expect(calls[2]?.values[0]).toEqual([
      {
        stationId: 'CS-1',
        stationDbId: 'sta_1',
        allocatedKw: 0,
        limit: { state: 'unknown', mightKw: null },
      },
    ]);
    const off = stationSql(
      [{ site_id: 'sit_1', applied_allocations: null, station_id: 'CS-1', on_circuit: false }],
      true,
    );
    expect(await applyStationLimitEvent(off.sql, 'sta_1', { type: 'boot' })).toBe(false);
    // No stored limit: unlimited already, no entry.
    const none = stationSql([
      { site_id: 'sit_1', applied_allocations: null, station_id: 'CS-1', on_circuit: true },
    ]);
    expect(await applyStationLimitEvent(none.sql, 'sta_1', { type: 'boot' })).toBe(false);
  });

  it('writes nothing while load management is off (no locked row)', async () => {
    const { sql, calls } = stationSql([]);
    expect(await applyStationLimitEvent(sql, 'sta_1', { type: 'boot' })).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('allocationsAfterStationEvent', () => {
  const station = { stationUuid: 'sta_1', stationId: 'CS-1' };
  const awaiting = (commandId: string) => [
    {
      stationId: 'CS-1',
      stationDbId: 'sta_1',
      allocatedKw: 7,
      rejectedUnits: ['W'],
      limit: { state: 'awaiting', commandId, sentKw: 7, mightKw: 9 },
    },
  ];

  it('sends again on the next cycle after every refusal, also in a unit refused before (review 15)', () => {
    const out = allocationsAfterStationEvent(
      awaiting('c2'),
      station,
      { type: 'reply', accepted: false, commandId: 'c2', unit: 'W' },
      { hasStoredLimit: false },
    );
    expect(out.changed).toBe(true);
    expect(out.resend).toBe(true);
  });

  it('does not ask for a resend after an accepted reply', () => {
    const out = allocationsAfterStationEvent(
      awaiting('c3'),
      station,
      { type: 'reply', accepted: true, commandId: 'c3', unit: 'A' },
      { hasStoredLimit: false },
    );
    expect(out.resend).toBe(false);
  });

  it('adds an unknown entry for a boot only over a stored station limit', () => {
    expect(
      allocationsAfterStationEvent([], station, { type: 'boot' }, { hasStoredLimit: true }).next,
    ).toEqual([
      {
        stationId: 'CS-1',
        stationDbId: 'sta_1',
        allocatedKw: 0,
        limit: { state: 'unknown', mightKw: null },
      },
    ]);
    expect(
      allocationsAfterStationEvent([], station, { type: 'boot' }, { hasStoredLimit: false })
        .changed,
    ).toBe(false);
  });
});

describe('unit box default records (TxDefaultProfile)', () => {
  const awaiting = { state: 'awaiting', commandId: 'd1', sentKw: 2.9, mightKw: 1 };
  const entry = {
    stationId: 'CS-1',
    stationDbId: 'sta',
    allocatedKw: 10,
    limit: { state: 'accepted', commandId: 'c', sentKw: 10, mightKw: 10 },
    evseDefaults: [
      { evseNumber: 1, limit: awaiting },
      { evseNumber: 2, limit: { ...awaiting, commandId: 'd2' } },
    ],
  };
  const defaultOf = (e: Record<string, unknown>, n: number): Record<string, unknown> | undefined =>
    (e['evseDefaults'] as Array<Record<string, unknown>>).find((d) => d['evseNumber'] === n);
  const unknown = { state: 'unknown', mightKw: null };

  it('applies a reply only to the default of its EVSE and command', () => {
    const next = stationEntryAfterEvent(entry, {
      type: 'defaultReply',
      accepted: true,
      commandId: 'd1',
      evseNumber: 1,
    });
    expect(defaultOf(next, 1)?.['limit']).toMatchObject({ state: 'accepted', sentKw: 2.9 });
    expect(defaultOf(next, 2)?.['limit']).toEqual(entry.evseDefaults[1]?.limit);
    const other = stationEntryAfterEvent(entry, {
      type: 'defaultReply',
      accepted: false,
      commandId: 'd9',
      evseNumber: 1,
    });
    expect(other).toEqual(entry);
    const refused = stationEntryAfterEvent(entry, {
      type: 'defaultReply',
      accepted: false,
      commandId: 'd2',
      evseNumber: 2,
    });
    expect(defaultOf(refused, 2)?.['limit']).toMatchObject({ state: 'refused', mightKw: null });
  });

  it('moves a default never decided on to lost', () => {
    const next = stationEntryAfterEvent(entry, {
      type: 'notSent',
      commandId: 'd1',
      transactionId: null,
      evseDefault: 1,
    });
    expect(defaultOf(next, 1)?.['limit']).toMatchObject({ state: 'lost', mightKw: 2.9 });
    expect(next['limit']).toEqual(entry.limit);
  });

  it('moves every default to unknown on a boot, and the cleared ones on a clear', () => {
    const booted = stationEntryAfterEvent(entry, { type: 'boot' });
    expect(defaultOf(booted, 1)?.['limit']).toEqual(unknown);
    expect(defaultOf(booted, 2)?.['limit']).toEqual(unknown);
    const cleared = stationEntryAfterEvent(entry, { type: 'defaultsCleared', evseNumbers: [2] });
    expect(defaultOf(cleared, 1)?.['limit']).toEqual(awaiting);
    expect(defaultOf(cleared, 2)?.['limit']).toEqual(unknown);
    expect(cleared['limit']).toEqual(entry.limit);
    const all = stationEntryAfterEvent(entry, { type: 'defaultsCleared', evseNumbers: 'all' });
    expect(defaultOf(all, 1)?.['limit']).toEqual(unknown);
  });

  it('sends again at once after a refused default or a clear of one', () => {
    const station = { stationUuid: 'sta', stationId: 'CS-1' };
    const refused = allocationsAfterStationEvent(
      [entry],
      station,
      { type: 'defaultReply', accepted: false, commandId: 'd1', evseNumber: 1 },
      { hasStoredLimit: false },
    );
    expect(refused.resend).toBe(true);
    const cleared = allocationsAfterStationEvent(
      [entry],
      station,
      { type: 'defaultsCleared', evseNumbers: 'all' },
      { hasStoredLimit: false },
    );
    expect(cleared).toMatchObject({ changed: true, resend: true });
  });
});
