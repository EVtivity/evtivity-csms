// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { sessionReceiptVariables } from '../session-receipt.js';
import { MoneyValue } from '../notification-values.js';

describe('sessionReceiptVariables', () => {
  it('builds the receipt variables with the duration, money value and tax flag', () => {
    const variables = sessionReceiptVariables({
      siteName: 'Main',
      stationId: 'CS-1',
      transactionId: 'tx-1',
      energyDeliveredWh: 12000,
      finalCostCents: 1190,
      currency: 'EUR',
      tariffTaxRate: '0.19',
      startedAt: '2026-06-04T00:00:00Z',
      endedAt: '2026-06-04T01:30:00Z',
      notCharged: false,
    });
    expect(variables).toMatchObject({
      siteName: 'Main',
      stationId: 'CS-1',
      transactionId: 'tx-1',
      energyDeliveredWh: 12000,
      finalCostCents: 1190,
      costIncludesTax: true,
      currency: 'EUR',
      durationMinutes: 90,
      startedAt: '2026-06-04T00:00:00Z',
      endedAt: '2026-06-04T01:30:00Z',
      notCharged: false,
    });
    expect(variables['costFormatted']).toBeInstanceOf(MoneyValue);
  });

  it('formats a missing cost as zero without tax and an unknown site as empty', () => {
    const variables = sessionReceiptVariables({
      siteName: null,
      stationId: 'CS-1',
      transactionId: 'tx-1',
      energyDeliveredWh: 0,
      finalCostCents: null,
      currency: 'USD',
      tariffTaxRate: null,
      startedAt: new Date('2026-06-04T00:00:00Z'),
      endedAt: new Date('2026-06-04T00:00:00Z'),
      notCharged: true,
    });
    expect(variables['siteName']).toBe('');
    expect(variables['costIncludesTax']).toBe(false);
    expect(variables['durationMinutes']).toBe(0);
    expect((variables['costFormatted'] as MoneyValue).cents).toBe(0);
  });
});
