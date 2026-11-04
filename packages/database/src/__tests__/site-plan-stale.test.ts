// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ServiceLogger } from '@evtivity/lib';

const dbMock = vi.hoisted(() => {
  const conflictSets: Array<Record<string, unknown>> = [];
  return {
    conflictSets,
    execute: vi.fn((_query: unknown) => Promise.resolve([])),
    insert: vi.fn(() => ({
      values: () => ({
        onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
          conflictSets.push(config.set);
          return Promise.resolve();
        },
      }),
    })),
  };
});

vi.mock('../config.js', () => ({ db: dbMock }));

import { markSitePlanStale } from '../lib/vehicle-departures.js';

const dialect = new PgDialect();

function makeLogger(): ServiceLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

beforeEach(() => {
  dbMock.conflictSets.length = 0;
});

describe('markSitePlanStale', () => {
  it('marks any site and creates its plan row', async () => {
    expect(await markSitePlanStale('sit_a', 'departure_created', makeLogger())).toBe(true);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(dbMock.conflictSets[0]?.['trigger']).toBe('departure_created');
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('marks only a departure-aware site when asked, in one statement', async () => {
    expect(
      await markSitePlanStale('sit_a', 'session_started', makeLogger(), {
        departureAwareOnly: true,
      }),
    ).toBe(true);
    expect(dbMock.insert).not.toHaveBeenCalled();
    const { sql, params } = dialect.sqlToQuery(dbMock.execute.mock.calls[0]![0] as SQL);
    expect(sql).toContain('INSERT INTO site_charging_plans');
    expect(sql).toContain("strategy = 'departure_aware'");
    expect(sql).toContain('ON CONFLICT (site_id) DO UPDATE');
    expect(params).toEqual(['sit_a', 'session_started', 'sit_a']);
  });

  it('never throws: a failed mark is logged and the next slot replans', async () => {
    dbMock.execute.mockRejectedValueOnce(new Error('db down'));
    const log = makeLogger();
    expect(
      await markSitePlanStale('sit_a', 'panel_changed', log, { departureAwareOnly: true }),
    ).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_a', trigger: 'panel_changed' }),
      'Site charging plan not marked stale, the next cycle replans',
    );
  });
});
