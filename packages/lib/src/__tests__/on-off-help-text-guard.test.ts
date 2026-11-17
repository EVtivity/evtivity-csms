// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Help and description texts are plain full sentences. A text that labels its
// cases as "On: ... Off: ..." (or "Enabled:", "When on:" and the same words in
// the other UI languages) fails here, in every CSMS and portal locale.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PACKAGES_DIR = path.resolve(import.meta.dirname, '../../..');
const APPS = ['csms', 'portal'];
const LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'];

const LABELS = [
  'On',
  'Off',
  'Enabled',
  'Disabled',
  'When on',
  'When off',
  'When enabled',
  'When disabled',
  'Ein',
  'Aus',
  'An',
  'Aktiviert',
  'Deaktiviert',
  'Activado',
  'Desactivado',
  'Activada',
  'Desactivada',
  '켜짐',
  '꺼짐',
  '켜기',
  '끄기',
  '开启',
  '关闭',
  '启用',
  '禁用',
  '開啟',
  '關閉',
  '啟用',
  '停用',
];

// A label word at the start of the text or of a sentence, followed by a colon.
const LABELLED_CASE = new RegExp(`(^|[.!?。；;]\\s*)(${LABELS.join('|')})\\s*[:：]`, 'i');

function labelledTexts(value: unknown, keyPath: string, out: string[]): void {
  if (typeof value === 'string') {
    if (LABELLED_CASE.test(value)) out.push(`${keyPath}: ${value}`);
    return;
  }
  if (value != null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      labelledTexts(child, keyPath === '' ? key : `${keyPath}.${key}`, out);
    }
  }
}

describe('help texts are full sentences, not On:/Off: labels', () => {
  it('matches the labelled pattern it is meant to refuse', () => {
    expect(LABELLED_CASE.test('On: drivers add cards. Off: drivers only see them.')).toBe(true);
    expect(LABELLED_CASE.test('Lets drivers add cards. Aus: nichts.')).toBe(true);
    expect(LABELLED_CASE.test('开启：充电桩可以分组')).toBe(true);
    expect(LABELLED_CASE.test('When enabled, sessions are billed per segment.')).toBe(false);
    expect(LABELLED_CASE.test('Station: CS-1')).toBe(false);
  });

  for (const app of APPS) {
    for (const lang of LANGUAGES) {
      it(`${app} ${lang} has no On:/Off: help text`, () => {
        const file = path.join(PACKAGES_DIR, app, 'src/i18n/locales', `${lang}.json`);
        const found: string[] = [];
        labelledTexts(JSON.parse(readFileSync(file, 'utf8')) as unknown, '', found);
        expect(found).toEqual([]);
      });
    }
  }
});
