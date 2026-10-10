// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  resolveStationTariff: vi.fn(),
  getCompanyTaxBasis: vi.fn(),
  getReservationSettings: vi.fn(),
  // The free vend lookup (a client tagged-template query).
  client: vi.fn(),
}));

vi.mock('../config.js', () => ({ client: m.client }));
vi.mock('../lib/tariff-resolution.js', () => ({ resolveStationTariff: m.resolveStationTariff }));
vi.mock('../lib/system-settings.js', () => ({ getCompanyTaxBasis: m.getCompanyTaxBasis }));
vi.mock('../lib/reservation-setting.js', () => ({
  getReservationSettings: m.getReservationSettings,
}));

import {
  resolveReservationFeeTerms,
  snapshotReservationFeeTerms,
} from '../lib/reservation-fee-terms.js';

beforeEach(() => {
  vi.clearAllMocks();
  m.resolveStationTariff.mockResolvedValue({ taxRate: '0.19', reservationFeePerMinute: '0.10' });
  m.getCompanyTaxBasis.mockResolvedValue('gross');
  m.getReservationSettings.mockResolvedValue({
    cancellationFeeCents: 300,
    cancellationWindowMinutes: 30,
  });
  m.client.mockResolvedValue([{ free_vend_enabled: false }]);
});

describe('snapshotReservationFeeTerms', () => {
  it('stores no holding fee and no cancellation fee at a free vend site', async () => {
    m.client.mockResolvedValue([{ free_vend_enabled: true }]);

    await expect(
      snapshotReservationFeeTerms({ stationUuid: 'sta_1', driverUuid: 'drv_1' }),
    ).resolves.toEqual({
      feeTaxBasis: 'gross',
      feeTaxRate: '0.19',
      feePerMinute: null,
      feeCancellationCents: 0,
    });
  });

  it('fails open to no snapshot when the free vend lookup fails', async () => {
    m.client.mockRejectedValue(new Error('db down'));

    await expect(
      snapshotReservationFeeTerms({ stationUuid: 'sta_1', driverUuid: 'drv_1' }),
    ).resolves.toEqual({
      feeTaxBasis: null,
      feeTaxRate: null,
      feePerMinute: null,
      feeCancellationCents: null,
    });
  });

  it('stores the tariff tax rate and holding fee, the cancellation fee, and the tax basis', async () => {
    await expect(
      snapshotReservationFeeTerms({ stationUuid: 'sta_1', driverUuid: 'drv_1' }),
    ).resolves.toEqual({
      feeTaxBasis: 'gross',
      feeTaxRate: '0.19',
      feePerMinute: '0.10',
      feeCancellationCents: 300,
    });
    expect(m.resolveStationTariff).toHaveBeenCalledWith(
      { stationUuid: 'sta_1', driverUuid: 'drv_1' },
      m.client,
    );
  });

  it('stores null tariff terms when no tariff resolves', async () => {
    m.resolveStationTariff.mockResolvedValue(null);

    await expect(
      snapshotReservationFeeTerms({ stationUuid: 'sta_1', driverUuid: null }),
    ).resolves.toEqual({
      feeTaxBasis: 'gross',
      feeTaxRate: null,
      feePerMinute: null,
      feeCancellationCents: 300,
    });
  });

  it('fails open to no snapshot when the lookup fails', async () => {
    m.resolveStationTariff.mockRejectedValue(new Error('db down'));

    await expect(
      snapshotReservationFeeTerms({ stationUuid: 'sta_1', driverUuid: 'drv_1' }),
    ).resolves.toEqual({
      feeTaxBasis: null,
      feeTaxRate: null,
      feePerMinute: null,
      feeCancellationCents: null,
    });
  });
});

describe('resolveReservationFeeTerms', () => {
  it('TC-T3-24 keeps the snapshot at creation after a tariff and setting edit', async () => {
    const snapshot = await snapshotReservationFeeTerms({
      stationUuid: 'sta_1',
      driverUuid: 'drv_1',
    });
    // The operator edits the tariff, the fee setting, and the tax basis.
    m.resolveStationTariff.mockResolvedValue({ taxRate: '0.07', reservationFeePerMinute: '0.50' });
    m.getCompanyTaxBasis.mockResolvedValue('net');
    m.getReservationSettings.mockResolvedValue({
      cancellationFeeCents: 900,
      cancellationWindowMinutes: 30,
    });
    m.resolveStationTariff.mockClear();

    await expect(
      resolveReservationFeeTerms({ stationId: 'sta_1', driverId: 'drv_1', ...snapshot }),
    ).resolves.toEqual({
      basis: 'gross',
      taxRate: '0.19',
      feePerMinute: '0.10',
      cancellationFeeCents: 300,
    });
    expect(m.resolveStationTariff).not.toHaveBeenCalled();
  });

  it('falls back to the current terms for a reservation created before the snapshot', async () => {
    await expect(
      resolveReservationFeeTerms({
        stationId: 'sta_1',
        driverId: 'drv_1',
        feeTaxBasis: null,
        feeTaxRate: null,
        feePerMinute: null,
        feeCancellationCents: null,
      }),
    ).resolves.toEqual({
      basis: 'gross',
      taxRate: '0.19',
      feePerMinute: '0.10',
      cancellationFeeCents: 300,
    });
    expect(m.resolveStationTariff).toHaveBeenCalledWith(
      { stationUuid: 'sta_1', driverUuid: 'drv_1' },
      m.client,
    );
  });

  it('treats a missing cancellation fee in a snapshot as no fee', async () => {
    await expect(
      resolveReservationFeeTerms({
        stationId: 'sta_1',
        driverId: null,
        feeTaxBasis: 'net',
        feeTaxRate: null,
        feePerMinute: null,
        feeCancellationCents: null,
      }),
    ).resolves.toEqual({
      basis: 'net',
      taxRate: null,
      feePerMinute: null,
      cancellationFeeCents: 0,
    });
  });

  it('keeps the snapshot fees after the site switches to free vend', async () => {
    const snapshot = await snapshotReservationFeeTerms({
      stationUuid: 'sta_1',
      driverUuid: 'drv_1',
    });
    m.client.mockResolvedValue([{ free_vend_enabled: true }]);

    await expect(
      resolveReservationFeeTerms({ stationId: 'sta_1', driverId: 'drv_1', ...snapshot }),
    ).resolves.toEqual({
      basis: 'gross',
      taxRate: '0.19',
      feePerMinute: '0.10',
      cancellationFeeCents: 300,
    });
  });

  it('charges no fee for a reservation without a snapshot at a site that is free vend now', async () => {
    m.client.mockResolvedValue([{ free_vend_enabled: true }]);

    await expect(
      resolveReservationFeeTerms({
        stationId: 'sta_1',
        driverId: 'drv_1',
        feeTaxBasis: null,
        feeTaxRate: null,
        feePerMinute: null,
        feeCancellationCents: null,
      }),
    ).resolves.toEqual({
      basis: 'gross',
      taxRate: '0.19',
      feePerMinute: null,
      cancellationFeeCents: 0,
    });
  });

  it('propagates a free vend lookup error at the charge instead of charging', async () => {
    m.client.mockRejectedValue(new Error('db down'));

    await expect(
      resolveReservationFeeTerms({
        stationId: 'sta_1',
        driverId: 'drv_1',
        feeTaxBasis: null,
        feeTaxRate: null,
        feePerMinute: null,
        feeCancellationCents: null,
      }),
    ).rejects.toThrow('db down');
  });
});
