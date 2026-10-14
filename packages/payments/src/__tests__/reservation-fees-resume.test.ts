// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => {
  // Each select resolves to the next queued result: first the stale records,
  // then one reservation row per resumed record.
  const queue: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'innerJoin', 'orderBy']) chain[method] = () => chain;
  chain['limit'] = () => Promise.resolve(queue.shift() ?? []);
  return {
    queue,
    db: { select: vi.fn(() => chain) },
    resolveReservationFeeTerms: vi.fn(),
    getPlatformFeePercent: vi.fn(),
    getSitePaymentConfig: vi.fn(),
    markChargeCaptured: vi.fn(),
    markChargeFailed: vi.fn(),
    sitePayoutReadiness: vi.fn(),
    writeReservationAudit: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => ({
  db: m.db,
  chargingStations: { id: 'cs.id', siteId: 'cs.site_id' },
  driverPaymentMethods: {},
  paymentRecords: {},
  reservations: {},
  getCompanyCurrency: vi.fn(),
  getPlatformFeePercent: m.getPlatformFeePercent,
  resolveReservationFeeTerms: m.resolveReservationFeeTerms,
  writeReservationAudit: m.writeReservationAudit,
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
  isNotNull: (a: unknown) => ({ isNotNull: a }),
  lt: (a: unknown, b: unknown) => ({ lt: [a, b] }),
}));

vi.mock('../settings.js', () => ({ getSitePaymentConfig: m.getSitePaymentConfig }));
vi.mock('../payout-accounts.js', () => ({
  PAYOUT_NOT_READY_FAILURE: 'Payout account not ready',
  sitePayoutReadiness: m.sitePayoutReadiness,
}));
vi.mock('../payment-records.js', () => ({
  recordPendingCharge: vi.fn(),
  findReservationCharge: vi.fn(),
  markChargeCaptured: m.markChargeCaptured,
  markChargeFailed: m.markChargeFailed,
  reservationFeeRequest: (metadata: { feeRequest?: unknown } | null) =>
    metadata?.feeRequest ?? null,
}));

import { resumeStaleReservationFees } from '../reservation-fees.js';
import type { PaymentContext } from '../context.js';
import type { PaymentProviderRegistry } from '../registry.js';

const provider = { id: 'stripe', chargeSavedMethod: vi.fn() };
const registry = { getPaymentProvider: vi.fn() };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx: PaymentContext = {
  registry: registry as unknown as PaymentProviderRegistry,
  logger,
};
const NOW = new Date('2026-10-11T12:00:00Z');

function staleRecord(hoursOld: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    chargeType: 'reservation_no_show',
    reservationId: 'rsv_9',
    driverId: 'drv_9',
    provider: 'stripe',
    customerId: 'cus_9',
    methodId: 'pm_9',
    currency: 'EUR',
    metadata: null,
    createdAt: new Date(NOW.getTime() - hoursOld * 3_600_000),
    ...overrides,
  };
}

const reservationRow = {
  stationId: 'sta_1',
  driverId: 'drv_9',
  siteId: 'sit_1',
  startsAt: null,
  createdAt: new Date('2026-10-11T08:00:00Z'),
  expiresAt: new Date('2026-10-11T08:30:00Z'),
  feeTaxBasis: 'net',
  feeTaxRate: '0',
  feePerMinute: '0.10',
  feeCancellationCents: 0,
};

beforeEach(() => {
  m.queue.length = 0;
  m.resolveReservationFeeTerms.mockResolvedValue({
    basis: 'net',
    taxRate: '0',
    feePerMinute: '0.10',
    cancellationFeeCents: 0,
  });
  m.getPlatformFeePercent.mockResolvedValue(0);
  m.getSitePaymentConfig.mockResolvedValue({ configId: 1, payoutAccountId: null });
  m.sitePayoutReadiness.mockResolvedValue('none');
  m.markChargeCaptured.mockResolvedValue(true);
  m.markChargeFailed.mockResolvedValue(true);
  registry.getPaymentProvider.mockResolvedValue(provider);
  provider.chargeSavedMethod.mockResolvedValue({ paymentId: 'pi_resumed' });
});

describe('TC-RES-15: resumeStaleReservationFees', () => {
  it('charges a stale pending fee again with the same key and the rebuilt amount', async () => {
    m.queue.push([staleRecord(2)], [reservationRow]);

    const result = await resumeStaleReservationFees(ctx, NOW);

    expect(result).toEqual({ resumed: 1, expired: 0, errors: [] });
    expect(provider.chargeSavedMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_9',
        methodId: 'pm_9',
        currency: 'EUR',
        // 30 minutes held at 0.10 per minute, no tax.
        grossCents: 300,
        idempotencyKey: 'no-show-fee-rsv_9',
      }),
    );
    expect(m.markChargeCaptured).toHaveBeenCalledWith(
      41,
      {
        provider: 'stripe',
        paymentId: 'pi_resumed',
        amountCents: 300,
      },
      ctx,
    );
    expect(m.writeReservationAudit).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'rsv_9', action: 'fee_charged' }),
      undefined,
      expect.anything(),
    );
  });

  it('sends the stored request again, not a repriced one (the key pins its parameters)', async () => {
    m.queue.push(
      [
        staleRecord(2, {
          metadata: {
            feeRequest: { grossCents: 450, platformFeePercent: 7, payoutAccountId: 'acct_then' },
          },
        }),
      ],
      [reservationRow],
    );
    // Terms and settings changed since the first attempt.
    m.getPlatformFeePercent.mockResolvedValue(20);
    m.getSitePaymentConfig.mockResolvedValue({ configId: 1, payoutAccountId: 'acct_now' });

    const result = await resumeStaleReservationFees(ctx, NOW);

    expect(result.resumed).toBe(1);
    expect(provider.chargeSavedMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        grossCents: 450,
        platformFeePercent: 7,
        payoutAccountId: 'acct_then',
        idempotencyKey: 'no-show-fee-rsv_9',
      }),
    );
    expect(m.markChargeCaptured).toHaveBeenCalledWith(
      41,
      expect.objectContaining({ amountCents: 450 }),
      ctx,
    );
  });

  it('marks a record past the key window failed with a reason naming the key', async () => {
    m.queue.push([staleRecord(30)]);

    const result = await resumeStaleReservationFees(ctx, NOW);

    expect(result).toEqual({ resumed: 0, expired: 1, errors: [] });
    expect(provider.chargeSavedMethod).not.toHaveBeenCalled();
    expect(m.markChargeFailed).toHaveBeenCalledWith(
      41,
      'No provider answer within 23 hours; check the provider for a payment with the key no-show-fee-rsv_9',
      ctx,
    );
    expect(m.writeReservationAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'fee_failed', reason: 'provider_error' }),
      undefined,
      expect.anything(),
    );
  });

  it('reports a record whose reservation is gone without charging', async () => {
    m.queue.push([staleRecord(2)], []);

    const result = await resumeStaleReservationFees(ctx, NOW);

    expect(result.errors).toEqual(['Reservation fee record 41: reservation rsv_9 not found']);
    expect(provider.chargeSavedMethod).not.toHaveBeenCalled();
  });

  it('records a declined resume as failed', async () => {
    m.queue.push(
      [staleRecord(2, { chargeType: 'reservation_cancellation' })],
      [{ ...reservationRow, feeCancellationCents: 500 }],
    );
    m.resolveReservationFeeTerms.mockResolvedValue({
      basis: 'net',
      taxRate: '0',
      feePerMinute: null,
      cancellationFeeCents: 500,
    });
    provider.chargeSavedMethod.mockRejectedValue(new Error('card declined'));

    const result = await resumeStaleReservationFees(ctx, NOW);

    expect(result.resumed).toBe(1);
    expect(provider.chargeSavedMethod).toHaveBeenCalledWith(
      expect.objectContaining({ grossCents: 500, idempotencyKey: 'cancellation-fee-rsv_9' }),
    );
    expect(m.markChargeFailed).toHaveBeenCalledWith(41, 'card declined', ctx);
  });

  it('keeps going after one record fails', async () => {
    m.queue.push([staleRecord(2, { id: 1 }), staleRecord(2, { id: 2 })], [reservationRow]);
    registry.getPaymentProvider
      .mockRejectedValueOnce(new Error('settings unreadable'))
      .mockResolvedValue(provider);
    m.queue.push([reservationRow]);

    const result = await resumeStaleReservationFees(ctx, NOW);

    expect(result.resumed).toBe(1);
    expect(result.errors).toEqual(['Reservation fee record 1 not resumed: settings unreadable']);
  });
});
