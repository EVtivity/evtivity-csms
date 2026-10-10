// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('getAiSettings (TC-AI-C-06)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
