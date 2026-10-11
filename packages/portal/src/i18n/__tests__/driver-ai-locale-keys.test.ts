// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  DRIVER_ACTION_CODES,
  DRIVER_AI_NOTICE_VERSIONS,
  SUPPORT_CASE_AI_ASSIST_STATUS,
} from '@evtivity/lib/driver-ai';
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

function flatten(node: unknown, prefix = ''): string[] {
  if (node == null || typeof node !== 'object') return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix === '' ? k : `${prefix}.${k}`),
  );
}

// Every reason of the reservation_cancel_reason enum, with the two that lane
// R1 adds in migration 0450.
const CANCEL_REASONS = [
  'driver_initiated',
  'operator_manual',
  'expired_no_show',
  'station_rejected_occupied',
  'station_rejected_other',
  'station_no_response',
  'station_offline_at_activation',
  'evse_in_use_at_activation',
  'station_faulted_at_activation',
  'station_unavailable_during_hold',
  'system_cleanup',
];

describe('portal driver AI and reservation locale keys (v0.1.45, lane K1)', () => {
  it('has a text for every notice version the server accepts, the same keys in every locale', () => {
    // The text a version names never changes after release (plan 2.4).
    for (const version of DRIVER_AI_NOTICE_VERSIONS) {
      const english = flatten(value(en, `supportCases.ai.notice.v${String(version)}`)).sort();
      expect(english.length, `v${String(version)}`).toBeGreaterThanOrEqual(10);
      for (const [lang, locale] of Object.entries(LOCALES)) {
        const keys = flatten(value(locale, `supportCases.ai.notice.v${String(version)}`)).sort();
        expect(keys, lang).toEqual(english);
      }
    }
  });

  it('has every driver AI, cancel reason and error key in all six locales, none empty', () => {
    const keys = [
      `supportCases.statuses.${SUPPORT_CASE_AI_ASSIST_STATUS}`,
      ...DRIVER_ACTION_CODES.map((c) => `supportCases.ai.driverAction.${c}`),
      ...[
        'choiceTitle',
        'choiceAi',
        'choiceTeam',
        'analyzing',
        'answerTitle',
        'feedbackQuestion',
        'feedbackYes',
        'feedbackNo',
        'feedbackNoHint',
        'feedbackFailed',
        'resolved',
        'escalated',
        'sentToTeam',
      ].map((k) => `supportCases.ai.${k}`),
      ...flatten(value(en, 'supportCases.ai.notice')).map((k) => `supportCases.ai.notice.${k}`),
      ...CANCEL_REASONS.map((r) => `reservations.cancelReason.${r}`),
      'errors.DRIVER_AI_NOTICE_OUTDATED',
      'errors.SUPPORT_CASE_AI_NOT_AWAITING_FEEDBACK',
    ];
    for (const key of keys) {
      for (const [lang, locale] of Object.entries(LOCALES)) {
        const text = value(locale, key);
        expect(typeof text === 'string' && text.trim() !== '', `${lang} ${key}`).toBe(true);
      }
    }
  });
});
