// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  AI_LIMIT_SETTINGS,
  REMOVED_AI_SETTING_KEYS,
  aiProviderApiKeySettingKey,
  aiProviderBaseUrlSettingKey,
  buildAiSettings,
  isAiBaseUrlSettingKey,
  isAiSettingKey,
  normalizeAiSettingValue,
  parseAiLimitValue,
} from '../ai-config.js';
import { validateAiBaseUrl } from '../url-validation.js';

describe('AI setting keys', () => {
  it('names one key and base URL per provider', () => {
    expect(aiProviderApiKeySettingKey('deepseek')).toBe('ai.deepseek.apiKeyEnc');
    expect(aiProviderBaseUrlSettingKey('gemini')).toBe('ai.gemini.baseUrl');
    expect(isAiBaseUrlSettingKey('ai.openai.baseUrl')).toBe(true);
    expect(isAiBaseUrlSettingKey('ai.mistral.baseUrl')).toBe(false);
  });

  it('classifies the keys the cached reader holds', () => {
    for (const key of ['ai.rateLimit.userPerMinute', 'chatbotAi.model', 'supportAi.tone']) {
      expect(isAiSettingKey(key)).toBe(true);
    }
    expect(isAiSettingKey('company.name')).toBe(false);
  });

  it('lists every removed key with a replacement', () => {
    expect(Object.keys(REMOVED_AI_SETTING_KEYS).sort()).toEqual(
      [
        'chatbotAi.apiKeyEnc',
        'chatbotAi.temperature',
        'chatbotAi.topK',
        'chatbotAi.topP',
        'supportAi.apiKeyEnc',
        'supportAi.temperature',
        'supportAi.topK',
        'supportAi.topP',
      ].sort(),
    );
  });
});

describe('normalizeAiSettingValue', () => {
  it('refuses the removed keys', () => {
    for (const key of Object.keys(REMOVED_AI_SETTING_KEYS)) {
      expect(normalizeAiSettingValue(key, '0.5')).toBeNull();
    }
  });

  it('checks providers, effort, tone and the enabled flags', () => {
    expect(normalizeAiSettingValue('chatbotAi.provider', 'deepseek')).toEqual({
      value: 'deepseek',
    });
    expect(normalizeAiSettingValue('supportAi.provider', '')).toEqual({ value: '' });
    expect(normalizeAiSettingValue('chatbotAi.provider', 'mistral')).toBeNull();
    expect(normalizeAiSettingValue('chatbotAi.effort', 'high')).toEqual({ value: 'high' });
    expect(normalizeAiSettingValue('supportAi.effort', 'max')).toBeNull();
    expect(normalizeAiSettingValue('supportAi.tone', 'formal')).toEqual({ value: 'formal' });
    expect(normalizeAiSettingValue('supportAi.tone', 'sarcastic')).toBeNull();
    expect(normalizeAiSettingValue('chatbotAi.enabled', true)).toEqual({ value: true });
    expect(normalizeAiSettingValue('chatbotAi.enabled', 'true')).toBeNull();
  });

  it('checks the limits and stores numbers', () => {
    expect(normalizeAiSettingValue('ai.maxToolCallsPerTurn', '30')).toEqual({ value: 30 });
    expect(normalizeAiSettingValue('ai.maxToolCallsPerTurn', 0)).toBeNull();
    expect(normalizeAiSettingValue('ai.maxToolCallsPerTurn', 101)).toBeNull();
    expect(normalizeAiSettingValue('ai.budget.userDailyTokens', 0)).toEqual({ value: 0 });
    expect(normalizeAiSettingValue('ai.attachments.maxBytes', 1.5)).toBeNull();
    expect(normalizeAiSettingValue('ai.rateLimit.userPerMinute', '')).toBeNull();
  });

  it('leaves free-text keys to the caller', () => {
    expect(normalizeAiSettingValue('chatbotAi.model', 'x')).toBeUndefined();
    expect(normalizeAiSettingValue('chatbotAi.systemPrompt', 'x')).toBeUndefined();
    expect(normalizeAiSettingValue('ai.openai.apiKeyEnc', 'x')).toBeUndefined();
  });

  it('accepts every default limit', () => {
    for (const [key, def] of Object.entries(AI_LIMIT_SETTINGS)) {
      expect(parseAiLimitValue(key as keyof typeof AI_LIMIT_SETTINGS, def.defaultValue)).toBe(
        def.defaultValue,
      );
    }
  });
});

describe('buildAiSettings', () => {
  it('gives every missing or invalid value its default', () => {
    const s = buildAiSettings([
      { key: 'chatbotAi.provider', value: 'mistral' },
      { key: 'chatbotAi.effort', value: 'max' },
      { key: 'supportAi.tone', value: '' },
      { key: 'ai.rateLimit.userPerMinute', value: -1 },
    ]);
    expect(s.chatbot).toEqual({
      enabled: false,
      provider: null,
      model: '',
      effort: 'medium',
      systemPrompt: '',
    });
    expect(s.support.tone).toBe('professional');
    expect(s.limits).toEqual({
      userPerMinute: 10,
      sitePerMinute: 60,
      userDailyTokens: 2_000_000,
      maxToolCallsPerTurn: 20,
      conversationRetentionDays: 30,
      attachmentsMaxBytes: 10_485_760,
      attachmentsMaxPerMessage: 5,
    });
    expect(s.providers.anthropic).toEqual({ apiKeyEnc: '', baseUrl: '' });
  });

  it('maps the stored values per surface and provider', () => {
    const s = buildAiSettings([
      { key: 'supportAi.enabled', value: true },
      { key: 'supportAi.provider', value: 'gemini' },
      { key: 'supportAi.model', value: ' gemini-x ' },
      { key: 'supportAi.effort', value: 'low' },
      { key: 'supportAi.tone', value: 'friendly' },
      { key: 'ai.gemini.apiKeyEnc', value: 'cipher' },
      { key: 'ai.gemini.baseUrl', value: 'https://proxy.example.com/v1' },
      { key: 'ai.budget.userDailyTokens', value: 0 },
    ]);
    expect(s.support).toEqual({
      enabled: true,
      provider: 'gemini',
      model: 'gemini-x',
      effort: 'low',
      systemPrompt: '',
      tone: 'friendly',
    });
    expect(s.providers.gemini).toEqual({
      apiKeyEnc: 'cipher',
      baseUrl: 'https://proxy.example.com/v1',
    });
    expect(s.limits.userDailyTokens).toBe(0);
  });
});

describe('validateAiBaseUrl (TC-AI-C-05)', () => {
  const prod = { allowPrivateHosts: false };
  const dev = { allowPrivateHosts: true };

  it('accepts empty (official endpoint) and a public https URL', () => {
    expect(validateAiBaseUrl('', prod)).toBe('');
    expect(validateAiBaseUrl('  ', prod)).toBe('');
    expect(validateAiBaseUrl(' https://api.example.com/v1 ', prod)).toBe(
      'https://api.example.com/v1',
    );
  });

  it.each([
    ['plain http', 'http://api.example.com'],
    ['credentials', 'https://user:pass@api.example.com'],
    ['a query', 'https://api.example.com/?key=x'],
    ['a fragment', 'https://api.example.com/#x'],
    ['localhost', 'https://localhost:8443'],
    ['loopback IP', 'https://127.0.0.1'],
    ['private IP', 'https://10.0.0.5'],
    ['link-local metadata IP', 'https://169.254.169.254'],
    ['IPv6 loopback', 'https://[::1]'],
    ['an internal name', 'https://llm.internal'],
    ['another scheme', 'file:///etc/passwd'],
    ['not a URL', 'api.example.com'],
  ])('refuses %s', (_label, url) => {
    expect(validateAiBaseUrl(url, prod)).toBeNull();
  });

  it('refuses a non-string value', () => {
    expect(validateAiBaseUrl(42, prod)).toBeNull();
    expect(validateAiBaseUrl(null, dev)).toBeNull();
  });

  it('allows a local mock provider in development only, still without credentials', () => {
    expect(validateAiBaseUrl('http://localhost:4010', dev)).toBe('http://localhost:4010');
    expect(validateAiBaseUrl('https://127.0.0.1:4010', dev)).toBe('https://127.0.0.1:4010');
    expect(validateAiBaseUrl('http://u:p@localhost:4010', dev)).toBeNull();
    expect(validateAiBaseUrl('ftp://localhost', dev)).toBeNull();
  });
});
