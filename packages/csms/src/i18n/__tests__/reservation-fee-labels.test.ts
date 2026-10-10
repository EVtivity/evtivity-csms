// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// TC-T3-26: the cancellation fee setting labels follow company.taxBasis. The
// fee is entered in the tax basis, so on the gross basis it includes tax and
// on the net basis tax is added. TC-T3-27: the reservation detail shows the
// reservation's own gross fee with its tax rate, in every locale.

import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import en from '../locales/en.json';
import de from '../locales/de.json';
import es from '../locales/es.json';
import ko from '../locales/ko.json';
import zh from '../locales/zh.json';
import zhTW from '../locales/zh-TW.json';

const LOCALES: Record<string, unknown> = { en, de, es, ko, zh, 'zh-TW': zhTW };

const BASIS_KEYS = [
  'settings.reservationCancellationFee',
  'settings.reservationCancellationFeeHelp',
];

const RESERVATION_KEYS = [
  'reservations.feeInclTax',
  'reservations.chargeCancellationFeeLabel',
  'reservations.cancellationPolicyText',
];

function lookup(messages: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node != null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      messages,
    );
}

function isText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

describe('reservation cancellation fee labels', () => {
  for (const [lang, messages] of Object.entries(LOCALES)) {
    it(`TC-T3-26 has a net and a gross setting label in ${lang}, and no basis-less one`, () => {
      for (const key of BASIS_KEYS) {
        const net = lookup(messages, `${key}_net`);
        const gross = lookup(messages, `${key}_gross`);
        expect(isText(net), `${lang} ${key}_net`).toBe(true);
        expect(isText(gross), `${lang} ${key}_gross`).toBe(true);
        expect(net, `${lang} ${key}`).not.toBe(gross);
        expect(lookup(messages, key), `${lang} ${key}`).toBeUndefined();
      }
    });

    it(`TC-T3-27 has the reservation fee texts in ${lang}, and no unused fee warning`, () => {
      for (const key of RESERVATION_KEYS) {
        expect(isText(lookup(messages, key)), `${lang} ${key}`).toBe(true);
      }
      const rate = lookup(messages, 'reservations.feeInclTax') as string;
      expect(rate).toContain('{{amount}}');
      expect(rate).toContain('{{rate}}');
      expect(lookup(messages, 'reservations.cancellationFeeWarning')).toBeUndefined();
    });
  }

  it('TC-T3-26 renders excl. tax on the net basis and incl. tax on the gross basis', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });

    expect(i18n.t('settings.reservationCancellationFee', { currency: 'EUR', context: 'net' })).toBe(
      'Cancellation Fee (EUR, excl. tax)',
    );
    expect(
      i18n.t('settings.reservationCancellationFee', { currency: 'EUR', context: 'gross' }),
    ).toBe('Cancellation Fee (EUR, incl. tax)');
  });
});
