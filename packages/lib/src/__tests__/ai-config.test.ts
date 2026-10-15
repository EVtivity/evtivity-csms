// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  AI_FLAG_SETTINGS,
  AI_LIMIT_SETTINGS,
  AI_SETTING_DEFAULTS,
  REMOVED_AI_SETTING_KEYS,
  aiProviderApiKeySettingKey,
  aiProviderBaseUrlSettingKey,
  buildAiSettings,
  isAiBaseUrlSettingKey,
  isAiSettingKey,
  normalizeAiSettingValue,
  parseAiLimitValue,
  parseAiMcpAllowedOrigins,
} from '../ai-config.js';
import { AI_INSIGHT_SETTING_KEYS, OPS_AI_SETTING_KEYS } from '../ai-insights.js';
import { AI_MCP_SETTING_KEYS, AI_WORKER_SETTING_KEYS } from '../ai-proposals.js';
import { AI_BUDGET_SETTING_KEYS } from '../ai-usage.js';
import { DRIVER_AI_SETTING_KEYS } from '../driver-ai.js';

const CONTRACT_KEYS = [
  ...Object.values(OPS_AI_SETTING_KEYS),
  ...Object.values(AI_INSIGHT_SETTING_KEYS),
  ...Object.values(AI_WORKER_SETTING_KEYS),
  ...Object.values(AI_MCP_SETTING_KEYS),
  ...Object.values(AI_BUDGET_SETTING_KEYS),
  // v0.1.45 (lane K1).
  ...Object.values(DRIVER_AI_SETTING_KEYS),
];
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
      companyMonthlyTokens: 0,
      siteMonthlyTokens: 0,
      siteDailyTokens: 300_000,
      driverDailyTokens: 40_000,
      driverPerMinute: 2,
      budgetWarnPercent: 80,
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

describe('AI roadmap settings (TC-AI-C-11)', () => {
  it('has a default for every setting key of the contracts', () => {
    // Plus the offline end threshold of stuck sessions and the insight expiry (v0.1.46).
    expect(CONTRACT_KEYS).toHaveLength(41);
    for (const key of CONTRACT_KEYS) {
      expect(Object.hasOwn(AI_SETTING_DEFAULTS, key), key).toBe(true);
      expect(isAiSettingKey(key), key).toBe(true);
    }
  });

  it('accepts every default it ships', () => {
    for (const [key, value] of Object.entries(AI_SETTING_DEFAULTS)) {
      const result = normalizeAiSettingValue(key, value);
      if (result !== undefined) expect(result, key).toEqual({ value });
    }
  });

  it('keeps system-initiated AI, every worker job, MCP and MCP writes off by default (D4)', () => {
    expect(AI_SETTING_DEFAULTS['opsAi.enabled']).toBe(false);
    expect(AI_SETTING_DEFAULTS['ai.mcp.enabled']).toBe(false);
    expect(AI_SETTING_DEFAULTS['ai.mcp.allowWrites']).toBe(false);
    for (const key of [
      'aiWorkers.networkSummary.enabled',
      'aiWorkers.stuckSessions.enabled',
      'aiWorkers.tariffAnomalies.enabled',
    ]) {
      expect(AI_SETTING_DEFAULTS[key], key).toBe(false);
    }
    for (const key of [
      'aiInsights.station.enabled',
      'aiInsights.session.enabled',
      'aiInsights.authorization.enabled',
    ]) {
      expect(AI_SETTING_DEFAULTS[key], key).toBe(true);
    }
  });

  it('uses the D5 thresholds', () => {
    expect(AI_SETTING_DEFAULTS).toMatchObject({
      'aiInsights.debounceSeconds': 120,
      'aiInsights.cooldownMinutes': 60,
      'aiInsights.siteIncidentThreshold': 3,
      'aiInsights.maxPerSitePerDay': 50,
      'aiInsights.retentionDays': 90,
      'ai.budget.siteDailyTokens': 300_000,
      'opsAi.effort': 'low',
    });
  });

  it('checks switches, the ops provider and effort, the language and the limits', () => {
    for (const key of Object.keys(AI_FLAG_SETTINGS)) {
      expect(normalizeAiSettingValue(key, true)).toEqual({ value: true });
      expect(normalizeAiSettingValue(key, 'true')).toBeNull();
    }
    expect(normalizeAiSettingValue('opsAi.provider', 'gemini')).toEqual({ value: 'gemini' });
    expect(normalizeAiSettingValue('opsAi.provider', '')).toEqual({ value: '' });
    expect(normalizeAiSettingValue('opsAi.provider', 'mistral')).toBeNull();
    expect(normalizeAiSettingValue('opsAi.effort', 'max')).toBeNull();
    expect(normalizeAiSettingValue('aiInsights.primaryLanguage', 'zh-TW')).toEqual({
      value: 'zh-TW',
    });
    expect(normalizeAiSettingValue('aiInsights.primaryLanguage', 'fr')).toBeNull();
    expect(normalizeAiSettingValue('aiInsights.siteIncidentThreshold', 1)).toBeNull();
    expect(normalizeAiSettingValue('aiWorkers.stuckSessions.idleMinutes', '45')).toEqual({
      value: 45,
    });
    expect(normalizeAiSettingValue('ai.budget.companyMonthlyTokens', 0)).toEqual({ value: 0 });
    expect(normalizeAiSettingValue('ai.budget.warnPercent', 0)).toBeNull();
    expect(normalizeAiSettingValue('opsAi.model', 'x')).toBeUndefined();
    expect(normalizeAiSettingValue('opsAi.systemPrompt', 'x')).toBeUndefined();
  });

  it('TC-CFG-03 validates the driver support and reservation insight keys', () => {
    expect(AI_SETTING_DEFAULTS).toMatchObject({
      'driverAi.enabled': false,
      'driverAi.provider': 'anthropic',
      'driverAi.model': '',
      'driverAi.effort': 'low',
      'driverAi.systemPrompt': '',
      'driverAi.maxCasesPerDriverPerDay': 3,
      'driverAi.feedbackTimeoutHours': 24,
      'ai.budget.driverDailyTokens': 40_000,
      'ai.rateLimit.driverPerMinute': 2,
      'aiInsights.reservation.enabled': true,
    });
    for (const key of ['driverAi.enabled', 'aiInsights.reservation.enabled']) {
      expect(normalizeAiSettingValue(key, false), key).toEqual({ value: false });
      expect(normalizeAiSettingValue(key, 'false'), key).toBeNull();
      expect(normalizeAiSettingValue(key, 0), key).toBeNull();
    }
    expect(normalizeAiSettingValue('driverAi.provider', 'deepseek')).toEqual({
      value: 'deepseek',
    });
    expect(normalizeAiSettingValue('driverAi.provider', '')).toEqual({ value: '' });
    expect(normalizeAiSettingValue('driverAi.provider', 'mistral')).toBeNull();
    expect(normalizeAiSettingValue('driverAi.effort', 'high')).toEqual({ value: 'high' });
    expect(normalizeAiSettingValue('driverAi.effort', 'max')).toBeNull();
    // Positive whole numbers; the driver token budget also takes 0 (no limit).
    expect(normalizeAiSettingValue('driverAi.maxCasesPerDriverPerDay', '5')).toEqual({ value: 5 });
    expect(normalizeAiSettingValue('driverAi.maxCasesPerDriverPerDay', 0)).toBeNull();
    expect(normalizeAiSettingValue('driverAi.maxCasesPerDriverPerDay', 1.5)).toBeNull();
    expect(normalizeAiSettingValue('driverAi.feedbackTimeoutHours', 168)).toEqual({ value: 168 });
    expect(normalizeAiSettingValue('driverAi.feedbackTimeoutHours', 169)).toBeNull();
    expect(normalizeAiSettingValue('ai.budget.driverDailyTokens', 0)).toEqual({ value: 0 });
    expect(normalizeAiSettingValue('ai.budget.driverDailyTokens', -1)).toBeNull();
    expect(normalizeAiSettingValue('ai.rateLimit.driverPerMinute', 0)).toBeNull();
    expect(normalizeAiSettingValue('ai.rateLimit.driverPerMinute', 1000)).toEqual({ value: 1000 });
    // Free text: no constraint here.
    expect(normalizeAiSettingValue('driverAi.model', 'x')).toBeUndefined();
    expect(normalizeAiSettingValue('driverAi.systemPrompt', 'x')).toBeUndefined();
  });

  it('TC-CFG-03 builds the driver surface, its limits and the reservation switch', () => {
    const defaults = buildAiSettings([]);
    expect(defaults.driver).toEqual({
      enabled: false,
      provider: null,
      model: '',
      effort: 'low',
      systemPrompt: '',
      maxCasesPerDriverPerDay: 3,
      feedbackTimeoutHours: 24,
    });
    expect(defaults.limits.driverDailyTokens).toBe(40_000);
    expect(defaults.limits.driverPerMinute).toBe(2);
    expect(defaults.insights.reservationEnabled).toBe(true);

    const s = buildAiSettings([
      { key: 'driverAi.enabled', value: true },
      { key: 'driverAi.provider', value: 'openai' },
      { key: 'driverAi.model', value: ' gpt-x ' },
      { key: 'driverAi.effort', value: 'medium' },
      { key: 'driverAi.systemPrompt', value: 'Be brief.' },
      { key: 'driverAi.maxCasesPerDriverPerDay', value: 5 },
      { key: 'driverAi.feedbackTimeoutHours', value: 'bad' },
      { key: 'ai.budget.driverDailyTokens', value: 0 },
      { key: 'ai.rateLimit.driverPerMinute', value: 7 },
      { key: 'aiInsights.reservation.enabled', value: false },
    ]);
    expect(s.driver).toEqual({
      enabled: true,
      provider: 'openai',
      model: 'gpt-x',
      effort: 'medium',
      systemPrompt: 'Be brief.',
      maxCasesPerDriverPerDay: 5,
      feedbackTimeoutHours: 24,
    });
    expect(s.limits.driverDailyTokens).toBe(0);
    expect(s.limits.driverPerMinute).toBe(7);
    expect(s.insights.reservationEnabled).toBe(false);
    expect(isAiSettingKey('driverAi.enabled')).toBe(true);
  });

  it('parses the MCP allowed origins', () => {
    expect(parseAiMcpAllowedOrigins([])).toEqual([]);
    expect(
      parseAiMcpAllowedOrigins([
        ' https://App.Example.com ',
        'https://app.example.com/',
        'http://localhost:6274',
        'https://[::1]:8443',
      ]),
    ).toEqual(['https://app.example.com', 'http://localhost:6274', 'https://[::1]:8443']);
    for (const bad of [
      'https://app.example.com/path',
      'https://app.example.com?x=1',
      'https://user:pass@app.example.com',
      'ftp://app.example.com',
      'app.example.com',
      '*',
    ]) {
      expect(parseAiMcpAllowedOrigins([bad]), bad).toBeNull();
    }
    expect(parseAiMcpAllowedOrigins('https://app.example.com')).toBeNull();
    expect(
      parseAiMcpAllowedOrigins(['https://app.example.com:443', 'http://b.example:80']),
    ).toEqual(['https://app.example.com', 'http://b.example']);
    expect(parseAiMcpAllowedOrigins([42])).toBeNull();
    expect(
      parseAiMcpAllowedOrigins(
        Array.from({ length: 51 }, (_, i) => `https://a${String(i)}.example`),
      ),
    ).toBeNull();
  });

  it('builds the ops surface, insights, workers and MCP with their defaults', () => {
    const s = buildAiSettings([]);
    expect(s.ops).toEqual({
      enabled: false,
      provider: null,
      model: '',
      effort: 'low',
      systemPrompt: '',
    });
    expect(s.insights).toEqual({
      stationEnabled: true,
      sessionEnabled: true,
      authorizationEnabled: true,
      reservationEnabled: true,
      debounceSeconds: 120,
      cooldownMinutes: 60,
      siteIncidentThreshold: 3,
      maxPerSitePerDay: 50,
      primaryLanguage: 'en',
      retentionDays: 90,
      expireAfterDays: 7,
    });
    expect(s.workers).toEqual({
      networkSummaryEnabled: false,
      stuckSessionsEnabled: false,
      stuckSessionsIdleMinutes: 90,
      stuckSessionsOfflineEndAfterHours: 24,
      stuckSessionsUseModel: false,
      tariffAnomaliesEnabled: false,
      proposalTtlHours: 24,
    });
    expect(s.mcp).toEqual({
      enabled: false,
      rateLimitPerMinute: 60,
      dailyCallsPerKey: 5000,
      allowWrites: false,
      allowedOrigins: [],
    });
  });

  it('maps stored values and replaces invalid ones with their defaults', () => {
    const s = buildAiSettings([
      { key: 'opsAi.enabled', value: true },
      { key: 'opsAi.provider', value: 'deepseek' },
      { key: 'opsAi.effort', value: 'high' },
      { key: 'aiInsights.session.enabled', value: false },
      { key: 'aiInsights.station.enabled', value: 'no' },
      { key: 'aiInsights.primaryLanguage', value: 'de' },
      { key: 'aiInsights.cooldownMinutes', value: 0 },
      { key: 'aiWorkers.stuckSessions.enabled', value: true },
      { key: 'ai.mcp.enabled', value: true },
      { key: 'ai.mcp.allowWrites', value: true },
      { key: 'ai.mcp.allowedOrigins', value: ['https://app.example.com'] },
      { key: 'ai.budget.companyMonthlyTokens', value: 5_000_000 },
    ]);
    expect(s.ops).toMatchObject({ enabled: true, provider: 'deepseek', effort: 'high' });
    expect(s.insights).toMatchObject({
      sessionEnabled: false,
      stationEnabled: true,
      primaryLanguage: 'de',
      cooldownMinutes: 60,
    });
    expect(s.workers.stuckSessionsEnabled).toBe(true);
    expect(s.mcp).toMatchObject({
      enabled: true,
      allowWrites: true,
      allowedOrigins: ['https://app.example.com'],
    });
    expect(s.limits.companyMonthlyTokens).toBe(5_000_000);
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
