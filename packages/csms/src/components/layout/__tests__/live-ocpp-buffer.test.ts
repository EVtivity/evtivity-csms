// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  LIVE_OCPP_OVERLAP_MS,
  liveOcppCursor,
  mergeLiveOcppLines,
  newestLineAt,
  type LiveOcppLine,
} from '../live-ocpp-buffer';

function line(id: number, at: string): LiveOcppLine {
  return {
    id,
    stationId: 'sta_1',
    stationOcppId: 'CS-1',
    direction: 'inbound',
    messageType: 2,
    messageId: `m${String(id)}`,
    action: 'Heartbeat',
    errorCode: null,
    errorDescription: null,
    createdAt: at,
  };
}

describe('mergeLiveOcppLines', () => {
  it('adds new lines in time order and drops repeats by id', () => {
    const a = line(1, '2026-11-03T10:00:00Z');
    const b = line(3, '2026-11-03T10:00:02Z');
    const c = line(2, '2026-11-03T10:00:01Z');
    const merged = mergeLiveOcppLines([a, b], [b, c]);
    expect(merged.map((l) => l.id)).toEqual([1, 2, 3]);
  });

  it('keeps only the newest lines past the maximum', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      line(i + 1, new Date(Date.UTC(2026, 10, 3, 10, 0, i)).toISOString()),
    );
    expect(mergeLiveOcppLines([], lines, { max: 4 }).map((l) => l.id)).toEqual([7, 8, 9, 10]);
  });

  it('leaves out lines the user cleared', () => {
    const merged = mergeLiveOcppLines(
      [],
      [line(4, '2026-11-03T10:00:00Z'), line(5, '2026-11-03T10:00:01Z')],
      { hiddenUpToId: 4 },
    );
    expect(merged.map((l) => l.id)).toEqual([5]);
  });

  it('keeps the same array content when nothing is new', () => {
    const a = line(1, '2026-11-03T10:00:00Z');
    expect(mergeLiveOcppLines([a], [a])).toEqual([a]);
  });
});

describe('liveOcppCursor and newestLineAt', () => {
  it('asks again for the overlap before the newest line', () => {
    expect(liveOcppCursor(null)).toBeUndefined();
    expect(liveOcppCursor('nonsense')).toBeUndefined();
    const at = '2026-11-03T10:00:10.000Z';
    expect(liveOcppCursor(at)).toBe(new Date(Date.parse(at) - LIVE_OCPP_OVERLAP_MS).toISOString());
  });

  it('tracks the newest time across polls', () => {
    const first = newestLineAt(null, [
      line(1, '2026-11-03T10:00:05Z'),
      line(2, '2026-11-03T10:00:01Z'),
    ]);
    expect(first).toBe('2026-11-03T10:00:05Z');
    expect(newestLineAt(first, [])).toBe(first);
    expect(newestLineAt(first, [line(3, '2026-11-03T10:00:09Z')])).toBe('2026-11-03T10:00:09Z');
  });
});
