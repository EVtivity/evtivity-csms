// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { accountBillingAt } from '../fleet-billing';

const account = { mode: 'account' as const, fleetName: 'Acme', invoicedTo: 'fleet' as const };
const member = { mode: 'account' as const, fleetName: 'Acme', invoicedTo: 'member' as const };
const card = { mode: 'card' as const, fleetName: null, invoicedTo: null };

describe('accountBillingAt', () => {
  it('uses the charger pricing once it is loaded', () => {
    expect(accountBillingAt({ billing: account }, card)).toEqual({
      fleetName: 'Acme',
      invoicedTo: 'fleet',
    });
    expect(accountBillingAt({ billing: card }, account)).toBeNull();
  });

  it('bills nothing to the fleet at a free vend site (pricing billing null)', () => {
    expect(accountBillingAt({ billing: null }, account)).toBeNull();
  });

  it('falls back to the driver profile while the pricing is missing', () => {
    expect(accountBillingAt(undefined, account)?.fleetName).toBe('Acme');
    expect(accountBillingAt(undefined, card)).toBeNull();
    expect(accountBillingAt(undefined, undefined)).toBeNull();
  });

  it('reports a member invoice, and the fleet for a server without invoicedTo', () => {
    expect(accountBillingAt({ billing: member }, card)?.invoicedTo).toBe('member');
    expect(
      accountBillingAt({ billing: { mode: 'account', fleetName: 'Acme' } }, undefined)?.invoicedTo,
    ).toBe('fleet');
  });
});
