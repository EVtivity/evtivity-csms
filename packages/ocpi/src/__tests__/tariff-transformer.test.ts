// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { transformTariff } from '../transformers/tariff.transformer.js';

const tariff = {
  id: 'trf_1',
  name: 'Standard',
  pricePerKwh: '0.30',
  pricePerMinute: null,
  pricePerSession: '1.00',
  idleFeePricePerMinute: null,
  taxRate: null,
  isActive: true,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};

describe('transformTariff', () => {
  it('publishes the tariff in the given company currency', () => {
    const result = transformTariff(
      { tariff, currency: 'EUR', countryCode: 'DE', partyId: 'EVT', ocpiTariffId: 'T-1' },
      '2.2.1',
    );
    expect(result.currency).toBe('EUR');
    expect(result.id).toBe('T-1');
    expect(result.country_code).toBe('DE');
    expect(result.party_id).toBe('EVT');
  });

  it('prices energy and the session fee', () => {
    const result = transformTariff(
      { tariff, currency: 'USD', countryCode: 'US', partyId: 'EVT', ocpiTariffId: 'T-2' },
      '2.2.1',
    );
    const components = result.elements.flatMap((e) => e.price_components);
    expect(components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ENERGY', price: 0.3 }),
        expect.objectContaining({ type: 'FLAT', price: 1 }),
      ]),
    );
  });
});
