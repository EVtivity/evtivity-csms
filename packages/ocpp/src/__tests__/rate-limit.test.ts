// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { consumeStationMessage } from '../server/middleware/rate-limit.js';

describe('consumeStationMessage', () => {
  it('allows messages under the limit', () => {
    expect(consumeStationMessage('RATE-001', 10)).toEqual({ allowed: true, count: 1 });
  });

  it('refuses messages over the limit', () => {
    expect(consumeStationMessage('RATE-002', 2).allowed).toBe(true);
    expect(consumeStationMessage('RATE-002', 2).allowed).toBe(true);
    expect(consumeStationMessage('RATE-002', 2)).toEqual({ allowed: false, count: 3 });
  });

  it('tracks rate limits per station', () => {
    expect(consumeStationMessage('RATE-003', 1).allowed).toBe(true);
    expect(consumeStationMessage('RATE-004', 1).allowed).toBe(true);
    expect(consumeStationMessage('RATE-003', 1).allowed).toBe(false);
  });

  it('resets the per-station window after one second', () => {
    vi.useFakeTimers();
    try {
      const start = 1_000_000;
      vi.setSystemTime(start);
      expect(consumeStationMessage('RATE-WINDOW', 1).allowed).toBe(true);
      expect(consumeStationMessage('RATE-WINDOW', 1).allowed).toBe(false);

      vi.setSystemTime(start + 1001);
      expect(consumeStationMessage('RATE-WINDOW', 1)).toEqual({ allowed: true, count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('consumeStationMessage stale-entry cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('deletes counters for stations idle beyond the stale threshold', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const start = 5_000_000;
    vi.setSystemTime(start);

    // Importing under fake timers registers the module-level cleanup interval
    // against the fake clock so it can be fired deterministically.
    const mod = await import('../server/middleware/rate-limit.js');
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    mod.consumeStationMessage('STALE-001', 50);

    // Advance past the 300s stale threshold, then fire one 60s cleanup tick.
    vi.setSystemTime(start + 300_001);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deleteSpy).toHaveBeenCalledWith('STALE-001');
  });

  it('keeps counters for stations within the stale threshold', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const start = 8_000_000;
    vi.setSystemTime(start);

    const mod = await import('../server/middleware/rate-limit.js');
    mod.consumeStationMessage('FRESH-001', 50);

    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deleteSpy).not.toHaveBeenCalledWith('FRESH-001');
  });
});
