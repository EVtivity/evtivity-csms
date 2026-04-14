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
