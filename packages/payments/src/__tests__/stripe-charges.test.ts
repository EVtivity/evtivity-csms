// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import { platformFeeCents } from '@evtivity/lib';
import { captureHoldWithFee, chargeShortfallTopUp } from '../providers/stripe/charges.js';
import type { StripeChargeClient } from '../providers/stripe/charges.js';

function client(intent: Record<string, unknown>) {
  const retrieve = vi.fn().mockResolvedValue({
    customer: 'cus_1',
    payment_method: 'pm_1',
    on_behalf_of: null,
    transfer_data: null,
    ...intent,
  });
  const capture = vi.fn().mockResolvedValue({ id: 'pi_hold' });
  const create = vi.fn().mockResolvedValue({ id: 'pi_topup' });
  const stripe = { paymentIntents: { retrieve, capture, create } } as StripeChargeClient;
  return { stripe, retrieve, capture, create };
}

const connected = { on_behalf_of: 'acct_1', transfer_data: { destination: 'acct_1' } };

describe('captureHoldWithFee', () => {
  it('sets the fee of the net amount captured on a destination charge', async () => {
    const { stripe, capture } = client(connected);
    const result = await captureHoldWithFee(stripe, {
      intentId: 'pi_hold',
      amountCents: 11900,
      taxRate: 0.19,
      platformFeePercent: 10,
      idempotencyKey: 'capture_1',
    });
    expect(result.applicationFeeCents).toBe(1000);
    expect(capture).toHaveBeenCalledWith(
      'pi_hold',
      { amount_to_capture: 11900, application_fee_amount: 1000 },
      { idempotencyKey: 'capture_1' },
    );
  });

  it('sets no fee when the hold is not a destination charge', async () => {
    const { stripe, capture } = client({});
    const result = await captureHoldWithFee(stripe, {
      intentId: 'pi_hold',
      amountCents: 11900,
      taxRate: 0.19,
      platformFeePercent: 10,
    });
    expect(result.applicationFeeCents).toBe(0);
    expect(capture).toHaveBeenCalledWith('pi_hold', { amount_to_capture: 11900 }, undefined);
  });

  it('does not read the intent without a fee percent', async () => {
    const { stripe, retrieve, capture } = client(connected);
    await captureHoldWithFee(stripe, {
      intentId: 'pi_hold',
      amountCents: 500,
      taxRate: 0,
      platformFeePercent: 0,
      idempotencyKey: 'capture_2',
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(
      'pi_hold',
      { amount_to_capture: 500 },
      { idempotencyKey: 'capture_2' },
    );
  });

  it('propagates a Stripe capture error', async () => {
    const { stripe, capture } = client(connected);
    capture.mockRejectedValueOnce(new Error('card_declined'));
    await expect(
      captureHoldWithFee(stripe, {
        intentId: 'pi_hold',
        amountCents: 500,
        taxRate: 0,
        platformFeePercent: 5,
      }),
    ).rejects.toThrow('card_declined');
  });
});

describe('chargeShortfallTopUp', () => {
  it('charges the delta with the fee of the increment, so capture and top-up fees add up', async () => {
    const { stripe, create } = client(connected);
    const capture = await captureHoldWithFee(client(connected).stripe, {
      intentId: 'pi_hold',
      amountCents: 5000,
      taxRate: 0.19,
      platformFeePercent: 7,
    });
    const topUp = await chargeShortfallTopUp(stripe, {
      originalIntentId: 'pi_hold',
      capturedCents: 5000,
      finalCostCents: 8333,
      taxRate: 0.19,
      platformFeePercent: 7,
      currency: 'EUR',
      description: 'Top-up',
      idempotencyKey: 'topup_1',
    });
    expect(topUp.amountCents).toBe(3333);
    expect(capture.applicationFeeCents + topUp.applicationFeeCents).toBe(
      platformFeeCents(8333, 0.19, 7),
    );
    expect(create).toHaveBeenCalledWith(
      {
        amount: 3333,
        currency: 'eur',
        customer: 'cus_1',
        payment_method: 'pm_1',
        confirm: true,
        off_session: true,
        capture_method: 'automatic',
        description: 'Top-up',
        on_behalf_of: 'acct_1',
        transfer_data: { destination: 'acct_1' },
        application_fee_amount: topUp.applicationFeeCents,
      },
      { idempotencyKey: 'topup_1' },
    );
  });

  it('charges a platform account top-up without Connect fields', async () => {
    const { stripe, create } = client({
      customer: { id: 'cus_2' },
      payment_method: { id: 'pm_2' },
    });
    await chargeShortfallTopUp(stripe, {
      originalIntentId: 'pi_hold',
      capturedCents: 100,
      finalCostCents: 300,
      taxRate: 0,
      platformFeePercent: 10,
      currency: 'USD',
      description: 'Top-up',
      idempotencyKey: 'topup_2',
    });
    const params = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params['customer']).toBe('cus_2');
    expect(params['payment_method']).toBe('pm_2');
    expect(params['transfer_data']).toBeUndefined();
    expect(params['application_fee_amount']).toBeUndefined();
  });

  it('throws without a shortfall or without a saved card', async () => {
    const base = {
      originalIntentId: 'pi_hold',
      taxRate: 0,
      platformFeePercent: 0,
      currency: 'USD',
      description: 'Top-up',
      idempotencyKey: 'k',
    };
    await expect(
      chargeShortfallTopUp(client({}).stripe, { ...base, capturedCents: 500, finalCostCents: 500 }),
    ).rejects.toThrow('No shortfall');
    await expect(
      chargeShortfallTopUp(client({ customer: null }).stripe, {
        ...base,
        capturedCents: 100,
        finalCostCents: 500,
      }),
    ).rejects.toThrow('missing customer');
  });
});
