// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { NormalizedPaymentEvent, SavedMethodDetails } from '../../types.js';
import { fromAdyenAmount } from './amounts.js';
import type { AdyenNotificationItem } from './hmac.js';

export interface AdyenNotification {
  /** 'true' or 'false' as a string. */
  live: string | undefined;
  items: AdyenNotificationItem[];
}

/**
 * Parses a Standard JSON webhook `{ live, notificationItems: [{ NotificationRequestItem }] }`
 * (https://docs.adyen.com/development-resources/webhooks/webhook-types). JSON
 * webhooks carry one item; every item is handled when there are more.
 * Returns null for a body that is not one.
 */
export function parseAdyenNotification(rawBody: string): AdyenNotification | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Not JSON: the caller rejects it as an unverifiable webhook.
    return null;
  }
  if (body == null || typeof body !== 'object') return null;
  const { live, notificationItems } = body as { live?: unknown; notificationItems?: unknown };
  if (!Array.isArray(notificationItems) || notificationItems.length === 0) return null;
  const items: AdyenNotificationItem[] = [];
  for (const wrapper of notificationItems) {
    const item = (wrapper as { NotificationRequestItem?: unknown } | null)?.NotificationRequestItem;
    if (item == null || typeof item !== 'object') return null;
    items.push(item);
  }
  return { live: typeof live === 'string' ? live : undefined, items };
}

function amountCents(item: AdyenNotificationItem): number | null {
  const { value, currency } = item.amount ?? {};
  if (typeof value !== 'number' || typeof currency !== 'string') return null;
  try {
    return fromAdyenAmount({ value, currency });
  } catch {
    // A currency the provider never sends (IDR): the event carries no usable amount.
    return null;
  }
}

function occurredAt(item: AdyenNotificationItem): Date {
  const date = item.eventDate != null ? new Date(item.eventDate) : null;
  return date != null && !Number.isNaN(date.getTime()) ? date : new Date();
}

function nonEmpty(value: string | undefined): string | null {
  return value != null && value !== '' ? value : null;
}

/** The stored method an AUTHORISATION carries when the payment saved one. */
function storedMethod(item: AdyenNotificationItem): SavedMethodDetails | undefined {
  const data = item.additionalData ?? {};
  const methodId =
    nonEmpty(data['tokenization.storedPaymentMethodId']) ??
    nonEmpty(data['recurring.recurringDetailReference']);
  const customerId =
    nonEmpty(data['tokenization.shopperReference']) ?? nonEmpty(data['recurring.shopperReference']);
  if (methodId == null || customerId == null) return undefined;
  return {
    methodId,
    customerId,
    brand: nonEmpty(item.paymentMethod),
    last4: nonEmpty(data['cardSummary']),
  };
}

/**
 * Normalizes one verified item. The event id is `eventCode:pspReference:success`
 * (Adyen has no event id; retried duplicates share these fields). The payment
 * is the item's `pspReference` for AUTHORISATION and its `originalReference`
 * for modifications, whose own `pspReference` is the operation reference a
 * pending result returned. Amounts are per event (a REFUND is one refund, not
 * a cumulative total). Codes the platform does not act on are 'ignored'.
 */
export function normalizeAdyenItem(item: AdyenNotificationItem): NormalizedPaymentEvent {
  const eventCode = item.eventCode ?? '';
  const pspReference = item.pspReference ?? '';
  const success = item.success === 'true';
  const eventId = `${eventCode}:${pspReference}:${item.success ?? ''}`;
  const at = occurredAt(item);
  const ignored: NormalizedPaymentEvent = {
    eventId,
    type: 'ignored',
    providerType: eventCode,
    occurredAt: at,
  };
  const reason = nonEmpty(item.reason);
  const original = nonEmpty(item.originalReference);
  const amount = amountCents(item);
  const modification =
    original == null
      ? null
      : { eventId, paymentId: original, operationRef: pspReference, occurredAt: at };

  switch (eventCode) {
    case 'AUTHORISATION': {
      if (pspReference === '') return ignored;
      if (!success) {
        return { eventId, type: 'payment.failed', paymentId: pspReference, reason, occurredAt: at };
      }
      if (amount == null) return ignored;
      const method = storedMethod(item);
      return {
        eventId,
        type: 'payment.authorized',
        paymentId: pspReference,
        amountCents: amount,
        merchantReference: item.merchantReference ?? '',
        ...(method != null ? { method } : {}),
        occurredAt: at,
      };
    }
    case 'AUTHORISATION_ADJUSTMENT':
      if (modification == null) return ignored;
      return {
        ...modification,
        type: 'payment.adjusted',
        authorizedCents: success ? (amount ?? 0) : 0,
        success,
      };
    case 'CAPTURE':
      if (modification == null) return ignored;
      if (!success) return { ...modification, type: 'payment.capture_failed', reason };
      if (amount == null) return ignored;
      return { ...modification, type: 'payment.captured', amountCents: amount };
    case 'CAPTURE_FAILED':
      if (modification == null) return ignored;
      return { ...modification, type: 'payment.capture_failed', reason };
    case 'CANCELLATION':
    case 'TECHNICAL_CANCEL':
    case 'EXPIRE':
      if (modification == null) return ignored;
      return success
        ? {
            ...modification,
            type: 'payment.cancelled',
            ...(eventCode === 'EXPIRE' ? { expired: true } : {}),
          }
        : { ...modification, type: 'payment.cancel_failed', reason };
    case 'REFUND':
      if (modification == null || amount == null) return ignored;
      return success
        ? {
            ...modification,
            type: 'payment.refunded',
            refundId: pspReference,
            amountCents: amount,
            cumulativeRefundedCents: null,
            capturedCents: null,
          }
        : {
            ...modification,
            type: 'payment.refund_failed',
            refundId: pspReference,
            amountCents: amount,
            reason,
          };
    case 'REFUND_FAILED':
      if (modification == null || amount == null) return ignored;
      return {
        ...modification,
        type: 'payment.refund_failed',
        refundId: pspReference,
        amountCents: amount,
        reason,
      };
    case 'CHARGEBACK':
      if (original == null) return ignored;
      return {
        eventId,
        type: 'payment.disputed',
        paymentId: original,
        disputeId: pspReference,
        reason: reason ?? nonEmpty(item.additionalData?.['chargebackReasonCode']),
        occurredAt: at,
      };
    default:
      return ignored;
  }
}
