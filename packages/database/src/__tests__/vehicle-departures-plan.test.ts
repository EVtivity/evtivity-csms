// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  bindDepartureSessions,
  readinessUpdateSql,
  writeSitePlan,
  type DepartureDb,
  type DepartureReadinessWrite,
} from '../lib/vehicle-departures.js';

const dialect = new PgDialect();

function render(query: SQL): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(query);
}

function entry(
  id: string,
  overrides: Partial<DepartureReadinessWrite> = {},
): DepartureReadinessWrite {
  return {
    departureId: id,
    readiness: 'on_track',
    readinessReason: null,
    plannedKwh: 40.123,
    deliveredKwh: 10,
    shortfallKwh: 0,
    predictedReadyAt: new Date('2026-11-01T04:10:00Z'),
    ...overrides,
  };
}

interface FakeTx {
  tx: DepartureDb;
  executed: SQL[];
  planSets: Array<Record<string, unknown>>;
  clearWheres: SQL[];
}

function fakeTx(
  answer: (query: SQL) => unknown[] = () => [],
  cleared: Array<{ id: string }> = [],
): FakeTx {
  const executed: SQL[] = [];
  const planSets: Array<Record<string, unknown>> = [];
  const clearWheres: SQL[] = [];
  const t = {
    // The writer locks the plan row first; none is stored here.
    select: () => ({
      from: () => ({ where: () => ({ for: () => Promise.resolve([]) }) }),
    }),
    update: () => ({
      set: () => ({
        where: (where: SQL) => {
          clearWheres.push(where);
          return { returning: () => Promise.resolve(cleared) };
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
          planSets.push(config.set);
          return Promise.resolve();
        },
      }),
    }),
    execute: vi.fn((query: SQL) => {
      executed.push(query);
      return Promise.resolve(answer(query));
    }),
  };
  const tx = {
    transaction: (fn: (inner: unknown) => Promise<unknown>) => fn(t),
  } as unknown as DepartureDb;
  return { tx, executed, planSets, clearWheres };
}

const PLAN = {
  staleAtRead: new Date('2026-10-31T12:00:00.123Z'),
  trigger: 'slot_boundary',
  slotStarts: [],
  plan: {},
  siteLoadKw: [],
  capacityKw: [],
  pricePerKwh: [],
  runtimeMs: 12,
};

describe('readiness update', () => {
  it('writes only scheduled departures of the site, and only rows that change', () => {
    const { sql, params } = render(readinessUpdateSql('sit_a', [entry('vdp_1')]));
    expect(sql).toContain("d.status = 'scheduled'");
    expect(sql).toContain('d.site_id = $');
    expect(params).toContain('sit_a');
    for (const column of [
      'readiness',
      'readiness_reason',
      'planned_kwh',
      'delivered_kwh',
      'shortfall_kwh',
      'predicted_ready_at',
    ]) {
      expect(sql).toContain(`d.${column} IS DISTINCT FROM v.${column}`);
    }
    // Never touches the status or the outcome.
    const setPart = sql.slice(sql.indexOf(' SET'), sql.indexOf('FROM (VALUES'));
    expect(setPart).not.toMatch(/\bstatus\s*=/);
    expect(sql).not.toContain('outcome');
  });

  it('sends kWh rounded to the stored two decimals and the ready time as ISO', () => {
    const { params } = render(readinessUpdateSql('sit_a', [entry('vdp_1')]));
    expect(params).toEqual(
      expect.arrayContaining([
        'vdp_1',
        'on_track',
        '40.12',
        '10.00',
        '0.00',
        '2026-11-01T04:10:00.000Z',
      ]),
    );
  });

  it('casts every value so the first row types each column', () => {
    const { sql } = render(readinessUpdateSql('sit_a', [entry('vdp_1'), entry('vdp_2')]));
    expect(sql.match(/::numeric\(8,2\)/g)).toHaveLength(6);
    expect(sql.match(/::timestamptz/g)).toHaveLength(4);
  });
});

describe('writeSitePlan', () => {
  it('leaves a departed entry (null readiness) alone and runs no update without planned rows', async () => {
    const fake = fakeTx();
    const result = await writeSitePlan(
      'sit_a',
      PLAN,
      [entry('vdp_1', { readiness: null })],
      fake.tx,
    );
    expect(fake.executed).toHaveLength(0);
    expect(result.changed).toEqual([]);
    expect(fake.planSets).toHaveLength(1);
  });

  it('reports only the rows the update changed', async () => {
    const fake = fakeTx(() => [
      { id: 'vdp_2', readiness: 'at_risk', readiness_reason: 'site_capacity' },
    ]);
    const result = await writeSitePlan(
      'sit_a',
      PLAN,
      [entry('vdp_1'), entry('vdp_2', { readiness: 'at_risk', readinessReason: 'site_capacity' })],
      fake.tx,
    );
    expect(fake.executed).toHaveLength(1);
    expect(render(fake.executed[0]!).params).not.toContain('vdp_9');
    expect(result.changed).toEqual([
      { id: 'vdp_2', readiness: 'at_risk', readinessReason: 'site_capacity' },
    ]);
  });

  it('clears the stale mark only when it is still the one the planner read', async () => {
    const fake = fakeTx();
    await writeSitePlan('sit_a', PLAN, [], fake.tx);
    const staleAt = fake.planSets[0]?.['staleAt'] as SQL;
    const { sql, params } = render(staleAt);
    expect(sql).toMatch(
      /CASE WHEN .*stale_at.* IS NOT DISTINCT FROM \$1::timestamptz THEN NULL ELSE .*stale_at.* END/,
    );
    expect(params).toEqual([PLAN.staleAtRead.toISOString()]);
  });

  it('clears the readiness of scheduled departures of the site the run did not list', async () => {
    const fake = fakeTx(() => [], [{ id: 'vdp_moved' }]);
    const result = await writeSitePlan(
      'sit_a',
      PLAN,
      [entry('vdp_1'), entry('vdp_left', { readiness: null })],
      fake.tx,
    );
    const { sql, params } = render(fake.clearWheres[0]!);
    expect(sql).toContain('"status" = $');
    expect(sql).toContain('not in');
    // Listed ids, departed ones included, keep what the update decided.
    expect(params).toEqual(expect.arrayContaining(['sit_a', 'scheduled', 'vdp_1', 'vdp_left']));
    expect(result.changed).toEqual([{ id: 'vdp_moved', readiness: null, readinessReason: null }]);
  });

  it('splits a large depot into updates of at most 1000 departures', async () => {
    const fake = fakeTx();
    const entries = Array.from({ length: 2001 }, (_, i) => entry(`vdp_${String(i)}`));
    await writeSitePlan('sit_a', PLAN, entries, fake.tx);
    expect(fake.executed).toHaveLength(3);
  });
});

describe('bindDepartureSessions', () => {
  it('binds only scheduled departures of the site whose session changes', async () => {
    const execute = vi.fn((_query: SQL) => Promise.resolve([{ id: 'vdp_1' }]));
    const tx = { execute } as unknown as DepartureDb;
    const ids = await bindDepartureSessions(
      'sit_a',
      [{ departureId: 'vdp_1', sessionId: 'ses_1' }],
      tx,
    );
    expect(ids).toEqual(['vdp_1']);
    const { sql, params } = render(execute.mock.calls[0]![0]);
    expect(sql).toContain("d.status = 'scheduled'");
    expect(sql).toContain('d.session_id IS DISTINCT FROM v.session_id');
    expect(params).toEqual(['vdp_1', 'ses_1', 'sit_a']);
  });

  it('unbinds with a null session', async () => {
    const execute = vi.fn((_query: SQL) => Promise.resolve([{ id: 'vdp_1' }]));
    const tx = { execute } as unknown as DepartureDb;
    await bindDepartureSessions('sit_a', [{ departureId: 'vdp_1', sessionId: null }], tx);
    const { params } = render(execute.mock.calls[0]![0]);
    expect(params).toEqual(['vdp_1', null, 'sit_a']);
  });

  it('writes nothing without bindings', async () => {
    const execute = vi.fn();
    const tx = { execute } as unknown as DepartureDb;
    expect(await bindDepartureSessions('sit_a', [], tx)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
