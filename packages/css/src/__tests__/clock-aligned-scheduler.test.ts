// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClockAlignedScheduler } from '../clock-aligned-scheduler.js';

function createMockSim(
  overrides: Partial<{
    isConnected: boolean;
    stationId: string;
    getAlignedIntervalSeconds: () => number;
    sendClockAlignedMeterValues: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }> = {},
) {
  return {
    isConnected: true,
    stationId: 'CS-001',
    getAlignedIntervalSeconds: () => 60,
    sendClockAlignedMeterValues: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ClockAlignedScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls sendClockAlignedMeterValues on aligned interval', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });

    const mockSim = createMockSim();
    const scheduler = new ClockAlignedScheduler();
    scheduler.register(mockSim);
    scheduler.start();

    // Advance past first aligned boundary + max jitter (90% of 60s = 54s)
    await vi.advanceTimersByTimeAsync(120_000);

    expect(mockSim.sendClockAlignedMeterValues).toHaveBeenCalled();
    scheduler.stop();
  });

  it('does not call when interval is 0', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });

    const mockSim = createMockSim({
      stationId: 'CS-002',
      getAlignedIntervalSeconds: () => 0,
    });

    const scheduler = new ClockAlignedScheduler();
    scheduler.register(mockSim);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(mockSim.sendClockAlignedMeterValues).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('handles different intervals for different stations', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });

    const sim30s = createMockSim({
      stationId: 'CS-30S',
      getAlignedIntervalSeconds: () => 30,
    });
    const sim120s = createMockSim({
      stationId: 'CS-120S',
      getAlignedIntervalSeconds: () => 120,
    });

    const scheduler = new ClockAlignedScheduler();
    scheduler.register(sim30s);
    scheduler.register(sim120s);
    scheduler.start();

    // 30s station: boundary at 30s + up to 27s jitter = 57s max
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sim30s.sendClockAlignedMeterValues).toHaveBeenCalled();
    expect(sim120s.sendClockAlignedMeterValues).not.toHaveBeenCalled();

    // 120s station: boundary at 120s + up to 108s jitter = 228s max
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sim120s.sendClockAlignedMeterValues).toHaveBeenCalled();

    scheduler.stop();
  });

  it('unregistered stations stop firing', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });

    const mockSim = createMockSim({ stationId: 'CS-UNREG' });
    const scheduler = new ClockAlignedScheduler();
    scheduler.register(mockSim);
    scheduler.start();

    // Let it fire once (advance past boundary + max jitter)
    await vi.advanceTimersByTimeAsync(120_000);
    const callsBeforeUnregister = mockSim.sendClockAlignedMeterValues.mock.calls.length;
    expect(callsBeforeUnregister).toBeGreaterThan(0);

    // Unregister and advance another full interval
    scheduler.unregister('CS-UNREG');
    await vi.advanceTimersByTimeAsync(120_000);

    // Should not have been called again
    expect(mockSim.sendClockAlignedMeterValues.mock.calls.length).toBe(callsBeforeUnregister);
    scheduler.stop();
  });

  it('skips disconnected simulators', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });

    const mockSim = createMockSim({
      stationId: 'CS-OFFLINE',
      isConnected: false,
    });

    const scheduler = new ClockAlignedScheduler();
    scheduler.register(mockSim);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(mockSim.sendClockAlignedMeterValues).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('errors in one station do not affect others', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });

    const failingSim = createMockSim({
      stationId: 'CS-FAIL',
      sendClockAlignedMeterValues: vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error('WebSocket closed')),
    });
    const goodSim = createMockSim({ stationId: 'CS-GOOD' });

    const scheduler = new ClockAlignedScheduler();
    scheduler.register(failingSim);
    scheduler.register(goodSim);
    scheduler.start();

    // Suppress console.log for the error output
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await vi.advanceTimersByTimeAsync(120_000);

    expect(failingSim.sendClockAlignedMeterValues).toHaveBeenCalled();
    expect(goodSim.sendClockAlignedMeterValues).toHaveBeenCalled();

    logSpy.mockRestore();
    scheduler.stop();
  });

  it('handles 1000 simulators without issues', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });

    const sims = Array.from({ length: 1000 }, (_, i) =>
      createMockSim({ stationId: `CS-${String(i).padStart(4, '0')}` }),
    );

    const scheduler = new ClockAlignedScheduler();
    for (const sim of sims) scheduler.register(sim);
    scheduler.start();

    // Advance past boundary (60s) + max jitter (54s) = 114s
    await vi.advanceTimersByTimeAsync(120_000);

    const calledCount = sims.filter(
      (s) => s.sendClockAlignedMeterValues.mock.calls.length > 0,
    ).length;
    expect(calledCount).toBe(1000);
    scheduler.stop();
  });

  it('picks up interval changes dynamically', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });

    let interval = 0;
    const mockSim = createMockSim({
      stationId: 'CS-DYNAMIC',
      getAlignedIntervalSeconds: () => interval,
    });

    const scheduler = new ClockAlignedScheduler();
    scheduler.register(mockSim);
    scheduler.start();

    // With interval 0, nothing should fire
    await vi.advanceTimersByTimeAsync(65_000);
    expect(mockSim.sendClockAlignedMeterValues).not.toHaveBeenCalled();

    // Enable the interval
    interval = 30;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSim.sendClockAlignedMeterValues).toHaveBeenCalled();

    scheduler.stop();
  });
});
