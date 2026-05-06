// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let pmRows: unknown[] = [];
vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(pmRows)),
        })),
      })),
    })),
  },
  driverPaymentMethods: {},
}));

const mockCreatePaymentIntent = vi.fn().mockResolvedValue({ id: 'pi_test' });
const mockGetStripeConfig = vi.fn();
vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: (...args: unknown[]) => mockGetStripeConfig(...args),
}));

describe('chargeReservationNoShowFee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pmRows = [];
    mockGetStripeConfig.mockResolvedValue({
      stripe: { paymentIntents: { create: mockCreatePaymentIntent } },
      currency: 'USD',
    });
  });

  it('no-ops when amountCents <= 0 (skips DB and Stripe)', async () => {
    const { chargeReservationNoShowFee } = await import('../lib/reservation-fees.js');
    await chargeReservationNoShowFee('drv_1', 'site_1', 0, 'rsv_1');
    expect(mockGetStripeConfig).not.toHaveBeenCalled();
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();

    await chargeReservationNoShowFee('drv_1', 'site_1', -100, 'rsv_1');
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it('no-ops when driver has no default payment method', async () => {
    pmRows = [];
    const { chargeReservationNoShowFee } = await import('../lib/reservation-fees.js');
    await chargeReservationNoShowFee('drv_1', 'site_1', 500, 'rsv_1');
    expect(mockGetStripeConfig).not.toHaveBeenCalled();
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it('no-ops when site Stripe config is missing', async () => {
    pmRows = [{ stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1' }];
    mockGetStripeConfig.mockResolvedValueOnce(null);
    const { chargeReservationNoShowFee } = await import('../lib/reservation-fees.js');
    await chargeReservationNoShowFee('drv_1', 'site_1', 500, 'rsv_1');
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it('creates a Stripe PaymentIntent off-session with idempotency key', async () => {
    pmRows = [{ stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1' }];
    const { chargeReservationNoShowFee } = await import('../lib/reservation-fees.js');
    await chargeReservationNoShowFee('drv_1', 'site_1', 500, 'rsv_42');

    expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 500,
        currency: 'usd',
        customer: 'cus_1',
        payment_method: 'pm_1',
        confirm: true,
        off_session: true,
        metadata: expect.objectContaining({
          reservationId: 'rsv_42',
          type: 'reservation_no_show_fee',
        }),
      }),
      { idempotencyKey: 'no-show-fee-rsv_42' },
    );
  });
});
