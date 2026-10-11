// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Prompt helpers every AI surface shares: the CSMS languages a prompt can be
 * written in, and the framing of content the operator did not write.
 */

export const PROMPT_LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'] as const;
export type PromptLanguage = (typeof PROMPT_LANGUAGES)[number];

/** How the prompt names each language to the model. */
export const LANGUAGE_NAMES: Record<PromptLanguage, string> = {
  en: 'English',
  de: 'German (Deutsch)',
  es: 'Spanish (Español)',
  ko: 'Korean (한국어)',
  zh: 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
};

/**
 * Chinese and Korean terms the platform uses (the CSMS locale files); the
 * model is told to use them. Korean: a driver is 운전자, never 드라이버
 * (owner decision 2026-10-11). Every AI surface adds this note: the chat, the insights, their
 * translations and the background workers. A station is never called a site:
 * DeepSeek wrote 站点 for a charging station (2026-10-11).
 */
const TERMINOLOGY: Partial<Record<PromptLanguage, string>> = {
  ko: 'In Korean, call a driver 운전자 (never 드라이버) and a charging station 충전소.',
  zh: 'In Chinese, call a charging station 充电站 (never 站点, which means a site), a site 站点, a driver 驾驶员 and firmware 固件.',
  'zh-TW':
    'In Chinese, call a charging station 充電站 (never 站點, which means a site), a site 站點, a driver 駕駛員 and firmware 固件.',
};

export function terminologyNote(language: PromptLanguage): string {
  return TERMINOLOGY[language] ?? '';
}

export function promptLanguage(value: string | null | undefined): PromptLanguage {
  return (PROMPT_LANGUAGES as readonly string[]).includes(value ?? '')
    ? (value as PromptLanguage)
    : 'en';
}

const ATTRIBUTE_UNSAFE = /[^A-Za-z0-9_.:-]/g;

/**
 * Wraps untrusted text in an `<untrusted>` block. A `<untrusted` or
 * `</untrusted` inside the text is escaped, so the text cannot close its own
 * block or open a new one (TC-AI-I-05).
 */
export function frameUntrusted(source: string, id: string, text: string): string {
  const safeSource = source.replace(ATTRIBUTE_UNSAFE, '_').slice(0, 64);
  const safeId = id.replace(ATTRIBUTE_UNSAFE, '_').slice(0, 200);
  const body = text.replace(/<(\/?\s*untrusted)/gi, '&lt;$1');
  return `<untrusted source="${safeSource}" id="${safeId}">\n${body}\n</untrusted>`;
}
