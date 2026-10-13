// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  AI_INSIGHT_ERROR_CODES,
  AI_INSIGHT_SETTING_KEYS,
  FIX_CODES,
  INSIGHT_KIND_FALLBACKS,
  OPS_AI_SETTING_KEYS,
  WORKER_ACTION_INSIGHT_KINDS,
  ROOT_CAUSE_CATEGORIES,
  RULE_INSIGHTS,
  insightAnswerProblem,
  insightModelOutputSchema,
  ruleInsightFor,
  sanitizeInsightModelOutput,
} from '../ai-insights.js';
import {
  AI_MCP_SETTING_KEYS,
  AI_PROPOSAL_ERROR_CODES,
  AI_PROPOSAL_STATUSES,
  AI_PROPOSAL_TERMINAL_STATUSES,
  AI_WORKER_ACTIONS,
  AI_WORKER_SETTING_KEYS,
  findAiWorkerAction,
  readAiAuditVia,
  workerActionArgsAllowed,
} from '../ai-proposals.js';
import { AI_BUDGET_SETTING_KEYS, AI_USAGE_ERROR_CODES, aiUsageDtoSchema } from '../ai-usage.js';
import { AI_LIMIT_SETTINGS } from '../ai-config.js';

describe('insight model output', () => {
  const pack = new Set(['ev1', 'ev2']);
  const answer = {
    category: 'connectivity',
    confidence: 'high',
    summary: 'The station lost its network connection twice in an hour.',
    fixes: [
      { code: 'check_network_connection', note: 'Check the modem.' },
      { code: 'make_coffee' },
      { code: 'check_network_connection' },
      { code: 'reboot_station' },
      { code: 'monitor' },
      { code: 'update_firmware' },
    ],
    evidenceRefs: ['ev1', 'ev9', 'ev1'],
  };

  it('drops unknown and repeated fix codes, keeps at most three, and keeps only pack evidence', () => {
    const output = sanitizeInsightModelOutput(answer, pack);
    expect(output).toEqual({
      category: 'connectivity',
      confidence: 'high',
      summary: answer.summary,
      fixes: [
        { code: 'check_network_connection', note: 'Check the modem.' },
        { code: 'reboot_station' },
        { code: 'monitor' },
      ],
      evidenceRefs: ['ev1'],
    });
    expect(insightModelOutputSchema.safeParse(output).success).toBe(true);
  });

  it('cuts a long fix note to its limit', () => {
    const output = sanitizeInsightModelOutput(
      { ...answer, fixes: [{ code: 'monitor', note: 'x'.repeat(300) }] },
      pack,
    );
    expect(output?.fixes[0]?.note).toHaveLength(200);
  });

  it('gives an unknown root cause low confidence', () => {
    const output = sanitizeInsightModelOutput(
      { ...answer, category: 'unknown', confidence: 'high' },
      pack,
    );
    expect(output).toMatchObject({ category: 'unknown', confidence: 'low' });
  });

  it.each([
    ['an unknown category', { ...answer, category: 'weather' }],
    ['an empty summary', { ...answer, summary: '  ' }],
    ['a summary over 600 characters', { ...answer, summary: 'a'.repeat(601) }],
    ['a missing field', { category: 'hardware', confidence: 'low', summary: 'x' }],
    ['plain text', 'connectivity'],
  ])('rejects %s', (_name, value) => {
    expect(sanitizeInsightModelOutput(value, pack)).toBeNull();
    expect(insightAnswerProblem(value)).not.toBeNull();
  });

  it('names why an answer fails, without its text', () => {
    expect(insightAnswerProblem(answer)).toBeNull();
    const long = `secret ${'a'.repeat(720)}`;
    const problem = insightAnswerProblem({ ...answer, summary: long });
    expect(problem).toBe('summary has 727 characters, at most 600 are allowed');
    expect(insightAnswerProblem({ ...answer, category: 'weather' })).toBe(
      'category: invalid_enum_value',
    );
    expect(insightAnswerProblem('connectivity')).toBe('the answer is not a JSON object');
    expect(insightAnswerProblem({ category: 'hardware', confidence: 'low', summary: 'x' })).toBe(
      'fixes: invalid_type; evidenceRefs: invalid_type',
    );
  });

  it('every rule insight uses a known category and known fix codes', () => {
    for (const [reason, rule] of Object.entries(RULE_INSIGHTS)) {
      expect(ROOT_CAUSE_CATEGORIES, reason).toContain(rule.category);
      expect(rule.fixes.length, reason).toBeGreaterThan(0);
      for (const fix of rule.fixes) expect(FIX_CODES, reason).toContain(fix);
    }
    expect(Object.keys(RULE_INSIGHTS).sort()).toEqual(
      [
        'AccountCreditLimit',
        'EndRequestFailed',
        'EVConnectTimeout',
        'MissingPaymentMethod',
        'PaymentFailed',
        'PreAuthDeclined',
        'blocked',
        'concurrent_tx',
        'expired',
        'no_credit',
        // Reservation audit rows (v0.1.45), keyed <action>:<reason>.
        'expired:no_show',
        'fee_failed:declined',
        'fee_failed:no_payment_method',
        'station_cancel_failed:station_offline',
        'station_rejected:evse_in_use_at_activation',
        'station_rejected:station_faulted_at_activation',
        'station_rejected:station_offline_at_activation',
        'station_rejected:station_rejected_occupied',
      ].sort(),
    );
    expect(ruleInsightFor('AccountCreditLimit')?.category).toBe('payment');
    expect(ruleInsightFor('toString')).toBeUndefined();
    expect(ruleInsightFor(null)).toBeUndefined();
  });
});

describe('AI worker actions (TC-AI-WK-05)', () => {
  it('holds only OCPP stop, soft reset and availability commands, no money operation', () => {
    for (const action of AI_WORKER_ACTIONS) {
      expect(action.path).toMatch(/^\/v1\/ocpp\/commands\/v(16|21)\//);
      expect(action.path).not.toMatch(/pay|refund|invoice|tariff|pric|bill|credit|vend/i);
    }
    expect(new Set(AI_WORKER_ACTIONS.map((a) => a.kind))).toEqual(
      new Set(['stop_transaction', 'soft_reset', 'change_availability']),
    );
  });

  it('pins a soft reset to the idle reset of each OCPP version', () => {
    const v21 = findAiWorkerAction('ocppv21_Reset');
    const v16 = findAiWorkerAction('ocppv16_Reset');
    expect(v21 && workerActionArgsAllowed(v21, { stationId: 'S1', type: 'OnIdle' })).toBe(true);
    expect(v21 && workerActionArgsAllowed(v21, { stationId: 'S1', type: 'Immediate' })).toBe(false);
    expect(v16 && workerActionArgsAllowed(v16, { stationId: 'S1', type: 'Soft' })).toBe(true);
    expect(v16 && workerActionArgsAllowed(v16, { stationId: 'S1', type: 'Hard' })).toBe(false);
    expect(findAiWorkerAction('payments_refund')).toBeUndefined();
  });

  it('limits change availability to the two statuses', () => {
    const v21 = findAiWorkerAction('ocppv21_ChangeAvailability');
    expect(v21 && workerActionArgsAllowed(v21, { operationalStatus: 'Inoperative' })).toBe(true);
    expect(v21 && workerActionArgsAllowed(v21, { operationalStatus: 'Broken' })).toBe(false);
    expect(v21 && workerActionArgsAllowed(v21, {})).toBe(false);
  });

  it('treats every status but pending as final', () => {
    expect(AI_PROPOSAL_STATUSES.filter((s) => !AI_PROPOSAL_TERMINAL_STATUSES.includes(s))).toEqual([
      'pending',
    ]);
  });
});

describe('via_ai audit field', () => {
  it('reads a stored chat row without a channel as channel chat', () => {
    expect(readAiAuditVia({ conversationId: 'aic_1', toolCallId: 'tc_1' })).toEqual({
      channel: 'chat',
      conversationId: 'aic_1',
      toolCallId: 'tc_1',
    });
  });

  it('reads the new shapes and refuses anything else', () => {
    expect(
      readAiAuditVia({ channel: 'proposal', proposalId: 'aip_1', confirmedBy: 'usr_1' }),
    ).toEqual({ channel: 'proposal', proposalId: 'aip_1', confirmedBy: 'usr_1' });
    expect(readAiAuditVia({ channel: 'email' })).toBeNull();
    expect(readAiAuditVia({})).toBeNull();
    expect(readAiAuditVia(null)).toBeNull();
    expect(readAiAuditVia('chat')).toBeNull();
  });
});

describe('reserved error codes and setting keys', () => {
  it('reserves the twelve roadmap error codes with their HTTP status', () => {
    expect({
      ...AI_INSIGHT_ERROR_CODES,
      ...AI_PROPOSAL_ERROR_CODES,
      ...AI_USAGE_ERROR_CODES,
    }).toEqual({
      AI_INSIGHT_NOT_FOUND: 404,
      AI_INSIGHT_COOLDOWN: 429,
      AI_INSIGHTS_DISABLED: 400,
      AI_SITE_BUDGET_EXCEEDED: 429,
      AI_MONTHLY_BUDGET_EXCEEDED: 429,
      AI_CONTEXT_NOT_FOUND: 404,
      AI_PROPOSAL_NOT_FOUND: 404,
      AI_PROPOSAL_EXPIRED: 409,
      AI_PROPOSAL_STALE: 409,
      AI_PROPOSAL_ALREADY_DECIDED: 409,
      AI_CONFIRMATION_REQUIRES_SESSION: 403,
      AI_MCP_RATE_LIMITED: 429,
    });
  });

  it('names each new setting key once, without clashing with the existing AI keys', () => {
    const keys = [
      OPS_AI_SETTING_KEYS,
      AI_INSIGHT_SETTING_KEYS,
      AI_WORKER_SETTING_KEYS,
      AI_MCP_SETTING_KEYS,
      AI_BUDGET_SETTING_KEYS,
    ].flatMap((group) => Object.values(group) as string[]);
    // 29 in v0.1.44, plus the reservation insight switch (v0.1.45).
    expect(keys).toHaveLength(30);
    expect(new Set(keys).size).toBe(keys.length);
    // The v0.1.43 limit keys. AI_LIMIT_SETTINGS now also holds the numeric new keys (R7).
    const existing = [
      'ai.rateLimit.userPerMinute',
      'ai.rateLimit.sitePerMinute',
      'ai.budget.userDailyTokens',
      'ai.maxToolCallsPerTurn',
      'ai.conversationRetentionDays',
      'ai.attachments.maxBytes',
      'ai.attachments.maxPerMessage',
    ];
    expect(existing.every((key) => Object.hasOwn(AI_LIMIT_SETTINGS, key))).toBe(true);
    for (const key of keys) expect(existing, key).not.toContain(key);
  });
});

describe('usage DTO', () => {
  const totals = {
    tokens: { input: 10, cachedRead: 0, cacheWrite: 0, output: 5, reasoning: 0 },
    totalTokens: 15,
    costMicros: 3,
  };

  it('accepts a restricted user response without company rows', () => {
    const dto = {
      month: '2026-10',
      period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
      company: null,
      unattributed: null,
      sites: [
        {
          siteId: 'sit_1',
          siteName: 'Depot',
          totals,
          budget: { limitTokens: null, usedTokens: 15, percent: null },
        },
      ],
      surfaces: [{ surface: 'insight', totals }],
      topUsers: null,
    };
    expect(aiUsageDtoSchema.safeParse(dto).success).toBe(true);
    expect(aiUsageDtoSchema.safeParse({ ...dto, month: '2026-13' }).success).toBe(false);
  });
});

describe('worker action insight fixes', () => {
  it('never recommend waiting next to the action the insight carries', () => {
    for (const kind of WORKER_ACTION_INSIGHT_KINDS) {
      expect(INSIGHT_KIND_FALLBACKS[kind].fixes).not.toContain('monitor');
    }
    expect(INSIGHT_KIND_FALLBACKS.stuck_session.fixes).toEqual([]);
  });
});
