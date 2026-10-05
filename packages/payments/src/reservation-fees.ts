// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import {
  client,
  db,
  driverPaymentMethods,
  getCompanyCurrency,
  getPlatformFeePercent,
  resolveStationTariff,
} from '@evtivity/database';
import type { PaymentChargeType } from '@evtivity/database';
import { taxLineFromNet } from '@evtivity/lib';
import type { PaymentContext } from './context.js';
import { errorMessage } from './context.js';
import { PaymentProviderNotConfiguredError } from './errors.js';
import { reservationFeeKey } from './idempotency-keys.js';
import { pinnedProvider } from './pinning.js';
import {
  findReservationCharge,
  markChargeCaptured,
  markChargeFailed,
  recordPendingCharge,
} from './payment-records.js';
import { PAYOUT_NOT_READY_FAILURE, sitePayoutReadiness } from './payout-accounts.js';
import { getSitePaymentConfig } from './settings.js';
import type { PaymentProvider } from './types.js';

/**
 * Reservation cancellation and no-show fees. The fee is priced net, like
 * tariff prices, and taxed at the tax rate of the station's tariff for the
 * driver (taxLineFromNet). Each charge is a payment record (`charge_type`,
 * `reservation_id`, `tax_rate`), charged on the driver's default card through
 * the provider the card is saved with and the site's payout account, with the
 * platform fee of its net amount, and counted in revenue.
 */
export type ReservationFeeType = Extract<
  PaymentChargeType,
  'reservation_cancellation' | 'reservation_no_show'
>;

export interface ReservationFeeInput {
  type: ReservationFeeType;
  /** Internal reservation row id. */
  reservationId: string;
  driverId: string;
  /** Station row id, for the tariff tax rate. */
  stationId: string;
  siteId: string | null;
  /** The fee before tax, in cents of the company currency. */
  netCents: number;
}

export type ReservationFeeResult =
  | {
      status: 'charged';
      paymentRecordId: number;
      grossCents: number;
      netCents: number;
      taxCents: number;
      taxRate: number;
      currency: string;
    }
  /** Nothing charged: no amount, no default card, or payments not configured. */
  | { status: 'skipped'; reason: 'no_amount' | 'no_payment_method' | 'payments_not_configured' }
  /** The fee for this reservation and type was already recorded (a retry). */
  | { status: 'duplicate'; paymentRecordId: number }
  | { status: 'failed'; paymentRecordId: number; reason: string };

const DESCRIPTION: Record<ReservationFeeType, string> = {
  reservation_cancellation: 'Reservation cancellation fee',
  reservation_no_show: 'Reservation no-show fee',
};

/**
 * Charges a reservation fee once. The payment record is inserted as `pending`
 * before the card is charged (unique per reservation and fee type, so a retry
 * or a concurrent call charges nothing), then marked `captured` or `failed`.
 * A crash between the two leaves the `pending` record for reconciliation.
 * The idempotency key derives from the reservation id
 * (`cancellation-fee-<id>`, `no-show-fee-<id>`).
 */
export async function chargeReservationFee(
  input: ReservationFeeInput,
  ctx: PaymentContext,
): Promise<ReservationFeeResult> {
  if (input.netCents <= 0) return { status: 'skipped', reason: 'no_amount' };

  const [method] = await db
    .select({
      provider: driverPaymentMethods.provider,
      customerId: driverPaymentMethods.providerCustomerId,
      methodId: driverPaymentMethods.providerPaymentMethodId,
    })
    .from(driverPaymentMethods)
    .where(
      and(
        eq(driverPaymentMethods.driverId, input.driverId),
        eq(driverPaymentMethods.isDefault, true),
      ),
    )
    .limit(1);
  if (method == null) {
    return { status: 'skipped', reason: 'no_payment_method' };
  }
  const customerId = method.customerId;
  const methodId = method.methodId;

  let provider: PaymentProvider;
  try {
    provider = await pinnedProvider(ctx.registry, method.provider);
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) {
      return { status: 'skipped', reason: 'payments_not_configured' };
    }
    throw err;
  }

  const [currency, site, tariff] = await Promise.all([
    getCompanyCurrency(),
    input.siteId != null ? getSitePaymentConfig(input.siteId) : Promise.resolve(null),
    resolveStationTariff({ stationUuid: input.stationId, driverUuid: input.driverId }, client),
  ]);
  const taxRate = Number(tariff?.taxRate ?? 0);
  const charge = taxLineFromNet(input.netCents, taxRate);

  const recordId = await recordPendingCharge({
    chargeType: input.type,
    reservationId: input.reservationId,
    driverId: input.driverId,
    sitePaymentConfigId: site?.configId ?? null,
    provider: provider.id,
    customerId,
    methodId,
    currency,
    taxRate,
  });
  if (recordId == null) {
    const existing = await findReservationCharge(input.reservationId, input.type);
    return { status: 'duplicate', paymentRecordId: existing ?? 0 };
  }

  // O5, fail closed: a payout account that is not ready gets no charge, and
  // the charge is not moved to the platform either.
  const readiness =
    input.siteId != null && site?.payoutAccountId != null
      ? await sitePayoutReadiness(input.siteId, ctx)
      : 'none';
  if (readiness === 'not_ready') {
    await markChargeFailed(recordId, PAYOUT_NOT_READY_FAILURE);
    ctx.logger.warn(
      { paymentRecordId: recordId, reservationId: input.reservationId, siteId: input.siteId },
      'Reservation fee not charged: the payout account of the site is not ready',
    );
    return { status: 'failed', paymentRecordId: recordId, reason: PAYOUT_NOT_READY_FAILURE };
  }

  let paymentId: string;
  try {
    const result = await provider.chargeSavedMethod({
      customerId,
      methodId,
      grossCents: charge.grossCents,
      currency,
      feeTaxRate: taxRate,
      platformFeePercent: await getPlatformFeePercent(input.siteId),
      payoutAccountId: site?.payoutAccountId ?? null,
      description: DESCRIPTION[input.type],
      metadata: { reservationId: input.reservationId, type: `${input.type}_fee` },
      idempotencyKey: reservationFeeKey(input.type, input.reservationId),
    });
    paymentId = result.paymentId;
  } catch (err) {
    const reason = errorMessage(err, 'Unknown payment error');
    await markChargeFailed(recordId, reason);
    return { status: 'failed', paymentRecordId: recordId, reason };
  }

  if (
    !(await markChargeCaptured(recordId, {
      provider: provider.id,
      paymentId,
      amountCents: charge.grossCents,
    }))
  ) {
    ctx.logger.error(
      { paymentRecordId: recordId, paymentId },
      'Reservation fee charged but its record had moved on; manual reconciliation required',
    );
  }
  return {
    status: 'charged',
    paymentRecordId: recordId,
    grossCents: charge.grossCents,
    netCents: charge.netCents,
    taxCents: charge.taxCents,
    taxRate,
    currency,
  };
}
