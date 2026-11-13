// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { execute, selectRows, atInWindows, spanInWindows } = vi.hoisted(() => ({
  execute: vi.fn(),
  selectRows: [] as unknown[][],
  atInWindows: vi.fn(),
  spanInWindows: vi.fn(),
}));

vi.mock('@evtivity/database', async () => ({
  ...(await import('@evtivity/database/src/schema/sim.js')),
  db: {
    execute,
    select: () => {
      const rows = selectRows.shift() ?? [];
      const self: Record<string, unknown> = {};
      self['from'] = () => self;
      self['where'] = () => Promise.resolve(rows);
      return self;
    },
  },
}));
vi.mock('@evtivity/services/station-sim.service', () => ({ atInWindows, spanInWindows }));

import {
  parseSimTimelineCursor,
  parseTimelineCursor,
  simAlertItem,
  simSessionItem,
  simTimelinePage,
  timelineMs,
  timelinePageKeys,
} from '../lib/sim-timeline.js';
import { simAlerts, simSessions } from '@evtivity/database';

const dialect = new PgDialect();
const encode = (s: string) => Buffer.from(s).toString('base64url');
const range = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-31T00:00:00Z') };

const sessionRow = {
  id: 11,
  provider: 'hologram',
  startedAt: new Date('2026-10-20T10:00:00Z'),
  endedAt: new Date('2026-10-20T11:00:00Z'),
  bytes: 1024,
  networkName: 'T-Mobile',
  radioAccessTechnology: 'LTE',
  cellId: 'c1',
  apn: 'hologram',
} as unknown as typeof simSessions.$inferSelect;
const alertRow = {
  id: 22,
  provider: 'hologram',
  kind: 'data_limit',
} as unknown as typeof simAlerts.$inferSelect;

beforeEach(() => {
  execute.mockReset();
  selectRows.length = 0;
  atInWindows.mockReturnValue(sql`at_ok`);
  spanInWindows.mockReturnValue(sql`span_ok`);
});

describe('timeline cursors', () => {
  it('refuses cursors of another timeline, a bad time or a bad id', () => {
    expect(parseSimTimelineCursor(encode('2026-10-20T10:00:00.000Z|sim:alert|5'))).toEqual({
      at: new Date('2026-10-20T10:00:00.000Z'),
      from: 'sim:alert',
      id: 5,
    });
    expect(parseSimTimelineCursor(encode('2026-10-20T10:00:00.000Z|ocpp:event|5'))).toBeNull();
    expect(parseSimTimelineCursor(encode('not-a-date|sim:alert|5'))).toBeNull();
    expect(parseSimTimelineCursor(encode('2026-10-20T10:00:00.000Z|sim:alert|x'))).toBeNull();
    expect(parseSimTimelineCursor(encode('only-one-part'))).toBeNull();
    expect(parseTimelineCursor(encode('a|toString|1'), { a: 1 })).toBeNull();
  });

  it('truncates times to milliseconds', () => {
    expect(dialect.sqlToQuery(timelineMs(simAlerts.receivedAt)).sql).toBe(
      `date_trunc('milliseconds', "sim_alerts"."received_at")`,
    );
  });
});

describe('timeline items', () => {
  it('maps sessions and alerts', () => {
    expect(simSessionItem(sessionRow)).toEqual({
      source: 'sim',
      kind: 'session',
      details: {
        provider: 'hologram',
        endedAt: '2026-10-20T11:00:00.000Z',
        bytes: 1024,
        networkName: 'T-Mobile',
        radioAccessTechnology: 'LTE',
        cellId: 'c1',
        apn: 'hologram',
      },
    });
    expect(simAlertItem(alertRow)).toEqual({
      source: 'sim',
      kind: 'data_limit',
      details: { provider: 'hologram' },
    });
  });
});

describe('timelinePageKeys', () => {
  it('returns an empty page without sources and reads nothing', async () => {
    expect(await timelinePageKeys({ a: 0 }, [], { kind: 'page', page: 1, limit: 10 })).toEqual({
      keys: [],
      total: 0,
      nextCursor: null,
      previousAt: null,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads after a cursor, drops unknown ranks and counts the total', async () => {
    execute
      .mockResolvedValueOnce([
        { rank: 1, id: '11', at_ms: String(Date.parse('2026-10-20T10:00:00Z')) },
        { rank: 9, id: '99', at_ms: '0' },
        { rank: 0, id: 22, at_ms: Date.parse('2026-10-19T10:00:00Z') },
      ])
      .mockResolvedValueOnce([{ total: '7' }]);
    const cursorAt = new Date('2026-10-21T00:00:00Z');
    const page = await timelinePageKeys(
      { 'sim:session': 1, 'sim:alert': 0 },
      [
        {
          from: 'sim:session',
          table: simSessions,
          id: simSessions.id,
          at: simSessions.startedAt,
          where: undefined,
        },
        {
          from: 'sim:alert',
          table: simAlerts,
          id: simAlerts.id,
          at: simAlerts.receivedAt,
          where: undefined,
        },
      ],
      { kind: 'cursor', cursor: { at: cursorAt, from: 'sim:alert', id: 3 }, limit: 2 },
    );
    expect(page.keys).toEqual([
      { at: new Date('2026-10-20T10:00:00Z'), from: 'sim:session', id: 11 },
      { at: new Date('2026-10-19T10:00:00Z'), from: 'sim:alert', id: 22 },
    ]);
    expect(page.total).toBe(7);
    expect(page.previousAt).toEqual(cursorAt);
    expect(page.nextCursor).toBeNull();
    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain('UNION ALL');
    expect(query.sql).toContain('WHERE (t.at, t.rank, t.id) <');
    expect(query.params).toContain(cursorAt.toISOString());
  });

  it('reads a total of 0 when the count returns no row', async () => {
    execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const page = await timelinePageKeys(
      { a: 0 },
      [{ from: 'a', table: simAlerts, id: simAlerts.id, at: simAlerts.receivedAt, where: sql`x` }],
      { kind: 'page', page: 1, limit: 10 },
    );
    expect(page.total).toBe(0);
  });
});

describe('simTimelinePage', () => {
  it('reads the rows of the page keys and builds the reply', async () => {
    execute
      .mockResolvedValueOnce([
        { rank: 1, id: 11, at_ms: Date.parse('2026-10-20T10:00:00Z') },
        { rank: 0, id: 22, at_ms: Date.parse('2026-10-19T10:00:00Z') },
        { rank: 0, id: 23, at_ms: Date.parse('2026-10-18T10:00:00Z') },
      ])
      .mockResolvedValueOnce([{ total: 3 }]);
    selectRows.push([sessionRow], [alertRow]);
    const out = await simTimelinePage('sim_1', range, { kind: 'page', page: 1, limit: 2 });
    expect(out.page).toBe(1);
    expect(out.total).toBe(3);
    expect(out.previousAt).toBeNull();
    expect(out.nextCursor).not.toBeNull();
    expect(out.items).toEqual([
      { at: '2026-10-20T10:00:00.000Z', ...simSessionItem(sessionRow) },
      { at: '2026-10-19T10:00:00.000Z', ...simAlertItem(alertRow) },
    ]);
    expect(atInWindows).not.toHaveBeenCalled();
    expect(spanInWindows).not.toHaveBeenCalled();
  });

  it('limits the sources to the windows of a site-restricted viewer and reads no rows for an empty page', async () => {
    execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
    const windows = [{ from: range.from, to: range.to }];
    const out = await simTimelinePage(
      'sim_1',
      range,
      { kind: 'page', page: 1, limit: 10 },
      windows,
    );
    expect(out.items).toEqual([]);
    expect(spanInWindows).toHaveBeenCalledWith(simSessions.startedAt, simSessions.endedAt, windows);
    expect(atInWindows).toHaveBeenCalledWith(simAlerts.receivedAt, windows);
    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain('span_ok');
    expect(query.sql).toContain('at_ok');
  });
});
