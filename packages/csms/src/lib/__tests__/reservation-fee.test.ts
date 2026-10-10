// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeAll, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import en from '../../i18n/locales/en.json';
import { reservationFeeLabel } from '../reservation-fee';

beforeAll(async () => {
  await i18next.init({ lng: 'en', resources: { en: { translation: en } } });
});

describe('reservationFeeLabel', () => {
  it('TC-T3-27 shows the reservation gross fee with the tax it includes', () => {
    // 300 net at 19 % is charged 357: the operator sees the 357 the driver pays.
    expect(reservationFeeLabel(i18next.t, { grossCents: 357, taxRate: 0.19 }, 'EUR')).toBe(
      '€3.57 incl. 19% tax',
    );
    expect(
      i18next.t('reservations.chargeCancellationFeeLabel', {
        fee: reservationFeeLabel(i18next.t, { grossCents: 300, taxRate: 0.19 }, 'EUR'),
      }),
    ).toBe('Charge cancellation fee (€3.00 incl. 19% tax)');
  });

  it('shows the amount alone without tax', () => {
    expect(reservationFeeLabel(i18next.t, { grossCents: 500, taxRate: 0 }, 'USD')).toBe('$5.00');
  });
});
