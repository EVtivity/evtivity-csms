// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  executeMock,
  updateMock,
  getReservationSettingsMock,
  writeReservationAuditMock,
  chargeCancellationFeeMock,
  alertStationWatchersMock,
} = vi.hoisted(() => ({
  alertStationWatchersMock: vi.fn(async (..._args: unknown[]) => false),
  executeMock: vi.fn(),
  updateMock: vi.fn(),
  getReservationSettingsMock: vi.fn(),
  writeReservationAuditMock: vi.fn(async () => undefined),
  chargeCancellationFeeMock: vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      status: 'charged',
      paymentRecordId: 1,
      grossCents: 595,
      netCents: 500,
      taxCents: 95,
      taxRate: 0.19,
      currency: 'USD',
    }),
  ),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    execute: executeMock,
    update: updateMock,
  },
  reservations: { id: 'id' },
  getReservationSettings: getReservationSettingsMock,
  writeReservationAudit: writeReservationAuditMock,
  alertStationWatchersIfAvailable: alertStationWatchersMock,
  client: { tag: 'client' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: vi.fn() },
  ),
}));

vi.mock('@evtivity/payments', () => ({
  chargeReservationFee: chargeCancellationFeeMock,
}));

import { applyReservationCancellation } from '../reservation-cancel.js';
import type { ReservationCancelInput } from '../reservation-cancel.js';
import type { PaymentContext } from '@evtivity/payments';

// The calling process's payment context (the API passes its own registry).
const payments = { registry: 'registry', logger: { warn: vi.fn() } } as unknown as PaymentContext;

function makeUpdateChain(): { set: ReturnType<typeof vi.fn>; where: ReturnType<typeof vi.fn> } {
  const where = vi.fn(() => Promise.resolve(undefined));
  const set = vi.fn(() => ({ where }));
  return { set, where };
}

function baseInput(overrides: Record<string, unknown> = {}): ReservationCancelInput {
  return {
    reservationDbId: 'rsv_1',
    siteId: 'sit_1',
    driverId: 'drv_1',
    startsAt: new Date(Date.now() + 60 * 60_000), // 1h out
    createdAt: new Date(),
    actor: 'driver',
    reason: 'driver_initiated',
    chargeFee: true,
    payments,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockImplementation(() => makeUpdateChain());
  getReservationSettingsMock.mockResolvedValue({
    cancellationFeeCents: 500,
    cancellationWindowMinutes: 30,
  });
});

describe('applyReservationCancellation', () => {
  it('returns cancelled=false when the conditional UPDATE matches no row (already terminal / lost race)', async () => {
    executeMock.mockResolvedValueOnce([]); // no winning row
    const result = await applyReservationCancellation(baseInput());
    expect(result).toEqual({
      feeChargedCents: 0,
      cancelled: false,
      feeChargeFailed: false,
      feeCurrency: null,
    });
    expect(writeReservationAuditMock).not.toHaveBeenCalled();
    expect(chargeCancellationFeeMock).not.toHaveBeenCalled();
  });

  it('writes the audit row with the previous status on a winning cancel', async () => {
    executeMock.mockResolvedValueOnce([{ id: 'rsv_1', status_before: 'active' }]);
    // Outside the window -> no fee.
    const result = await applyReservationCancellation(
      baseInput({ startsAt: new Date(Date.now() + 60 * 60_000), note: 'changed plans' }),
    );

    expect(result).toEqual({
      feeChargedCents: 0,
      cancelled: true,
      feeChargeFailed: false,
      feeCurrency: null,
    });
    expect(writeReservationAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'rsv_1',
        action: 'cancelled',
        actor: 'driver',
        statusBefore: 'active',
        statusAfter: 'cancelled',
        notes: 'changed plans',
      }),
    );
  });

  // A cancelled reservation can free the station with no connector change, so
  // the cancel checks the station watches with the shared availability rule.
  it('checks the station watches after a winning cancel', async () => {
    executeMock.mockResolvedValueOnce([
      { id: 'rsv_1', status_before: 'active', station_id: 'sta_1' },
    ]);
    await applyReservationCancellation(baseInput({ chargeFee: false, payments: undefined }));
    expect(alertStationWatchersMock).toHaveBeenCalledWith(
      { tag: 'client' },
      expect.objectContaining({ publish: expect.any(Function) }),
      'sta_1',
    );
  });

  it('still cancels when the station watch check fails', async () => {
    executeMock.mockResolvedValueOnce([
      { id: 'rsv_1', status_before: 'active', station_id: 'sta_1' },
    ]);
    alertStationWatchersMock.mockRejectedValueOnce(new Error('db down'));
    const result = await applyReservationCancellation(
      baseInput({ chargeFee: false, payments: undefined }),
    );
    expect(result.cancelled).toBe(true);
  });

  it('does not check the station watches when the cancel lost the race', async () => {
    executeMock.mockResolvedValueOnce([]);
    await applyReservationCancellation(baseInput());
    expect(alertStationWatchersMock).not.toHaveBeenCalled();
  });

  it('does not charge a fee for the system actor even when chargeFee=true and inside the window', async () => {
    executeMock.mockResolvedValueOnce([{ id: 'rsv_1', status_before: 'scheduled' }]);
    const result = await applyReservationCancellation(
      baseInput({
        actor: 'system',
        startsAt: new Date(Date.now() + 5 * 60_000), // inside the 30m window
      }),
    );
    expect(result.feeChargedCents).toBe(0);
    expect(chargeCancellationFeeMock).not.toHaveBeenCalled();
  });

  it('does not charge a fee when the cancel is outside the cancellation window', async () => {
    executeMock.mockResolvedValueOnce([{ id: 'rsv_1', status_before: 'active' }]);
    const result = await applyReservationCancellation(
      baseInput({ startsAt: new Date(Date.now() + 120 * 60_000) }), // 2h out, window is 30m
    );
    expect(result.feeChargedCents).toBe(0);
    expect(chargeCancellationFeeMock).not.toHaveBeenCalled();
  });

  it('does not charge a fee when cancellationFeeCents is 0', async () => {
    getReservationSettingsMock.mockResolvedValue({
      cancellationFeeCents: 0,
      cancellationWindowMinutes: 30,
    });
    executeMock.mockResolvedValueOnce([{ id: 'rsv_1', status_before: 'active' }]);
    const result = await applyReservationCancellation(
      baseInput({ startsAt: new Date(Date.now() + 5 * 60_000) }),
    );
    expect(result.feeChargedCents).toBe(0);
    expect(chargeCancellationFeeMock).not.toHaveBeenCalled();
  });

  it('does not charge a fee when the driverId is null', async () => {
    executeMock.mockResolvedValueOnce([{ id: 'rsv_1', status_before: 'active' }]);
    const result = await applyReservationCancellation(
      baseInput({ driverId: null, startsAt: new Date(Date.now() + 5 * 60_000) }),
    );
    expect(result.feeChargedCents).toBe(0);
    expect(chargeCancellationFeeMock).not.toHaveBeenCalled();
  });

  it('charges the fee inside the window and persists the actual amount', async () => {
    executeMock.mockResolvedValueOnce([
      { id: 'rsv_1', status_before: 'active', station_id: 'sta_1' },
    ]);
    chargeCancellationFeeMock.mockResolvedValueOnce({
      status: 'charged',
      paymentRecordId: 1,
      grossCents: 595,
      netCents: 500,
      taxCents: 95,
      taxRate: 0.19,
      currency: 'EUR',
    });
    const updateChain = makeUpdateChain();
    updateMock.mockReturnValue(updateChain);

    const result = await applyReservationCancellation(
      baseInput({ startsAt: new Date(Date.now() + 5 * 60_000) }),
    );

    // The fee setting (500) is net; the charge adds the station tariff's tax.
    // The charge runs with the caller's payment context.
    expect(chargeCancellationFeeMock).toHaveBeenCalledWith(
      {
        type: 'reservation_cancellation',
        reservationId: 'rsv_1',
        driverId: 'drv_1',
        stationId: 'sta_1',
        siteId: 'sit_1',
        netCents: 500,
      },
      payments,
    );
    expect(result).toEqual({
      feeChargedCents: 595,
      cancelled: true,
      feeChargeFailed: false,
      feeCurrency: 'EUR',
    });
    // The follow-up UPDATE writes the amount charged, tax included.
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ cancellationFeeCents: 595 }),
    );
  });

  it('reports no fee when the charge is skipped for lack of a payment method', async () => {
    executeMock.mockResolvedValueOnce([{ id: 'rsv_1', status_before: 'active' }]);
    chargeCancellationFeeMock.mockResolvedValueOnce({
      status: 'skipped',
      reason: 'no_payment_method',
    });
    const updateChain = makeUpdateChain();
    updateMock.mockReturnValue(updateChain);

    const result = await applyReservationCancellation(
      baseInput({ startsAt: new Date(Date.now() + 5 * 60_000) }),
    );

    expect(result).toEqual({
      feeChargedCents: 0,
      cancelled: true,
      feeChargeFailed: false,
      feeCurrency: null,
    });
    expect(updateChain.set).not.toHaveBeenCalled();
  });

  it('surfaces feeChargeFailed=true and logs when the fee charge throws', async () => {
    executeMock.mockResolvedValueOnce([{ id: 'rsv_1', status_before: 'active' }]);
    chargeCancellationFeeMock.mockRejectedValueOnce(new Error('card declined'));
    const errorLog = vi.fn();

    const result = await applyReservationCancellation(
      baseInput({
        startsAt: new Date(Date.now() + 5 * 60_000),
        logger: { error: errorLog },
      }),
    );

    expect(result).toEqual({
      feeChargedCents: 0,
      cancelled: true,
      feeChargeFailed: true,
      feeCurrency: null,
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'rsv_1', plannedFeeCents: 500 }),
      'cancellation fee charge failed',
    );
  });

  it('surfaces feeChargeFailed=true when the card is declined', async () => {
    executeMock.mockResolvedValueOnce([
      { id: 'rsv_1', status_before: 'active', station_id: 'sta_1' },
    ]);
    chargeCancellationFeeMock.mockResolvedValueOnce({
      status: 'failed',
      paymentRecordId: 4,
      reason: 'Your card was declined.',
    });
    const warnLog = vi.fn();
    const logger = { warn: warnLog };

    const result = await applyReservationCancellation(
      baseInput({
        startsAt: new Date(Date.now() + 5 * 60_000),
        logger: logger,
      }),
    );

    expect(chargeCancellationFeeMock).toHaveBeenCalledWith(expect.anything(), payments);

    expect(result).toEqual({
      feeChargedCents: 0,
      cancelled: true,
      feeChargeFailed: true,
      feeCurrency: null,
    });
    expect(warnLog).toHaveBeenCalledWith(
      { reservationId: 'rsv_1', paymentRecordId: 4 },
      'cancellation fee charge failed: Your card was declined.',
    );
  });

  it('passes null notes when the note is empty', async () => {
    executeMock.mockResolvedValueOnce([{ id: 'rsv_1', status_before: 'scheduled' }]);
    await applyReservationCancellation(
      baseInput({ note: '', startsAt: new Date(Date.now() + 120 * 60_000) }),
    );
    expect(writeReservationAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ notes: null }),
    );
  });
});
