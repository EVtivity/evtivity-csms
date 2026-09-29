// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { currenciesIn, entryFor, splitPrimary } from '../currency-amounts';

describe('splitPrimary', () => {
  it('returns the first entry as primary and the rest as others', () => {
    const { primary, others } = splitPrimary([
      { currency: 'EUR' },
      { currency: 'USD' },
      { currency: 'GBP' },
    ]);
    expect(primary).toEqual({ currency: 'EUR' });
    expect(others).toEqual([{ currency: 'USD' }, { currency: 'GBP' }]);
  });

  it('handles missing data', () => {
    expect(splitPrimary(undefined)).toEqual({ primary: undefined, others: [] });
  });
});

describe('entryFor', () => {
  it('finds the entry for a currency', () => {
    expect(entryFor([{ currency: 'EUR' }, { currency: 'USD' }], 'USD')).toEqual({
      currency: 'USD',
    });
  });

  it('returns undefined for an unknown or missing currency', () => {
    expect(entryFor([{ currency: 'EUR' }], 'USD')).toBeUndefined();
    expect(entryFor([{ currency: 'EUR' }], undefined)).toBeUndefined();
  });
});

describe('currenciesIn', () => {
  it('lists currencies in first-seen order across days', () => {
    expect(
      currenciesIn([
        { date: '2026-09-01', sessionCount: 0, revenue: [] },
        {
          date: '2026-09-02',
          sessionCount: 2,
          revenue: [
            { currency: 'EUR', revenueCents: 1, sessionCount: 1 },
            { currency: 'USD', revenueCents: 1, sessionCount: 1 },
          ],
        },
        {
          date: '2026-09-03',
          sessionCount: 1,
          revenue: [{ currency: 'GBP', revenueCents: 1, sessionCount: 1 }],
        },
      ]),
    ).toEqual(['EUR', 'USD', 'GBP']);
  });
});
