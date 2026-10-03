// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Structural tariff shape sufficient to determine if a session is free.
 * Accepts the price fields as nullable strings so it can be called with
 * either Drizzle row types or postgres-js raw query results without
 * coupling the lib package to either driver.
 */
interface FreeTariffShape {
  pricePerKwh: string | null;
  pricePerMinute: string | null;
  pricePerSession: string | null;
  idleFeePricePerMinute: string | null;
  reservationFeePerMinute?: string | null | undefined;
}

function isZero(price: string | null | undefined): boolean {
  return price == null || Number(price) === 0;
}

/**
 * Returns true when charging costs nothing: every price component on the
 * tariff is null or zero. Treats `null` (no tariff resolved) as free so guest
 * and authenticated flows behave identically when pricing isn't configured.
 *
 * The reservation holding fee is billed only on a session started from a
 * reservation, so it counts only when `reserved` is true: a tariff whose only
 * price is the reservation fee is free for a walk-up session and paid for the
 * reservation holder.
 */
export function isTariffFree(
  tariff: FreeTariffShape | null,
  options: { reserved?: boolean } = {},
): boolean {
  if (tariff == null) return true;
  return (
    isZero(tariff.pricePerKwh) &&
    isZero(tariff.pricePerMinute) &&
    isZero(tariff.pricePerSession) &&
    isZero(tariff.idleFeePricePerMinute) &&
    (options.reserved !== true || isZero(tariff.reservationFeePerMinute))
  );
}
