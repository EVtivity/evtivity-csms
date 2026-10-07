// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

const savedLanguage = localStorage.getItem('language') ?? 'en';

// The page language follows the UI language, so screen readers read the text in
// that language (WCAG 3.1.1). index.html starts with lang="en".
i18n.on('languageChanged', (lng: string) => {
  document.documentElement.lang = lng;
});

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: savedLanguage,
  fallbackLng: {
    'zh-TW': ['zh', 'en'],
    default: ['en'],
  },
  interpolation: {
    escapeValue: false,
  },
  initImmediate: false,
});

// Resolves once the saved language bundle is loaded and active. main.tsx waits for it before
// the first render, so no page shows English first.
export const i18nReady: Promise<void> =
  savedLanguage === 'en' ? Promise.resolve() : loadLanguage(savedLanguage);

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
