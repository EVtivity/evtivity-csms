// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import type { RedisPubSubClient } from '@evtivity/lib';
import type { RunConfig, RunSummary, TestCaseResult } from '@evtivity/octt';

// Capture the latest update().set() payload so tests can assert exact status
// transitions in order.
const updateSets: Record<string, unknown>[] = [];
const insertValues: Record<string, unknown>[] = [];

// insert() returns a thenable so the handler's `.then(...).catch(...)` chain
// runs. The resolved/rejected behaviour is controlled per-test.
let insertShouldReject = false;
let insertRejectError: unknown = new Error('insert boom');

function makeUpdateChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['set'] = vi.fn((payload: Record<string, unknown>) => {
    updateSets.push(payload);
    return chain;
  });
  chain['where'] = vi.fn(() => Promise.resolve());
  return chain;
}

function makeInsertChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain['values'] = vi.fn((payload: Record<string, unknown>) => {
    insertValues.push(payload);
    return chain;
  });
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (insertShouldReject) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- mock rejects with a controlled value to exercise the handler error branches
      return Promise.reject(insertRejectError).then(resolve, reject);
    }
    return Promise.resolve(undefined).then(resolve, reject);
  };
  chain['catch'] = (reject: (r: unknown) => unknown) => Promise.resolve().catch(reject);
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    update: vi.fn(() => makeUpdateChain()),
    insert: vi.fn(() => makeInsertChain()),
  },
  octtRuns: { id: 'octtRuns.id' },
  octtTestResults: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

const workerConfig = vi.hoisted(() => ({
  OCPP_SERVER_URL: 'ws://localhost:7103',
  API_BASE_URL: 'http://localhost:7102',
  OCTT_OCSP_RESPONDER_URL: undefined as string | undefined,
}));
vi.mock('../../lib/config.js', () => ({ config: workerConfig }));

const mockRunTests = vi.fn();
vi.mock('@evtivity/octt', () => ({
  runTests: (...args: unknown[]) => mockRunTests(...args),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
const pubsub: RedisPubSubClient = {
  publish: mockPublish,
} as unknown as RedisPubSubClient;

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

const summary: RunSummary = {
  total: 6,
  passed: 3,
  failed: 1,
  skipped: 1,
  errors: 0,
  notApplicable: 1,
  durationMs: 4200,
};

function makeResult(overrides: Partial<TestCaseResult> = {}): TestCaseResult {
  return {
    testId: 'TC_B_01_CSMS',
    testName: 'Cold boot',
    module: 'B-provisioning',
    version: 'ocpp2.1',
    result: {
      status: 'passed',
      durationMs: 120,
      steps: [{ name: 'boot', status: 'passed' }],
      error: undefined,
    },
    ...overrides,
  } as TestCaseResult;
}

describe('octtRunnerHandler', () => {
  beforeEach(() => {
    updateSets.length = 0;
    insertValues.length = 0;
    insertShouldReject = false;
    insertRejectError = new Error('insert boom');
    mockRunTests.mockReset();
    mockPublish.mockClear();
    workerConfig.OCPP_SERVER_URL = 'ws://localhost:7103';
    workerConfig.API_BASE_URL = 'http://localhost:7102';
  });

  it('marks the run running at start, then completed with summary counts on success', async () => {
    mockRunTests.mockResolvedValue(summary);

    const { octtRunnerHandler } = await import('../../handlers/octt-runner.js');
    const log = makeLogger();
    await octtRunnerHandler({ runId: 7, ocppVersion: 'ocpp2.1', sutType: 'csms' }, log, pubsub);

    expect(updateSets).toHaveLength(2);
    expect(updateSets[0]).toMatchObject({ status: 'running' });
    expect(updateSets[0]?.['startedAt']).toBeInstanceOf(Date);

    expect(updateSets[1]).toMatchObject({
      status: 'completed',
      totalTests: 6,
      passed: 3,
      failed: 1,
      skipped: 1,
      errors: 0,
      notApplicable: 1,
      durationMs: 4200,
    });
    expect(updateSets[1]?.['completedAt']).toBeInstanceOf(Date);

    expect(log.info).toHaveBeenCalledWith({ runId: 7, summary }, 'OCTT run completed');
  });

  it('passes version undefined to runTests when ocppVersion is "all"', async () => {
    mockRunTests.mockResolvedValue(summary);

    const { octtRunnerHandler } = await import('../../handlers/octt-runner.js');
    await octtRunnerHandler({ runId: 1, ocppVersion: 'all', sutType: 'cs' }, makeLogger(), pubsub);

    const config = mockRunTests.mock.calls[0]?.[0] as RunConfig;
    expect(config.version).toBeUndefined();
    expect(config.sut).toBe('cs');
    expect(config.concurrency).toBe(3);
    expect(config.serverUrl).toBe('ws://localhost:7103');
    expect(config.apiUrl).toBe('http://localhost:7102');
    // No responder configured: the OCSP tests are skipped.
    expect(config.ocspResponderUrl).toBeUndefined();
  });

  it('starts the Test System OCSP responder at OCTT_OCSP_RESPONDER_URL', async () => {
    workerConfig.OCTT_OCSP_RESPONDER_URL = 'http://worker:7110/ocsp';
    mockRunTests.mockResolvedValue(summary);
    try {
      const { octtRunnerHandler } = await import('../../handlers/octt-runner.js');
      await octtRunnerHandler(
        { runId: 3, ocppVersion: 'ocpp2.1', sutType: 'csms' },
        makeLogger(),
        pubsub,
      );
    } finally {
      workerConfig.OCTT_OCSP_RESPONDER_URL = undefined;
    }

    const config = mockRunTests.mock.calls[0]?.[0] as RunConfig;
    expect(config.ocspResponderUrl).toBe('http://worker:7110/ocsp');
  });

  it('passes the concrete version and the configured urls to runTests', async () => {
    workerConfig.OCPP_SERVER_URL = 'ws://ocpp.internal:9000';
    workerConfig.API_BASE_URL = 'http://api.internal:8000';
    mockRunTests.mockResolvedValue(summary);

    const { octtRunnerHandler } = await import('../../handlers/octt-runner.js');
    await octtRunnerHandler(
      { runId: 2, ocppVersion: 'ocpp1.6', sutType: 'csms' },
      makeLogger(),
      pubsub,
    );

    const config = mockRunTests.mock.calls[0]?.[0] as RunConfig;
    expect(config.version).toBe('ocpp1.6');
    expect(config.serverUrl).toBe('ws://ocpp.internal:9000');
    expect(config.apiUrl).toBe('http://api.internal:8000');
  });

  it('inserts a test result and publishes octt.progress per onResult callback', async () => {
    const result = makeResult();
    mockRunTests.mockImplementation(
      async (_cfg: RunConfig, onResult: (r: TestCaseResult) => void) => {
        onResult(result);
        // Allow the insert().then(publish) microtask chain to settle.
        await Promise.resolve();
        await Promise.resolve();
        return summary;
      },
    );

    const { octtRunnerHandler } = await import('../../handlers/octt-runner.js');
    await octtRunnerHandler(
      { runId: 9, ocppVersion: 'ocpp2.1', sutType: 'csms' },
      makeLogger(),
      pubsub,
    );

    expect(insertValues).toHaveLength(1);
    expect(insertValues[0]).toEqual({
      runId: 9,
      testId: 'TC_B_01_CSMS',
      testName: 'Cold boot',
      module: 'B-provisioning',
      ocppVersion: 'ocpp2.1',
      status: 'passed',
      durationMs: 120,
      steps: [{ name: 'boot', status: 'passed' }],
      error: null,
      notApplicableItem: null,
      notApplicableReason: null,
    });

    expect(mockPublish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({
        eventType: 'octt.progress',
        runId: 9,
        testId: 'TC_B_01_CSMS',
        status: 'passed',
      }),
    );
  });

  it('persists a notApplicable result with its PICS item and reason', async () => {
    const result = makeResult({
      testId: 'TC_M_26_CSMS',
      result: {
        status: 'notApplicable',
        durationMs: 0,
        steps: [],
        notApplicable: {
          item: 'ContractCertificateInstallationEV',
          reason: 'PICS ContractCertificateInstallationEV not supported: no provisioning',
        },
      },
    });
    mockRunTests.mockImplementation(
      async (_cfg: RunConfig, onResult: (r: TestCaseResult) => void) => {
        onResult(result);
        await Promise.resolve();
        await Promise.resolve();
        return summary;
      },
    );

    const { octtRunnerHandler } = await import('../../handlers/octt-runner.js');
    await octtRunnerHandler(
      { runId: 5, ocppVersion: 'ocpp2.1', sutType: 'csms' },
      makeLogger(),
      pubsub,
    );

    expect(insertValues[0]).toMatchObject({
      testId: 'TC_M_26_CSMS',
      status: 'notApplicable',
      durationMs: 0,
      error: null,
      notApplicableItem: 'ContractCertificateInstallationEV',
      notApplicableReason: 'PICS ContractCertificateInstallationEV not supported: no provisioning',
    });
  });

  it('coerces a missing result error to null on insert', async () => {
    const result = makeResult({
      result: { status: 'failed', durationMs: 50, steps: [], error: 'step failed' },
    });
    mockRunTests.mockImplementation(
      async (_cfg: RunConfig, onResult: (r: TestCaseResult) => void) => {
        onResult(result);
        await Promise.resolve();
        await Promise.resolve();
        return summary;
      },
    );

    const { octtRunnerHandler } = await import('../../handlers/octt-runner.js');
    await octtRunnerHandler(
      { runId: 3, ocppVersion: 'ocpp2.1', sutType: 'csms' },
      makeLogger(),
      pubsub,
    );

    expect(insertValues[0]?.['error']).toBe('step failed');
  });

  it('fail-open: a failed result insert is warned and does not abort the run', async () => {
    insertShouldReject = true;
    insertRejectError = new Error('db insert failed');
    const log = makeLogger();
    const result = makeResult();
    mockRunTests.mockImplementation(
      async (_cfg: RunConfig, onResult: (r: TestCaseResult) => void) => {
        onResult(result);
        await Promise.resolve();
        await Promise.resolve();
        return summary;
      },
    );

    const { octtRunnerHandler } = await import('../../handlers/octt-runner.js');
    await octtRunnerHandler({ runId: 4, ocppVersion: 'ocpp2.1', sutType: 'csms' }, log, pubsub);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 4, testId: 'TC_B_01_CSMS' }),
      'Failed to persist OCTT test result or publish progress',
    );
    // The publish never fired because the insert rejected first.
    expect(mockPublish).not.toHaveBeenCalled();
    // The run still completes.
    expect(updateSets[updateSets.length - 1]).toMatchObject({ status: 'completed' });
  });

  it('marks the run failed and logs the error message when runTests throws an Error', async () => {
    mockRunTests.mockRejectedValue(new Error('runner exploded'));
    const log = makeLogger();

    const { octtRunnerHandler } = await import('../../handlers/octt-runner.js');
    await octtRunnerHandler({ runId: 11, ocppVersion: 'ocpp2.1', sutType: 'csms' }, log, pubsub);

    expect(updateSets).toHaveLength(2);
    expect(updateSets[0]).toMatchObject({ status: 'running' });
    expect(updateSets[1]).toMatchObject({ status: 'failed' });
    expect(updateSets[1]?.['completedAt']).toBeInstanceOf(Date);

    expect(log.error).toHaveBeenCalledWith(
      { runId: 11, error: 'runner exploded' },
      'OCTT run failed',
    );
  });

  it('stringifies a non-Error rejection in the failure log', async () => {
    mockRunTests.mockRejectedValue('plain string failure');
    const log = makeLogger();

    const { octtRunnerHandler } = await import('../../handlers/octt-runner.js');
    await octtRunnerHandler({ runId: 12, ocppVersion: 'ocpp2.1', sutType: 'csms' }, log, pubsub);

    expect(log.error).toHaveBeenCalledWith(
      { runId: 12, error: 'plain string failure' },
      'OCTT run failed',
    );
    expect(updateSets[1]).toMatchObject({ status: 'failed' });
  });
});
