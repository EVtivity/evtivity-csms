// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFeeTerms = vi.fn();
vi.mock('@evtivity/database', () => ({
  resolveReservationFeeTerms: (...args: unknown[]) => mockFeeTerms(...args),
}));

import { reservationFeesView } from '../lib/reservation-fee-view.js';

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

function row(snapshot: {
  feeTaxBasis: string | null;
  feeTaxRate: string | null;
  feePerMinute: string | null;
  feeCancellationCents: number | null;
}): Parameters<typeof reservationFeesView>[0] {
  return {
    status: 'active',
    stationId: 'sta_1',
    driverId: 'drv_1',
    startsAt: '2026-10-10T10:00:00.000Z',
    createdAt: '2026-10-10T09:50:00.000Z',
    expiresAt: '2026-10-10T10:30:00.000Z',
    ...snapshot,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reservationFeesView', () => {
  it('shows no cancellation fee and no no-show fee for a free vend site reservation', async () => {
    // The terms of a reservation made at a free vend site.
    mockFeeTerms.mockResolvedValue({
      basis: 'gross',
      taxRate: '0.19',
      feePerMinute: null,
      cancellationFeeCents: 0,
    });

    await expect(
      reservationFeesView(
        row({
          feeTaxBasis: 'gross',
          feeTaxRate: '0.19',
          feePerMinute: null,
          feeCancellationCents: 0,
        }),
        log,
      ),
    ).resolves.toEqual({ cancellationFee: null, noShowFee: null });
  });

  it('shows both fees, tax included, for a reservation with fee terms', async () => {
    mockFeeTerms.mockResolvedValue({
      basis: 'gross',
      taxRate: '0.19',
      feePerMinute: '0.10',
      cancellationFeeCents: 300,
    });

    const view = await reservationFeesView(
      row({
        feeTaxBasis: 'gross',
        feeTaxRate: '0.19',
        feePerMinute: '0.10',
        feeCancellationCents: 300,
      }),
      log,
    );

    expect(view.cancellationFee).toEqual({ grossCents: 300, taxRate: 0.19 });
    // 30 minutes from the start to the expiry at 0.10 gross per minute.
    expect(view.noShowFee).toEqual({ grossCents: 300, taxRate: 0.19 });
  });
});
