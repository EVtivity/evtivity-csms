// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, paymentReconciliationRuns } from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { errorMessage } from './context.js';
import { PaymentProviderNotConfiguredError } from './errors.js';
import { providerOfStoredIds } from './pinning.js';
import { recordsWithPayments } from './payment-records.js';
import type { PaymentProvider, PaymentProviderId } from './types.js';

export interface ReconciliationDiscrepancy {
  paymentRecordId: number;
  /** The provider payment id (the column keeps its Stripe name until P4). */
  stripePaymentIntentId: string;
  field: string;
  localValue: string;
  stripeValue: string;
}

export interface ReconciliationResult {
  checked: number;
  matched: number;
  discrepancies: ReconciliationDiscrepancy[];
  errors: string[];
}

const BATCH_SIZE = 200;

/**
 * Compares payment records of the last `lookbackHours` with the provider each
 * is pinned to. Providers without a status lookup (async providers, the
 * simulated one) are skipped. A provider that is not configured in this
 * process adds one error and its records are skipped. Lookups run in
 * parallel per batch of 200; a failed lookup is an error, not a discrepancy.
 */
export async function reconcilePayments(
  ctx: PaymentContext,
  lookbackHours = 48,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { checked: 0, matched: 0, discrepancies: [], errors: [] };
  const since = new Date(Date.now() - lookbackHours * 3600_000);
  ctx.logger.info({ lookbackHours, since }, 'Payment reconciliation started');

  // One lookup per provider, shared by the parallel reads of a batch.
  const providers = new Map<PaymentProviderId, Promise<PaymentProvider | null>>();
  function providerFor(id: PaymentProviderId): Promise<PaymentProvider | null> {
    let pending = providers.get(id);
    if (pending == null) {
      pending = ctx.registry.getPaymentProvider(id).catch((err: unknown) => {
        if (!(err instanceof PaymentProviderNotConfiguredError)) throw err;
        result.errors.push(`Payment provider ${id} not configured`);
        ctx.logger.warn(
          { provider: id },
          'Payment reconciliation skipped: provider not configured',
        );
        return null;
      });
      providers.set(id, pending);
    }
    return pending;
  }

  let lastId = 0;
  for (;;) {
    const batch = await recordsWithPayments(since, lastId, BATCH_SIZE);
    const last = batch[batch.length - 1];
    if (last == null) break;
    lastId = last.id;

    const lookups = await Promise.all(
      batch.map(async (record) => {
        const paymentId = record.stripePaymentIntentId as string;
        const provider = await providerFor(
          providerOfStoredIds({ customerId: record.stripeCustomerId, paymentId }),
        );
        if (provider?.getPaymentState == null || !provider.capabilities.stateLookup) {
          return { kind: 'skipped' as const };
        }
        try {
          const state = await provider.getPaymentState(paymentId);
          return { kind: 'read' as const, record, paymentId, state };
        } catch (err) {
          return {
            kind: 'error' as const,
            paymentId,
            error: errorMessage(err, 'Unknown error', 2000),
          };
        }
      }),
    );

    for (const lookup of lookups) {
      if (lookup.kind === 'skipped') continue;
      result.checked++;
      if (lookup.kind === 'error') {
        result.errors.push(`Failed to retrieve ${lookup.paymentId}: ${lookup.error}`);
        ctx.logger.warn(
          { paymentId: lookup.paymentId, error: lookup.error },
          'Failed to read the payment during reconciliation',
        );
        continue;
      }
      const { record, paymentId, state } = lookup;
      const acceptable = state.acceptableLocalStatuses;
      if (acceptable != null && !acceptable.has(record.status)) {
        result.discrepancies.push({
          paymentRecordId: record.id,
          stripePaymentIntentId: paymentId,
          field: 'status',
          localValue: record.status,
          stripeValue: `${state.providerStatus} (acceptable local: ${[...acceptable].join('|')})`,
        });
        continue;
      }
      // The received amount does not drop on refunds, so it also compares
      // for partially refunded and refunded records.
      if (
        (record.status === 'captured' ||
          record.status === 'partially_refunded' ||
          record.status === 'refunded') &&
        record.capturedAmountCents != null &&
        state.capturedCents != null &&
        state.capturedCents !== record.capturedAmountCents
      ) {
        result.discrepancies.push({
          paymentRecordId: record.id,
          stripePaymentIntentId: paymentId,
          field: 'capturedAmountCents',
          localValue: String(record.capturedAmountCents),
          stripeValue: String(state.capturedCents),
        });
        continue;
      }
      result.matched++;
    }
    if (batch.length < BATCH_SIZE) break;
  }

  ctx.logger.info(
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

/** Runs reconciliation and stores the run (`payment_reconciliation_runs`). */
export async function runPaymentReconciliation(ctx: PaymentContext): Promise<ReconciliationResult> {
  const result = await reconcilePayments(ctx);
  await db.insert(paymentReconciliationRuns).values({
    checkedCount: result.checked,
    matchedCount: result.matched,
    discrepancyCount: result.discrepancies.length,
    errorCount: result.errors.length,
    discrepancies: result.discrepancies,
    errors: result.errors.length > 0 ? result.errors : null,
  });
  return result;
}
