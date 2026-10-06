// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import * as schedulerModule from '../scheduler.js';

const mockUpsertJobScheduler = vi.fn().mockResolvedValue(undefined);

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() =>
        Promise.resolve([
          { id: 1, name: 'report-scheduler', schedule: '* * * * *' },
          { id: 2, name: 'guest-session-cleanup', schedule: '*/5 * * * *' },
        ]),
      ),
    })),
  },
  cronjobs: {},
}));

describe('scheduleCronJobs', () => {
  it('calls upsertJobScheduler for each job in the database', async () => {
    const { scheduleCronJobs } = schedulerModule;
    const mockQueue = { upsertJobScheduler: mockUpsertJobScheduler } as never;
    await scheduleCronJobs(mockQueue);
    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'report-scheduler',
      { pattern: '* * * * *' },
      expect.objectContaining({ name: 'report-scheduler' }),
    );
    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'guest-session-cleanup',
      { pattern: '*/5 * * * *' },
      expect.objectContaining({ name: 'guest-session-cleanup' }),
    );
  });
});

describe('scheduleLoadManagementCoordinator', () => {
  it('registers the coordinator every 10 s under its scheduler id', async () => {
    const { scheduleLoadManagementCoordinator } = schedulerModule;
    const upsert = vi.fn().mockResolvedValue(undefined);
    await scheduleLoadManagementCoordinator({ upsertJobScheduler: upsert } as never);
    expect(upsert).toHaveBeenCalledWith(
      'load-management-coordinator',
      { every: 10_000 },
      { name: 'load-management-coordinator' },
    );
  });
});

describe('findMissingSchedulers', () => {
  function queue(keys: string[]): never {
    return {
      getJobSchedulers: vi.fn().mockResolvedValue(keys.map((key) => ({ key, name: key }))),
    } as never;
  }

  it('returns nothing while Redis holds every cron scheduler and the coordinator', async () => {
    const { findMissingSchedulers } = schedulerModule;
    const missing = await findMissingSchedulers(
      queue(['report-scheduler', 'guest-session-cleanup']),
      queue(['load-management-coordinator']),
    );
    expect(missing).toEqual([]);
  });

  it('names each cronjobs row and the coordinator that Redis lost', async () => {
    const { findMissingSchedulers } = schedulerModule;
    expect(await findMissingSchedulers(queue([]), queue([]))).toEqual([
      'report-scheduler',
      'guest-session-cleanup',
      'load-management-coordinator',
    ]);
    expect(
      await findMissingSchedulers(
        queue(['report-scheduler']),
        queue(['load-management-coordinator']),
      ),
    ).toEqual(['guest-session-cleanup']);
  });
});
