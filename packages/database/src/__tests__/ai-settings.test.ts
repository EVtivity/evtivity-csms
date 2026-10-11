// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSelect = vi.fn();
vi.mock('../config.js', () => ({ db: { select: mockSelect } }));
vi.mock('drizzle-orm', () => ({
  like: vi.fn(() => ({ type: 'like' })),
  or: vi.fn(() => ({ type: 'or' })),
}));
vi.mock('../schema/settings.js', () => ({ settings: { key: 'key', value: 'value' } }));

function rows(result: unknown[] | Error) {
  const chain: Record<string, unknown> = {};
  chain['from'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  return chain;
}

const STORED = [
  { key: 'chatbotAi.enabled', value: true },
  { key: 'chatbotAi.provider', value: 'deepseek' },
  { key: 'chatbotAi.effort', value: 'high' },
  { key: 'supportAi.enabled', value: false },
  { key: 'ai.deepseek.apiKeyEnc', value: 'cipher' },
  { key: 'ai.rateLimit.userPerMinute', value: 25 },
];

// Under load (a full run) the first import of the module graph can outlast
// the 5 s test timeout. Load it once here with a longer hook timeout; each
// test still imports a fresh copy after vi.resetModules, from the warm cache.
beforeAll(async () => {
  await import('../lib/ai-settings.js');
}, 30_000);

describe('getAiSettings (TC-AI-C-06)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSelect.mockReset();
  });

  it('reads every AI key in one query, caches it, and reloads after clearAiSettingsCache', async () => {
    mockSelect.mockReturnValue(rows(STORED));
    const { getAiSettings, clearAiSettingsCache } = await import('../lib/ai-settings.js');
    const first = await getAiSettings();
    expect(first.chatbot).toMatchObject({ enabled: true, provider: 'deepseek', effort: 'high' });
    expect(first.providers.deepseek.apiKeyEnc).toBe('cipher');
    expect(first.limits.userPerMinute).toBe(25);
    await getAiSettings();
    expect(mockSelect).toHaveBeenCalledTimes(1);

    mockSelect.mockReturnValue(rows([{ key: 'chatbotAi.enabled', value: false }]));
    clearAiSettingsCache();
    expect((await getAiSettings()).chatbot.enabled).toBe(false);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('serves the cached value when a later read fails', async () => {
    vi.useFakeTimers();
    try {
      mockSelect.mockReturnValue(rows(STORED));
      const { getAiSettings } = await import('../lib/ai-settings.js');
      await getAiSettings();
      vi.advanceTimersByTime(61_000);
      mockSelect.mockReturnValue(rows(new Error('db down')));
      expect((await getAiSettings()).chatbot.provider).toBe('deepseek');
      expect(mockSelect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when the first read fails, and the enabled checks fail closed', async () => {
    mockSelect.mockReturnValue(rows(new Error('db down')));
    const { getAiSettings, isChatbotAiEnabled, isSupportAiEnabled } =
      await import('../lib/ai-settings.js');
    await expect(getAiSettings()).rejects.toThrow('db down');
    expect(await isChatbotAiEnabled()).toBe(false);
    expect(await isSupportAiEnabled()).toBe(false);
  });

  it('reports each surface as enabled from its own key', async () => {
    mockSelect.mockReturnValue(rows(STORED));
    const { isChatbotAiEnabled, isSupportAiEnabled } = await import('../lib/ai-settings.js');
    expect(await isChatbotAiEnabled()).toBe(true);
    expect(await isSupportAiEnabled()).toBe(false);
  });
});

describe('AI roadmap readers (TC-AI-C-11)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSelect.mockReset();
  });

  it('reads every AI key prefix in the one query', async () => {
    mockSelect.mockReturnValue(rows([]));
    const { like } = await import('drizzle-orm');
    const { getAiSettings } = await import('../lib/ai-settings.js');
    await getAiSettings();
    const prefixes = vi.mocked(like).mock.calls.map((call) => call[1]);
    expect(prefixes).toEqual([
      'ai.%',
      'chatbotAi.%',
      'supportAi.%',
      'opsAi.%',
      'aiInsights.%',
      'aiWorkers.%',
    ]);
  });

  it('serves the ops surface, insights, workers and MCP from the cached settings', async () => {
    mockSelect.mockReturnValue(
      rows([
        { key: 'opsAi.enabled', value: true },
        { key: 'opsAi.provider', value: 'openai' },
        { key: 'aiInsights.cooldownMinutes', value: 15 },
        { key: 'aiWorkers.tariffAnomalies.enabled', value: true },
        { key: 'ai.mcp.enabled', value: true },
        { key: 'ai.mcp.rateLimitPerMinute', value: 10 },
      ]),
    );
    const m = await import('../lib/ai-settings.js');
    expect(await m.getOpsAiSettings()).toMatchObject({ enabled: true, provider: 'openai' });
    expect(await m.isOpsAiEnabled()).toBe(true);
    expect((await m.getAiInsightSettings()).cooldownMinutes).toBe(15);
    expect((await m.getAiWorkerSettings()).tariffAnomaliesEnabled).toBe(true);
    expect((await m.getAiMcpSettings()).rateLimitPerMinute).toBe(10);
    expect(await m.isAiMcpEnabled()).toBe(true);
    expect(mockSelect).toHaveBeenCalledTimes(1);

    mockSelect.mockReturnValue(rows([{ key: 'opsAi.enabled', value: false }]));
    m.clearAiSettingsCache();
    expect(await m.isOpsAiEnabled()).toBe(false);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('shows the AI Inbox only when a proposing worker or the MCP server is on', async () => {
    const m = await import('../lib/ai-settings.js');
    const cases: [Record<string, boolean>, boolean][] = [
      [{}, false],
      [{ 'aiWorkers.stuckSessions.enabled': true }, false],
      [{ 'opsAi.enabled': true }, false],
      [{ 'opsAi.enabled': true, 'aiWorkers.tariffAnomalies.enabled': true }, false],
      [{ 'opsAi.enabled': true, 'aiWorkers.stuckSessions.enabled': true }, true],
      [{ 'opsAi.enabled': true, 'aiWorkers.networkSummary.enabled': true }, true],
      [{ 'ai.mcp.enabled': true }, true],
    ];
    for (const [values, expected] of cases) {
      mockSelect.mockReturnValue(
        rows(Object.entries(values).map(([key, value]) => ({ key, value }))),
      );
      m.clearAiSettingsCache();
      expect(await m.isAiInboxEnabled(), JSON.stringify(values)).toBe(expected);
    }
  });

  it('shows the dashboard insights card only while ops AI and an insight kind are on', async () => {
    const m = await import('../lib/ai-settings.js');
    const cases: [Record<string, boolean>, boolean][] = [
      [{}, false],
      [{ 'opsAi.enabled': true }, true],
      [
        {
          'opsAi.enabled': true,
          'aiInsights.station.enabled': false,
          'aiInsights.session.enabled': false,
          'aiInsights.authorization.enabled': false,
        },
        false,
      ],
      [
        {
          'opsAi.enabled': true,
          'aiInsights.station.enabled': false,
          'aiInsights.session.enabled': true,
          'aiInsights.authorization.enabled': false,
        },
        true,
      ],
      [{ 'opsAi.enabled': false, 'aiInsights.station.enabled': true }, false],
    ];
    for (const [values, expected] of cases) {
      mockSelect.mockReturnValue(
        rows(Object.entries(values).map(([key, value]) => ({ key, value }))),
      );
      m.clearAiSettingsCache();
      expect(await m.isAiInsightsEnabled(), JSON.stringify(values)).toBe(expected);
    }
  });

  it('fails closed for the ops and MCP switches and throws for the threshold readers', async () => {
    mockSelect.mockReturnValue(rows(new Error('db down')));
    const m = await import('../lib/ai-settings.js');
    expect(await m.isOpsAiEnabled()).toBe(false);
    expect((await m.getOpsAiSettings()).enabled).toBe(false);
    expect(await m.isAiMcpEnabled()).toBe(false);
    expect(await m.isAiInboxEnabled()).toBe(false);
    expect(await m.isAiInsightsEnabled()).toBe(false);
    await expect(m.getAiInsightSettings()).rejects.toThrow('db down');
    await expect(m.getAiWorkerSettings()).rejects.toThrow('db down');
    await expect(m.getAiMcpSettings()).rejects.toThrow('db down');
  });
});
