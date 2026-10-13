// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { INSIGHT_SUMMARY_MAX_LENGTH } from '@evtivity/lib/ai-insights';
import {
  INSIGHT_SUMMARY_TARGET_LENGTH,
  INSIGHT_CATEGORY_RULE,
  insightAnswerContract,
  insightRepairRequest,
  insightSystemBlocks,
  translationSystemBlocks,
} from '../ai-insights/prompt.js';
import { opsSystemPrompt, stuckSessionFacts } from '../ai-workers/prompts.js';

describe('insight prompt', () => {
  it('asks for a summary below the limit and names both numbers from the schema constant', () => {
    expect(INSIGHT_SUMMARY_TARGET_LENGTH).toBeLessThan(INSIGHT_SUMMARY_MAX_LENGTH);
    const contract = insightAnswerContract('en');
    expect(contract).toContain(`about ${String(INSIGHT_SUMMARY_TARGET_LENGTH)} characters`);
    expect(contract).toContain(
      `summary over ${String(INSIGHT_SUMMARY_MAX_LENGTH)} characters is rejected`,
    );
  });

  it('asks for the most likely root cause and keeps unknown for no evidence', () => {
    const contract = insightAnswerContract('en');
    expect(contract).toContain(INSIGHT_CATEGORY_RULE);
    expect(INSIGHT_CATEGORY_RULE).toContain('Answer "unknown" only when no evidence item');
  });

  it('names the problem in the repair request', () => {
    expect(insightRepairRequest('summary has 700 characters, at most 600 are allowed')).toContain(
      'summary has 700 characters, at most 600 are allowed',
    );
  });

  it('gives the platform Chinese terms to insights, translations and workers', () => {
    const zh = insightSystemBlocks('station_offline', 'zh', '')[0]?.text ?? '';
    expect(zh).toContain('充电站');
    expect(zh).toContain('never 站点');
    expect(zh).toContain('驾驶员');
    expect(zh).toContain('固件');
    const tw = translationSystemBlocks('zh-TW')[0]?.text ?? '';
    expect(tw).toContain('充電站');
    expect(tw).toContain('站點');
    expect(tw).toContain('駕駛員');
    expect(opsSystemPrompt('network_summary', 'zh', '')).toContain('充电站');
    expect(opsSystemPrompt('stuck_sessions', 'zh-TW', 'Custom prompt.')).toContain('充電站');
    expect(insightAnswerContract('en')).not.toContain('充电站');
  });
});

describe('stuck-session rationale prompt', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const session = {
    ocppStationId: 'CS-0030',
    transactionId: 'tx-1',
    reason: 'station_offline' as const,
    startedAt: new Date('2026-10-11T10:30:00Z'),
    lastActivityAt: new Date('2026-10-11T11:38:30Z'),
  };

  it('gives the measured silence and session age apart from the configured threshold', () => {
    expect(stuckSessionFacts(session, { idleMinutes: 90, now })).toEqual({
      stationId: 'CS-0030',
      transactionId: 'tx-1',
      reason: 'station_offline',
      measuredSilenceMinutes: 21,
      measuredSessionAgeMinutes: 90,
      configuredIdleThresholdMinutes: 90,
    });
    expect(
      stuckSessionFacts({ ...session, startedAt: null }, { idleMinutes: 90, now })[
        'measuredSessionAgeMinutes'
      ],
    ).toBeNull();
  });

  it('tells the model to cite measured values only, under the operator prompt too', () => {
    for (const custom of ['', 'Operator prompt.']) {
      const prompt = opsSystemPrompt('stuck_sessions', 'en', custom);
      expect(prompt).toContain('measuredSilenceMinutes');
      expect(prompt).toContain('configuredIdleThresholdMinutes');
      expect(prompt).toContain('Cite only the measured values');
      expect(prompt).toContain('How long a station has been offline is not measured');
    }
    expect(opsSystemPrompt('stuck_sessions', 'en', 'Operator prompt.')).toMatch(
      /^Operator prompt\./,
    );
    expect(opsSystemPrompt('network_summary', 'en', '')).not.toContain('measuredSilenceMinutes');
  });

  it('ties the stuck-session text to the stop action, under the operator prompt too', () => {
    for (const custom of ['', 'Operator prompt.']) {
      const prompt = opsSystemPrompt('stuck_sessions', 'en', custom);
      expect(prompt).toContain('one suggested action: stop this session');
      expect(prompt).toContain('Never recommend waiting, monitoring or any other action instead');
    }
    expect(opsSystemPrompt('tariff_anomalies', 'en', '')).not.toContain('stop this session');
  });
});
