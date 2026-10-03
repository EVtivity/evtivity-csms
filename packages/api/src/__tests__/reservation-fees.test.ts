// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let pmRows: unknown[] = [];
let existingRows: unknown[] = [];
let insertedRows: unknown[] = [{ id: 7 }];
const insertedValues: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];

vi.mock('@evtivity/database', () => {
  let selectCall = 0;
  return {
    db: {
      select: vi.fn(() => {
        const call = selectCall++;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => {
              // First select of a charge: the default payment method (with
              // limit); a later one: the existing record of a duplicate.
              const result = { limit: vi.fn(() => Promise.resolve(pmRows)) };
              return Object.assign(Promise.resolve(existingRows), result, { call });
            }),
          })),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          insertedValues.push(values);
          return {
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(() => Promise.resolve(insertedRows)),
            })),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updates.push(values);
          return { where: vi.fn(() => Promise.resolve()) };
        }),
      })),
    },
    driverPaymentMethods: {},
    paymentRecords: { reservationId: 'reservation_id', chargeType: 'charge_type', id: 'id' },
    getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  };
});

const mockChargeSavedCard = vi.fn().mockResolvedValue({ id: 'pi_fee' });
const mockGetStripeConfig = vi.fn();
vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: (...args: unknown[]) => mockGetStripeConfig(...args),
  chargeSavedCard: (...args: unknown[]) => mockChargeSavedCard(...args),
}));

const mockResolveTariff = vi.fn();
vi.mock('../services/tariff.service.js', () => ({
  resolveTariff: (...args: unknown[]) => mockResolveTariff(...args),
}));

const mockSimulatedFailure = vi.fn(() => false);
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  shouldSimulatePaymentFailure: () => mockSimulatedFailure(),
}));

import { chargeReservationFee } from '../lib/reservation-fees.js';

const stripeConfig = { stripe: {}, currency: 'USD', configId: 3, connectedAccountId: 'acct_1' };

const baseInput = {
  type: 'reservation_cancellation' as const,
  reservationId: 'rsv_1',
  driverId: 'drv_1',
  stationId: 'sta_1',
  siteId: 'site_1',
  netCents: 500,
};

describe('chargeReservationFee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pmRows = [{ stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1' }];
    existingRows = [];
    insertedRows = [{ id: 7 }];
    insertedValues.length = 0;
    updates.length = 0;
    mockGetStripeConfig.mockResolvedValue(stripeConfig);
    mockResolveTariff.mockResolvedValue({ taxRate: '0.19' });
    mockChargeSavedCard.mockResolvedValue({ id: 'pi_fee' });
    mockSimulatedFailure.mockReturnValue(false);
  });

  it('skips without an amount', async () => {
    await expect(chargeReservationFee({ ...baseInput, netCents: 0 })).resolves.toEqual({
      status: 'skipped',
      reason: 'no_amount',
    });
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(0);
  });

  it('skips when the driver has no default payment method', async () => {
    pmRows = [];
    await expect(chargeReservationFee(baseInput)).resolves.toEqual({
      status: 'skipped',
      reason: 'no_payment_method',
    });
    expect(mockGetStripeConfig).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(0);
  });

  it('skips when payments are not configured for the site', async () => {
    mockGetStripeConfig.mockResolvedValueOnce(null);
    await expect(chargeReservationFee(baseInput)).resolves.toEqual({
      status: 'skipped',
      reason: 'payments_not_configured',
    });
    expect(insertedValues).toHaveLength(0);
  });

  it('taxes the net fee at the station tariff rate and records it before charging', async () => {
    const result = await chargeReservationFee(baseInput);

    expect(mockResolveTariff).toHaveBeenCalledWith('sta_1', 'drv_1');
    expect(insertedValues[0]).toMatchObject({
      chargeType: 'reservation_cancellation',
      reservationId: 'rsv_1',
      driverId: 'drv_1',
      sitePaymentConfigId: 3,
      currency: 'USD',
      taxRate: '0.19',
      status: 'pending',
    });
    expect(mockChargeSavedCard).toHaveBeenCalledWith(stripeConfig, {
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      grossCents: 595,
      taxRate: 0.19,
      description: 'Reservation cancellation fee',
      metadata: { reservationId: 'rsv_1', type: 'reservation_cancellation_fee' },
      idempotencyKey: 'cancellation-fee-rsv_1',
    });
    expect(updates[0]).toMatchObject({
      status: 'captured',
      stripePaymentIntentId: 'pi_fee',
      capturedAmountCents: 595,
    });
    expect(result).toEqual({
      status: 'charged',
      paymentRecordId: 7,
      grossCents: 595,
      netCents: 500,
      taxCents: 95,
      taxRate: 0.19,
      currency: 'USD',
    });
  });

  it('keeps the no-show idempotency key', async () => {
    await chargeReservationFee({
      ...baseInput,
      type: 'reservation_no_show',
      reservationId: 'rsv_9',
    });
    expect(mockChargeSavedCard).toHaveBeenCalledWith(
      stripeConfig,
      expect.objectContaining({
        description: 'Reservation no-show fee',
        idempotencyKey: 'no-show-fee-rsv_9',
        metadata: { reservationId: 'rsv_9', type: 'reservation_no_show_fee' },
      }),
    );
  });

  it('charges the net amount when no tariff resolves', async () => {
    mockResolveTariff.mockResolvedValueOnce(null);
    const result = await chargeReservationFee(baseInput);
    expect(result).toMatchObject({ status: 'charged', grossCents: 500, taxCents: 0, taxRate: 0 });
  });

  it('charges nothing a second time for the same reservation and fee type', async () => {
    insertedRows = [];
    existingRows = [{ id: 7 }];
    await expect(chargeReservationFee(baseInput)).resolves.toEqual({
      status: 'duplicate',
      paymentRecordId: 7,
    });
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  it('marks the record failed when Stripe declines', async () => {
    mockChargeSavedCard.mockRejectedValueOnce(new Error('Your card was declined.'));
    await expect(chargeReservationFee(baseInput)).resolves.toEqual({
      status: 'failed',
      paymentRecordId: 7,
      reason: 'Your card was declined.',
    });
    expect(updates[0]).toMatchObject({
      status: 'failed',
      failureReason: 'Your card was declined.',
    });
  });

  it('charges a simulated customer without Stripe', async () => {
    pmRows = [{ stripeCustomerId: 'cus_sim_1', stripePaymentMethodId: 'pm_sim_1' }];
    const result = await chargeReservationFee(baseInput);
    expect(mockGetStripeConfig).not.toHaveBeenCalled();
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
    expect(insertedValues[0]).toMatchObject({ currency: 'EUR', sitePaymentConfigId: null });
    expect(String(updates[0]?.['stripePaymentIntentId'])).toMatch(/^pi_sim_/);
    expect(result).toMatchObject({ status: 'charged', grossCents: 595, currency: 'EUR' });
  });

  it('fails a simulated customer like simulated session payments', async () => {
    pmRows = [{ stripeCustomerId: 'cus_sim_1', stripePaymentMethodId: 'pm_sim_1' }];
    mockSimulatedFailure.mockReturnValueOnce(true);
    await expect(chargeReservationFee(baseInput)).resolves.toMatchObject({
      status: 'failed',
      reason: 'Simulated payment failure',
    });
  });
});
