// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { priceTimedFee } from '@evtivity/lib/pricing-engine';
import type { TaxBasis } from '@evtivity/lib/price-display';
import { reservationHoldingMinutes } from '@evtivity/lib/reservation-holding';
import { formatCents, formatTaxPercent } from '@/lib/utils';

/**
 * A fee of an open reservation from the portal reservation API (cancellation
 * or no-show fee): the amount charged, tax included, priced by the server's
 * pricing engine on the terms snapshotted when the reservation was made.
 */
export interface ReservationFee {
  grossCents: number;
  /** Tax rate included in grossCents, as a fraction. */
  taxRate: number;
}

/**
 * Whether cancelling now charges the fee: the reservation has one and starts
 * (or, without a start, was created) less than the cancellation window from
 * now. Mirrors the server gate in applyReservationCancellation.
 */
export function cancellationFeeApplies(
  reservation: {
    startsAt: string | null;
    createdAt: string;
    cancellationFee?: ReservationFee | null;
  },
  windowMinutes: number,
  now = Date.now(),
): boolean {
  const fee = reservation.cancellationFee;
  if (fee == null || fee.grossCents <= 0 || windowMinutes <= 0) return false;
  const referenceTime = new Date(reservation.startsAt ?? reservation.createdAt).getTime();
  return Math.floor((referenceTime - now) / 60_000) < windowMinutes;
}

/** The gross fee the driver is charged, with the tax it includes ("3,57 € incl. 19% tax"). */
export function reservationFeeLabel(t: TFunction, fee: ReservationFee, currency: string): string {
  const amount = formatCents(fee.grossCents, currency);
  return fee.taxRate > 0
    ? t('reservations.feeInclTax', { amount, rate: formatTaxPercent(fee.taxRate) })
    : amount;
}

/** The cancel dialog warning, with the gross fee and its tax label. */
export function cancellationFeeWarning(
  t: TFunction,
  fee: ReservationFee,
  currency: string,
): string {
  return t('reservations.cancellationFeeWarning', {
    fee: reservationFeeLabel(t, fee, currency),
  });
}

/**
 * The no-show fee a reservation made now would be charged if it expires
 * unused, tax included: the station's holding fee per minute for the minutes
 * from the start (now for an instant reservation) to the expiry, priced by
 * the pricing engine as the server charges it. Null without a holding fee or
 * a valid window.
 */
export function noShowFeeEstimate(
  pricing: {
    reservationFeePerMinute?: string | null;
    taxRate: string | null;
    taxBasis?: TaxBasis;
  },
  window: { startsAt: Date | null; expiresAt: Date },
  now = new Date(),
): ReservationFee | null {
  const perMinute = pricing.reservationFeePerMinute;
  if (perMinute == null || !(Number(perMinute) > 0)) return null;
  const minutes = reservationHoldingMinutes({
    startsAt: window.startsAt,
    createdAt: now,
    expiresAt: window.expiresAt,
  });
  if (minutes <= 0) return null;
  const fee = priceTimedFee({
    pricePerMinute: perMinute,
    minutes,
    taxRate: pricing.taxRate,
    basis: pricing.taxBasis ?? 'net',
  });
  return fee.grossCents > 0 ? { grossCents: fee.grossCents, taxRate: fee.taxRate } : null;
}

/** The no-show fee note, with the gross fee and its tax label. */
export function noShowFeeNote(t: TFunction, fee: ReservationFee, currency: string): string {
  return t('reservations.noShowFeeAmount', { fee: reservationFeeLabel(t, fee, currency) });
}
