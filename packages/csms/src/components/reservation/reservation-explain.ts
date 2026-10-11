// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { RESERVATION_REJECT_REASONS } from '@evtivity/lib/ai-insights';

/**
 * Cancel reasons that come from the station: it refused or never answered the
 * hold, could not take it at activation, or went offline or faulted during it.
 */
const STATION_CANCEL_REASONS: ReadonlySet<string> = new Set([
  ...RESERVATION_REJECT_REASONS,
  'station_unavailable_during_hold',
]);

/**
 * Whether the reservation page offers Explain (plan 2026-10-11 section 4.4):
 * a cancel with a station reason, an expiry, or a failed fee (a failed fee
 * payment record, or a fee failure insight when the user cannot read payments).
 */
export function reservationExplainable(
  reservation: { status: string; cancelReason: string | null },
  feePayments: readonly { status: string }[],
  insights: readonly { kind: string }[],
): boolean {
  if (reservation.status === 'expired') return true;
  if (
    reservation.status === 'cancelled' &&
    reservation.cancelReason != null &&
    STATION_CANCEL_REASONS.has(reservation.cancelReason)
  ) {
    return true;
  }
  return (
    feePayments.some((p) => p.status === 'failed') ||
    insights.some((i) => i.kind === 'reservation_fee_failed')
  );
}
