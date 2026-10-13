// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { AI_TOOL_STEP_STATUSES } from '@evtivity/lib/ai-stream';
import { AI_EFFORTS, AI_SUPPORT_TONES } from '@evtivity/lib/ai-config';
import {
  AI_CONTEXT_KINDS,
  FIX_CODES,
  INSIGHT_CONFIDENCES,
  INSIGHT_KINDS,
  INSIGHT_SKIP_REASONS,
  INSIGHT_VISIBLE_STATUSES,
  ROOT_CAUSE_CATEGORIES,
  insightScopeCountsSchema,
  RESERVATION_FIX_CODES,
  RESERVATION_INSIGHT_KINDS,
} from '@evtivity/lib/ai-insights';
import {
  DRIVER_ACTION_CODES,
  DRIVER_AI_CONSENT_DECISIONS,
  DRIVER_AI_STATE_REASONS,
  DRIVER_AI_STATES,
  SUPPORT_CASE_AI_ASSIST_STATUS,
  SUPPORT_CASE_RESOLUTION_SOURCES,
} from '@evtivity/lib/driver-ai';
import {
  AI_PROPOSAL_REFUSAL_REASONS,
  AI_WORKER_ACTION_KINDS,
  AI_WORKER_JOBS,
} from '@evtivity/lib/ai-proposals';
import { AI_USAGE_SURFACES } from '@evtivity/lib/ai-usage';
import en from '../locales/en.json';
import de from '../locales/de.json';
import es from '../locales/es.json';
import ko from '../locales/ko.json';
import zh from '../locales/zh.json';
import zhTW from '../locales/zh-TW.json';
import { SUGGESTION_PAGES, SUGGESTION_SLOTS } from '../../components/ai/SuggestedPrompts';
import { WORKER_RATIONALE_CODES } from '../../components/ai/insights/insight-action';
import { AI_SETTINGS_TABS } from '../../components/settings/ai-settings-tabs';

const LOCALES: Record<string, unknown> = { en, de, es, ko, zh, 'zh-TW': zhTW };

function flatten(node: unknown, prefix = ''): string[] {
  if (node == null || typeof node !== 'object') return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix === '' ? k : `${prefix}.${k}`),
  );
}

function aiKeys(locale: unknown): string[] {
  const all = flatten(locale);
  return all
    .filter(
      (k) =>
        k.startsWith('ai.') ||
        /^ai(Insights|Workers|Usage)\./.test(k) ||
        /^settings\.ai[A-Z]/.test(k) ||
        /^profile\.(ai[A-Z]|chatbotAi|supportAi)/.test(k) ||
        k.startsWith('supportCases.aiAssist'),
    )
    .sort();
}

function value(locale: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((n, part) => (n as Record<string, unknown> | undefined)?.[part], locale);
}

describe('AI locale keys (TC-AI-UI-10)', () => {
  const english = aiKeys(en);

  it('every locale has exactly the English AI keys, none empty', () => {
    for (const [lang, locale] of Object.entries(LOCALES)) {
      expect(aiKeys(locale), lang).toEqual(english);
      for (const key of english) {
        const text = value(locale, key);
        expect(typeof text === 'string' && text.trim() !== '', `${lang} ${key}`).toBe(true);
      }
    }
  });

  it('has the keys the components build at runtime', () => {
    const dynamic = [
      ...AI_TOOL_STEP_STATUSES.map((s) => `ai.stepStatus.${s}`),
      ...['max_tokens', 'refusal', 'context_exceeded'].map((f) => `ai.finish.${f}`),
      ...SUGGESTION_PAGES.flatMap((p) => SUGGESTION_SLOTS.map((s) => `ai.suggestions.${p}.${s}`)),
      ...AI_EFFORTS.map((e) => `settings.aiEfforts.${e}`),
      ...AI_SUPPORT_TONES.map((t) => `settings.aiTones.${t}`),
      ...['chatbot', 'support', 'ops'].flatMap((s) =>
        ['title', 'description', 'enabled'].map((f) => `settings.aiSurface.${s}.${f}`),
      ),
    ];
    for (const key of dynamic) expect(english, key).toContain(key);
  });

  it('localizes every structured insight, proposal and usage value of the contracts', () => {
    const dynamic = [
      ...ROOT_CAUSE_CATEGORIES.map((c) => `aiInsights.category.${c}`),
      ...FIX_CODES.map((c) => `aiInsights.fix.${c}`),
      ...INSIGHT_CONFIDENCES.map((c) => `aiInsights.confidence.${c}`),
      ...INSIGHT_VISIBLE_STATUSES.map((s) => `aiInsights.status.${s}`),
      'aiInsights.analyzing',
      'aiInsights.skipped',
      ...INSIGHT_KINDS.map((k) => `aiInsights.kind.${k}`),
      ...INSIGHT_SKIP_REASONS.map((r) => `aiInsights.skipReason.${r}`),
      ...Object.keys(insightScopeCountsSchema.shape).flatMap((c) => [
        `aiInsights.scope.${c}_one`,
        `aiInsights.scope.${c}_other`,
      ]),
      ...AI_WORKER_JOBS.map((j) => `aiInsights.action.job.${j}`),
      ...AI_PROPOSAL_REFUSAL_REASONS.map((r) => `aiInsights.action.refused.${r}`),
      ...AI_WORKER_ACTION_KINDS.map((a) => `aiInsights.action.kind.${a}`),
      ...AI_USAGE_SURFACES.map((s) => `aiUsage.surface.${s}`),
      ...AI_CONTEXT_KINDS.map((k) => `ai.explain.${k}`),
      // TC-AI-EX-06: the Explain prompt and the context chip of every kind.
      ...AI_CONTEXT_KINDS.map((k) => `ai.explain.kind.${k}`),
      'ai.explain.button',
      'ai.explain.followUp',
      'ai.explain.contextLabel',
      ...WORKER_RATIONALE_CODES.map((c) => `aiWorkers.rationale.${c}`),
    ];
    for (const key of dynamic) expect(english, key).toContain(key);
    // The AI Inbox merged into AI Insights (v0.1.45): none of its keys remain.
    expect(flatten(en).filter((k) => k.startsWith('aiInbox.') || k === 'nav.aiInbox')).toEqual([]);
  });

  it('keeps the interpolation variables in every translation', () => {
    for (const key of english) {
      const vars = (String(value(en, key)).match(/\{\{\w+\}\}/g) ?? []).sort();
      for (const [lang, locale] of Object.entries(LOCALES)) {
        const got = (String(value(locale, key)).match(/\{\{\w+\}\}/g) ?? []).sort();
        expect(got, `${lang} ${key}`).toEqual(vars);
      }
    }
  });

  it('no removed sampling keys remain', () => {
    for (const [lang, locale] of Object.entries(LOCALES)) {
      const leftover = flatten(locale).filter((k) => /(Temperature|TopP|TopK)(Hint)?$/.test(k));
      expect(leftover, lang).toEqual([]);
    }
  });
});

describe('v0.1.45 base locale keys (lane K1)', () => {
  // Driver AI support (item 1), reservation insights (item 3) and the
  // Settings > AI tabs and site AI tab (item 5).
  const keys = [
    ...RESERVATION_INSIGHT_KINDS.flatMap((k) => [
      `aiInsights.kind.${k}`,
      `aiInsights.headline.${k}`,
    ]),
    ...RESERVATION_FIX_CODES.map((c) => `aiInsights.fix.${c}`),
    'ai.explain.reservation',
    'ai.explain.kind.reservation',
    ...['title', 'description', 'enabled'].map((f) => `settings.aiSurface.driver.${f}`),
    ...[
      'title',
      'maxCasesPerDriverPerDay',
      'feedbackTimeoutHours',
      'feedbackTimeoutHelp',
      'driverDailyTokens',
      'driverPerMinute',
      'overLimitHelp',
    ].map((f) => `settings.aiDriverSettings.${f}`),
    'settings.aiInsightsSettings.reservation',
    ...['providers', 'assistant', 'support', 'driver', 'insights', 'mcp', 'usage'].flatMap(
      (tab) => [`settings.aiTabs.${tab}`, `settings.aiTabs.${tab}Description`],
    ),
    'sites.tabs.ai',
    `supportCases.statuses.${SUPPORT_CASE_AI_ASSIST_STATUS}`,
    ...DRIVER_AI_STATES.map((s) => `supportCases.ai.state.${s}`),
    ...DRIVER_AI_STATE_REASONS.map((r) => `supportCases.ai.reason.${r}`),
    ...DRIVER_AI_CONSENT_DECISIONS.map((d) => `supportCases.ai.consent.${d}`),
    'supportCases.ai.consent.notAsked',
    ...SUPPORT_CASE_RESOLUTION_SOURCES.map((r) => `supportCases.ai.resolutionSource.${r}`),
    ...DRIVER_ACTION_CODES.map((c) => `supportCases.ai.driverAction.${c}`),
    ...[
      'consentTitle',
      'consentAt',
      'consentLanguage',
      'noticeVersion',
      'automaticAnswer',
      'resolvedByAi',
      'stateLabel',
      'filterAiState',
      'allAiStates',
      'filterResolvedBy',
      'allResolvedBy',
    ].map((k) => `supportCases.ai.${k}`),
    ...['station_no_response', 'station_unavailable_during_hold'].map(
      (r) => `reservations.cancelReason.${r}`,
    ),
    ...['DRIVER_AI_NOTICE_OUTDATED', 'SUPPORT_CASE_AI_NOT_AWAITING_FEEDBACK'].map(
      (c) => `errors.${c}`,
    ),
  ];

  it('has every key in all six locales, none empty, with the English variables', () => {
    for (const key of keys) {
      const vars = (String(value(en, key)).match(/\{\{\w+\}\}/g) ?? []).sort();
      for (const [lang, locale] of Object.entries(LOCALES)) {
        const text = value(locale, key);
        expect(typeof text === 'string' && text.trim() !== '', `${lang} ${key}`).toBe(true);
        expect((String(text).match(/\{\{\w+\}\}/g) ?? []).sort(), `${lang} ${key}`).toEqual(vars);
      }
    }
  });
});

describe('AI data notice (plan section 8a)', () => {
  // The verified note lives in `packages/ai/src/__contract__/data-handling.md`.
  const spec = Object.values(
    import.meta.glob<string>('../../../../ai/src/__contract__/data-handling.md', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )[0];

  it('has a title and body in every locale', () => {
    for (const [lang, locale] of Object.entries(LOCALES)) {
      for (const key of ['ai.dataNotice.title', 'ai.dataNotice.body']) {
        const text = value(locale, key);
        expect(typeof text === 'string' && text.trim() !== '', `${lang} ${key}`).toBe(true);
      }
    }
  });

  it('shows the verified English note text unchanged', () => {
    expect(spec).toBeDefined();
    const note = /```note\n([\s\S]*?)\n```/.exec(spec ?? '')?.[1];
    expect(note).toBeDefined();
    expect(value(en, 'ai.dataNotice.body')).toBe(note);
  });
});

describe('Layout keys (plan v0.1.45, section 6)', () => {
  it('TC-UI-LY-06 sites.tabs.ai is in all six locales', () => {
    for (const [lang, locale] of Object.entries(LOCALES)) {
      const text = value(locale, 'sites.tabs.ai');
      expect(typeof text === 'string' && text.trim() !== '', lang).toBe(true);
    }
  });

  it('TC-UI-LY-11 every Settings > AI tab has a label and a description in all six locales', () => {
    const keys = [
      ...AI_SETTINGS_TABS.flatMap((tab) => [
        `settings.aiTabs.${tab}`,
        `settings.aiTabs.${tab}Description`,
      ]),
      'settings.aiAdvancedOptions',
      'settings.aiPromptCustomSummary',
      'settings.aiPromptDefaultSummary',
      'settings.aiBaseUrlDefaultSummary',
      'settings.aiInsightsSettings.reservationOff',
      'settings.aiInsightsSettings.reservationOffLink',
    ];
    for (const key of keys) {
      for (const [lang, locale] of Object.entries(LOCALES)) {
        const text = value(locale, key);
        expect(typeof text === 'string' && text.trim() !== '', `${lang} ${key}`).toBe(true);
      }
    }
  });

  it('the old Configuration and Usage sub-tab labels are gone', () => {
    for (const [lang, locale] of Object.entries(LOCALES)) {
      expect(value(locale, 'settings.aiConfigTab'), lang).toBeUndefined();
      expect(value(locale, 'settings.aiUsageTab'), lang).toBeUndefined();
    }
  });

  it('the insight action Reject button and its dialog title use the same word', () => {
    for (const [lang, locale] of Object.entries(LOCALES)) {
      const button = value(locale, 'aiInsights.action.reject');
      const title = value(locale, 'aiInsights.action.rejectDialog.title');
      expect(typeof button === 'string' && typeof title === 'string', lang).toBe(true);
      expect((title as string).toLowerCase(), lang).toContain((button as string).toLowerCase());
    }
  });

  it('the CJK insight action reject toast uses the button word', () => {
    for (const lang of ['ko', 'zh', 'zh-TW']) {
      const locale = LOCALES[lang];
      const button = value(locale, 'aiInsights.action.reject') as string;
      expect(value(locale, 'aiInsights.action.rejectedToast'), lang).toContain(button);
    }
  });
});
