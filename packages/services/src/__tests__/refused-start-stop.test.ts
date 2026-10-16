// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { add, jobQueue, publishOcppCommand, dispatchOneShotStationMessage, writeCsmsSessionAudit } =
  vi.hoisted(() => {
    const addFn = vi.fn();
    return {
      add: addFn,
      jobQueue: vi.fn(() => ({ add: addFn, addBulk: vi.fn() })),
      publishOcppCommand: vi.fn(),
      dispatchOneShotStationMessage: vi.fn(),
      writeCsmsSessionAudit: vi.fn(),
    };
  });

vi.mock('@evtivity/database', () => ({ writeCsmsSessionAudit }));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  publishOcppCommand,
  dispatchOneShotStationMessage,
}));
vi.mock('@evtivity/lib/job-queues', () => ({ jobQueue }));

import {
  enqueueRefusedStartStop,
  REFUSED_START_STOP_GRACE_MS,
  refusedStartStopJobId,
  runRefusedStartStop,
} from '../refused-start-stop.js';
import { PAYMENT_STOP_JOB_OPTIONS, PAYMENT_STOP_QUEUE } from '@evtivity/lib/worker-queues';

const target = {
  sessionId: 'sess-1',
  transactionId: '5001',
  ocppStationId: 'KEBA-1',
  stationDbId: 'station-uuid',
};

function makeDeps(endedRows: unknown[]) {
  const calls: string[] = [];
  const sql = vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FROM transaction_events')) {
      calls.push('ended-check');
      return Promise.resolve(endedRows);
    }
    if (text.includes('FROM settings')) return Promise.resolve([]);
    return Promise.resolve([]);
  });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const pubsub = { publish: vi.fn(), subscribe: vi.fn() };
  return {
    calls,
    logger,
    pubsub,
    deps: { sql, pubsub, logger } as unknown as Parameters<typeof runRefusedStartStop>[0],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  add.mockResolvedValue(undefined);
  publishOcppCommand.mockResolvedValue(undefined);
  dispatchOneShotStationMessage.mockResolvedValue(true);
  writeCsmsSessionAudit.mockResolvedValue(undefined);
});

describe('enqueueRefusedStartStop', () => {
  it('adds one delayed job per session to the payment stop queue', async () => {
    await enqueueRefusedStartStop(target);
    expect(jobQueue).toHaveBeenCalledWith(PAYMENT_STOP_QUEUE, PAYMENT_STOP_JOB_OPTIONS);
    expect(add).toHaveBeenCalledWith('refused-start-stop', target, {
      jobId: 'refused-start-stop.sess-1',
      delay: REFUSED_START_STOP_GRACE_MS,
    });
    expect(REFUSED_START_STOP_GRACE_MS).toBe(30_000);
    expect(refusedStartStopJobId('sess-1')).not.toContain(':');
  });

  it('throws when the job cannot be added, so the caller stops at once', async () => {
    add.mockRejectedValueOnce(new Error('NOPERM'));
    await expect(enqueueRefusedStartStop(target)).rejects.toThrow('NOPERM');
  });
});

describe('runRefusedStartStop', () => {
  it('sends no stop and no message when the station ended the transaction itself', async () => {
    const h = makeDeps([{ '?column?': 1 }]);
    await expect(runRefusedStartStop(h.deps, target)).resolves.toBe('station_ended');
    expect(publishOcppCommand).not.toHaveBeenCalled();
    expect(dispatchOneShotStationMessage).not.toHaveBeenCalled();
    expect(writeCsmsSessionAudit).not.toHaveBeenCalled();
  });

  it('stops the transaction, shows the credit limit message and audits when it is still open', async () => {
    const h = makeDeps([]);
    await expect(runRefusedStartStop(h.deps, target)).resolves.toBe('stopped');
    expect(h.calls).toEqual(['ended-check']);
    expect(publishOcppCommand).toHaveBeenCalledWith(h.pubsub, {
      stationId: 'KEBA-1',
      action: 'RequestStopTransaction',
      payload: { transactionId: '5001' },
    });
    expect(dispatchOneShotStationMessage).toHaveBeenCalledWith(
      h.pubsub,
      h.deps.sql,
      expect.objectContaining({
        stationOcppId: 'KEBA-1',
        stationDbId: 'station-uuid',
        state: 'account_credit_limit',
      }),
      { ttlSeconds: 30, autoClearMs: 30_000 },
    );
    expect(writeCsmsSessionAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        action: 'stopped_by_csms',
        actor: 'system',
        actorLabel: 'refused-start-stop',
      }),
      undefined,
      h.logger,
    );
  });

  it('throws a failed stop publish so the queue retries it', async () => {
    const h = makeDeps([]);
    publishOcppCommand.mockRejectedValueOnce(new Error('redis down'));
    await expect(runRefusedStartStop(h.deps, target)).rejects.toThrow('redis down');
    expect(dispatchOneShotStationMessage).not.toHaveBeenCalled();
  });
});
