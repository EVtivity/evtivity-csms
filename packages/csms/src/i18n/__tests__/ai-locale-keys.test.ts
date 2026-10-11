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
  INSIGHT_STATUSES,
  ROOT_CAUSE_CATEGORIES,
  insightScopeCountsSchema,
} from '@evtivity/lib/ai-insights';
import {
  AI_PROPOSAL_PRECONDITION_KINDS,
  AI_PROPOSAL_SOURCES,
  AI_PROPOSAL_STATUSES,
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
import { WORKER_RATIONALE_CODES } from '../../components/ai/inbox/proposal-summary';

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
        /^ai(Insights|Inbox|Workers|Usage)\./.test(k) ||
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
      ...INSIGHT_STATUSES.map((s) => `aiInsights.status.${s}`),
      ...INSIGHT_KINDS.map((k) => `aiInsights.kind.${k}`),
      ...INSIGHT_SKIP_REASONS.map((r) => `aiInsights.skipReason.${r}`),
      ...Object.keys(insightScopeCountsSchema.shape).flatMap((c) => [
        `aiInsights.scope.${c}_one`,
        `aiInsights.scope.${c}_other`,
      ]),
      ...AI_PROPOSAL_SOURCES.map((s) => `aiInbox.source.${s}`),
      ...AI_WORKER_JOBS.map((j) => `aiInbox.job.${j}`),
      ...AI_PROPOSAL_STATUSES.map((s) => `aiInbox.status.${s}`),
      ...AI_WORKER_ACTION_KINDS.map((a) => `aiInbox.action.${a}`),
      ...AI_PROPOSAL_PRECONDITION_KINDS.map((p) => `aiInbox.precondition.${p}`),
      ...AI_USAGE_SURFACES.map((s) => `aiUsage.surface.${s}`),
      ...AI_CONTEXT_KINDS.map((k) => `ai.explain.${k}`),
      // TC-AI-EX-06: the Explain prompt and the context chip of every kind.
      ...AI_CONTEXT_KINDS.map((k) => `ai.explain.kind.${k}`),
      'ai.explain.button',
      'ai.explain.followUp',
      'ai.explain.about',
      ...WORKER_RATIONALE_CODES.map((c) => `aiWorkers.rationale.${c}`),
    ];
    for (const key of dynamic) expect(english, key).toContain(key);
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
