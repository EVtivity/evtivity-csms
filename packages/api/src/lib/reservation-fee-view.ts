// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { resolveReservationFeeTerms } from '@evtivity/database';
import type { ReservationFeeSnapshot, ReservationFeeTerms } from '@evtivity/database';
import { priceFee, priceTimedFee, reservationHoldingMinutes } from '@evtivity/lib';
import type { ServiceLogger } from '@evtivity/lib';

/** Response schema of a reservation's cancellation fee (portal and operator APIs). */
export const reservationCancellationFeeSchema = z
  .object({
    grossCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Cancellation fee charged when the reservation is cancelled inside the cancellation window, in cents of the company currency, tax included',
      ),
    taxRate: z
      .number()
      .min(0)
      .describe('Tax rate included in grossCents, as a fraction (0.19 for 19 %)'),
  })
  .nullable()
  .describe(
    'The cancellation fee of an open (scheduled or active) reservation, on the terms snapshotted when it was made. Null when it is not open or has no fee. The cancellation window is in GET /v1/portal/features',
  );

/** Response schema of a reservation's no-show fee (portal API). */
export const reservationNoShowFeeSchema = z
  .object({
    grossCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'No-show fee charged when the reservation expires without a charging session, for the minutes it holds the connector, in cents of the company currency, tax included',
      ),
    taxRate: z
      .number()
      .min(0)
      .describe('Tax rate included in grossCents, as a fraction (0.19 for 19 %)'),
  })
  .nullable()
  .describe(
    'The no-show fee of an open (scheduled or active) reservation: the holding fee per minute of the terms snapshotted when it was made, times the minutes from its start (or creation) to its expiry. Null when it is not open or has no holding fee',
  );

export interface ReservationCancellationFeeView {
  grossCents: number;
  taxRate: number;
}

type FeeRow = ReservationFeeSnapshot & {
  status: string;
  stationId: string;
  driverId: string | null;
};

function isOpen(row: { status: string }): boolean {
  return row.status === 'active' || row.status === 'scheduled';
}

/** The cancellation fee on the terms, tax included; null without a fee. */
function cancellationFeeOf(terms: ReservationFeeTerms): ReservationCancellationFeeView | null {
  if (terms.cancellationFeeCents <= 0) return null;
  const fee = priceFee({
    amountCents: terms.cancellationFeeCents,
    taxRate: terms.taxRate,
    basis: terms.basis,
  });
  return { grossCents: fee.grossCents, taxRate: fee.taxRate };
}

/**
 * The no-show fee on the terms, tax included: the holding fee per minute
 * times the minutes the reservation holds the connector
 * (reservationHoldingMinutes, as the expiry job charges it). Null without a
 * holding fee.
 */
function noShowFeeOf(
  terms: ReservationFeeTerms,
  window: { startsAt: Date | string | null; createdAt: Date | string; expiresAt: Date | string },
): ReservationCancellationFeeView | null {
  if (terms.feePerMinute == null || !(Number(terms.feePerMinute) > 0)) return null;
  const fee = priceTimedFee({
    pricePerMinute: terms.feePerMinute,
    minutes: reservationHoldingMinutes(window),
    taxRate: terms.taxRate,
    basis: terms.basis,
  });
  return fee.grossCents > 0 ? { grossCents: fee.grossCents, taxRate: fee.taxRate } : null;
}

/**
 * The cancellation fee an open reservation is charged, tax included, priced
 * by the pricing engine on the reservation's fee terms (the snapshot at
 * creation, or the current terms for a reservation made before it). Null for
 * a closed reservation or one without a fee. Fail-open: a lookup error shows
 * no fee preview (logged); the cancel still charges it.
 */
export async function reservationCancellationFeeView(
  row: FeeRow,
  log: ServiceLogger,
): Promise<ReservationCancellationFeeView | null> {
  if (!isOpen(row)) return null;
  try {
    return cancellationFeeOf(await resolveReservationFeeTerms(row));
  } catch (err) {
    log.warn({ err, stationId: row.stationId }, 'Reservation cancellation fee preview failed');
    return null;
  }
}

/**
 * The cancellation and no-show fees of an open reservation, tax included,
 * from one lookup of its fee terms (see reservationCancellationFeeView). The
 * no-show fee is charged if the reservation expires without a session. Both
 * null for a closed reservation, and on a lookup error (fail-open, logged).
 */
export async function reservationFeesView(
  row: FeeRow & {
    startsAt: Date | string | null;
    createdAt: Date | string;
    expiresAt: Date | string;
  },
  log: ServiceLogger,
): Promise<{
  cancellationFee: ReservationCancellationFeeView | null;
  noShowFee: ReservationCancellationFeeView | null;
}> {
  if (!isOpen(row)) return { cancellationFee: null, noShowFee: null };
  try {
    const terms = await resolveReservationFeeTerms(row);
    return { cancellationFee: cancellationFeeOf(terms), noShowFee: noShowFeeOf(terms, row) };
  } catch (err) {
    log.warn({ err, stationId: row.stationId }, 'Reservation fee preview failed');
    return { cancellationFee: null, noShowFee: null };
  }
}
