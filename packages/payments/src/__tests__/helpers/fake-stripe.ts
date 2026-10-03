// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { vi } from 'vitest';
import type { Mock } from 'vitest';
import Stripe from 'stripe';

/** A real client used only for webhook signing and verification (no network). */
export const realStripe = new Stripe('sk_test_unused_for_webhooks');

type Fn = Mock<(...args: unknown[]) => unknown>;

export interface FakeStripeClient {
  balance: { retrieve: Fn };
  customers: { create: Fn };
  setupIntents: { create: Fn };
  ephemeralKeys: { create: Fn };
  paymentMethods: { retrieve: Fn; detach: Fn };
  paymentIntents: { create: Fn; retrieve: Fn; capture: Fn; cancel: Fn };
  refunds: { create: Fn };
  webhooks: Stripe['webhooks'];
}

/** A Stripe client whose resources are vi.fn mocks returning plausible objects. */
export function fakeClient(): FakeStripeClient {
  return {
    balance: { retrieve: vi.fn().mockResolvedValue({}) },
    customers: { create: vi.fn().mockResolvedValue({ id: 'cus_1' }) },
    setupIntents: {
      create: vi.fn().mockResolvedValue({ id: 'seti_1', client_secret: 'seti_1_secret' }),
    },
    ephemeralKeys: { create: vi.fn().mockResolvedValue({ secret: 'ek_secret' }) },
    paymentMethods: {
      retrieve: vi.fn().mockResolvedValue({
        id: 'pm_1',
        customer: 'cus_1',
        card: { brand: 'visa', last4: '4242' },
      }),
      detach: vi.fn().mockResolvedValue({}),
    },
    paymentIntents: {
      create: vi.fn().mockResolvedValue({
        id: 'pi_1',
        status: 'requires_capture',
        amount: 5000,
        amount_capturable: 5000,
      }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'pi_1',
        status: 'requires_capture',
        customer: 'cus_1',
        payment_method: 'pm_1',
        transfer_data: null,
        on_behalf_of: null,
        application_fee_amount: null,
        amount_received: 0,
      }),
      capture: vi.fn().mockResolvedValue({ id: 'pi_1' }),
      cancel: vi.fn().mockResolvedValue({ id: 'pi_1' }),
    },
    refunds: { create: vi.fn().mockResolvedValue({ id: 're_1', amount: 700 }) },
    webhooks: realStripe.webhooks,
  };
}
