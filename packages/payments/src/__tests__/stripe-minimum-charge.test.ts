// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { SUPPORTED_CURRENCIES } from '@evtivity/lib/currency';
import { stripeMinimumChargeCents } from '../providers/stripe/minimum-charge.js';

describe('stripeMinimumChargeCents', () => {
  it('returns the documented minimum in minor units', () => {
    expect(stripeMinimumChargeCents('USD')).toBe(50);
    expect(stripeMinimumChargeCents('usd')).toBe(50);
    expect(stripeMinimumChargeCents('GBP')).toBe(30);
    expect(stripeMinimumChargeCents('HUF')).toBe(17500);
    expect(stripeMinimumChargeCents('MXN')).toBe(1000);
  });

  it('has no minimum for a currency Stripe does not list', () => {
    expect(stripeMinimumChargeCents('TWD')).toBeNull();
    expect(stripeMinimumChargeCents('XXX')).toBeNull();
  });

  it('covers every supported currency Stripe lists a minimum for', () => {
    const unlisted = SUPPORTED_CURRENCIES.filter((c) => stripeMinimumChargeCents(c) == null);
    expect(unlisted).toEqual(['CNY', 'SAR', 'TWD', 'TRY']);
  });
});
