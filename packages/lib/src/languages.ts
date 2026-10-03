// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export const UI_LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && (UI_LANGUAGES as readonly string[]).includes(value);
}

// Maps a BCP 47 locale (browser or i18next) to a UI language. Traditional
// Chinese locales (zh-TW, zh-HK, zh-MO, zh-Hant) map to zh-TW.
export function toUiLanguage(locale: string | null | undefined): UiLanguage {
  const lower = (locale ?? '').toLowerCase();
  if (lower.startsWith('zh')) {
    return /^zh-(tw|hk|mo|hant)\b/.test(lower) ? 'zh-TW' : 'zh';
  }
  const base = lower.split('-')[0];
  return isUiLanguage(base) ? base : 'en';
}
