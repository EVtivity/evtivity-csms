// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import de from '../locales/de.json';
import es from '../locales/es.json';
import ko from '../locales/ko.json';
import zh from '../locales/zh.json';
import zhTW from '../locales/zh-TW.json';

const LOCALES: Record<string, unknown> = { en, de, es, ko, zh, 'zh-TW': zhTW };

function value(locale: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((n, part) => (n as Record<string, unknown> | undefined)?.[part], locale);
}

function entries(node: unknown, prefix: string): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (node == null || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    entries(v, `${prefix}.${k}`),
  );
}

// Every key the driver AI consent step, answer and feedback UI reads.
const UI_KEYS = [
  'supportCases.ai.choiceTitle',
  'supportCases.ai.choiceAi',
  'supportCases.ai.choiceTeam',
  'supportCases.ai.yourChoice',
  'supportCases.ai.changeChoice',
  'supportCases.ai.analyzing',
  'supportCases.ai.answerTitle',
  'supportCases.ai.feedbackQuestion',
  'supportCases.ai.feedbackYes',
  'supportCases.ai.feedbackNo',
  'supportCases.ai.feedbackNoHint',
  'supportCases.ai.feedbackFailed',
  'supportCases.ai.resolved',
  'supportCases.ai.escalated',
  'supportCases.ai.sentToTeam',
  'supportCases.statuses.ai_assist',
  'supportCases.ai.dataNotice.title',
  'supportCases.ai.dataNotice.body',
];

// The verified driver note lives in `packages/ai/src/__contract__/data-handling.md`.
const spec = Object.values(
  import.meta.glob<string>('../../../../ai/src/__contract__/data-handling.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)[0];

describe('portal driver AI data note (TC-AI-AD-13)', () => {
  it('TC-AI-AD-13: shows the verified English driver note text unchanged', () => {
    expect(spec).toBeDefined();
    const note = /```note-driver\n([\s\S]*?)\n```/.exec(spec ?? '')?.[1];
    expect(note).toBeDefined();
    expect(value(en, 'supportCases.ai.dataNotice.body')).toBe(note);
  });
});

describe('portal driver AI UI locales (TC-AI-DR-UI-05)', () => {
  it('TC-AI-DR-UI-05: every driver AI UI key is present and not empty in all six locales', () => {
    const englishTree = entries(value(en, 'supportCases.ai'), 'supportCases.ai').map(([k]) => k);
    for (const [lang, locale] of Object.entries(LOCALES)) {
      for (const key of [...UI_KEYS, ...englishTree]) {
        const text = value(locale, key);
        expect(typeof text === 'string' && text.trim() !== '', `${lang} ${key}`).toBe(true);
      }
    }
  });

  it('TC-AI-DR-UI-05: zh and zh-TW use the platform driver term, ko uses 운전자', () => {
    const forbidden: Record<string, RegExp> = {
      zh: /司机|司機|驾驶人|駕駛人/,
      'zh-TW': /司机|司機|驾驶人|駕駛人/,
      ko: /드라이버/,
    };
    const required: Record<string, string> = { zh: '驾驶员', 'zh-TW': '駕駛員', ko: '운전자' };
    for (const lang of ['zh', 'zh-TW', 'ko']) {
      const texts = [...entries(value(LOCALES[lang], 'supportCases.ai'), 'supportCases.ai')];
      for (const [key, text] of texts) {
        expect(forbidden[lang]?.test(text), `${lang} ${key}: ${text}`).toBe(false);
      }
      // The driver term appears where the notice speaks of driver data.
      expect(
        texts.some(([, text]) => text.includes(required[lang] ?? '')),
        `${lang} uses ${required[lang] ?? ''}`,
      ).toBe(true);
    }
  });
});
