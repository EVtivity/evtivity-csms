// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { noPaymentReason, type NoPaymentFacts } from '../lib/session-no-payment-reason.js';

/** An ended card session of a driver with a cost and no payment record. */
function facts(overrides: Partial<NoPaymentFacts> = {}): NoPaymentFacts {
  return {
    hasPaymentRecord: false,
    status: 'completed',
    freeVend: false,
    isRoaming: false,
    billingMode: 'card',
    stoppedReason: 'EVDisconnected',
    guestSession: false,
    driverId: 'drv_000000000001',
    prepaidToken: false,
    finalCostCents: 359,
    currentCostCents: 359,
    ...overrides,
  };
}

const paymentsOn = (): Promise<boolean> => Promise.resolve(false);
const paymentsOff = (): Promise<boolean> => Promise.resolve(true);

describe('noPaymentReason', () => {
  it('returns null and reads no provider when a payment record exists', async () => {
    const check = vi.fn(paymentsOff);
    expect(await noPaymentReason(facts({ hasPaymentRecord: true }), check)).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('free vend comes first', async () => {
    expect(await noPaymentReason(facts({ freeVend: true, isRoaming: true }), paymentsOff)).toBe(
      'free_vend',
    );
  });

  it('roaming', async () => {
    expect(await noPaymentReason(facts({ isRoaming: true, driverId: null }), paymentsOff)).toBe(
      'roaming',
    );
  });

  it('account billed (fleet or member invoice)', async () => {
    const check = vi.fn(paymentsOff);
    expect(await noPaymentReason(facts({ billingMode: 'account' }), check)).toBe('account_billed');
    expect(check).not.toHaveBeenCalled();
  });

  it('account start refused by the fleet credit limit', async () => {
    expect(
      await noPaymentReason(
        facts({
          billingMode: 'account',
          stoppedReason: 'AccountCreditLimit',
          status: 'faulted',
          finalCostCents: 0,
        }),
        paymentsOn,
      ),
    ).toBe('account_credit_limit');
  });

  it('an account session stopped at its ceiling is still billed to the account', async () => {
    expect(
      await noPaymentReason(
        facts({ billingMode: 'account', stoppedReason: 'AccountCreditLimit' }),
        paymentsOn,
      ),
    ).toBe('account_billed');
  });

  it('guest', async () => {
    expect(await noPaymentReason(facts({ guestSession: true, driverId: null }), paymentsOff)).toBe(
      'guest',
    );
  });

  it('anonymous: no driver and no guest checkout', async () => {
    expect(await noPaymentReason(facts({ driverId: null, billingMode: null }), paymentsOn)).toBe(
      'anonymous',
    );
  });

  it('stopped for a missing payment method', async () => {
    expect(
      await noPaymentReason(
        facts({ stoppedReason: 'MissingPaymentMethod', status: 'faulted', finalCostCents: 0 }),
        paymentsOn,
      ),
    ).toBe('no_payment_method');
  });

  it('stopped for a failed payment check', async () => {
    expect(
      await noPaymentReason(
        facts({ stoppedReason: 'PaymentFailed', status: 'faulted', finalCostCents: 0 }),
        paymentsOn,
      ),
    ).toBe('payment_failed');
  });

  it('an active card session is pending while payments are on', async () => {
    expect(
      await noPaymentReason(facts({ status: 'active', finalCostCents: null }), paymentsOn),
    ).toBe('pending');
  });

  it('an active card session with payments off never gets a hold', async () => {
    expect(
      await noPaymentReason(facts({ status: 'active', finalCostCents: null }), paymentsOff),
    ).toBe('payments_off');
  });

  it('an active prepaid session is pending whatever the provider', async () => {
    const check = vi.fn(paymentsOff);
    expect(await noPaymentReason(facts({ status: 'active', prepaidToken: true }), check)).toBe(
      'pending',
    );
    expect(check).not.toHaveBeenCalled();
  });

  it('an ended prepaid session with a cost and no debit record', async () => {
    expect(await noPaymentReason(facts({ prepaidToken: true }), paymentsOn)).toBe(
      'prepaid_not_debited',
    );
  });

  it('no cost: a zero or missing cost', async () => {
    const check = vi.fn(paymentsOff);
    expect(await noPaymentReason(facts({ finalCostCents: 0 }), check)).toBe('no_cost');
    expect(
      await noPaymentReason(facts({ finalCostCents: null, currentCostCents: null }), check),
    ).toBe('no_cost');
    expect(await noPaymentReason(facts({ prepaidToken: true, finalCostCents: 0 }), check)).toBe(
      'no_cost',
    );
    expect(check).not.toHaveBeenCalled();
  });

  it('payments off: a card session with a cost and no provider', async () => {
    expect(await noPaymentReason(facts(), paymentsOff)).toBe('payments_off');
  });

  it('not held: payments are on now but no hold was placed at the start', async () => {
    expect(await noPaymentReason(facts(), paymentsOn)).toBe('not_held');
  });

  it('uses the running cost when the final cost is not set', async () => {
    expect(
      await noPaymentReason(facts({ finalCostCents: null, currentCostCents: 120 }), paymentsOn),
    ).toBe('not_held');
  });
});
