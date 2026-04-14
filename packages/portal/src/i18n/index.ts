// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

function getInitialLanguage(): string {
  const stored = localStorage.getItem('portal_language');
  if (stored != null) return stored;
  const browserFull = navigator.language;
  // Check full locale first (en-GB, zh-TW)
  if (browserFull === 'en-GB') return 'en-GB';
  if (browserFull === 'zh-TW' || browserFull === 'zh-Hant') return 'zh-TW';
  const browser = browserFull.split('-')[0];
  if (browser === 'es') return 'es';
  if (browser === 'ko') return 'ko';
  if (browser === 'zh') return 'zh';
  return 'en';
}

const savedLanguage = getInitialLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: savedLanguage,
  fallbackLng: {
    'en-GB': ['en'],
    'zh-TW': ['zh', 'en'],
    default: ['en'],
  },
  interpolation: {
    escapeValue: false,
  },
  initImmediate: false,
});

if (savedLanguage !== 'en') {
  void loadLanguage(savedLanguage);
}

export async function loadLanguage(lang: string): Promise<void> {
  if (lang === 'en' || i18n.hasResourceBundle(lang, 'translation')) {
    await i18n.changeLanguage(lang);
    return;
  }
  const module = (await import(`./locales/${lang}.json`)) as { default: Record<string, unknown> };
  i18n.addResourceBundle(lang, 'translation', module.default);
  await i18n.changeLanguage(lang);
}

export default i18n;
