// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The minutes a reservation holds the connector, which the no-show fee is
 * charged for: from its start (an instant reservation without one: from its
 * creation) to its expiry, whole minutes rounded up, never below 0. The worker
 * charges the fee on it and the portal previews the fee with it.
 */
export function reservationHoldingMinutes(reservation: {
  startsAt: Date | string | null;
  createdAt: Date | string;
  expiresAt: Date | string;
}): number {
  const start = new Date(reservation.startsAt ?? reservation.createdAt).getTime();
  const holdingMs = new Date(reservation.expiresAt).getTime() - start;
  if (!Number.isFinite(holdingMs)) return 0;
  return Math.max(0, Math.ceil(holdingMs / 60_000));
}
