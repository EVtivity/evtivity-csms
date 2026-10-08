// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { toDriverBilling, toSessionAccountBilling } from '../lib/portal-billing.js';

const account = {
  billingMode: 'account',
  billingFleetName: 'Acme',
  billingInvoiceStatus: null,
  billingHasPaymentRecord: false,
};

describe('toDriverBilling', () => {
  it('answers card without a billing fleet', () => {
    expect(toDriverBilling(null)).toEqual({ mode: 'card', fleetName: null });
  });

  it('answers account with the fleet name', () => {
    expect(toDriverBilling({ fleetId: 'flt_1', fleetName: 'Acme' })).toEqual({
      mode: 'account',
      fleetName: 'Acme',
    });
  });
});

describe('toSessionAccountBilling', () => {
  it('is unbilled without an invoice', () => {
    expect(toSessionAccountBilling(account)).toEqual({ state: 'unbilled', fleetName: 'Acme' });
  });

  it('is invoiced on an issued invoice and paid on a paid one', () => {
    expect(toSessionAccountBilling({ ...account, billingInvoiceStatus: 'issued' })?.state).toBe(
      'invoiced',
    );
    expect(toSessionAccountBilling({ ...account, billingInvoiceStatus: 'paid' })?.state).toBe(
      'paid',
    );
  });

  it('is null for a card session or an account session with a payment record', () => {
    expect(toSessionAccountBilling({ ...account, billingMode: 'card' })).toBeNull();
    expect(toSessionAccountBilling({ ...account, billingMode: null })).toBeNull();
    expect(toSessionAccountBilling({ ...account, billingHasPaymentRecord: true })).toBeNull();
  });
});
