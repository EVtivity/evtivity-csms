// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  driverPaymentMethods,
  paymentRecords,
  getCompanyCurrency,
  type PaymentChargeType,
} from '@evtivity/database';
import { isSimulatedCustomer, shouldSimulatePaymentFailure, taxLineFromNet } from '@evtivity/lib';
import { getStripeConfig, chargeSavedCard } from '../services/stripe.service.js';
import { resolveTariff } from '../services/tariff.service.js';

/**
 * Reservation cancellation and no-show fees. The fee is priced net, like
 * tariff prices, and taxed at the tax rate of the station's tariff for the
 * driver (taxLineFromNet). Each charge is a payment record
 * (`charge_type`, `reservation_id`, `tax_rate`), charged on the driver's
 * default card through the site's Stripe Connect account with the platform
 * fee of its net amount, and counted in revenue.
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

const IDEMPOTENCY_PREFIX: Record<ReservationFeeType, string> = {
  reservation_cancellation: 'cancellation-fee',
  reservation_no_show: 'no-show-fee',
};

const DESCRIPTION: Record<ReservationFeeType, string> = {
  reservation_cancellation: 'Reservation cancellation fee',
  reservation_no_show: 'Reservation no-show fee',
};

/**
 * Charges a reservation fee once. The payment record is inserted as `pending`
 * before the card is charged (unique per reservation and fee type, so a retry
 * or a concurrent call charges nothing), then marked `captured` or `failed`.
 * A crash between the two leaves the `pending` record for reconciliation.
 * The Stripe idempotency key derives from the reservation id.
 *
 * Simulated customers (`cus_sim_`) get a `pi_sim_` intent without Stripe and
 * fail like simulated session payments do.
 */
export async function chargeReservationFee(
  input: ReservationFeeInput,
): Promise<ReservationFeeResult> {
  if (input.netCents <= 0) return { status: 'skipped', reason: 'no_amount' };

  const [paymentMethod] = await db
    .select({
      stripeCustomerId: driverPaymentMethods.stripeCustomerId,
      stripePaymentMethodId: driverPaymentMethods.stripePaymentMethodId,
    })
    .from(driverPaymentMethods)
    .where(
      and(
        eq(driverPaymentMethods.driverId, input.driverId),
        eq(driverPaymentMethods.isDefault, true),
      ),
    )
    .limit(1);
  if (paymentMethod == null) return { status: 'skipped', reason: 'no_payment_method' };

  const simulated = isSimulatedCustomer(paymentMethod.stripeCustomerId);
  const stripeConfig = simulated ? null : await getStripeConfig(input.siteId);
  if (!simulated && stripeConfig == null) {
    return { status: 'skipped', reason: 'payments_not_configured' };
  }
  const currency = stripeConfig?.currency ?? (await getCompanyCurrency());

  const tariff = await resolveTariff(input.stationId, input.driverId);
  const taxRate = Number(tariff?.taxRate ?? 0);
  const charge = taxLineFromNet(input.netCents, taxRate);

  const [inserted] = await db
    .insert(paymentRecords)
    .values({
      chargeType: input.type,
      reservationId: input.reservationId,
      driverId: input.driverId,
      sitePaymentConfigId: stripeConfig?.configId ?? null,
      stripeCustomerId: paymentMethod.stripeCustomerId,
      stripePaymentMethodId: paymentMethod.stripePaymentMethodId,
      paymentSource: 'web_portal',
      currency,
      taxRate: String(taxRate),
      status: 'pending',
    })
    .onConflictDoNothing({
      target: [paymentRecords.reservationId, paymentRecords.chargeType],
      where: sql`${paymentRecords.reservationId} IS NOT NULL`,
    })
    .returning({ id: paymentRecords.id });

  if (inserted == null) {
    const [existing] = await db
      .select({ id: paymentRecords.id })
      .from(paymentRecords)
      .where(
        and(
          eq(paymentRecords.reservationId, input.reservationId),
          eq(paymentRecords.chargeType, input.type),
        ),
      );
    return { status: 'duplicate', paymentRecordId: existing?.id ?? 0 };
  }

  let intentId: string;
  try {
    if (simulated) {
      if (shouldSimulatePaymentFailure()) throw new Error('Simulated payment failure');
      intentId = `pi_sim_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    } else {
      const intent = await chargeSavedCard(stripeConfig as NonNullable<typeof stripeConfig>, {
        customerId: paymentMethod.stripeCustomerId,
        paymentMethodId: paymentMethod.stripePaymentMethodId,
        grossCents: charge.grossCents,
        taxRate,
        description: DESCRIPTION[input.type],
        metadata: { reservationId: input.reservationId, type: `${input.type}_fee` },
        idempotencyKey: `${IDEMPOTENCY_PREFIX[input.type]}-${input.reservationId}`,
      });
      intentId = intent.id;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 500) : 'Unknown payment error';
    await db
      .update(paymentRecords)
      .set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
      .where(eq(paymentRecords.id, inserted.id));
    return { status: 'failed', paymentRecordId: inserted.id, reason };
  }

  await db
    .update(paymentRecords)
    .set({
      status: 'captured',
      stripePaymentIntentId: intentId,
      capturedAmountCents: charge.grossCents,
      updatedAt: new Date(),
    })
    .where(eq(paymentRecords.id, inserted.id));

  return {
    status: 'charged',
    paymentRecordId: inserted.id,
    grossCents: charge.grossCents,
    netCents: charge.netCents,
    taxCents: charge.taxCents,
    taxRate,
    currency,
  };
}
