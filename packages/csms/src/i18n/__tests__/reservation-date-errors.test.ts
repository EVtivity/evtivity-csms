// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The fleet reservation date errors read from the locales, never an English
// defaultValue, so every language shows its own text.

import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import de from '../locales/de.json';
import es from '../locales/es.json';
import ko from '../locales/ko.json';
import zh from '../locales/zh.json';
import zhTW from '../locales/zh-TW.json';
import tabSource from '@/components/fleet/FleetReservationsTab?raw';

const LOCALES: Record<string, { reservations: Record<string, unknown> }> = {
  en,
  de,
  es,
  ko,
  zh,
  'zh-TW': zhTW,
};
const KEYS = ['startsAtPastError', 'expiresTooSoonError', 'windowTooShortError', 'tooLongError'];

describe('fleet reservation date errors', () => {
  for (const [lang, messages] of Object.entries(LOCALES)) {
    it(`has every date error in ${lang}`, () => {
      for (const key of KEYS) {
        const text = messages.reservations[key];
        expect(typeof text === 'string' && text.trim() !== '', `${lang} ${key}`).toBe(true);
      }
      expect(String(messages.reservations['tooLongError'])).toContain('{{hours}}');
      if (lang !== 'en') {
        expect(messages.reservations['startsAtPastError']).not.toBe(
          en.reservations.startsAtPastError,
        );
      }
    });
  }

  it('reads them without an English default value', () => {
    expect(tabSource).toContain('reservations.startsAtPastError');
    expect(tabSource).not.toContain('defaultValue');
  });
});
