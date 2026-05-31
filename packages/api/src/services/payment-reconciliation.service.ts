// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, gte, isNotNull, gt, asc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { paymentRecords } from '@evtivity/database';
import type { FastifyBaseLogger } from 'fastify';
import { getStripeConfig } from './stripe.service.js';

export interface ReconciliationResult {
  checked: number;
  matched: number;
  discrepancies: ReconciliationDiscrepancy[];
  errors: string[];
}

export interface ReconciliationDiscrepancy {
  paymentRecordId: number;
  stripePaymentIntentId: string;
  field: string;
  localValue: string;
  stripeValue: string;
}

const RECONCILIATION_BATCH_SIZE = 200;

export async function reconcilePayments(
  log: FastifyBaseLogger,
  lookbackHours: number = 48,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    checked: 0,
    matched: 0,
    discrepancies: [],
    errors: [],
  };

  const config = await getStripeConfig(null);
  if (config == null) {
    result.errors.push('Stripe not configured');
    log.warn('Payment reconciliation skipped: Stripe not configured');
    return result;
  }

  const cutoff = new Date(Date.now() - lookbackHours * 3600_000);
  log.info({ lookbackHours, cutoff }, 'Payment reconciliation started');

  // Process payment records in batches using cursor-based pagination
  let lastId = 0;
  let hasMore = true;

  while (hasMore) {
    const batch = await db
      .select()
      .from(paymentRecords)
      .where(
        and(
          gte(paymentRecords.createdAt, cutoff),
          isNotNull(paymentRecords.stripePaymentIntentId),
          gt(paymentRecords.id, lastId),
        ),
      )
      .orderBy(asc(paymentRecords.id))
      .limit(RECONCILIATION_BATCH_SIZE);

    if (batch.length === 0) {
      hasMore = false;
      break;
    }

    const lastRecord = batch[batch.length - 1];
    if (lastRecord == null) break;
    lastId = lastRecord.id;
    if (batch.length < RECONCILIATION_BATCH_SIZE) {
      hasMore = false;
    }

    // Filter to only records with actual stripe payment intent IDs
    const recordsWithIntent = batch.filter(
      (r) => r.stripePaymentIntentId != null && r.stripePaymentIntentId !== '',
    );

    // Each Stripe API call is ~100-200ms over the network. Sequential
    // awaits on a 200-record batch take 20-40s; parallel fetches finish
    // in ~200ms total. Stripe rate-limits at 100 reqs/sec by default,
    // well above one batch worth of intents.
    const intentResults = await Promise.all(
      recordsWithIntent.map(async (record) => {
        const intentId = record.stripePaymentIntentId as string;
        try {
          const intent = await config.stripe.paymentIntents.retrieve(intentId);
          return { record, intentId, intent, error: null as string | null };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          return { record, intentId, intent: null, error: message };
        }
      }),
    );

    for (const { record, intentId, intent, error } of intentResults) {
      result.checked++;

      if (error != null || intent == null) {
        result.errors.push('Failed to retrieve ' + intentId + ': ' + (error ?? 'unknown'));
        log.warn({ intentId, error }, 'Failed to retrieve PaymentIntent during reconciliation');
        continue;
      }

      const acceptable = acceptableLocalStatusesForStripe(intent.status);
      if (acceptable != null && !acceptable.has(record.status)) {
        result.discrepancies.push({
          paymentRecordId: record.id,
          stripePaymentIntentId: intentId,
          field: 'status',
          localValue: record.status,
          stripeValue: intent.status + ' (acceptable local: ' + [...acceptable].join('|') + ')',
        });
        continue;
      }

      // Verify captured amount for captured/refunded states. Stripe's
      // amount_received doesn't decrease on refunds, so the comparison is
      // valid for partially_refunded and refunded local statuses too.
      if (
        (record.status === 'captured' ||
          record.status === 'partially_refunded' ||
          record.status === 'refunded') &&
        record.capturedAmountCents != null
      ) {
        const stripeAmount = intent.amount_received;
        if (stripeAmount !== record.capturedAmountCents) {
          result.discrepancies.push({
            paymentRecordId: record.id,
            stripePaymentIntentId: intentId,
            field: 'capturedAmountCents',
            localValue: String(record.capturedAmountCents),
            stripeValue: String(stripeAmount),
          });
          continue;
        }
      }

      result.matched++;
    }
  }

  log.info(
    {
      checked: result.checked,
      matched: result.matched,
      discrepancies: result.discrepancies.length,
      errors: result.errors.length,
    },
    'Payment reconciliation completed',
  );

  return result;
}

// Returns the set of local payment_records.status values that legitimately
// correspond to a given Stripe PaymentIntent.status. Multiple local statuses
// per Stripe status because refunds and pre-auth declines diverge from the
// intent's view: a refund keeps the intent at 'succeeded'; a pre-auth decline
// can leave the intent 'canceled' or absent depending on how it was cleaned up.
export function acceptableLocalStatusesForStripe(stripeStatus: string): Set<string> | null {
  const map: Record<string, Set<string>> = {
    requires_payment_method: new Set(['pending']),
    requires_confirmation: new Set(['pending']),
    requires_action: new Set(['pending']),
    processing: new Set(['pending']),
    requires_capture: new Set(['pre_authorized']),
    succeeded: new Set(['captured', 'partially_refunded', 'refunded']),
    canceled: new Set(['cancelled', 'failed']),
  };
  return map[stripeStatus] ?? null;
}

// Kept for backward compatibility (callers that want the canonical local
// status for a Stripe state). Returns the "primary" expected local status.
export function mapStripeStatusToLocal(stripeStatus: string): string | null {
  const map: Record<string, string> = {
    requires_payment_method: 'pending',
    requires_confirmation: 'pending',
    requires_action: 'pending',
    processing: 'pending',
    requires_capture: 'pre_authorized',
    succeeded: 'captured',
    canceled: 'cancelled',
  };
  return map[stripeStatus] ?? null;
}
