// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { DEFAULT_CURRENCY } from '@evtivity/lib/currency';
import { resolveCompanyCurrency } from '../company-currency';

describe('resolveCompanyCurrency', () => {
  it('returns undefined while branding is loading', () => {
    expect(resolveCompanyCurrency(undefined)).toBeUndefined();
  });

  it('returns the company currency setting', () => {
    expect(resolveCompanyCurrency({ currency: 'EUR', name: 'Acme' })).toBe('EUR');
  });

  it('falls back to the system default when the setting is unset', () => {
    expect(resolveCompanyCurrency({})).toBe(DEFAULT_CURRENCY);
    expect(resolveCompanyCurrency({ currency: '' })).toBe(DEFAULT_CURRENCY);
  });

  it('falls back to the system default for an unsupported or invalid code', () => {
    expect(resolveCompanyCurrency({ currency: 'JPY' })).toBe(DEFAULT_CURRENCY);
    expect(resolveCompanyCurrency({ currency: 'usd' })).toBe(DEFAULT_CURRENCY);
    expect(resolveCompanyCurrency({ currency: 'NOT-A-CODE' })).toBe(DEFAULT_CURRENCY);
  });
});
