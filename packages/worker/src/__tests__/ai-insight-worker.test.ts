// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, Queue } from 'bullmq';
import type { PubSubClient } from '@evtivity/lib';

const h = vi.hoisted(() => {
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return {
    log,
    processor: undefined as ((job: Job) => Promise<unknown>) | undefined,
    onFailed: undefined as ((job: Job | undefined, err: Error) => void) | undefined,
    generateInsight: vi.fn(),
    translateInsight: vi.fn(),
    getInsightRow: vi.fn(),
    failInsight: vi.fn(),
    storeInsightTranslation: vi.fn(),
    publishInsightUpdated: vi.fn(),
    logJobStarted: vi.fn(),
    logJobCompleted: vi.fn(),
    logJobFailed: vi.fn(),
    resolveOpsAiConfig: vi.fn(),
  };
});

vi.mock('@evtivity/lib', () => ({ createLogger: vi.fn(() => h.log) }));
vi.mock('@evtivity/database', () => ({
  checkAiBudgets: vi.fn(),
  getInsightAiSettings: vi.fn(),
}));
vi.mock('@evtivity/services/ai-insight.service', () => ({
  AI_INSIGHT_REQUESTS_CHANNEL: 'ai_insight_requests',
  failInsight: h.failInsight,
  getInsightRow: h.getInsightRow,
  publishInsightUpdated: h.publishInsightUpdated,
  storeInsightTranslation: h.storeInsightTranslation,
}));
vi.mock('@evtivity/services/ai-ops-config', () => ({
  createOpsAdapter: vi.fn(),
  resolveOpsAiConfig: h.resolveOpsAiConfig,
}));
vi.mock('@evtivity/services/ai-alerts', () => ({ aiProviderGate: vi.fn() }));
vi.mock('../lib/config.js', () => ({
  config: { SETTINGS_ENCRYPTION_KEY: 'key' },
  allowsDevelopmentRelaxations: () => false,
}));
vi.mock('../job-logger.js', () => ({
  logJobStarted: h.logJobStarted,
  logJobCompleted: h.logJobCompleted,
  logJobFailed: h.logJobFailed,
}));
vi.mock('../ai-insights/generate.js', () => ({ generateInsight: h.generateInsight }));
vi.mock('../ai-insights/translate.js', () => ({ translateInsight: h.translateInsight }));
vi.mock('bullmq', () => ({
  Worker: vi.fn(function (this: unknown, _name: string, processor: (job: Job) => Promise<unknown>) {
    h.processor = processor;
    return {
      on: (event: string, fn: (job: Job | undefined, err: Error) => void) => {
        if (event === 'failed') h.onFailed = fn;
      },
    };
  }),
}));

const {
  insightJobId,
  setAiInsightQueue,
  enqueueAiInsightJob,
  startAiInsightBridge,
  defaultInsightJobDeps,
  runAiInsightJob,
  handleAiInsightJobFailed,
  createAiInsightWorker,
} = await import('../ai-insight-worker.js');

const pubsub = {} as PubSubClient;
const ROW = { id: 'ins_1' };

beforeEach(() => {
  vi.clearAllMocks();
  h.log.child.mockReturnValue(h.log);
  h.logJobStarted.mockResolvedValue(7);
  h.logJobCompleted.mockResolvedValue(undefined);
  h.logJobFailed.mockResolvedValue(undefined);
  setAiInsightQueue(null);
});

describe('job ids and the queue', () => {
  it('uses the insight id for a generation and a colon-free stamp for a translation', () => {
    expect(insightJobId({ kind: 'generate', insightId: 'ins_1' })).toBe('ins_1');
    expect(
      insightJobId({ kind: 'translate', insightId: 'ins_1', language: 'zh-TW', attempt: 2 }),
    ).toBe('ins-tr.ins_1.zh-TW.2');
  });

  it('fails loud without a queue and adds jobs under their id, delayed when asked', async () => {
    await expect(enqueueAiInsightJob({ kind: 'generate', insightId: 'ins_1' })).rejects.toThrow(
      /queue is not set/,
    );
    const add = vi.fn(() => Promise.resolve());
    setAiInsightQueue({ add } as unknown as Queue);
    await enqueueAiInsightJob({ kind: 'generate', insightId: 'ins_1' }, 5000);
    await enqueueAiInsightJob({
      kind: 'translate',
      insightId: 'ins_1',
      language: 'de',
      attempt: 0,
    });
    expect(add.mock.calls).toEqual([
      ['generate', { kind: 'generate', insightId: 'ins_1' }, { jobId: 'ins_1', delay: 5000 }],
      [
        'translate',
        { kind: 'translate', insightId: 'ins_1', language: 'de', attempt: 0 },
        { jobId: 'ins-tr.ins_1.de.0' },
      ],
    ]);
  });
});

describe('startAiInsightBridge', () => {
  it('queues valid requests, drops malformed ones and logs a failed add', async () => {
    let handler: ((payload: string) => void) | undefined;
    const unsubscribe = vi.fn(() => Promise.resolve());
    const bridgePubsub = {
      subscribe: vi.fn((_channel: string, fn: (payload: string) => void) => {
        handler = fn;
        return Promise.resolve({ unsubscribe });
      }),
    } as unknown as PubSubClient;
    const add = vi.fn(() => Promise.resolve());
    setAiInsightQueue({ add } as unknown as Queue);
    const stop = await startAiInsightBridge(bridgePubsub);
    expect(bridgePubsub.subscribe).toHaveBeenCalledWith(
      'ai_insight_requests',
      expect.any(Function),
    );

    handler?.(JSON.stringify({ kind: 'generate', insightId: 'ins_2' }));
    handler?.('not json');
    handler?.(
      JSON.stringify({ kind: 'translate', insightId: 'ins_2', language: 'fr', attempt: 0 }),
    );
    await Promise.resolve();
    expect(add).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledTimes(2);

    add.mockRejectedValueOnce(new Error('redis down'));
    handler?.(JSON.stringify({ kind: 'generate', insightId: 'ins_3' }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ insightId: 'ins_3' }),
      'Failed to queue an AI insight job',
    );

    await stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('running jobs', () => {
  it('dispatches by kind', async () => {
    const deps = defaultInsightJobDeps(pubsub);
    h.generateInsight.mockResolvedValueOnce('generated');
    h.translateInsight.mockResolvedValueOnce('translated');
    expect(
      await runAiInsightJob({ kind: 'generate', insightId: 'ins_1' }, deps, h.log as never),
    ).toBe('generated');
    expect(
      await runAiInsightJob(
        { kind: 'translate', insightId: 'ins_1', language: 'ko', attempt: 1 },
        deps,
        h.log as never,
      ),
    ).toBe('translated');
    expect(h.translateInsight).toHaveBeenCalledWith('ins_1', 'ko', deps, h.log);
  });

  it('builds the default deps with the settings key', () => {
    const deps = defaultInsightJobDeps(pubsub);
    expect(deps.subjectSecret).toBe('key');
    expect(deps.pubsub).toBe(pubsub);
    expect(deps.now()).toBeInstanceOf(Date);
    deps.resolveConfig({} as never);
    expect(h.resolveOpsAiConfig).toHaveBeenCalledWith({}, 'key', false);
  });
});

describe('handleAiInsightJobFailed', () => {
  const generate = { kind: 'generate' as const, insightId: 'ins_1' };
  const translate = { kind: 'translate' as const, insightId: 'ins_1', language: 'es', attempt: 0 };

  it('only logs an attempt that will be retried', async () => {
    await handleAiInsightJobFailed(
      { data: generate, attemptsMade: 1, opts: { attempts: 3 } },
      new Error('x'),
      pubsub,
      h.log as never,
    );
    expect(h.getInsightRow).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalled();
  });

  it('fails a generation after the last attempt and announces it', async () => {
    h.getInsightRow.mockResolvedValue(ROW);
    h.failInsight.mockResolvedValue(true);
    await handleAiInsightJobFailed(
      { data: generate, attemptsMade: 3, opts: { attempts: 3 } },
      new Error('x'),
      pubsub,
      h.log as never,
    );
    expect(h.failInsight).toHaveBeenCalledWith('ins_1');
    expect(h.publishInsightUpdated).toHaveBeenCalledWith(pubsub, ROW);
  });

  it('marks a stalled translation unavailable and announces only a change', async () => {
    h.getInsightRow.mockResolvedValue(ROW);
    h.storeInsightTranslation.mockResolvedValueOnce(false);
    await handleAiInsightJobFailed(
      { data: translate, attemptsMade: 0, opts: {}, finishedOn: Date.now() },
      new Error('x'),
      pubsub,
      h.log as never,
    );
    expect(h.storeInsightTranslation).toHaveBeenCalledWith('ins_1', 'es', null);
    expect(h.publishInsightUpdated).not.toHaveBeenCalled();
  });

  it('does nothing for an insight that is gone', async () => {
    h.getInsightRow.mockResolvedValue(null);
    await handleAiInsightJobFailed(
      { data: generate, attemptsMade: 1, opts: {} },
      new Error('x'),
      pubsub,
    );
    expect(h.failInsight).not.toHaveBeenCalled();
  });
});

describe('createAiInsightWorker', () => {
  it('logs the job, returns its outcome and records a failure before rethrowing', async () => {
    const deps = defaultInsightJobDeps(pubsub);
    createAiInsightWorker({}, pubsub, deps);
    h.generateInsight.mockResolvedValueOnce('active');
    const job = { id: 'ins_1', name: 'generate', data: { kind: 'generate', insightId: 'ins_1' } };
    expect(await h.processor?.(job as unknown as Job)).toBe('active');
    expect(h.logJobCompleted).toHaveBeenCalledWith(7, expect.any(Number));

    h.generateInsight.mockRejectedValueOnce(new Error('model down'));
    h.logJobFailed.mockRejectedValueOnce(new Error('db down'));
    await expect(h.processor?.(job as unknown as Job)).rejects.toThrow('model down');
    expect(h.logJobFailed).toHaveBeenCalledWith(7, expect.any(Number), 'model down');
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'ins_1' }),
      'Failed to record AI insight job failure',
    );

    h.generateInsight.mockRejectedValueOnce('a string');
    await expect(h.processor?.(job as unknown as Job)).rejects.toBe('a string');
    expect(h.logJobFailed).toHaveBeenLastCalledWith(7, expect.any(Number), 'Unknown error');
  });

  it('handles a failed job after its last attempt and logs a failed handling', async () => {
    createAiInsightWorker({}, pubsub, defaultInsightJobDeps(pubsub));
    h.onFailed?.(undefined, new Error('x'));
    h.getInsightRow.mockRejectedValueOnce(new Error('db down'));
    h.onFailed?.(
      {
        id: 'ins_1',
        data: { kind: 'generate', insightId: 'ins_1' },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as unknown as Job,
      new Error('x'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'ins_1' }),
      'AI insight failure handling failed',
    );
  });
});
