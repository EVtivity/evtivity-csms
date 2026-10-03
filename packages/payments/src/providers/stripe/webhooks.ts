// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type Stripe from 'stripe';
import type { NormalizedPaymentEvent } from '../../types.js';

function refId(ref: string | { id: string } | null | undefined): string | null {
  if (ref == null) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

/**
 * Normalizes a verified Stripe event. Handles the events the webhook route
 * acts on today (failed intent, refunded charge, dispute); everything else is
 * 'ignored'.
 */
export function normalizeStripeEvent(event: Stripe.Event): NormalizedPaymentEvent {
  const occurredAt = new Date(event.created * 1000);
  const ignored: NormalizedPaymentEvent = {
    eventId: event.id,
    type: 'ignored',
    providerType: event.type,
    occurredAt,
  };
  switch (event.type) {
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      return {
        eventId: event.id,
        type: 'payment.failed',
        paymentId: pi.id,
        reason: pi.last_payment_error?.message ?? pi.last_payment_error?.code ?? null,
        occurredAt,
        providerType: event.type,
      };
    }
    case 'charge.refunded': {
      const charge = event.data.object;
      const paymentId = refId(charge.payment_intent);
      if (paymentId == null) return ignored;
      return {
        eventId: event.id,
        type: 'payment.refunded',
        paymentId,
        refundId: null,
        amountCents: null,
        cumulativeRefundedCents: charge.amount_refunded,
        capturedCents: charge.amount_captured,
        occurredAt,
        providerType: event.type,
      };
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object;
      const paymentId = refId(dispute.payment_intent);
      if (paymentId == null) return ignored;
      return {
        eventId: event.id,
        type: 'payment.disputed',
        paymentId,
        disputeId: dispute.id,
        reason: dispute.reason,
        occurredAt,
        providerType: event.type,
      };
    }
    default:
      return ignored;
  }
}
