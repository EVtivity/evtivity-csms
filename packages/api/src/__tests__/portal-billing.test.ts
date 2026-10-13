// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  toDriverBilling,
  toSessionAccountBilling,
  withAccountBilling,
} from '../lib/portal-billing.js';

const account = {
  billingMode: 'account',
  billingFleetName: 'Acme',
  billingInvoiceStatus: null,
  billingHasPaymentRecord: false,
  billingMemberBilled: false,
  billingInvoiceId: null,
  billingInvoiceNumber: null,
};

const member = {
  ...account,
  billingMemberBilled: true,
  billingInvoiceStatus: 'issued',
  billingInvoiceId: 'inv_member1',
  billingInvoiceNumber: 'INV-202610-0007',
};

describe('toDriverBilling', () => {
  it('answers card without a billing fleet', () => {
    expect(toDriverBilling(null)).toEqual({ mode: 'card', fleetName: null, invoicedTo: null });
  });

  it('answers account with the fleet name and the invoice recipient', () => {
    expect(toDriverBilling({ fleetId: 'flt_1', fleetName: 'Acme', recipient: 'fleet' })).toEqual({
      mode: 'account',
      fleetName: 'Acme',
      invoicedTo: 'fleet',
    });
    expect(
      toDriverBilling({ fleetId: 'flt_1', fleetName: 'Acme', recipient: 'member' }).invoicedTo,
    ).toBe('member');
  });
});

describe('toSessionAccountBilling', () => {
  it('is unbilled without an invoice', () => {
    expect(toSessionAccountBilling(account)).toEqual({
      state: 'unbilled',
      fleetName: 'Acme',
      invoicedTo: 'fleet',
      invoiceId: null,
      invoiceNumber: null,
    });
  });

  it('is invoiced on an issued invoice and paid on a paid one', () => {
    expect(toSessionAccountBilling({ ...account, billingInvoiceStatus: 'issued' })?.state).toBe(
      'invoiced',
    );
    expect(toSessionAccountBilling({ ...account, billingInvoiceStatus: 'paid' })?.state).toBe(
      'paid',
    );
  });

  it('never exposes the fleet invoice of a fleet-billed session', () => {
    const billing = toSessionAccountBilling({
      ...account,
      billingInvoiceStatus: 'issued',
      billingInvoiceId: 'inv_fleet1',
      billingInvoiceNumber: 'INV-202610-0001',
    });
    expect(billing).toMatchObject({ invoicedTo: 'fleet', invoiceId: null, invoiceNumber: null });
  });

  it('links a member-billed session to the driver invoice', () => {
    expect(toSessionAccountBilling(member)).toEqual({
      state: 'invoiced',
      fleetName: 'Acme',
      invoicedTo: 'member',
      invoiceId: 'inv_member1',
      invoiceNumber: 'INV-202610-0007',
    });
    expect(
      toSessionAccountBilling({
        ...member,
        billingInvoiceStatus: null,
        billingInvoiceId: null,
        billingInvoiceNumber: null,
      }),
    ).toMatchObject({ state: 'unbilled', invoicedTo: 'member', invoiceId: null });
  });

  it('is null for a card session or an account session with a payment record', () => {
    expect(toSessionAccountBilling({ ...account, billingMode: 'card' })).toBeNull();
    expect(toSessionAccountBilling({ ...account, billingMode: null })).toBeNull();
    expect(toSessionAccountBilling({ ...account, billingHasPaymentRecord: true })).toBeNull();
  });
});

describe('withAccountBilling', () => {
  it('replaces every billing helper column with accountBilling', () => {
    const row = withAccountBilling({ id: 'ses_1', ...member });
    expect(Object.keys(row).sort()).toEqual(['accountBilling', 'id']);
    expect(row.accountBilling?.invoiceId).toBe('inv_member1');
  });
});
