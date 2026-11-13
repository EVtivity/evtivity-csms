// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Every outcome of the background worker narrative call: each one but `ok`
// leaves the run with its deterministic output, and no budget check failure
// lets a model call through (fail closed).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAdapter } from '@evtivity/ai/core';

const h = vi.hoisted(() => ({
  settings: { ops: { enabled: true }, insights: { primaryLanguage: 'de' } },
  resolveOpsAiConfig: vi.fn(),
  recordAiUsage: vi.fn(),
  dispatchAiBudgetNotices: vi.fn(),
}));

vi.mock('@evtivity/services/ai-ops-config', () => ({ resolveOpsAiConfig: h.resolveOpsAiConfig }));
vi.mock('@evtivity/services/ai-alerts', () => ({
  aiProviderGate: vi.fn(() => Promise.resolve('open')),
  trackAiProviderCalls: (a: unknown) => a,
  dispatchAiBudgetNotices: h.dispatchAiBudgetNotices,
}));
vi.mock('@evtivity/database', () => ({
  checkAiBudgets: vi.fn(() => Promise.resolve({ allowed: true })),
  getAiSettings: () => Promise.resolve(h.settings),
  recordAiUsage: h.recordAiUsage,
}));

const { runOpsNarrative, MAX_NARRATIVE_CHARS } = await import('../ai-workers/ops-model.js');

const CONFIG = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
  baseUrl: '',
  effort: 'low',
  systemPrompt: '',
};
const REQUEST = {
  job: 'stuck_sessions' as never,
  siteId: 'sit_1',
  workerRunId: 3,
  facts: { a: 1 },
};

function adapter(text: string | Error) {
  const complete = vi.fn(() =>
    text instanceof Error
      ? Promise.reject(text)
      : Promise.resolve({ text, usage: { inputTokens: 10, outputTokens: 5 } }),
  );
  return { adapter: { complete } as unknown as AiAdapter, complete };
}

function deps(overrides: Record<string, unknown> = {}) {
  const { adapter: a } = adapter('A narrative.');
  return {
    createAdapter: () => a,
    checkBudgets: () => Promise.resolve({ allowed: true as const }),
    providerGate: () => Promise.resolve('open' as const),
    encryptionKey: 'k',
    allowPrivateHosts: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = { ops: { enabled: true }, insights: { primaryLanguage: 'de' } };
  h.resolveOpsAiConfig.mockReturnValue(CONFIG);
  h.recordAiUsage.mockResolvedValue([]);
  h.dispatchAiBudgetNotices.mockResolvedValue(undefined);
});

describe('runOpsNarrative', () => {
  it('answers disabled while the ops surface is off', async () => {
    h.settings = { ops: { enabled: false }, insights: { primaryLanguage: 'en' } };
    expect(await runOpsNarrative(REQUEST, deps())).toEqual({ kind: 'disabled' });
    expect(h.resolveOpsAiConfig).not.toHaveBeenCalled();
  });

  it('answers error for a key that cannot be read and not_configured without a provider', async () => {
    h.resolveOpsAiConfig.mockImplementationOnce(() => {
      throw new Error('bad ciphertext');
    });
    expect(await runOpsNarrative(REQUEST, deps())).toEqual({ kind: 'error' });
    h.resolveOpsAiConfig.mockReturnValueOnce(null);
    expect(await runOpsNarrative(REQUEST, deps())).toEqual({ kind: 'not_configured' });
  });

  it('makes no call when the budget check fails or refuses, or the provider is paused', async () => {
    const { adapter: a, complete } = adapter('x');
    const base = { createAdapter: () => a };
    expect(
      await runOpsNarrative(
        REQUEST,
        deps({ ...base, checkBudgets: () => Promise.reject(new Error('db')) }),
      ),
    ).toEqual({ kind: 'budget', code: 'AI_BUDGET_UNAVAILABLE' });
    expect(
      await runOpsNarrative(
        REQUEST,
        deps({
          ...base,
          checkBudgets: () => Promise.resolve({ allowed: false, code: 'AI_SITE_BUDGET_EXCEEDED' }),
        }),
      ),
    ).toEqual({ kind: 'budget', code: 'AI_SITE_BUDGET_EXCEEDED' });
    expect(
      await runOpsNarrative(
        REQUEST,
        deps({ ...base, providerGate: () => Promise.resolve('paused') }),
      ),
    ).toEqual({ kind: 'provider_paused' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns the cleaned text in the primary language and records the usage', async () => {
    const { adapter: a, complete } = adapter(` ${'n'.repeat(MAX_NARRATIVE_CHARS + 10)}\r `);
    const out = await runOpsNarrative(REQUEST, deps({ createAdapter: () => a }));
    expect(out).toMatchObject({ kind: 'ok', language: 'de', provider: 'deepseek' });
    if (out.kind === 'ok') {
      expect(out.text).toHaveLength(MAX_NARRATIVE_CHARS + 3);
      expect(out.text.endsWith('...')).toBe(true);
    }
    expect(complete).toHaveBeenCalledTimes(1);
    expect(h.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'worker', siteId: 'sit_1', workerRunId: '3' }),
    );
  });

  it('passes a base URL only when one is set', async () => {
    h.resolveOpsAiConfig.mockReturnValue({ ...CONFIG, baseUrl: 'https://llm.example' });
    const create = vi.fn(() => adapter('ok').adapter);
    await runOpsNarrative(REQUEST, deps({ createAdapter: create }));
    expect(create).toHaveBeenCalledWith('deepseek', {
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example',
    });
  });

  it('keeps the text when the usage cannot be recorded', async () => {
    h.recordAiUsage.mockRejectedValueOnce(new Error('db'));
    expect((await runOpsNarrative(REQUEST, deps())).kind).toBe('ok');
  });

  it('answers error for an empty reply or a failed call', async () => {
    expect(
      await runOpsNarrative(REQUEST, deps({ createAdapter: () => adapter('  ').adapter })),
    ).toEqual({ kind: 'error' });
    expect(
      await runOpsNarrative(
        REQUEST,
        deps({ createAdapter: () => adapter(new Error('timeout')).adapter }),
      ),
    ).toEqual({ kind: 'error' });
  });
});
