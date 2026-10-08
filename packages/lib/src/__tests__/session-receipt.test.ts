// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { receiptBilling, sessionReceiptVariables } from '../session-receipt.js';
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
      billingMode: 'card',
      billedTo: null,
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
      billingMode: 'card',
      billedTo: '',
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
      billingMode: null,
      billedTo: null,
    });
    expect(variables['billingMode']).toBe('');
    expect(variables['billedTo']).toBe('');
    expect(variables['siteName']).toBe('');
    expect(variables['costIncludesTax']).toBe(false);
    expect(variables['durationMinutes']).toBe(0);
    expect((variables['costFormatted'] as MoneyValue).cents).toBe(0);
  });

  it('names the fleet of an account session and only of one', () => {
    const base = {
      siteName: 'Main',
      stationId: 'CS-1',
      transactionId: 'tx-1',
      energyDeliveredWh: 1000,
      finalCostCents: 500,
      currency: 'EUR',
      tariffTaxRate: null,
      startedAt: '2026-06-04T00:00:00Z',
      endedAt: '2026-06-04T00:30:00Z',
      notCharged: false,
    };
    const account = sessionReceiptVariables({
      ...base,
      billingMode: 'account',
      billedTo: 'Acme Logistics',
    });
    expect(account['billingMode']).toBe('account');
    expect(account['billedTo']).toBe('Acme Logistics');
    const card = sessionReceiptVariables({ ...base, billingMode: 'card', billedTo: 'Acme' });
    expect(card['billedTo']).toBe('');
  });
});

describe('receiptBilling', () => {
  it('bills an account session without a payment record to its fleet', () => {
    expect(receiptBilling('account', 'Fleet A', false)).toEqual({
      billingMode: 'account',
      billedTo: 'Fleet A',
    });
  });

  it('treats an account session with a payment record (an operator hold) as paid by card', () => {
    expect(receiptBilling('account', 'Fleet A', true)).toEqual({
      billingMode: 'card',
      billedTo: null,
    });
  });

  it('keeps card and gives no mode for a missing or unknown stamp', () => {
    expect(receiptBilling('card', null, true)).toEqual({ billingMode: 'card', billedTo: null });
    expect(receiptBilling(null, null, false)).toEqual({ billingMode: null, billedTo: null });
    expect(receiptBilling('other', null, false)).toEqual({ billingMode: null, billedTo: null });
  });
});
