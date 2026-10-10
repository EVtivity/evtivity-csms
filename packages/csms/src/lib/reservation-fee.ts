// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { formatCents, formatTaxPercent } from '@/lib/formatting';

/**
 * The cancellation fee of an open reservation from GET /v1/reservations/:id:
 * the amount charged, tax included, priced by the server's pricing engine on
 * the terms snapshotted when the reservation was made.
 */
export interface ReservationCancellationFee {
  grossCents: number;
  /** Tax rate included in grossCents, as a fraction. */
  taxRate: number;
}

/** The gross fee the driver is charged, with the tax it includes ("€3.57 incl. 19% tax"). */
export function reservationFeeLabel(
  t: TFunction,
  fee: ReservationCancellationFee,
  currency: string,
): string {
  const amount = formatCents(fee.grossCents, currency);
  return fee.taxRate > 0
    ? t('reservations.feeInclTax', { amount, rate: formatTaxPercent(fee.taxRate) })
    : amount;
}
