// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

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
    const { scheduleCronJobs } = await import('../scheduler.js');
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
