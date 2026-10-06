// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileAllowedTemplate } from '@evtivity/lib';

const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'];
// The "nothing was charged" sentence of each language.
const NOT_CHARGED: Record<string, string> = {
  en: 'Nothing was charged for this session',
  de: 'Für diesen Ladevorgang wurde nichts berechnet',
  es: 'No se le cobró nada por esta sesión',
  ko: '이 세션에는 요금이 청구되지 않았습니다',
  zh: '本次充电会话未收取任何费用',
  'zh-TW': '本次充電工作階段未收取任何費用',
};

function render(language: string, event: string, notCharged: boolean): string {
  const source = readFileSync(
    resolve(TEMPLATES_DIR, language, 'session', event, 'email.hbs'),
    'utf-8',
  );
  return compileAllowedTemplate(source)({
    stationId: 'CS-1',
    energyDeliveredWh: 1000,
    costFormatted: '$0.22',
    durationMinutes: 10,
    startedAt: 'start',
    endedAt: 'end',
    notCharged,
  });
}

describe('session end email templates', () => {
  for (const event of ['Receipt', 'Completed']) {
    it.each(LANGUAGES)(`${event} (%s) keeps the cost and says when nothing was charged`, (lang) => {
      const notCharged = render(lang, event, true);
      expect(notCharged).toContain('$0.22');
      expect(notCharged).toContain(NOT_CHARGED[lang]);
      const charged = render(lang, event, false);
      expect(charged).toContain('$0.22');
      expect(charged).not.toContain(NOT_CHARGED[lang]);
    });
  }
});
