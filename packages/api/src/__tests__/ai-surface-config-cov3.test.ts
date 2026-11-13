// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAiSettings } from '@evtivity/lib/ai-config';
import type { AiSettings } from '@evtivity/lib/ai-config';
import { resolveModelId } from '@evtivity/ai/core';

const h = vi.hoisted(
  (): {
    settings: unknown;
    rows: Record<string, unknown>[];
    config: { SETTINGS_ENCRYPTION_KEY: string; NODE_ENV: string };
  } => ({
    settings: null,
    rows: [] as Record<string, unknown>[],
    config: { SETTINGS_ENCRYPTION_KEY: 'key', NODE_ENV: 'production' },
  }),
);

vi.mock('@evtivity/database', () => ({
  chatbotAiConfigs: { userId: 'user_id' },
  getAiSettings: vi.fn(() => Promise.resolve(h.settings)),
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(h.rows) }) }),
    })),
  },
}));

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return { ...actual, decryptString: vi.fn((c: string, k: string) => `plain:${c}:${k}`) };
});

vi.mock('../lib/config.js', () => ({ config: h.config }));

import {
  AiNotConfiguredError,
  isSurfaceAvailable,
  resolveSurfaceConfig,
} from '../services/ai/surfaces/config.js';

function settings(rows: Record<string, unknown>): AiSettings {
  return buildAiSettings(Object.entries(rows).map(([key, value]) => ({ key, value })));
}

beforeEach(() => {
  h.rows = [];
  h.config.NODE_ENV = 'production';
  h.settings = settings({});
});

describe('AiNotConfiguredError', () => {
  it('names the support surface, the chatbot and a bad base URL', () => {
    expect(new AiNotConfiguredError('support').code).toBe('SUPPORT_AI_NOT_CONFIGURED');
    expect(new AiNotConfiguredError('support').message).toBe('Support AI is not configured');
    expect(new AiNotConfiguredError('chatbot').code).toBe('AI_NOT_CONFIGURED');
    expect(new AiNotConfiguredError('chatbot').message).toBe('AI is not configured');
    const bad = new AiNotConfiguredError('support', 'base_url');
    expect(bad.code).toBe('AI_BASE_URL_INVALID');
    expect(bad.message).toBe('The AI provider base URL is not allowed');
    expect(bad.name).toBe('AiNotConfiguredError');
  });
});

describe('resolveSurfaceConfig', () => {
  it('refuses a disabled surface even with a personal configuration', async () => {
    h.settings = settings({ 'chatbotAi.enabled': false });
    h.rows = [{ provider: 'anthropic', apiKeyEnc: 'enc' }];
    await expect(resolveSurfaceConfig('chatbot', 'u1')).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED',
    });
  });

  it('uses the personal chatbot configuration first', async () => {
    h.settings = settings({
      'chatbotAi.enabled': true,
      'chatbotAi.provider': 'openai',
      'chatbotAi.effort': 'low',
      'ai.anthropic.baseUrl': 'https://proxy.example.com',
    });
    h.rows = [
      {
        provider: 'anthropic',
        apiKeyEnc: 'mine',
        model: ' custom-model ',
        effort: 'high',
        systemPrompt: '  Be brief.  ',
      },
    ];
    const config = await resolveSurfaceConfig('chatbot', 'u1');
    expect(config).toEqual({
      surface: 'chatbot',
      provider: 'anthropic',
      apiKey: 'plain:mine:key',
      baseUrl: 'https://proxy.example.com',
      model: 'custom-model',
      effort: 'high',
      systemPrompt: 'Be brief.',
      tone: 'professional',
      source: 'user',
    });
  });

  it('falls back to the surface effort and support tone for invalid personal values', async () => {
    h.settings = settings({
      'supportAi.enabled': true,
      'supportAi.effort': 'low',
      'supportAi.tone': 'formal',
    });
    h.rows = [
      {
        supportAiProvider: 'deepseek',
        supportAiApiKeyEnc: 'k2',
        supportAiModel: null,
        supportAiEffort: 'bogus',
        supportAiSystemPrompt: null,
        supportAiTone: 'shouty',
      },
    ];
    const config = await resolveSurfaceConfig('support', 'u1');
    expect(config.source).toBe('user');
    expect(config.provider).toBe('deepseek');
    expect(config.model).toBe(resolveModelId('deepseek', null));
    expect(config.effort).toBe('low');
    expect(config.tone).toBe('formal');
    expect(config.systemPrompt).toBe('');
    expect(config.baseUrl).toBe('');
  });

  it('keeps a valid personal support tone', async () => {
    h.settings = settings({ 'supportAi.enabled': true, 'supportAi.tone': 'formal' });
    h.rows = [{ supportAiProvider: 'gemini', supportAiApiKeyEnc: 'k', supportAiTone: 'friendly' }];
    expect((await resolveSurfaceConfig('support', 'u1')).tone).toBe('friendly');
  });

  it('refuses a personal provider whose stored base URL fails the check', async () => {
    h.settings = settings({
      'chatbotAi.enabled': true,
      'ai.anthropic.baseUrl': 'http://10.0.0.5:8080',
    });
    h.rows = [{ provider: 'anthropic', apiKeyEnc: 'mine' }];
    await expect(resolveSurfaceConfig('chatbot', 'u1')).rejects.toMatchObject({
      code: 'AI_BASE_URL_INVALID',
    });
  });

  it('allows a private plain-http base URL in development', async () => {
    h.config.NODE_ENV = 'development';
    h.settings = settings({
      'chatbotAi.enabled': true,
      'ai.anthropic.baseUrl': 'http://10.0.0.5:8080',
    });
    h.rows = [{ provider: 'anthropic', apiKeyEnc: 'mine' }];
    expect((await resolveSurfaceConfig('chatbot', 'u1')).baseUrl).toBe('http://10.0.0.5:8080');
  });

  it('ignores a personal provider without a key and uses the system settings', async () => {
    h.settings = settings({
      'chatbotAi.enabled': true,
      'chatbotAi.provider': 'openai',
      'chatbotAi.model': 'gpt-x',
      'chatbotAi.effort': 'medium',
      'chatbotAi.systemPrompt': '  System prompt ',
      'ai.openai.apiKeyEnc': 'sys',
    });
    h.rows = [{ provider: 'anthropic', apiKeyEnc: '' }];
    const config = await resolveSurfaceConfig('chatbot', 'u1');
    expect(config).toEqual({
      surface: 'chatbot',
      provider: 'openai',
      apiKey: 'plain:sys:key',
      baseUrl: '',
      model: 'gpt-x',
      effort: 'medium',
      systemPrompt: 'System prompt',
      tone: 'professional',
      source: 'system',
    });
  });

  it('uses the support setting tone for a system support configuration', async () => {
    h.settings = settings({
      'supportAi.enabled': true,
      'supportAi.provider': 'gemini',
      'supportAi.tone': 'formal',
      'ai.gemini.apiKeyEnc': 'g',
    });
    const config = await resolveSurfaceConfig('support', 'u1');
    expect(config.source).toBe('system');
    expect(config.tone).toBe('formal');
  });

  it('refuses when the surface has no provider', async () => {
    h.settings = settings({ 'supportAi.enabled': true });
    await expect(resolveSurfaceConfig('support', 'u1')).rejects.toMatchObject({
      code: 'SUPPORT_AI_NOT_CONFIGURED',
    });
  });

  it('refuses when the surface provider has no key', async () => {
    h.settings = settings({ 'chatbotAi.enabled': true, 'chatbotAi.provider': 'openai' });
    await expect(resolveSurfaceConfig('chatbot', 'u1')).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
  });

  it('refuses a system provider whose base URL fails the check', async () => {
    h.settings = settings({
      'chatbotAi.enabled': true,
      'chatbotAi.provider': 'openai',
      'ai.openai.apiKeyEnc': 'sys',
      'ai.openai.baseUrl': 'https://user:pass@example.com',
    });
    await expect(resolveSurfaceConfig('chatbot', 'u1')).rejects.toMatchObject({
      code: 'AI_BASE_URL_INVALID',
    });
  });
});

describe('isSurfaceAvailable', () => {
  const all = (): boolean => true;

  it('is false for a disabled surface', async () => {
    h.settings = settings({ 'supportAi.enabled': false });
    h.rows = [{ supportAiProvider: 'anthropic', supportAiApiKeyEnc: 'k' }];
    expect(await isSurfaceAvailable('support', 'u1', all)).toBe(false);
  });

  it('checks the personal provider adapter and base URL', async () => {
    h.settings = settings({ 'supportAi.enabled': true });
    h.rows = [{ supportAiProvider: 'anthropic', supportAiApiKeyEnc: 'k' }];
    expect(await isSurfaceAvailable('support', 'u1', all)).toBe(true);
    const hasAdapter = vi.fn(() => false);
    expect(await isSurfaceAvailable('support', 'u1', hasAdapter)).toBe(false);
    expect(hasAdapter).toHaveBeenCalledWith('anthropic');
  });

  it('is false for a personal provider whose base URL fails the check', async () => {
    h.settings = settings({ 'chatbotAi.enabled': true, 'ai.openai.baseUrl': 'ftp://x' });
    h.rows = [{ provider: 'openai', apiKeyEnc: 'k' }];
    expect(await isSurfaceAvailable('chatbot', 'u1', all)).toBe(false);
  });

  it('uses the surface provider without a personal key', async () => {
    h.settings = settings({
      'chatbotAi.enabled': true,
      'chatbotAi.provider': 'deepseek',
      'ai.deepseek.apiKeyEnc': 'k',
    });
    h.rows = [{ provider: 'anthropic', apiKeyEnc: null }];
    expect(await isSurfaceAvailable('chatbot', 'u1', all)).toBe(true);
  });

  it('is false without a surface provider or its key', async () => {
    h.settings = settings({ 'chatbotAi.enabled': true });
    expect(await isSurfaceAvailable('chatbot', 'u1', all)).toBe(false);
    h.settings = settings({ 'chatbotAi.enabled': true, 'chatbotAi.provider': 'deepseek' });
    expect(await isSurfaceAvailable('chatbot', 'u1', all)).toBe(false);
  });
});
