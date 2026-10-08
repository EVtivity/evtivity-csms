// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq } from 'drizzle-orm';
import { db, webhookEvents } from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { PaymentProviderNotConfiguredError, WebhookNotConfiguredError } from './errors.js';
import { attachGuestAuthorisation, GUEST_REFERENCE_PREFIX } from './guest-payments.js';
import { cancelKey } from './idempotency-keys.js';
import {
  confirmOperation,
  failPendingCapture,
  findByChargePaymentId,
  findByPaymentId,
  findRecord,
  lockRecord,
  markAuthorisationEnded,
  markCaptured,
  markHoldFailed,
  markOpenPaymentFailed,
  markRefunded,
  matchPendingAdjustment,
  settleRefund,
} from './payment-records.js';
import type { PaymentRecord } from './payment-records.js';
import { refreshPayoutAccountById } from './payout-accounts.js';
import { settleAdjustedHold } from './session-payments.js';
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
  /** What the caller tells the driver and the operator UI (`dispatchPaymentWebhookNotices`). */
  notices: PaymentWebhookNotice[];
}

/**
 * A change a webhook made that the driver or the operator UI hears about.
 * The services leave notifications and pub/sub to the calling process.
 */
export type PaymentWebhookNotice =
  /**
   * A session hold settled after its authorisation adjustment: the driver
   * hears about the payment (`session.PaymentReceived`), as on session end.
   */
  | { kind: 'session_paid'; record: PaymentRecord; amountCents: number }
  /**
   * The provider confirmed a capture (an async capture recorded at session
   * end, or one it reports before the capture was recorded): the session
   * receipt is due now (finding JB-3).
   */
  | { kind: 'capture_confirmed'; record: PaymentRecord }
  /** A capture the provider accepted failed: the record is `failed`. */
  | { kind: 'capture_failed'; record: PaymentRecord; reason: string | null }
  /** A pending refund the provider confirmed. */
  | { kind: 'refund_succeeded'; record: PaymentRecord; amountCents: number }
  /** A refund the provider could not carry out. */
  | { kind: 'refund_failed'; record: PaymentRecord; amountCents: number; reason: string | null }
  /** Any other change of the record's state (operator UI refresh only). */
  | { kind: 'record_changed'; record: PaymentRecord }
  /** A dispute was opened on a payment of the record. */
  | { kind: 'disputed'; record: PaymentRecord; disputeId: string; reason: string | null };

/**
 * The inbound webhook pipeline: verify the provider's signature, deduplicate
 * each event on its provider and id (`webhook_events`, insert-or-skip, P7),
 * then apply it with status guards (P5); `(provider, event_id)` is the
 * primary key. Throws WebhookNotConfiguredError when the provider has no
 * signing secret or credentials in this process, and
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
  const notices: PaymentWebhookNotice[] = [];
  for (const event of events) {
    const eventType = event.providerType ?? event.type;
    ctx.logger.info(
      { provider: providerId, type: eventType, id: event.eventId },
      'Payment webhook received',
    );
    const inserted = await db
      .insert(webhookEvents)
      .values({ provider: providerId, eventId: event.eventId, eventType })
      .onConflictDoNothing()
      .returning({ eventId: webhookEvents.eventId });
    if (inserted.length === 0) {
      ctx.logger.info({ eventId: event.eventId }, 'Duplicate webhook event, skipping');
      duplicates++;
      continue;
    }
    try {
      const notice = await applyPaymentEvent(providerId, event, ctx);
      if (notice != null) notices.push(notice);
    } catch (err) {
      // Forget the event id so the provider's retry applies it (the event
      // must not be lost behind its own dedupe row).
      await db
        .delete(webhookEvents)
        .where(
          and(eq(webhookEvents.provider, providerId), eq(webhookEvents.eventId, event.eventId)),
        );
      throw err;
    }
    applied++;
  }
  return { ack: provider.webhookAck(), applied, duplicates, notices };
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

/**
 * Applies one verified, first-seen event to the payment records (P5 guards
 * throughout). Returns what the caller notifies about, or null.
 *
 * Async providers confirm their own operations: a capture, cancel or refund
 * applies only to the record operation with the same provider reference
 * (`pending_operation_ref`, the refund ledger), so a foreign or out-of-order
 * event changes nothing. An event that arrives before the service recorded
 * its own request (a webhook faster than the database write) still moves an
 * open hold to the reported outcome; the service's later write then finds
 * the record moved on and leaves it.
 */
export async function applyPaymentEvent(
  providerId: PaymentProviderId,
  event: NormalizedPaymentEvent,
  ctx: PaymentContext,
): Promise<PaymentWebhookNotice | null> {
  switch (event.type) {
    case 'payment.failed': {
      const record = await findByPaymentId(providerId, event.paymentId);
      if (record == null) return null;
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
        return changed(record.id);
      }
      ctx.logger.info(
        { paymentId: event.paymentId, status: record.status },
        'Payment failure webhook ignored: record is in a terminal state',
      );
      return null;
    }
    case 'payment.refunded': {
      const record = await findByChargePaymentId(providerId, event.paymentId);
      if (record == null) return null;
      if (event.cumulativeRefundedCents == null) {
        // One refund (Adyen, simulated async): settled once through the ledger.
        const refundId = event.operationRef ?? event.refundId;
        if (refundId == null || event.amountCents == null) {
          ctx.logger.warn(
            { paymentId: event.paymentId },
            'Refund webhook without a refund reference or amount',
          );
          return null;
        }
        return settleRefundEvent(
          record.id,
          { refundId, paymentId: event.paymentId, amountCents: event.amountCents },
          'succeeded',
          null,
          ctx,
        );
      }
      const refunded = event.cumulativeRefundedCents;
      if (refunded <= 0) {
        ctx.logger.info({ paymentId: event.paymentId }, 'Refund webhook without a refunded amount');
        return null;
      }
      if (topUpCharges(record).length > 0) {
        await applyChargeRefund(record.id, event.paymentId, refunded, ctx);
        return null;
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
      return null;
    }
    case 'payment.refund_failed': {
      const record = await findByChargePaymentId(providerId, event.paymentId);
      if (record == null) return null;
      return settleRefundEvent(
        record.id,
        {
          refundId: event.operationRef ?? event.refundId,
          paymentId: event.paymentId,
          amountCents: event.amountCents,
        },
        'failed',
        event.reason,
        ctx,
      );
    }
    case 'payment.captured': {
      const record = await findByChargePaymentId(providerId, event.paymentId);
      if (record == null) return null;
      const ref = event.operationRef;
      if (ref != null && (await confirmOperation(record.id, 'capture', ref))) {
        ctx.logger.info(
          { paymentRecordId: record.id, operationRef: ref },
          'Capture confirmed via webhook',
        );
        return captureConfirmed(record.id);
      }
      if (record.status === 'pre_authorized' && record.providerPaymentId === event.paymentId) {
        // The confirmation came before the capture was recorded (or the
        // capture was made in the provider's dashboard): it is final.
        if (
          await markCaptured(record.id, { capturedCents: event.amountCents, failureReason: null })
        ) {
          ctx.logger.info(
            { paymentRecordId: record.id, amountCents: event.amountCents },
            'Hold captured via webhook',
          );
          return captureConfirmed(record.id);
        }
      }
      ctx.logger.info(
        { paymentRecordId: record.id, status: record.status, operationRef: ref },
        'Capture webhook ignored: no matching pending capture',
      );
      return null;
    }
    case 'payment.capture_failed': {
      const record = await findByChargePaymentId(providerId, event.paymentId);
      if (record == null) return null;
      const reason = `${label(providerId)} capture failed${event.reason != null ? `: ${event.reason.slice(0, 450)}` : ''}`;
      const ref = event.operationRef;
      if (ref != null) {
        const failed = await failPendingCapture(record.id, ref, reason);
        if (failed != null) {
          ctx.logger.warn(
            { paymentRecordId: record.id, operationRef: ref, reason: event.reason },
            'Capture failed via webhook; the payment is not collected',
          );
          return { kind: 'capture_failed', record: failed, reason: event.reason };
        }
      }
      if (record.status === 'pre_authorized' && record.providerPaymentId === event.paymentId) {
        // The failure came before the capture was recorded.
        if (await markHoldFailed(record.id, reason)) {
          const failed = await findRecord(record.id);
          if (failed != null)
            return { kind: 'capture_failed', record: failed, reason: event.reason };
        }
      }
      // A failed capture of a refunded record, or of a top-up, needs a person.
      const level = record.status === 'failed' ? 'info' : 'error';
      ctx.logger[level](
        {
          paymentRecordId: record.id,
          paymentId: event.paymentId,
          status: record.status,
          operationRef: ref,
          pendingOperationRef: record.pendingOperationRef,
          refundedAmountCents: record.refundedAmountCents,
        },
        'Capture failure webhook not applied: no matching capture of an unrefunded record',
      );
      return null;
    }
    case 'payment.cancelled': {
      const record = await findByChargePaymentId(providerId, event.paymentId);
      if (record == null) return null;
      const ref = event.operationRef;
      if (event.expired !== true && ref != null) {
        if (await confirmOperation(record.id, 'cancel', ref)) {
          ctx.logger.info(
            { paymentRecordId: record.id, operationRef: ref },
            'Cancel confirmed via webhook',
          );
          return changed(record.id);
        }
      }
      // The provider ended the authorisation without a request of ours
      // (expiry, a technical cancel, a cancel in its dashboard). No driver
      // notification: the hold just lapsed.
      if (record.providerPaymentId === event.paymentId) {
        const reason =
          event.expired === true
            ? `${label(providerId)} authorisation expired`
            : `${label(providerId)} cancelled the authorisation`;
        if (await markAuthorisationEnded(record.id, reason)) {
          ctx.logger.info(
            { paymentRecordId: record.id, expired: event.expired === true },
            'Authorisation ended by the provider',
          );
          return changed(record.id);
        }
      }
      ctx.logger.info(
        { paymentRecordId: record.id, status: record.status, operationRef: ref },
        'Cancellation webhook ignored: no open hold or matching cancel',
      );
      return null;
    }
    case 'payment.cancel_failed': {
      const record = await findByChargePaymentId(providerId, event.paymentId);
      if (record == null) return null;
      const ref = event.operationRef;
      if (ref != null && (await confirmOperation(record.id, 'cancel', ref))) {
        // The record stays cancelled: nothing was captured and the
        // authorisation lapses by itself; until then the card stays held.
        ctx.logger.error(
          { paymentRecordId: record.id, operationRef: ref, reason: event.reason },
          'Cancel of the hold failed at the provider; the authorisation stays until it expires',
        );
        return changed(record.id);
      }
      ctx.logger.info(
        { paymentRecordId: record.id, operationRef: ref },
        'Cancel failure webhook ignored: no matching pending cancel',
      );
      return null;
    }
    case 'payment.authorized':
      return applyAuthorisation(providerId, event, ctx);
    case 'payment.disputed': {
      ctx.logger.warn(
        { paymentId: event.paymentId, disputeId: event.disputeId, reason: event.reason },
        'Payment dispute created',
      );
      const record = await findByChargePaymentId(providerId, event.paymentId);
      if (record == null) return null;
      return { kind: 'disputed', record, disputeId: event.disputeId, reason: event.reason };
    }
    case 'payout_account.updated': {
      // The payload is never trusted: the account is read back from the
      // provider. A read failure throws, so the provider retries the event.
      const updated = await refreshPayoutAccountById(event.accountId, ctx);
      if (updated === 0) {
        ctx.logger.info(
          { accountId: event.accountId },
          'Payout account event for an account no site uses',
        );
      } else {
        ctx.logger.info({ accountId: event.accountId, updated }, 'Payout account status refreshed');
      }
      return null;
    }
    case 'payment.adjusted':
      return applyAdjustment(providerId, event, ctx);
    case 'ignored':
      ctx.logger.debug({ type: event.providerType }, 'Unhandled webhook event type');
      return null;
  }
}

/** A refund confirmation or failure through the ledger (`settleRefund`). */
async function settleRefundEvent(
  recordId: number,
  refund: { refundId: string; paymentId: string; amountCents: number },
  outcome: 'succeeded' | 'failed',
  reason: string | null,
  ctx: PaymentContext,
): Promise<PaymentWebhookNotice | null> {
  const result = await settleRefund(recordId, { ...refund, outcome });
  switch (result.status) {
    case 'applied':
      if (outcome === 'failed') {
        ctx.logger.warn(
          { paymentRecordId: recordId, refundId: refund.refundId, reason },
          'Refund failed at the provider; the amount stays refundable',
        );
        return {
          kind: 'refund_failed',
          record: result.record,
          amountCents: result.entry.amountCents,
          reason,
        };
      }
      ctx.logger.info(
        {
          paymentRecordId: recordId,
          refundId: refund.refundId,
          status: result.record.status,
          refundedAmount: result.record.refundedAmountCents,
        },
        'Refund confirmed via webhook',
      );
      return {
        kind: 'refund_succeeded',
        record: result.record,
        amountCents: result.entry.amountCents,
      };
    case 'already_settled':
      ctx.logger.info(
        { paymentRecordId: recordId, refundId: refund.refundId },
        'Refund webhook ignored: refund already settled',
      );
      return null;
    case 'not_refundable':
      ctx.logger.error(
        { paymentRecordId: recordId, refundId: refund.refundId, status: result.recordStatus },
        'Refund confirmed by the provider for a record that cannot take it; check the payment',
      );
      return null;
    case 'not_found':
      return null;
  }
}

/**
 * An authorisation the provider reports. A known payment is already
 * recorded (its own write came first). A guest checkout whose shopper
 * finished 3DS at the issuer but never returned is attached to its waiting
 * session, or cancelled when the session is gone (owner decision O4,
 * key `cancel_<paymentId>`). Other references (session holds, card
 * saves, top-ups, fees) are recorded by the request that made them.
 */
async function applyAuthorisation(
  providerId: PaymentProviderId,
  event: Extract<NormalizedPaymentEvent, { type: 'payment.authorized' }>,
  ctx: PaymentContext,
): Promise<PaymentWebhookNotice | null> {
  const record = await findByChargePaymentId(providerId, event.paymentId);
  if (record != null) return null;
  const reference = event.merchantReference;
  if (!reference.startsWith(GUEST_REFERENCE_PREFIX)) return null;
  const sessionToken = reference.slice(GUEST_REFERENCE_PREFIX.length);
  const attached = await attachGuestAuthorisation({
    provider: providerId,
    sessionToken,
    paymentId: event.paymentId,
  });
  if (attached === 'attached') {
    ctx.logger.info(
      { sessionToken, paymentId: event.paymentId },
      'Guest authorisation attached via webhook',
    );
    return null;
  }
  if (attached !== 'orphan') return null;
  try {
    const provider = await ctx.registry.getPaymentProvider(providerId);
    await provider.cancelHold({
      paymentId: event.paymentId,
      merchantReference: reference,
      idempotencyKey: cancelKey(event.paymentId),
    });
    ctx.logger.warn(
      { sessionToken, paymentId: event.paymentId },
      'Orphan guest authorisation cancelled',
    );
  } catch (err) {
    // The authorisation lapses by itself (P9 fail open).
    ctx.logger.warn(
      { err, sessionToken, paymentId: event.paymentId },
      'Failed to cancel an orphan guest authorisation; it expires by itself',
    );
  }
  return null;
}

/**
 * The result of an authorisation adjustment (P10 Part D). It settles the
 * session hold whose adjustment it answers (`matchPendingAdjustment`): a
 * raised hold captures the final cost, a refused one captures the hold and
 * charges the rest as a top-up. Any other adjustment event (a foreign
 * reference, a hold already settled) changes nothing.
 */
async function applyAdjustment(
  providerId: PaymentProviderId,
  event: Extract<NormalizedPaymentEvent, { type: 'payment.adjusted' }>,
  ctx: PaymentContext,
): Promise<PaymentWebhookNotice | null> {
  const record = await findByChargePaymentId(providerId, event.paymentId);
  if (record == null) return null;
  const ref = event.operationRef;
  const matched =
    ref != null && record.providerPaymentId === event.paymentId
      ? await matchPendingAdjustment(record.id, ref)
      : null;
  if (matched == null) {
    ctx.logger.info(
      { paymentRecordId: record.id, status: record.status, operationRef: ref },
      'Adjustment webhook ignored: no matching pending adjustment',
    );
    return null;
  }
  if (event.success) {
    ctx.logger.info(
      { paymentRecordId: record.id, authorizedCents: event.authorizedCents, operationRef: ref },
      'Authorisation adjusted via webhook; capturing the final cost',
    );
  } else {
    ctx.logger.warn(
      { paymentRecordId: record.id, operationRef: ref },
      'Authorisation adjustment refused; capturing the hold and charging the rest as a top-up',
    );
  }
  const outcome = await settleAdjustedHold(
    matched,
    { success: event.success, authorizedCents: event.authorizedCents },
    ctx,
  );
  if (outcome.mode !== 'card') return null;
  const now = await findRecord(record.id);
  if (now == null) return null;
  switch (outcome.status) {
    case 'captured':
      return outcome.recorded
        ? { kind: 'session_paid', record: now, amountCents: outcome.capturedCents }
        : { kind: 'record_changed', record: now };
    case 'failed':
      return { kind: 'capture_failed', record: now, reason: outcome.reason };
    case 'cancelled':
    case 'adjusting':
      return { kind: 'record_changed', record: now };
  }
}

/** The record as it is now, after the provider confirmed its capture. */
async function captureConfirmed(recordId: number): Promise<PaymentWebhookNotice | null> {
  const record = await findRecord(recordId);
  return record != null ? { kind: 'capture_confirmed', record } : null;
}

/** The record as it is now, for the operator UI refresh. */
async function changed(recordId: number): Promise<PaymentWebhookNotice | null> {
  const record = await findRecord(recordId);
  return record != null ? { kind: 'record_changed', record } : null;
}
