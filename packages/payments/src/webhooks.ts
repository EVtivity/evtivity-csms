// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, webhookEvents } from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { PaymentProviderNotConfiguredError, WebhookNotConfiguredError } from './errors.js';
import {
  findByChargePaymentId,
  findByPaymentId,
  lockRecord,
  markOpenPaymentFailed,
  markRefunded,
} from './payment-records.js';
import { paymentCharges, topUpCharges, withTopUpRefunds } from './top-ups.js';
import type { NormalizedPaymentEvent, PaymentProviderId, WebhookAck } from './types.js';

const PROVIDER_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  adyen: 'Adyen',
  simulated: 'Simulated',
};

function label(providerId: PaymentProviderId): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}

export interface WebhookResult {
  ack: WebhookAck;
  /** Events applied (not duplicates). */
  applied: number;
  duplicates: number;
}

/**
 * The inbound webhook pipeline: verify the provider's signature, deduplicate
 * each event on its id (`webhook_events`, insert-or-skip, P7), then apply it
 * with status guards (P5). Throws WebhookNotConfiguredError when the provider
 * has no signing secret or credentials in this process, and
 * WebhookSignatureError for a missing or wrong signature.
 */
export async function ingestPaymentWebhook(
  providerId: PaymentProviderId,
  rawBody: string,
  headers: Record<string, string | undefined>,
  ctx: PaymentContext,
): Promise<WebhookResult> {
  let provider;
  try {
    provider = await ctx.registry.getPaymentProvider(providerId);
  } catch (err) {
    if (err instanceof PaymentProviderNotConfiguredError) {
      throw new WebhookNotConfiguredError(providerId);
    }
    throw err;
  }
  const events = provider.verifyWebhook(rawBody, headers);
  let applied = 0;
  let duplicates = 0;
  for (const event of events) {
    const eventType = event.providerType ?? event.type;
    ctx.logger.info(
      { provider: providerId, type: eventType, id: event.eventId },
      'Payment webhook received',
    );
    const inserted = await db
      .insert(webhookEvents)
      .values({ eventId: event.eventId, eventType })
      .onConflictDoNothing()
      .returning({ eventId: webhookEvents.eventId });
    if (inserted.length === 0) {
      ctx.logger.info({ eventId: event.eventId }, 'Duplicate webhook event, skipping');
      duplicates++;
      continue;
    }
    try {
      await applyPaymentEvent(providerId, event, ctx);
    } catch (err) {
      // Forget the event id so the provider's retry applies it (the event
      // must not be lost behind its own dedupe row).
      await db.delete(webhookEvents).where(eq(webhookEvents.eventId, event.eventId));
      throw err;
    }
    applied++;
  }
  return { ack: provider.webhookAck(), applied, duplicates };
}

/**
 * A cumulative refund reported for one charge of a record with top-ups (the
 * hold or a top-up payment). The record is locked, that charge's refunded
 * total is raised to the reported one (never lowered), and the record total
 * is the sum over its charges, so the refund of one charge is never counted
 * against another or twice. Full when the sum reaches the captured total.
 */
async function applyChargeRefund(
  recordId: number,
  chargePaymentId: string,
  cumulativeRefundedCents: number,
  ctx: PaymentContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const locked = await lockRecord(tx, recordId);
    if (locked == null) return;
    const charges = paymentCharges(locked);
    const charge = charges.find((c) => c.paymentId === chargePaymentId);
    if (charge == null) return;
    const chargeRefunded = Math.min(
      charge.capturedCents,
      Math.max(charge.refundedCents, cumulativeRefundedCents),
    );
    if (chargeRefunded === charge.refundedCents) {
      ctx.logger.info(
        { paymentId: chargePaymentId, paymentRecordId: recordId },
        'Refund webhook ignored: charge already refunded this far',
      );
      return;
    }
    const total = locked.refundedAmountCents + (chargeRefunded - charge.refundedCents);
    const topUps = withTopUpRefunds(
      topUpCharges(locked),
      new Map(charge.kind === 'top_up' ? [[chargePaymentId, chargeRefunded]] : []),
    );
    const row = await markRefunded(
      locked.id,
      { refundedTotalCents: total, full: total >= (locked.capturedAmountCents ?? 0), topUps },
      tx,
    );
    if (row != null) {
      ctx.logger.info(
        { paymentId: chargePaymentId, status: row.status, refundedAmount: total },
        'Payment refund status updated via webhook',
      );
    } else {
      ctx.logger.info(
        { paymentId: chargePaymentId, status: locked.status },
        'Refund webhook ignored: record not refundable',
      );
    }
  });
}

/** Applies one verified, first-seen event to the payment records. */
export async function applyPaymentEvent(
  providerId: PaymentProviderId,
  event: NormalizedPaymentEvent,
  ctx: PaymentContext,
): Promise<void> {
  switch (event.type) {
    case 'payment.failed': {
      const record = await findByPaymentId(event.paymentId);
      if (record == null) return;
      const reason =
        event.reason != null
          ? `${label(providerId)} webhook: ${event.reason.slice(0, 480)}`
          : `${label(providerId)} webhook: ${event.providerType ?? event.type}`;
      // Terminal states are sticky (P5): a failure never overwrites a
      // captured, refunded, cancelled or failed record.
      if (await markOpenPaymentFailed(record.id, reason)) {
        ctx.logger.info(
          { paymentId: event.paymentId, reason: event.reason },
          'Payment marked as failed via webhook',
        );
      } else {
        ctx.logger.info(
          { paymentId: event.paymentId, status: record.status },
          'Payment failure webhook ignored: record is in a terminal state',
        );
      }
      return;
    }
    case 'payment.refunded': {
      const record = await findByChargePaymentId(event.paymentId);
      if (record == null) return;
      if (event.cumulativeRefundedCents == null) {
        // A refund reported as an increment (Adyen) needs the refund ids
        // stored per record to apply once; that arrives with the async
        // machinery (plan P10a). The operator refund already recorded it.
        ctx.logger.warn(
          { paymentId: event.paymentId, refundId: event.refundId, amountCents: event.amountCents },
          'Refund webhook without a cumulative total not applied',
        );
        return;
      }
      const refunded = event.cumulativeRefundedCents;
      if (refunded <= 0) {
        ctx.logger.info({ paymentId: event.paymentId }, 'Refund webhook without a refunded amount');
        return;
      }
      if (topUpCharges(record).length > 0) {
        await applyChargeRefund(record.id, event.paymentId, refunded, ctx);
        return;
      }
      // A partially captured hold refunds at most what was captured.
      const captured = event.capturedCents ?? record.capturedAmountCents ?? 0;
      const full = refunded >= captured;
      // Only a captured or partially refunded record takes a refund, and a
      // delayed event never lowers the stored total (P5).
      const row = await markRefunded(record.id, { refundedTotalCents: refunded, full });
      if (row != null) {
        ctx.logger.info(
          { paymentId: event.paymentId, status: row.status, refundedAmount: refunded },
          'Payment refund status updated via webhook',
        );
      } else {
        ctx.logger.info(
          {
            paymentId: event.paymentId,
            status: record.status,
            refundedAmountCents: record.refundedAmountCents,
            refundedAmount: refunded,
          },
          'Refund webhook ignored: record not refundable or already refunded further',
        );
      }
      return;
    }
    case 'payment.disputed':
      ctx.logger.warn(
        { paymentId: event.paymentId, disputeId: event.disputeId, reason: event.reason },
        'Payment dispute created',
      );
      return;
    case 'ignored':
      ctx.logger.debug({ type: event.providerType }, 'Unhandled webhook event type');
      return;
    default:
      // Confirmations of async modifications (captured, cancelled, adjusted,
      // their failures) belong to providers with async results; no provider
      // in use sends them before the async machinery (plan P10a).
      ctx.logger.warn(
        { type: event.type, paymentId: event.paymentId },
        'Payment webhook event not handled by synchronous providers',
      );
  }
}
