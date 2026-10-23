// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  mergeTimelinePage,
  parseTimelineCursor,
  SIM_TIMELINE_RANK,
  timelineItemsOut,
  type TimelineItem,
} from '../lib/sim-timeline.js';

// The shared keyset merge of the station and SIM page timelines.

const RANK = { a: 2, b: 1, c: 0 } as const;
type Source = keyof typeof RANK;

const at = (seconds: number): Date => new Date(Date.UTC(2026, 9, 22, 12, 0, seconds));
const item = (kind: string): TimelineItem => ({ source: 'sim', kind, details: {} });
const row = (id: number, seconds: number, kinds: string[] = [`k${String(id)}`]) => ({
  id,
  at: at(seconds),
  items: kinds.map(item),
});

describe('mergeTimelinePage', () => {
  it('sorts newest first, then by source rank, then by row id', () => {
    const { entries, nextCursor } = mergeTimelinePage<Source>(
      RANK,
      [
        { from: 'c', rows: [row(1, 30)] },
        { from: 'a', rows: [row(5, 30), row(4, 10)] },
        { from: 'b', rows: [row(9, 30)] },
      ],
      10,
    );
    expect(entries.map((e) => `${e.from}${String(e.id)}`)).toEqual(['a5', 'b9', 'c1', 'a4']);
    expect(nextCursor).toBeNull();
  });

  it('stops at the last row of a source that returned more than the limit', () => {
    const { entries, nextCursor } = mergeTimelinePage<Source>(
      RANK,
      [
        { from: 'a', rows: [row(3, 50), row(2, 40), row(1, 30)] },
        { from: 'b', rows: [row(7, 20)] },
      ],
      2,
    );
    expect(entries.map((e) => e.id)).toEqual([3, 2]);
    // Rows of source b older than a's horizon wait for the next page.
    const cursor = parseTimelineCursor(nextCursor ?? '', RANK);
    expect(cursor).toEqual({ at: at(40), from: 'a', id: 2 });
  });

  it("keeps every item of the page's last row on the page", () => {
    const { entries, nextCursor } = mergeTimelinePage<Source>(
      RANK,
      [{ from: 'b', rows: [row(1, 30, ['x', 'y', 'z']), row(2, 20)] }],
      2,
    );
    expect(entries.map((e) => e.kind)).toEqual(['x', 'y', 'z']);
    expect(parseTimelineCursor(nextCursor ?? '', RANK)).toEqual({ at: at(30), from: 'b', id: 1 });
  });

  it('counts rows, not items: a row without an item still counts toward the limit', () => {
    const { entries, nextCursor } = mergeTimelinePage<Source>(
      RANK,
      [{ from: 'b', rows: [row(3, 30), row(2, 20, []), row(1, 10)] }],
      2,
    );
    // Three rows for a limit of two: the source may hold more after row 1.
    expect(entries.map((e) => e.id)).toEqual([3, 1]);
    expect(parseTimelineCursor(nextCursor ?? '', RANK)).toEqual({ at: at(10), from: 'b', id: 1 });
  });

  it('gives the items as the replies show them', () => {
    const { entries } = mergeTimelinePage<Source>(RANK, [{ from: 'a', rows: [row(1, 5)] }], 5);
    expect(timelineItemsOut(entries)).toEqual([
      { at: at(5).toISOString(), source: 'sim', kind: 'k1', details: {} },
    ]);
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
