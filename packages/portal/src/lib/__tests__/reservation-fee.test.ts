// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';
import {
  cancellationFeeApplies,
  reservationFeeLabel,
  cancellationFeeWarning,
  noShowFeeEstimate,
  noShowFeeNote,
} from '../reservation-fee';

beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
  });
});

describe('cancellationFeeWarning', () => {
  it('TC-T3-25 shows the gross fee the driver is charged with the tax it includes', async () => {
    await i18next.changeLanguage('en');
    // 300 net at 19 % is charged 357; the warning shows 357, not 300 plus tax.
    expect(cancellationFeeWarning(i18next.t, { grossCents: 357, taxRate: 0.19 }, 'EUR')).toBe(
      'A cancellation fee of €3.57 incl. 19% tax will be charged to your default payment method.',
    );
    expect(reservationFeeLabel(i18next.t, { grossCents: 300, taxRate: 0.19 }, 'EUR')).toBe(
      '€3.00 incl. 19% tax',
    );
  });

  it('shows the amount alone without tax', async () => {
    await i18next.changeLanguage('en');
    expect(reservationFeeLabel(i18next.t, { grossCents: 500, taxRate: 0 }, 'USD')).toBe('$5.00');
  });

  it('localizes the label', async () => {
    await i18next.changeLanguage('de');
    expect(reservationFeeLabel(i18next.t, { grossCents: 357, taxRate: 0.19 }, 'EUR')).toBe(
      '3,57 € inkl. 19 % Steuer',
    );
    await i18next.changeLanguage('en');
  });
});

describe('cancellationFeeApplies', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const fee = { grossCents: 357, taxRate: 0.19 };

  it('applies inside the window', () => {
    expect(
      cancellationFeeApplies(
        {
          startsAt: '2026-10-09T12:20:00Z',
          createdAt: '2026-10-09T11:00:00Z',
          cancellationFee: fee,
        },
        30,
        now,
      ),
    ).toBe(true);
  });

  it('does not apply outside the window, without a fee, or without a window', () => {
    const inside = { startsAt: '2026-10-09T12:20:00Z', createdAt: '2026-10-09T11:00:00Z' };
    expect(
      cancellationFeeApplies(
        { startsAt: '2026-10-09T13:00:00Z', createdAt: inside.createdAt, cancellationFee: fee },
        30,
        now,
      ),
    ).toBe(false);
    expect(cancellationFeeApplies({ ...inside, cancellationFee: null }, 30, now)).toBe(false);
    expect(cancellationFeeApplies({ ...inside, cancellationFee: fee }, 0, now)).toBe(false);
  });

  it('uses the creation time of an instant reservation', () => {
    expect(
      cancellationFeeApplies(
        { startsAt: null, createdAt: '2026-10-09T11:50:00Z', cancellationFee: fee },
        30,
        now,
      ),
    ).toBe(true);
  });
});

describe('noShowFeeEstimate', () => {
  const window = {
    startsAt: new Date('2026-10-09T10:00:00Z'),
    expiresAt: new Date('2026-10-09T10:30:00Z'),
  };

  it('prices the held minutes tax included on the net basis (TC-T3-20)', () => {
    expect(
      noShowFeeEstimate(
        { reservationFeePerMinute: '0.10', taxRate: '0.19', taxBasis: 'net' },
        window,
      ),
    ).toEqual({ grossCents: 357, taxRate: 0.19 });
  });

  it('charges a gross price once on the gross basis (TC-T3-21)', () => {
    expect(
      noShowFeeEstimate(
        { reservationFeePerMinute: '0.10', taxRate: '0.19', taxBasis: 'gross' },
        window,
      ),
    ).toEqual({ grossCents: 300, taxRate: 0.19 });
  });

  it('counts an instant reservation from now and is null without a fee or window', () => {
    const now = new Date('2026-10-09T10:20:00Z');
    expect(
      noShowFeeEstimate(
        { reservationFeePerMinute: '0.10', taxRate: null },
        { startsAt: null, expiresAt: window.expiresAt },
        now,
      ),
    ).toEqual({ grossCents: 100, taxRate: 0 });
    expect(
      noShowFeeEstimate({ reservationFeePerMinute: null, taxRate: '0.19' }, window),
    ).toBeNull();
    expect(noShowFeeEstimate({ reservationFeePerMinute: '0', taxRate: '0.19' }, window)).toBeNull();
    expect(
      noShowFeeEstimate(
        { reservationFeePerMinute: '0.10', taxRate: '0.19' },
        { startsAt: window.expiresAt, expiresAt: window.startsAt },
      ),
    ).toBeNull();
  });

  it('shows the gross fee with its tax label', async () => {
    await i18next.changeLanguage('en');
    expect(noShowFeeNote(i18next.t, { grossCents: 357, taxRate: 0.19 }, 'EUR')).toBe(
      'If you do not start charging before the reservation expires, a no-show fee of €3.57 incl. 19% tax is charged to your default payment method.',
    );
  });
});
