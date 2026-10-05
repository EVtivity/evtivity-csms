// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { client, db, reservations } from '@evtivity/database';
import { dispatchDriverNotification, notificationMoney } from '@evtivity/lib';
import type { PubSubClient } from '@evtivity/lib';
import type { PaymentRecord } from './payment-records.js';

export const FEE_REFUNDED_EVENT = 'payment.FeeRefunded';

export interface FeeRefundNoticeDeps {
  /** Notification template directories of the calling process. */
  templatesDirs: string[];
  /** The process's pub/sub client, for the portal notification drawer. */
  pubsub: PubSubClient | null;
}

/**
 * Tells the driver that a reservation fee refund is done (`payment.FeeRefunded`).
 * Called once per refund: by the fee refund route when the provider confirmed
 * the refund synchronously, and by `dispatchPaymentWebhookNotices` when an
 * async provider confirms it (`settleRefund` moves the ledger entry
 * `pending -> succeeded` once). Session records and guest records send nothing.
 * Errors propagate; callers log them at warn (P9).
 */
export async function dispatchFeeRefundNotification(
  record: PaymentRecord,
  amountCents: number,
  deps: FeeRefundNoticeDeps,
): Promise<void> {
  if (record.driverId == null || record.chargeType === 'session') return;
  let reservationId = '';
  if (record.reservationId != null) {
    const [row] = await db
      .select({ reservationId: reservations.reservationId })
      .from(reservations)
      .where(eq(reservations.id, record.reservationId));
    if (row != null) reservationId = String(row.reservationId);
  }
  const isNoShowFee = record.chargeType === 'reservation_no_show';
  await dispatchDriverNotification(
    client,
    FEE_REFUNDED_EVENT,
    record.driverId,
    {
      amountCents,
      amountFormatted: notificationMoney(amountCents, record.currency),
      currency: record.currency,
      feeType: isNoShowFee ? 'no_show' : 'cancellation',
      isNoShowFee,
      reservationId,
      refundedAt: new Date().toISOString(),
    },
    deps.templatesDirs,
    deps.pubsub ?? undefined,
  );
}
