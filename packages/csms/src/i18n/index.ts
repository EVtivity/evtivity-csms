// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

const savedLanguage = localStorage.getItem('language') ?? 'en';

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
