// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

const mockAdd = vi.fn().mockResolvedValue(undefined);

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ siteId: 'site-1' }, { siteId: 'site-2' }])),
      })),
    })),
  },
  siteLoadManagement: { siteId: 'siteId', isEnabled: 'isEnabled' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

vi.mock('@evtivity/api/src/services/load-management.service.js', () => ({
  runLoadManagementCycle: vi.fn().mockResolvedValue(undefined),
}));

describe('enqueueLoadManagementJobs', () => {
  it('enqueues one job per enabled site with deduplication jobId', async () => {
    const { enqueueLoadManagementJobs } = await import('../load-management-worker.js');
    const mockQueue = { add: mockAdd } as never;
    await enqueueLoadManagementJobs(mockQueue);

    expect(mockAdd).toHaveBeenCalledTimes(2);
    expect(mockAdd).toHaveBeenCalledWith(
      'load-management',
      { siteId: 'site-1' },
      expect.objectContaining({ jobId: 'load-management-site-1' }),
    );
    expect(mockAdd).toHaveBeenCalledWith(
      'load-management',
      { siteId: 'site-2' },
      expect.objectContaining({ jobId: 'load-management-site-2' }),
    );
  });
});
