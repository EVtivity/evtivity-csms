// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
vi.mock('@evtivity/lib', () => ({
  createLogger: vi.fn(() => mockLog),
}));

// Capture the Worker processor and the event handlers registered via .on().
let capturedProcessor: ((job: Job) => Promise<void>) | undefined;
const onHandlers = new Map<string, (...args: unknown[]) => void>();
const mockWorkerOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
  onHandlers.set(event, handler);
});
const workerCtorCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];

vi.mock('bullmq', () => ({
  Worker: vi.fn(function (
    this: unknown,
    name: string,
    processor: (job: Job) => Promise<void>,
    opts: Record<string, unknown>,
  ) {
    capturedProcessor = processor;
    workerCtorCalls.push({ name, opts });
    return { on: mockWorkerOn };
  }),
}));

// Track every db.update().set().where() call so we can assert the cronjobs
// status transitions written by the processor and the failed listener.
const dbUpdateSet = vi.fn();
const dbUpdateWhere = vi.fn(() => Promise.resolve());
const mockDb = {
  update: vi.fn(() => ({
    set: (values: unknown) => {
      dbUpdateSet(values);
      return { where: dbUpdateWhere };
    },
  })),
};
vi.mock('@evtivity/database', () => ({
  db: mockDb,
  cronjobs: { name: 'name' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ a, b })),
  sql: Object.assign((strings: TemplateStringsArray) => ({ sql: strings.join('') }), {
    raw: vi.fn(),
  }),
}));

const mockLogJobStarted = vi.fn().mockResolvedValue(42);
const mockLogJobCompleted = vi.fn().mockResolvedValue(undefined);
const mockLogJobFailed = vi.fn().mockResolvedValue(undefined);
vi.mock('../job-logger.js', () => ({
  logJobStarted: (...args: unknown[]) => mockLogJobStarted(...args),
  logJobCompleted: (...args: unknown[]) => mockLogJobCompleted(...args),
  logJobFailed: (...args: unknown[]) => mockLogJobFailed(...args),
}));

// Mock every cron handler so we can assert dispatch routing and force failures.
const handlerMocks = {
  reportSchedulerHandler: vi.fn().mockResolvedValue(undefined),
  tariffBoundaryCheckHandler: vi.fn().mockResolvedValue(undefined),
  paymentReconciliationHandler: vi.fn().mockResolvedValue(undefined),
  guestSessionCleanupHandler: vi.fn().mockResolvedValue(undefined),
  chargingProfileReconciliationHandler: vi.fn().mockResolvedValue(undefined),
  configDriftDetectionHandler: vi.fn().mockResolvedValue(undefined),
  staleSessionCleanupHandler: vi.fn().mockResolvedValue(undefined),
  dashboardSnapshotHandler: vi.fn().mockResolvedValue(undefined),
  reservationExpiryCheckHandler: vi.fn().mockResolvedValue(undefined),
  offlineCommandCleanupHandler: vi.fn().mockResolvedValue(undefined),
  certificateExpirationCheckHandler: vi.fn().mockResolvedValue(undefined),
  stationMessageChargingRefreshHandler: vi.fn().mockResolvedValue(undefined),
  paymentCaptureRetryHandler: vi.fn().mockResolvedValue(undefined),
  auditRetentionPruneHandler: vi.fn().mockResolvedValue(undefined),
  logRetentionPruneHandler: vi.fn().mockResolvedValue(undefined),
  mfaChallengePruneHandler: vi.fn().mockResolvedValue(undefined),
  refreshTokenPruneHandler: vi.fn().mockResolvedValue(undefined),
  maintenanceSchedulerHandler: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../handlers/report-scheduler.js', () => ({
  reportSchedulerHandler: (...a: unknown[]) => handlerMocks.reportSchedulerHandler(...a),
}));
vi.mock('../handlers/tariff-boundary-check.js', () => ({
  tariffBoundaryCheckHandler: (...a: unknown[]) => handlerMocks.tariffBoundaryCheckHandler(...a),
}));
vi.mock('../handlers/payment-reconciliation.js', () => ({
  paymentReconciliationHandler: (...a: unknown[]) =>
    handlerMocks.paymentReconciliationHandler(...a),
}));
vi.mock('../handlers/guest-session-cleanup.js', () => ({
  guestSessionCleanupHandler: (...a: unknown[]) => handlerMocks.guestSessionCleanupHandler(...a),
}));
vi.mock('../handlers/charging-profile-reconciliation.js', () => ({
  chargingProfileReconciliationHandler: (...a: unknown[]) =>
    handlerMocks.chargingProfileReconciliationHandler(...a),
}));
vi.mock('../handlers/config-drift-detection.js', () => ({
  configDriftDetectionHandler: (...a: unknown[]) => handlerMocks.configDriftDetectionHandler(...a),
}));
vi.mock('../handlers/stale-session-cleanup.js', () => ({
  staleSessionCleanupHandler: (...a: unknown[]) => handlerMocks.staleSessionCleanupHandler(...a),
}));
vi.mock('../handlers/dashboard-snapshot.js', () => ({
  dashboardSnapshotHandler: (...a: unknown[]) => handlerMocks.dashboardSnapshotHandler(...a),
}));
vi.mock('../handlers/reservation-expiry-check.js', () => ({
  reservationExpiryCheckHandler: (...a: unknown[]) =>
    handlerMocks.reservationExpiryCheckHandler(...a),
}));
vi.mock('../handlers/offline-command-cleanup.js', () => ({
  offlineCommandCleanupHandler: (...a: unknown[]) =>
    handlerMocks.offlineCommandCleanupHandler(...a),
}));
vi.mock('../handlers/certificate-expiration-check.js', () => ({
  certificateExpirationCheckHandler: (...a: unknown[]) =>
    handlerMocks.certificateExpirationCheckHandler(...a),
}));
vi.mock('../handlers/station-message-charging-refresh.js', () => ({
  stationMessageChargingRefreshHandler: (...a: unknown[]) =>
    handlerMocks.stationMessageChargingRefreshHandler(...a),
}));
vi.mock('../handlers/payment-capture-retry.js', () => ({
  paymentCaptureRetryHandler: (...a: unknown[]) => handlerMocks.paymentCaptureRetryHandler(...a),
}));
vi.mock('../handlers/audit-retention-prune.js', () => ({
  auditRetentionPruneHandler: (...a: unknown[]) => handlerMocks.auditRetentionPruneHandler(...a),
}));
vi.mock('../handlers/log-retention-prune.js', () => ({
  logRetentionPruneHandler: (...a: unknown[]) => handlerMocks.logRetentionPruneHandler(...a),
}));
vi.mock('../handlers/mfa-challenge-prune.js', () => ({
  mfaChallengePruneHandler: (...a: unknown[]) => handlerMocks.mfaChallengePruneHandler(...a),
}));
vi.mock('../handlers/refresh-token-prune.js', () => ({
  refreshTokenPruneHandler: (...a: unknown[]) => handlerMocks.refreshTokenPruneHandler(...a),
}));
vi.mock('../handlers/maintenance-scheduler.js', () => ({
  maintenanceSchedulerHandler: (...a: unknown[]) => handlerMocks.maintenanceSchedulerHandler(...a),
}));

function makeJob(name: string, data: unknown = {}): Job {
  return { name, data } as unknown as Job;
}

beforeEach(() => {
  capturedProcessor = undefined;
  onHandlers.clear();
  workerCtorCalls.length = 0;
  mockWorkerOn.mockClear();
  mockLog.info.mockClear();
  mockLog.error.mockClear();
  mockLog.warn.mockClear();
  dbUpdateSet.mockClear();
  dbUpdateWhere.mockClear();
  dbUpdateWhere.mockReturnValue(Promise.resolve());
  mockDb.update.mockClear();
  mockLogJobStarted.mockClear();
  mockLogJobStarted.mockResolvedValue(42);
  mockLogJobCompleted.mockClear();
  mockLogJobCompleted.mockResolvedValue(undefined);
  mockLogJobFailed.mockClear();
  mockLogJobFailed.mockResolvedValue(undefined);
  for (const fn of Object.values(handlerMocks)) {
    fn.mockClear();
    fn.mockResolvedValue(undefined);
  }
});

describe('createCronWorker', () => {
  it('creates a BullMQ Worker on the cron-jobs queue with concurrency 1', async () => {
    const { Worker } = await import('bullmq');
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    expect(Worker).toHaveBeenCalledWith(
      'cron-jobs',
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
  });

  it('passes the provided connection through to the Worker', async () => {
    const { createCronWorker } = await import('../cron-worker.js');
    const connection = { host: 'redis-cron' } as never;
    createCronWorker(connection);

    expect(workerCtorCalls[0]?.opts['connection']).toBe(connection);
  });

  it('returns the worker instance', async () => {
    const { createCronWorker } = await import('../cron-worker.js');
    const worker = createCronWorker({});
    expect(worker).toBeDefined();
    expect(typeof (worker as unknown as { on: unknown }).on).toBe('function');
  });
});

describe('cron-worker processor dispatch', () => {
  it('dispatches a known job name to the matching handler and runs the success path', async () => {
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    await capturedProcessor?.(makeJob('payment-reconciliation'));

    // Routed to the right handler, and only that handler.
    expect(handlerMocks.paymentReconciliationHandler).toHaveBeenCalledTimes(1);
    expect(handlerMocks.paymentReconciliationHandler).toHaveBeenCalledWith(mockLog);
    expect(handlerMocks.reportSchedulerHandler).not.toHaveBeenCalled();

    // Job log lifecycle: started then completed (no failure).
    expect(mockLogJobStarted).toHaveBeenCalledWith('payment-reconciliation', 'cron-jobs');
    expect(mockLogJobCompleted).toHaveBeenCalledTimes(1);
    expect(mockLogJobCompleted.mock.calls[0]?.[0]).toBe(42);
    expect(typeof mockLogJobCompleted.mock.calls[0]?.[1]).toBe('number');
    expect(mockLogJobFailed).not.toHaveBeenCalled();

    // cronjobs row marked running, then completed.
    const setCalls = dbUpdateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(setCalls[0]).toMatchObject({ status: 'running' });
    expect(setCalls[1]).toMatchObject({
      status: 'completed',
      result: { success: true },
      error: null,
    });
  });

  it('routes each registered job name to its own handler', async () => {
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    const routes: Array<[string, keyof typeof handlerMocks]> = [
      ['report-scheduler', 'reportSchedulerHandler'],
      ['tariff-boundary-check', 'tariffBoundaryCheckHandler'],
      ['guest-session-cleanup', 'guestSessionCleanupHandler'],
      ['stale-session-cleanup', 'staleSessionCleanupHandler'],
      ['dashboard-snapshot', 'dashboardSnapshotHandler'],
      ['maintenance-scheduler', 'maintenanceSchedulerHandler'],
      ['audit-retention-prune', 'auditRetentionPruneHandler'],
    ];

    for (const [jobName, handlerKey] of routes) {
      await capturedProcessor?.(makeJob(jobName));
      expect(handlerMocks[handlerKey]).toHaveBeenCalledWith(mockLog);
    }
  });

  it('throws for an unknown job name and never starts a job log', async () => {
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    await expect(capturedProcessor?.(makeJob('does-not-exist'))).rejects.toThrow(
      'No handler registered for cron job: does-not-exist',
    );

    expect(mockLogJobStarted).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('logs failure and rethrows when a handler throws, without marking completed', async () => {
    handlerMocks.dashboardSnapshotHandler.mockRejectedValueOnce(new Error('snapshot boom'));
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    await expect(capturedProcessor?.(makeJob('dashboard-snapshot'))).rejects.toThrow(
      'snapshot boom',
    );

    // Started, marked running, then failed-logged. Never completed.
    expect(mockLogJobStarted).toHaveBeenCalledTimes(1);
    expect(mockLogJobFailed).toHaveBeenCalledTimes(1);
    expect(mockLogJobFailed.mock.calls[0]?.[0]).toBe(42);
    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('snapshot boom');
    expect(mockLogJobCompleted).not.toHaveBeenCalled();

    // Only the "running" status write happened (no "completed" write).
    const setCalls = dbUpdateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({ status: 'running' });
  });

  it('uses "Unknown error" when a handler throws a non-Error', async () => {
    handlerMocks.reportSchedulerHandler.mockRejectedValueOnce('weird');
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    await expect(capturedProcessor?.(makeJob('report-scheduler'))).rejects.toBe('weird');
    expect(mockLogJobFailed.mock.calls[0]?.[2]).toBe('Unknown error');
  });

  it('swallows a logJobFailed write error but still rethrows the original handler error', async () => {
    handlerMocks.tariffBoundaryCheckHandler.mockRejectedValueOnce(new Error('original'));
    mockLogJobFailed.mockRejectedValueOnce(new Error('log write failed'));
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    await expect(capturedProcessor?.(makeJob('tariff-boundary-check'))).rejects.toThrow('original');
  });
});

describe('cron-worker failed listener', () => {
  it('marks the cronjobs row failed with a truncated error message', async () => {
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    const failedHandler = onHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    const longMessage = 'x'.repeat(2000);
    failedHandler?.(makeJob('payment-reconciliation'), new Error(longMessage));

    expect(mockLog.error).toHaveBeenCalledWith(
      { jobName: 'payment-reconciliation', err: expect.any(Error) },
      'Cron job failed',
    );

    const setValues = dbUpdateSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(setValues['status']).toBe('failed');
    expect((setValues['error'] as string).length).toBe(1000);
  });

  it('falls back to "Unknown error" for a non-Error reason', async () => {
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    const failedHandler = onHandlers.get('failed');
    failedHandler?.(makeJob('report-scheduler'), 'string-error');

    const setValues = dbUpdateSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(setValues['error']).toBe('Unknown error');
  });

  it('ignores a null job', async () => {
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    const failedHandler = onHandlers.get('failed');
    failedHandler?.(null, new Error('boom'));

    expect(mockLog.error).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('swallows a db update rejection in the failed listener (fail-open)', async () => {
    dbUpdateWhere.mockReturnValueOnce(Promise.reject(new Error('db down')));
    const { createCronWorker } = await import('../cron-worker.js');
    createCronWorker({});

    const failedHandler = onHandlers.get('failed');
    expect(() => failedHandler?.(makeJob('dashboard-snapshot'), new Error('boom'))).not.toThrow();
    await Promise.resolve();
  });
});
