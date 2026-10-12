// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let pending = false;
let insightId: string | null = 'ins_000000000001';
let created: unknown = { id: 'apr_000000000001' };
let createError: Error | null = null;

vi.mock('@evtivity/database', () => ({
  getAiInsightSettings: () => Promise.resolve({ primaryLanguage: 'de' }),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: () => Promise.resolve() }),
}));

vi.mock('../ai-insight.service.js', () => ({
  storeWorkerActionInsight: (input: { primaryLanguage: string }) => {
    calls.push(`insight:${input.primaryLanguage}`);
    return Promise.resolve(insightId);
  },
  resolveInsights: (ids: string[]) => {
    calls.push(`resolve:${ids.join(',')}`);
    return Promise.resolve(ids);
  },
  getInsightRow: () => Promise.resolve(null),
  publishInsightUpdated: () => Promise.resolve(),
}));

vi.mock('../ai-proposal.service.js', () => ({
  hasPendingAiProposal: (key: string) => {
    calls.push(`pending:${key}`);
    return Promise.resolve(pending);
  },
  createAiProposal: (input: { insightId: string }) => {
    calls.push(`action:${input.insightId}`);
    if (createError !== null) return Promise.reject(createError);
    return Promise.resolve(created);
  },
}));

const { suggestWorkerAction } = await import('../ai-workers/suggest.js');

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const suggestion = {
  insight: {
    kind: 'stuck_session' as const,
    siteId: 'sit_000000000001',
    stationId: 'sta_000000000001',
    sessionId: 'ses_000000000001',
    triggerKey: 'stuck_sessions:ses_000000000001:2026-10-10T10:15',
    narrative: null,
  },
  action: {
    job: 'stuck_sessions' as const,
    siteId: 'sit_000000000001',
    operationId: 'ocppv21_RequestStopTransaction',
    method: 'POST',
    path: '/v1/ocpp/commands/v21/RequestStopTransaction',
    args: { stationId: 'CS-1', transactionId: 'tx-1' },
    dedupKey: 'stuck_sessions:ses_000000000001',
    expiresAt: new Date(Date.now() + 3_600_000),
    actor: { actor: 'system' as const, actorLabel: 'ai-stuck_sessions' },
  },
};

beforeEach(() => {
  calls.length = 0;
  pending = false;
  insightId = 'ins_000000000001';
  created = { id: 'apr_000000000001' };
  createError = null;
});

describe('TC-AI-IA-02 suggestWorkerAction', () => {
  it('writes the insight in the primary language, then its action', async () => {
    expect(await suggestWorkerAction(suggestion, log)).toBe('created');
    expect(calls).toEqual([
      'pending:stuck_sessions:ses_000000000001',
      'insight:de',
      'action:ins_000000000001',
    ]);
  });

  it('makes nothing while the same action is still pending', async () => {
    pending = true;
    expect(await suggestWorkerAction(suggestion, log)).toBe('duplicate');
    expect(calls).toEqual(['pending:stuck_sessions:ses_000000000001']);
  });

  it('makes no action when the insight trigger was seen before', async () => {
    insightId = null;
    expect(await suggestWorkerAction(suggestion, log)).toBe('duplicate');
    expect(calls).not.toContain('action:ins_000000000001');
  });

  it('resolves the new insight when a concurrent run made the action first', async () => {
    created = null;
    expect(await suggestWorkerAction(suggestion, log)).toBe('duplicate');
    expect(calls.at(-1)).toBe('resolve:ins_000000000001');
  });

  it('resolves the new insight and rethrows when the action is refused', async () => {
    createError = new Error('Unknown station');
    await expect(suggestWorkerAction(suggestion, log)).rejects.toThrow('Unknown station');
    expect(calls.at(-1)).toBe('resolve:ins_000000000001');
  });
});
