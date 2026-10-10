// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { AI_TOOL_STEP_STATUSES } from '@evtivity/lib/ai-stream';
import { AI_EFFORTS, AI_SUPPORT_TONES } from '@evtivity/lib/ai-config';
import en from '../locales/en.json';
import de from '../locales/de.json';
import es from '../locales/es.json';
import ko from '../locales/ko.json';
import zh from '../locales/zh.json';
import zhTW from '../locales/zh-TW.json';
import { SUGGESTION_PAGES, SUGGESTION_SLOTS } from '../../components/ai/SuggestedPrompts';

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
      ...['chatbot', 'support'].flatMap((s) =>
        ['title', 'description', 'enabled'].map((f) => `settings.aiSurface.${s}.${f}`),
      ),
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
