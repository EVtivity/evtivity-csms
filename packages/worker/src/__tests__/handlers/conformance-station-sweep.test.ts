// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

const mocks = vi.hoisted(() => ({
  returning: vi.fn(),
  deleteConformanceStations: vi.fn(),
  deleteConformanceTestDriver: vi.fn(),
  conformanceTestDriverInUse: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const chain = {
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: mocks.returning,
  };
  return {
    db: { update: vi.fn(() => chain) },
    octtRuns: { id: 'id', status: 'status' },
    deleteConformanceStations: mocks.deleteConformanceStations,
    deleteConformanceTestDriver: mocks.deleteConformanceTestDriver,
    conformanceTestDriverInUse: mocks.conformanceTestDriverInUse,
  };
});

vi.mock('@evtivity/lib', () => ({ createRedisClient: vi.fn() }));
vi.mock('../../handlers/octt-runner.js', () => ({ OCTT_RUN_LOCK_KEY: 'wkl:octt-run' }));

import {
  sweepConformanceStations,
  CONFORMANCE_SWEEP_IDLE_MS,
  CONFORMANCE_SWEEP_CS_AGE_MS,
} from '../../handlers/conformance-station-sweep.js';

const log = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
const now = new Date('2026-10-15T12:00:00Z');

describe('sweepConformanceStations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.returning.mockResolvedValue([]);
    mocks.deleteConformanceStations.mockResolvedValue(0);
    mocks.conformanceTestDriverInUse.mockResolvedValue(false);
    mocks.deleteConformanceTestDriver.mockResolvedValue({
      driverDeleted: false,
      pricingGroupsDeleted: 0,
      pricingGroupsKept: 0,
      detachedRows: 0,
    });
  });

  it('touches nothing while a worker run holds the run lock', async () => {
    const result = await sweepConformanceStations(log, {
      runLockHeld: () => Promise.resolve(true),
      now: () => now,
    });
    expect(result.skipped).toBe(true);
    expect(mocks.returning).not.toHaveBeenCalled();
    expect(mocks.deleteConformanceStations).not.toHaveBeenCalled();
    expect(mocks.deleteConformanceTestDriver).not.toHaveBeenCalled();
  });

  it('fails crashed runs and deletes idle stations, CS stations only past their age', async () => {
    mocks.returning.mockResolvedValue([{ id: 7 }]);
    mocks.deleteConformanceStations.mockResolvedValue(12);
    mocks.deleteConformanceTestDriver.mockResolvedValue({
      driverDeleted: true,
      pricingGroupsDeleted: 1,
      pricingGroupsKept: 0,
      detachedRows: 0,
    });

    const result = await sweepConformanceStations(log, {
      runLockHeld: () => Promise.resolve(false),
      now: () => now,
    });

    expect(result).toEqual({
      skipped: false,
      crashedRuns: 1,
      stationsDeleted: 12,
      driverDeleted: true,
    });
    expect(mocks.deleteConformanceStations).toHaveBeenCalledWith({
      includeCs: true,
      idleBefore: new Date(now.getTime() - CONFORMANCE_SWEEP_IDLE_MS),
      csCreatedBefore: new Date(now.getTime() - CONFORMANCE_SWEEP_CS_AGE_MS),
    });
    expect(mocks.conformanceTestDriverInUse).toHaveBeenCalledWith(
      new Date(now.getTime() - CONFORMANCE_SWEEP_IDLE_MS),
    );
  });

  it('keeps the test driver while a run may still use it', async () => {
    mocks.conformanceTestDriverInUse.mockResolvedValue(true);
    const result = await sweepConformanceStations(log, {
      runLockHeld: () => Promise.resolve(false),
      now: () => now,
    });
    expect(result.driverDeleted).toBe(false);
    expect(mocks.deleteConformanceTestDriver).not.toHaveBeenCalled();
  });
});
