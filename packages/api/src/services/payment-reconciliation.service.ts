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
    return result;
  }

  const cutoff = new Date(Date.now() - lookbackHours * 3600_000);

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

    for (const record of recordsWithIntent) {
      const intentId = record.stripePaymentIntentId as string;
      result.checked++;

      try {
        const intent = await config.stripe.paymentIntents.retrieve(intentId);

        // Compare status
        const expectedLocalStatus = mapStripeStatusToLocal(intent.status);
        if (expectedLocalStatus != null && record.status !== expectedLocalStatus) {
          result.discrepancies.push({
            paymentRecordId: record.id,
            stripePaymentIntentId: intentId,
            field: 'status',
            localValue: record.status,
            stripeValue: intent.status + ' (expected local: ' + expectedLocalStatus + ')',
          });
          continue;
        }

        // Compare captured amount
        if (record.status === 'captured' && record.capturedAmountCents != null) {
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
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        result.errors.push('Failed to retrieve ' + intentId + ': ' + message);
      }
    }
  }

  return result;
}

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
