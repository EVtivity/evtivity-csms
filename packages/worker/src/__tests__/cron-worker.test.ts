// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';

const mockWorkerInstance = {
  on: vi.fn(),
  close: vi.fn(),
};

vi.mock('bullmq', () => ({
  // Use a regular function (not arrow) so it can be called with `new`
  Worker: vi.fn(function () {
    return mockWorkerInstance;
  }),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  },
  cronjobs: {},
}));

vi.mock('../handlers/report-scheduler.js', () => ({
  reportSchedulerHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../handlers/tariff-boundary-check.js', () => ({
  tariffBoundaryCheckHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../handlers/payment-reconciliation.js', () => ({
  paymentReconciliationHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../handlers/guest-session-cleanup.js', () => ({
  guestSessionCleanupHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../handlers/charging-profile-reconciliation.js', () => ({
  chargingProfileReconciliationHandler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../handlers/config-drift-detection.js', () => ({
  configDriftDetectionHandler: vi.fn().mockResolvedValue(undefined),
}));

describe('createCronWorker', () => {
  it('creates a BullMQ Worker with concurrency 1', async () => {
    const { Worker } = await import('bullmq');
    const { createCronWorker } = await import('../cron-worker.js');
    const mockConn = {} as never;
    createCronWorker(mockConn);
    expect(Worker).toHaveBeenCalledWith(
      'cron-jobs',
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
  });
});
