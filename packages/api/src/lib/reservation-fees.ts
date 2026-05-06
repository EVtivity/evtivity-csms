// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { driverPaymentMethods } from '@evtivity/database';
import { getStripeConfig } from '../services/stripe.service.js';

export async function chargeReservationCancellationFee(
  driverId: string,
  siteId: string | null,
  amountCents: number,
  reservationId: string,
): Promise<void> {
  const [paymentMethod] = await db
    .select({
      stripeCustomerId: driverPaymentMethods.stripeCustomerId,
      stripePaymentMethodId: driverPaymentMethods.stripePaymentMethodId,
    })
    .from(driverPaymentMethods)
    .where(
      and(eq(driverPaymentMethods.driverId, driverId), eq(driverPaymentMethods.isDefault, true)),
    )
    .limit(1);

  if (paymentMethod == null) {
    return;
  }

  const stripeConfig = await getStripeConfig(siteId);
  if (stripeConfig == null) {
    return;
  }

  await stripeConfig.stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency: stripeConfig.currency.toLowerCase(),
      customer: paymentMethod.stripeCustomerId,
      payment_method: paymentMethod.stripePaymentMethodId,
      confirm: true,
      off_session: true,
      metadata: {
        reservationId,
        type: 'reservation_cancellation_fee',
      },
    },
    { idempotencyKey: `cancellation-fee-${reservationId}` },
  );
}

/**
 * No-show / unused-reservation charge. Fired by the worker reaper when an
 * `active` reservation expires WITHOUT a linked charging session, i.e. the
 * holder reserved the connector and never plugged in. Charges
 * `holdingMinutes * tariff.reservationFeePerMinute` (already converted to
 * cents by the caller).
 *
 * No-op when:
 *  - The driver has no default payment method (we still expire the row;
 *    silent skip rather than failing the whole reaper batch).
 *  - The site has no Stripe config.
 *
 * Idempotency key keys off the reservation row id, so retries of the same
 * reaper job won't double-charge.
 */
export async function chargeReservationNoShowFee(
  driverId: string,
  siteId: string | null,
  amountCents: number,
  reservationId: string,
): Promise<void> {
  if (amountCents <= 0) return;

  const [paymentMethod] = await db
    .select({
      stripeCustomerId: driverPaymentMethods.stripeCustomerId,
      stripePaymentMethodId: driverPaymentMethods.stripePaymentMethodId,
    })
    .from(driverPaymentMethods)
    .where(
      and(eq(driverPaymentMethods.driverId, driverId), eq(driverPaymentMethods.isDefault, true)),
    )
    .limit(1);

  if (paymentMethod == null) {
    return;
  }

  const stripeConfig = await getStripeConfig(siteId);
  if (stripeConfig == null) {
    return;
  }

  await stripeConfig.stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency: stripeConfig.currency.toLowerCase(),
      customer: paymentMethod.stripeCustomerId,
      payment_method: paymentMethod.stripePaymentMethodId,
      confirm: true,
      off_session: true,
      metadata: {
        reservationId,
        type: 'reservation_no_show_fee',
      },
    },
    { idempotencyKey: `no-show-fee-${reservationId}` },
  );
}
