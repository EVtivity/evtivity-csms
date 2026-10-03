// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { UI_LANGUAGES, isUiLanguage, toUiLanguage } from '../languages.js';

describe('UI languages', () => {
  it('lists the six UI languages', () => {
    expect(UI_LANGUAGES).toEqual(['en', 'de', 'es', 'ko', 'zh', 'zh-TW']);
  });

  it('recognizes only supported codes', () => {
    expect(isUiLanguage('ko')).toBe(true);
    expect(isUiLanguage('zh-TW')).toBe(true);
    expect(isUiLanguage('fr')).toBe(false);
    expect(isUiLanguage('zh-tw')).toBe(false);
    expect(isUiLanguage(42)).toBe(false);
  });
});

describe('toUiLanguage', () => {
  it.each([
    ['en-US', 'en'],
    ['de-DE', 'de'],
    ['es-419', 'es'],
    ['ko', 'ko'],
    ['ko-KR', 'ko'],
    ['zh', 'zh'],
    ['zh-CN', 'zh'],
    ['zh-Hans-CN', 'zh'],
    ['zh-SG', 'zh'],
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-MO', 'zh-TW'],
    ['zh-Hant', 'zh-TW'],
    ['zh-Hant-TW', 'zh-TW'],
  ])('maps %s to %s', (locale, expected) => {
    expect(toUiLanguage(locale)).toBe(expected);
  });

  it('falls back to English for unsupported or missing locales', () => {
    expect(toUiLanguage('fr-FR')).toBe('en');
    expect(toUiLanguage('')).toBe('en');
    expect(toUiLanguage(null)).toBe('en');
    expect(toUiLanguage(undefined)).toBe('en');
  });
});
