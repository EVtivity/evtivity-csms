// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger, isTaxBasis, type TaxBasis } from '@evtivity/lib';
import { client } from '../config.js';
import { getReservationSettings } from './reservation-setting.js';
import { getCompanyTaxBasis } from './system-settings.js';
import { resolveStationTariff } from './tariff-resolution.js';

const logger = createLogger('reservation-fee-terms');

/**
 * The fee terms a reservation row stores (migration 0341). feeTaxBasis null
 * means no snapshot: the reservation was created before 0341, or the lookup
 * failed at creation.
 */
export interface ReservationFeeSnapshot {
  /** 'net' or 'gross' (TaxBasis) when snapshotted. */
  feeTaxBasis: string | null;
  feeTaxRate: string | null;
  feePerMinute: string | null;
  feeCancellationCents: number | null;
}

/** The terms a cancellation or no-show fee is priced on (pricing engine priceFee / priceTimedFee). */
export interface ReservationFeeTerms {
  /** The tax basis the fee amounts are entered in (company.taxBasis). */
  basis: TaxBasis;
  /** Tax rate of the tariff the driver resolves at the station, a fraction; null for none. */
  taxRate: string | null;
  /** That tariff's reservation holding fee per minute (the no-show fee), in the basis; null for none. */
  feePerMinute: string | null;
  /** The cancellation fee in cents, in the basis. */
  cancellationFeeCents: number;
}

const NO_SNAPSHOT: ReservationFeeSnapshot = {
  feeTaxBasis: null,
  feeTaxRate: null,
  feePerMinute: null,
  feeCancellationCents: null,
};

/**
 * True when the station's site has free vend enabled. A reservation at a
 * free vend site costs nothing (no holding or cancellation fee). Read
 * uncached and not fail-open: a lookup error must not turn into a fee, so it
 * propagates to the caller (no snapshot at creation, no charge at expiry).
 */
async function isStationFreeVend(stationUuid: string): Promise<boolean> {
  const [row] = await client<{ free_vend_enabled: boolean }[]>`
    SELECT s.free_vend_enabled
    FROM charging_stations cs
    INNER JOIN sites s ON s.id = cs.site_id
    WHERE cs.id = ${stationUuid}
  `;
  return row?.free_vend_enabled === true;
}

async function currentTerms(q: {
  stationUuid: string;
  driverUuid: string | null;
}): Promise<ReservationFeeTerms> {
  const [tariff, basis, settings, freeVend] = await Promise.all([
    resolveStationTariff({ stationUuid: q.stationUuid, driverUuid: q.driverUuid }, client),
    getCompanyTaxBasis(),
    getReservationSettings(),
    isStationFreeVend(q.stationUuid),
  ]);
  if (freeVend) {
    return { basis, taxRate: tariff?.taxRate ?? null, feePerMinute: null, cancellationFeeCents: 0 };
  }
  return {
    basis,
    taxRate: tariff?.taxRate ?? null,
    feePerMinute: tariff?.reservationFeePerMinute ?? null,
    cancellationFeeCents: settings.cancellationFeeCents,
  };
}

/**
 * The fee terms to store on a reservation at creation: the tax rate and
 * holding fee per minute of the tariff the driver resolves at the station
 * now, the cancellation fee setting, and company.taxBasis. At a free vend
 * site the holding fee is null and the cancellation fee 0, so the
 * reservation costs nothing. A later tariff, setting or free vend edit does
 * not change what the reservation is charged. Fail-open:
 * on a lookup error the row gets no snapshot and is charged on the terms
 * current at the charge (the reservation itself must not fail).
 */
export async function snapshotReservationFeeTerms(q: {
  stationUuid: string;
  driverUuid: string | null;
}): Promise<ReservationFeeSnapshot> {
  try {
    const terms = await currentTerms(q);
    return {
      feeTaxBasis: terms.basis,
      feeTaxRate: terms.taxRate,
      feePerMinute: terms.feePerMinute,
      feeCancellationCents: terms.cancellationFeeCents,
    };
  } catch (err) {
    logger.warn(
      { err, stationUuid: q.stationUuid, driverUuid: q.driverUuid },
      'Reservation fee terms snapshot failed, the fees use the terms current at the charge',
    );
    return NO_SNAPSHOT;
  }
}

/**
 * The fee terms of a reservation: its snapshot when it has one. A
 * reservation without a snapshot (created before migration 0341, or the
 * snapshot failed at creation) falls back to the terms current now: the
 * station tariff the driver resolves, the cancellation fee setting, and
 * company.taxBasis, with no fees when the site is free vend now.
 */
export async function resolveReservationFeeTerms(
  reservation: ReservationFeeSnapshot & { stationId: string; driverId: string | null },
): Promise<ReservationFeeTerms> {
  if (isTaxBasis(reservation.feeTaxBasis)) {
    return {
      basis: reservation.feeTaxBasis,
      taxRate: reservation.feeTaxRate,
      feePerMinute: reservation.feePerMinute,
      cancellationFeeCents: reservation.feeCancellationCents ?? 0,
    };
  }
  return currentTerms({ stationUuid: reservation.stationId, driverUuid: reservation.driverId });
}
