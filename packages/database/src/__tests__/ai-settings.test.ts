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
const reservationFeature = vi.hoisted(() => ({ enabled: true }));
vi.mock('../lib/reservation-setting.js', () => ({
  isReservationEnabled: vi.fn(() => Promise.resolve(reservationFeature.enabled)),
}));

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
      'driverAi.%',
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
        { key: 'ai.mcp.allowWrites', value: true },
      ]),
    );
    const m = await import('../lib/ai-settings.js');
    expect(await m.getOpsAiSettings()).toMatchObject({ enabled: true, provider: 'openai' });
    expect(await m.isOpsAiEnabled()).toBe(true);
    expect((await m.getAiInsightSettings()).cooldownMinutes).toBe(15);
    expect((await m.getAiWorkerSettings()).tariffAnomaliesEnabled).toBe(true);
    expect(await m.getAiMcpSettings()).toMatchObject({ rateLimitPerMinute: 10, allowWrites: true });
    expect(await m.isAiMcpEnabled()).toBe(true);
    expect(mockSelect).toHaveBeenCalledTimes(1);

    mockSelect.mockReturnValue(rows([{ key: 'opsAi.enabled', value: false }]));
    m.clearAiSettingsCache();
    expect(await m.isOpsAiEnabled()).toBe(false);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('TC-AI-IA-07 turns AI Insights on only while ops AI and an insight kind or worker job are on', async () => {
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
          'aiInsights.reservation.enabled': false,
        },
        false,
      ],
      [
        {
          'opsAi.enabled': true,
          'aiInsights.station.enabled': false,
          'aiInsights.session.enabled': false,
          'aiInsights.authorization.enabled': false,
          'aiInsights.reservation.enabled': true,
        },
        true,
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
      // Background worker suggestions are insights too.
      [
        {
          'opsAi.enabled': true,
          'aiInsights.station.enabled': false,
          'aiInsights.session.enabled': false,
          'aiInsights.authorization.enabled': false,
          'aiInsights.reservation.enabled': false,
          'aiWorkers.stuckSessions.enabled': true,
        },
        true,
      ],
      [{ 'opsAi.enabled': false, 'aiWorkers.networkSummary.enabled': true }, false],
    ];
    for (const [values, expected] of cases) {
      mockSelect.mockReturnValue(
        rows(Object.entries(values).map(([key, value]) => ({ key, value }))),
      );
      m.clearAiSettingsCache();
      expect(await m.isAiInsightsEnabled(), JSON.stringify(values)).toBe(expected);
    }
  });

  it('counts reservation insights as on only while the reservation feature is on', async () => {
    const m = await import('../lib/ai-settings.js');
    const onlyReservations = [
      { key: 'opsAi.enabled', value: true },
      { key: 'aiInsights.station.enabled', value: false },
      { key: 'aiInsights.session.enabled', value: false },
      { key: 'aiInsights.authorization.enabled', value: false },
      { key: 'aiInsights.reservation.enabled', value: true },
    ];
    try {
      mockSelect.mockReturnValue(rows(onlyReservations));
      m.clearAiSettingsCache();
      reservationFeature.enabled = true;
      expect((await m.getAiInsightSettings()).reservationEnabled).toBe(true);
      expect((await m.getInsightAiSettings()).insights.reservationEnabled).toBe(true);
      expect(await m.isAiInsightsEnabled()).toBe(true);

      reservationFeature.enabled = false;
      expect((await m.getAiInsightSettings()).reservationEnabled).toBe(false);
      expect((await m.getInsightAiSettings()).insights.reservationEnabled).toBe(false);
      expect(await m.isAiInsightsEnabled()).toBe(false);
      // The stored switch is unchanged: the settings page still shows it.
      expect((await m.getAiSettings()).insights.reservationEnabled).toBe(true);
      // Both readers are cached: still the one settings query.
      expect(mockSelect).toHaveBeenCalledTimes(1);
    } finally {
      reservationFeature.enabled = true;
    }
  });

  it('TC-CFG-04 serves the driver surface and reloads it after clearAiSettingsCache', async () => {
    mockSelect.mockReturnValue(rows([]));
    const m = await import('../lib/ai-settings.js');
    expect(await m.getDriverAiSettings()).toEqual({
      enabled: false,
      provider: null,
      model: '',
      effort: 'low',
      systemPrompt: '',
      maxCasesPerDriverPerDay: 3,
      feedbackTimeoutHours: 24,
    });
    expect(await m.isDriverAiEnabled()).toBe(false);
    expect((await m.getAiInsightSettings()).reservationEnabled).toBe(true);

    // A settings write calls clearAiSettingsCache (routes/settings.ts); the
    // next read sees the new values.
    mockSelect.mockReturnValue(
      rows([
        { key: 'driverAi.enabled', value: true },
        { key: 'driverAi.provider', value: 'anthropic' },
        { key: 'driverAi.maxCasesPerDriverPerDay', value: 5 },
        { key: 'ai.budget.driverDailyTokens', value: 1000 },
        { key: 'ai.rateLimit.driverPerMinute', value: 4 },
        { key: 'aiInsights.reservation.enabled', value: false },
      ]),
    );
    expect(await m.isDriverAiEnabled()).toBe(false);
    m.clearAiSettingsCache();
    expect(await m.isDriverAiEnabled()).toBe(true);
    const settings = await m.getAiSettings();
    expect(settings.driver).toMatchObject({
      enabled: true,
      provider: 'anthropic',
      maxCasesPerDriverPerDay: 5,
    });
    expect(settings.limits).toMatchObject({ driverDailyTokens: 1000, driverPerMinute: 4 });
    expect(settings.insights.reservationEnabled).toBe(false);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('fails closed for the ops and MCP switches and throws for the threshold readers', async () => {
    mockSelect.mockReturnValue(rows(new Error('db down')));
    const m = await import('../lib/ai-settings.js');
    expect(await m.isOpsAiEnabled()).toBe(false);
    expect((await m.getOpsAiSettings()).enabled).toBe(false);
    expect(await m.isDriverAiEnabled()).toBe(false);
    expect((await m.getDriverAiSettings()).enabled).toBe(false);
    expect(await m.isAiMcpEnabled()).toBe(false);
    expect(await m.isAiInsightsEnabled()).toBe(false);
    await expect(m.getAiInsightSettings()).rejects.toThrow('db down');
    await expect(m.getAiWorkerSettings()).rejects.toThrow('db down');
    await expect(m.getAiMcpSettings()).rejects.toThrow('db down');
  });
});
