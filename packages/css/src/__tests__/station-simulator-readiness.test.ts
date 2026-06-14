// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { StationSimulator } from '../station-simulator.js';
import { noopSql, makeConfig } from './sim-test-helpers.js';

// Readiness is driven from the lifecycle chokepoint updateStationStatus, which
// every boot/reconnect/offline/reset path funnels through. Exercise it directly
// to assert the watchdog probes (isReady/getNotReadyMs) the manager relies on.
function setStatus(sim: StationSimulator, status: string): Promise<void> {
  return (sim as unknown as { updateStationStatus(s: string): Promise<void> }).updateStationStatus(
    status,
  );
}

describe('StationSimulator readiness signal', () => {
  it('starts not-ready, with no boot status and zero not-ready time', () => {
    const sim = new StationSimulator(makeConfig(), noopSql());
    expect(sim.isReady()).toBe(false);
    expect(sim.getBootStatus()).toBeNull();
    expect(sim.getNotReadyMs()).toBe(0);
  });

  it('reports offline only after a deliberate goOffline (what the watchdog excludes)', async () => {
    const sim = new StationSimulator(makeConfig(), noopSql());
    // goOffline closes the WebSocket; stub disconnect so no real socket is needed.
    Object.defineProperty(sim.client, 'disconnect', { value: vi.fn(), writable: true });
    expect(sim.isOffline()).toBe(false);
    await sim.goOffline();
    expect(sim.isOffline()).toBe(true);
  });

  it('is ready when operational, not-ready while booting or disconnected', async () => {
    const sim = new StationSimulator(makeConfig(), noopSql());
    await setStatus(sim, 'booting');
    expect(sim.isReady()).toBe(false);
    await setStatus(sim, 'available');
    expect(sim.isReady()).toBe(true);
    expect(sim.getNotReadyMs()).toBe(0);
    await setStatus(sim, 'disconnected');
    expect(sim.isReady()).toBe(false);
  });

  it('accumulates continuous not-ready time while not ready', async () => {
    vi.useFakeTimers();
    try {
      const sim = new StationSimulator(makeConfig(), noopSql());
      await setStatus(sim, 'booting');
      vi.advanceTimersByTime(50_000);
      expect(sim.isReady()).toBe(false);
      expect(sim.getNotReadyMs()).toBeGreaterThanOrEqual(50_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the not-ready clock on recovery so a brief reconnect is not counted', async () => {
    vi.useFakeTimers();
    try {
      const sim = new StationSimulator(makeConfig(), noopSql());
      await setStatus(sim, 'booting');
      vi.advanceTimersByTime(40_000);
      await setStatus(sim, 'available'); // recovered
      await setStatus(sim, 'disconnected'); // dropped again
      vi.advanceTimersByTime(5_000);
      // Counts only the latest 5s stretch, not the earlier 40s.
      expect(sim.getNotReadyMs()).toBeGreaterThanOrEqual(5_000);
      expect(sim.getNotReadyMs()).toBeLessThan(40_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
