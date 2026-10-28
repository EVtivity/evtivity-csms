// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  parseTimelineCursor,
  SIM_TIMELINE_RANK,
  splitTimelineRows,
  timelineEntries,
  timelineIdsOf,
  timelineItemsOut,
  timelinePageOut,
  timelinePaging,
  timelineReadWindow,
  TIMELINE_DEFAULT_LIMIT,
  type TimelineCursor,
  type TimelineItem,
} from '../lib/sim-timeline.js';

// The shared paging of the station and SIM page timelines. The SQL merge and
// count run against a real database in 133-station-sim and 135-sim-inventory.

const RANK = { a: 2, b: 1, c: 0 } as const;
type Source = keyof typeof RANK;

const at = (seconds: number): Date => new Date(Date.UTC(2026, 9, 22, 12, 0, seconds));
const item = (kind: string): TimelineItem => ({ source: 'sim', kind, details: {} });
const key = (from: Source, id: number, seconds: number): TimelineCursor<Source> => ({
  at: at(seconds),
  from,
  id,
});
const cursor = (k: TimelineCursor<Source>): string =>
  Buffer.from(`${k.at.toISOString()}|${k.from}|${String(k.id)}`).toString('base64url');

describe('timelinePaging', () => {
  it('reads page 1 by default and the default limit', () => {
    expect(timelinePaging<Source>({}, RANK)).toEqual({
      kind: 'page',
      page: 1,
      limit: TIMELINE_DEFAULT_LIMIT,
    });
    expect(timelinePaging<Source>({ page: 3, limit: 20 }, RANK)).toEqual({
      kind: 'page',
      page: 3,
      limit: 20,
    });
  });

  it('reads a cursor, and refuses a cursor with a page or one it did not hand out', () => {
    const k = key('b', 7, 3);
    expect(timelinePaging<Source>({ cursor: cursor(k), limit: 5 }, RANK)).toEqual({
      kind: 'cursor',
      cursor: k,
      limit: 5,
    });
    expect(timelinePaging<Source>({ cursor: cursor(k), page: 2 }, RANK)).toEqual({
      error: 'Send a page or a cursor, not both',
    });
    expect(timelinePaging<Source>({ cursor: 'junk' }, RANK)).toEqual({
      error: 'The cursor is not valid',
    });
  });
});

describe('timelineReadWindow and splitTimelineRows', () => {
  const rows = [key('a', 9, 50), key('b', 8, 40), key('c', 7, 30), key('a', 6, 20)];

  it('reads the first page with one row more to tell whether a next page exists', () => {
    const paging = { kind: 'page', page: 1, limit: 2 } as const;
    expect(timelineReadWindow(paging)).toEqual({ offset: 0, count: 3, withPrevious: false });
    const split = splitTimelineRows(paging, rows.slice(0, 3));
    expect(split.keys).toEqual(rows.slice(0, 2));
    expect(split.previousAt).toBeNull();
    expect(split.nextCursor).toBe(cursor(rows[1]!));
  });

  it('reads a later page with the last entry of the previous page first', () => {
    const paging = { kind: 'page', page: 2, limit: 2 } as const;
    expect(timelineReadWindow(paging)).toEqual({ offset: 1, count: 4, withPrevious: true });
    const split = splitTimelineRows(paging, rows.slice(1, 4));
    expect(split.keys).toEqual(rows.slice(2, 4));
    expect(split.previousAt).toEqual(at(40));
    expect(split.nextCursor).toBeNull();
  });

  it('gives no entries and no previous time past the last page', () => {
    const split = splitTimelineRows({ kind: 'page', page: 9, limit: 2 }, []);
    expect(split).toEqual({ keys: [], nextCursor: null, previousAt: null });
  });

  it('takes the time before a cursor page from the cursor', () => {
    const paging = { kind: 'cursor', cursor: rows[1]!, limit: 1 } as const;
    expect(timelineReadWindow(paging)).toEqual({ offset: 0, count: 2, withPrevious: false });
    const split = splitTimelineRows(paging, rows.slice(2, 4));
    expect(split.keys).toEqual([rows[2]]);
    expect(split.previousAt).toEqual(at(40));
    expect(split.nextCursor).toBe(cursor(rows[2]!));
  });
});

describe('timelineEntries', () => {
  it('keeps the key order, gives every item of a row, and skips a row read no more', () => {
    const keys = [key('a', 1, 30), key('b', 2, 30), key('c', 3, 10)];
    const items: Record<string, TimelineItem[]> = {
      'a:1': [item('x')],
      'b:2': [item('y1'), item('y2')],
    };
    const entries = timelineEntries(keys, (from, id) => items[`${from}:${String(id)}`]);
    expect(entries.map((e) => `${e.from}:${e.kind}`)).toEqual(['a:x', 'b:y1', 'b:y2']);
    expect(timelineIdsOf(keys, 'b')).toEqual([2]);
    expect(timelineItemsOut(entries)[0]).toEqual({
      at: at(30).toISOString(),
      source: 'sim',
      kind: 'x',
      details: {},
    });
  });

  it('gives the paging fields of a reply', () => {
    const keys = [key('a', 1, 30)];
    const out = timelinePageOut(
      { kind: 'page', page: 2, limit: 1 },
      { keys, total: 5, nextCursor: 'n', previousAt: at(40) },
      timelineEntries(keys, () => [item('x')]),
    );
    expect(out).toMatchObject({
      total: 5,
      page: 2,
      nextCursor: 'n',
      previousAt: at(40).toISOString(),
    });
  });
});

describe('parseTimelineCursor', () => {
  it('refuses a cursor of another timeline, an inherited property and junk', () => {
    const station = Buffer.from(`${at(1).toISOString()}|ocpp|4`).toString('base64url');
    expect(parseTimelineCursor(station, SIM_TIMELINE_RANK)).toBeNull();
    const inherited = Buffer.from(`${at(1).toISOString()}|toString|4`).toString('base64url');
    expect(parseTimelineCursor(inherited, SIM_TIMELINE_RANK)).toBeNull();
    expect(parseTimelineCursor('not-a-cursor', SIM_TIMELINE_RANK)).toBeNull();
    const ok = Buffer.from(`${at(1).toISOString()}|sim:alert|4`).toString('base64url');
    expect(parseTimelineCursor(ok, SIM_TIMELINE_RANK)).toEqual({
      at: at(1),
      from: 'sim:alert',
      id: 4,
    });
  });
});
