// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => {
  const methodRows: { value: unknown[] } = { value: [] };
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where']) chain[method] = () => chain;
  chain['limit'] = () => Promise.resolve(methodRows.value);
  return {
    methodRows,
    db: { select: vi.fn(() => chain) },
    getCompanyCurrency: vi.fn(),
    getPlatformFeePercent: vi.fn(),
    resolveStationTariff: vi.fn(),
    getSitePaymentConfig: vi.fn(),
    recordPendingCharge: vi.fn(),
    findReservationCharge: vi.fn(),
    markChargeCaptured: vi.fn(),
    markChargeFailed: vi.fn(),
    sitePayoutReadiness: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: m.db,
  client: { __client: true },
  driverPaymentMethods: { __table: 'driver_payment_methods' },
  getCompanyCurrency: m.getCompanyCurrency,
  getPlatformFeePercent: m.getPlatformFeePercent,
  resolveStationTariff: m.resolveStationTariff,
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));

vi.mock('../settings.js', () => ({ getSitePaymentConfig: m.getSitePaymentConfig }));
vi.mock('../payout-accounts.js', () => ({
  PAYOUT_NOT_READY_FAILURE: 'Payout account not ready',
  sitePayoutReadiness: m.sitePayoutReadiness,
}));

vi.mock('../payment-records.js', () => ({
  recordPendingCharge: m.recordPendingCharge,
  findReservationCharge: m.findReservationCharge,
  markChargeCaptured: m.markChargeCaptured,
  markChargeFailed: m.markChargeFailed,
}));

import { chargeReservationFee } from '../reservation-fees.js';
import type { ReservationFeeInput } from '../reservation-fees.js';
import { PaymentProviderNotConfiguredError } from '../errors.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';

const provider = { id: 'stripe', chargeSavedMethod: vi.fn() };
const registry = { getPaymentProvider: vi.fn() };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: PaymentContext = {
  registry: registry as unknown as PaymentProviderRegistry,
  logger,
};

const baseInput: ReservationFeeInput = {
  type: 'reservation_cancellation',
  reservationId: 'rsv_1',
  driverId: 'drv_1',
  stationId: 'sta_1',
  siteId: 'site_1',
  netCents: 500,
};

beforeEach(() => {
  m.methodRows.value = [{ provider: 'stripe', customerId: 'cus_1', methodId: 'pm_1' }];
  m.getCompanyCurrency.mockResolvedValue('USD');
  m.getPlatformFeePercent.mockResolvedValue(10);
  m.resolveStationTariff.mockResolvedValue({ taxRate: '0.19' });
  m.getSitePaymentConfig.mockResolvedValue({
    configId: 3,
    payoutAccountId: 'acct_site',
    preAuthAmountCents: 5000,
  });
  m.sitePayoutReadiness.mockResolvedValue('ready');
  m.recordPendingCharge.mockResolvedValue(7);
  m.findReservationCharge.mockResolvedValue(7);
  m.markChargeCaptured.mockResolvedValue(true);
  m.markChargeFailed.mockResolvedValue(true);
  provider.chargeSavedMethod.mockResolvedValue({
    paymentId: 'pi_fee',
    amountCents: 595,
    applicationFeeCents: 50,
  });
  registry.getPaymentProvider.mockResolvedValue(provider);
});

describe('chargeReservationFee', () => {
  it('records a failed fee without charging when the payout account is not ready', async () => {
    m.sitePayoutReadiness.mockResolvedValue('not_ready');

    await expect(chargeReservationFee(baseInput, ctx)).resolves.toEqual({
      status: 'failed',
      paymentRecordId: 7,
      reason: 'Payout account not ready',
    });
    expect(m.sitePayoutReadiness).toHaveBeenCalledWith('site_1', ctx);
    expect(m.markChargeFailed).toHaveBeenCalledWith(7, 'Payout account not ready');
    expect(provider.chargeSavedMethod).not.toHaveBeenCalled();
  });

  it('charges the platform without checking readiness when the site has no payout account', async () => {
    m.getSitePaymentConfig.mockResolvedValue({
      configId: 3,
      payoutAccountId: null,
      preAuthAmountCents: 5000,
    });

    await expect(chargeReservationFee(baseInput, ctx)).resolves.toMatchObject({
      status: 'charged',
    });
    expect(m.sitePayoutReadiness).not.toHaveBeenCalled();
    expect(provider.chargeSavedMethod).toHaveBeenCalledWith(
      expect.objectContaining({ payoutAccountId: null }),
    );
  });

  it('skips without an amount', async () => {
    await expect(chargeReservationFee({ ...baseInput, netCents: 0 }, ctx)).resolves.toEqual({
      status: 'skipped',
      reason: 'no_amount',
    });
    expect(m.db.select).not.toHaveBeenCalled();
    expect(m.recordPendingCharge).not.toHaveBeenCalled();
  });

  it('skips when the driver has no default payment method', async () => {
    m.methodRows.value = [];

    await expect(chargeReservationFee(baseInput, ctx)).resolves.toEqual({
      status: 'skipped',
      reason: 'no_payment_method',
    });
    expect(registry.getPaymentProvider).not.toHaveBeenCalled();
    expect(m.recordPendingCharge).not.toHaveBeenCalled();
  });

  it('skips when the provider of the saved card is not configured', async () => {
    registry.getPaymentProvider.mockRejectedValue(new PaymentProviderNotConfiguredError('stripe'));

    await expect(chargeReservationFee(baseInput, ctx)).resolves.toEqual({
      status: 'skipped',
      reason: 'payments_not_configured',
    });
    expect(m.recordPendingCharge).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected provider lookup error', async () => {
    registry.getPaymentProvider.mockRejectedValue(new Error('settings unreadable'));

    await expect(chargeReservationFee(baseInput, ctx)).rejects.toThrow('settings unreadable');
  });

  it('taxes the net fee at the station tariff rate and records it before charging', async () => {
    const result = await chargeReservationFee(baseInput, ctx);

    expect(registry.getPaymentProvider).toHaveBeenCalledWith('stripe');
    expect(m.resolveStationTariff).toHaveBeenCalledWith(
      { stationUuid: 'sta_1', driverUuid: 'drv_1' },
      { __client: true },
    );
    expect(m.getSitePaymentConfig).toHaveBeenCalledWith('site_1');
    expect(m.recordPendingCharge).toHaveBeenCalledWith({
      chargeType: 'reservation_cancellation',
      reservationId: 'rsv_1',
      driverId: 'drv_1',
      sitePaymentConfigId: 3,
      provider: 'stripe',
      customerId: 'cus_1',
      methodId: 'pm_1',
      currency: 'USD',
      taxRate: 0.19,
    });
    expect(m.recordPendingCharge.mock.invocationCallOrder[0]).toBeLessThan(
      provider.chargeSavedMethod.mock.invocationCallOrder[0] ?? 0,
    );
    expect(m.getPlatformFeePercent).toHaveBeenCalledWith('site_1');
    expect(provider.chargeSavedMethod).toHaveBeenCalledWith({
      customerId: 'cus_1',
      methodId: 'pm_1',
      grossCents: 595,
      currency: 'USD',
      feeTaxRate: 0.19,
      platformFeePercent: 10,
      payoutAccountId: 'acct_site',
      description: 'Reservation cancellation fee',
      metadata: { reservationId: 'rsv_1', type: 'reservation_cancellation_fee' },
      idempotencyKey: 'cancellation-fee-rsv_1',
    });
    expect(m.markChargeCaptured).toHaveBeenCalledWith(7, {
      provider: 'stripe',
      paymentId: 'pi_fee',
      amountCents: 595,
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
    await chargeReservationFee(
      { ...baseInput, type: 'reservation_no_show', reservationId: 'rsv_9' },
      ctx,
    );

    expect(provider.chargeSavedMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Reservation no-show fee',
        idempotencyKey: 'no-show-fee-rsv_9',
        metadata: { reservationId: 'rsv_9', type: 'reservation_no_show_fee' },
      }),
    );
  });

  it('charges the net amount when no tariff resolves', async () => {
    m.resolveStationTariff.mockResolvedValue(null);

    const result = await chargeReservationFee(baseInput, ctx);

    expect(result).toMatchObject({ status: 'charged', grossCents: 500, taxCents: 0, taxRate: 0 });
  });

  it('charges without a site config or payout account for a reservation without a site', async () => {
    await chargeReservationFee({ ...baseInput, siteId: null }, ctx);

    expect(m.getSitePaymentConfig).not.toHaveBeenCalled();
    expect(m.recordPendingCharge).toHaveBeenCalledWith(
      expect.objectContaining({ sitePaymentConfigId: null }),
    );
    expect(provider.chargeSavedMethod).toHaveBeenCalledWith(
      expect.objectContaining({ payoutAccountId: null }),
    );
    expect(m.getPlatformFeePercent).toHaveBeenCalledWith(null);
  });

  it('charges nothing a second time for the same reservation and fee type', async () => {
    m.recordPendingCharge.mockResolvedValue(null);

    await expect(chargeReservationFee(baseInput, ctx)).resolves.toEqual({
      status: 'duplicate',
      paymentRecordId: 7,
    });
    expect(m.findReservationCharge).toHaveBeenCalledWith('rsv_1', 'reservation_cancellation');
    expect(provider.chargeSavedMethod).not.toHaveBeenCalled();
  });

  it('reports record 0 on a duplicate whose record cannot be found', async () => {
    m.recordPendingCharge.mockResolvedValue(null);
    m.findReservationCharge.mockResolvedValue(null);

    await expect(chargeReservationFee(baseInput, ctx)).resolves.toEqual({
      status: 'duplicate',
      paymentRecordId: 0,
    });
  });

  it('marks the record failed when the charge is declined', async () => {
    provider.chargeSavedMethod.mockRejectedValue(new Error('Your card was declined.'));

    await expect(chargeReservationFee(baseInput, ctx)).resolves.toEqual({
      status: 'failed',
      paymentRecordId: 7,
      reason: 'Your card was declined.',
    });
    expect(m.markChargeFailed).toHaveBeenCalledWith(7, 'Your card was declined.');
    expect(m.markChargeCaptured).not.toHaveBeenCalled();
  });

  it('uses a fallback reason for a non-Error decline', async () => {
    provider.chargeSavedMethod.mockRejectedValue('weird');

    await expect(chargeReservationFee(baseInput, ctx)).resolves.toMatchObject({
      status: 'failed',
      reason: 'Unknown payment error',
    });
  });

  it('charges a simulated card through the simulated provider', async () => {
    m.methodRows.value = [{ provider: 'simulated', customerId: 'cus_sim_1', methodId: 'pm_sim_1' }];

    const result = await chargeReservationFee(baseInput, ctx);

    expect(registry.getPaymentProvider).toHaveBeenCalledWith('simulated');
    expect(result).toMatchObject({ status: 'charged', grossCents: 595 });
  });

  it('skips a default method without a provider or provider ids', async () => {
    m.methodRows.value = [{ provider: null, customerId: 'cus_1', methodId: 'pm_1' }];
    await expect(chargeReservationFee(baseInput, ctx)).resolves.toEqual({
      status: 'skipped',
      reason: 'payments_not_configured',
    });
    m.methodRows.value = [{ provider: 'stripe', customerId: null, methodId: 'pm_1' }];
    await expect(chargeReservationFee(baseInput, ctx)).resolves.toEqual({
      status: 'skipped',
      reason: 'no_payment_method',
    });
    expect(m.recordPendingCharge).not.toHaveBeenCalled();
  });

  it('logs when the charged record had already moved on', async () => {
    m.markChargeCaptured.mockResolvedValue(false);

    const result = await chargeReservationFee(baseInput, ctx);

    expect(result).toMatchObject({ status: 'charged', paymentRecordId: 7 });
    expect(logger.error).toHaveBeenCalledWith(
      { paymentRecordId: 7, paymentId: 'pi_fee' },
      'Reservation fee charged but its record had moved on; manual reconciliation required',
    );
  });
});
