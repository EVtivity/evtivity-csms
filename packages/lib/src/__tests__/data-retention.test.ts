// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  DATA_RETENTION_GROUPS,
  DATA_RETENTION_KEYS,
  DATA_RETENTION_SETTINGS,
  SECURITY_HISTORY_MIN_DAYS,
  effectiveRetentionDays,
  isAllowedRetentionDays,
  isDataRetentionSettingKey,
} from '../data-retention.js';
import { AI_LIMIT_SETTINGS, AI_THRESHOLD_SETTINGS } from '../ai-config.js';
import { AI_INSIGHT_SETTING_KEYS } from '../ai-insights.js';
import { SIM_RETENTION_DAYS, SIM_SETTING_KEYS } from '../sim-settings.js';

describe('data retention settings', () => {
  it('lists every retention key once, in a known group', () => {
    expect(new Set(DATA_RETENTION_KEYS).size).toBe(DATA_RETENTION_KEYS.length);
    expect(DATA_RETENTION_KEYS).toHaveLength(16);
    for (const def of Object.values(DATA_RETENTION_SETTINGS)) {
      expect(DATA_RETENTION_GROUPS).toContain(def.group);
      expect(def.defaultDays).toBeGreaterThanOrEqual(def.min);
      expect(def.defaultDays).toBeLessThanOrEqual(def.max);
    }
  });

  it('reuses the AI and SIM bounds', () => {
    const conversation = DATA_RETENTION_SETTINGS['ai.conversationRetentionDays'];
    expect(conversation.min).toBe(AI_LIMIT_SETTINGS['ai.conversationRetentionDays'].min);
    expect(conversation.max).toBe(AI_LIMIT_SETTINGS['ai.conversationRetentionDays'].max);
    expect(conversation.defaultDays).toBe(
      AI_LIMIT_SETTINGS['ai.conversationRetentionDays'].defaultValue,
    );
    const insights = DATA_RETENTION_SETTINGS[AI_INSIGHT_SETTING_KEYS.retentionDays];
    expect(insights.min).toBe(AI_THRESHOLD_SETTINGS[AI_INSIGHT_SETTING_KEYS.retentionDays].min);
    const sim = DATA_RETENTION_SETTINGS[SIM_SETTING_KEYS.retentionDays];
    expect(sim).toMatchObject({
      min: SIM_RETENTION_DAYS.min,
      max: SIM_RETENTION_DAYS.max,
      defaultDays: SIM_RETENTION_DAYS.default,
      keepForever: false,
    });
  });

  it('allows 0 (keep forever) only where the prune job skips it', () => {
    const forever = DATA_RETENTION_KEYS.filter((k) => DATA_RETENTION_SETTINGS[k].keepForever);
    expect(forever.every((k) => DATA_RETENTION_SETTINGS[k].min === 0)).toBe(true);
    expect(forever).toContain('logs.ocppMessage.retentionDays');
    expect(forever).toContain('audit.retentionDays');
    expect(forever).toContain('refreshTokens.retentionDays');
    expect(forever).not.toContain('ai.conversationRetentionDays');
  });

  it('takes 0 or 30 to 3650 days for the security history and reads a lower stored value as 30', () => {
    for (const key of [
      'audit.retentionDays',
      'logs.loginAudit.retentionDays',
      'logs.securityEvents.retentionDays',
    ] as const) {
      expect(DATA_RETENTION_SETTINGS[key].keptMin).toBe(SECURITY_HISTORY_MIN_DAYS);
      expect(isAllowedRetentionDays(key, 0)).toBe(true);
      expect(isAllowedRetentionDays(key, 1)).toBe(false);
      expect(isAllowedRetentionDays(key, 29)).toBe(false);
      expect(isAllowedRetentionDays(key, 30)).toBe(true);
      expect(isAllowedRetentionDays(key, 3650)).toBe(true);
      expect(isAllowedRetentionDays(key, 3651)).toBe(false);
      expect(effectiveRetentionDays(key, 5)).toBe(30);
      expect(effectiveRetentionDays(key, 0)).toBe(0);
    }
    expect(isAllowedRetentionDays('logs.access.retentionDays', 1)).toBe(true);
    expect(effectiveRetentionDays('logs.access.retentionDays', 1)).toBe(1);
  });

  it('recognizes its keys only', () => {
    expect(isDataRetentionSettingKey('logs.meterValues.retentionDays')).toBe(true);
    expect(isDataRetentionSettingKey('sim.sessions.fetchDays')).toBe(false);
    expect(isDataRetentionSettingKey('aiInsights.expireAfterDays')).toBe(false);
  });

  it('reads the value each prune job uses', () => {
    const logs = 'logs.ocppMessage.retentionDays';
    expect(effectiveRetentionDays(logs, 14)).toBe(14);
    expect(effectiveRetentionDays(logs, 0)).toBe(0);
    expect(effectiveRetentionDays(logs, -3)).toBe(0);
    expect(effectiveRetentionDays(logs, 5000)).toBe(5000);
    expect(effectiveRetentionDays(logs, '14')).toBe(30);
    expect(effectiveRetentionDays(logs, undefined)).toBe(30);
    const simKey = 'sim.sessions.retentionDays';
    expect(effectiveRetentionDays(simKey, 3)).toBe(90);
    expect(effectiveRetentionDays(simKey, 30)).toBe(30);
    const ai = 'ai.conversationRetentionDays';
    expect(effectiveRetentionDays(ai, 0)).toBe(30);
    expect(effectiveRetentionDays(ai, '45')).toBe(45);
  });
});
