// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, paymentReconciliationRuns } from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { errorMessage } from './context.js';
import { PaymentProviderNotConfiguredError } from './errors.js';
import { recordsAwaitingConfirmation, recordsWithPayments } from './payment-records.js';
import type { PaymentRecord } from './payment-records.js';
import { paymentCharges } from './top-ups.js';
import type { PaymentCharge } from './top-ups.js';
import type {
  PaymentProvider,
  PaymentProviderId,
  PaymentStatus,
  ProviderPaymentState,
} from './types.js';

export interface ReconciliationDiscrepancy {
  paymentRecordId: number;
  /** The provider the record is pinned to. */
  provider: string;
  /** The provider payment that differs: the hold, or one of its top-ups. */
  providerPaymentId: string;
  field: string;
  localValue: string;
  providerValue: string;
  /**
   * Set only for `pending_confirmation`: an async operation or refund the
   * provider has not confirmed for 24 hours (its webhook may be lost or
   * misconfigured; check the provider's webhook log). Absent: the provider's
   * state differs from the record.
   */
  kind?: 'pending_confirmation';
  /** Deprecated: same as providerPaymentId; removed in P8. */
  stripePaymentIntentId: string;
  /** Deprecated: same as providerValue; removed in P8. */
  stripeValue: string;
}

export interface ReconciliationResult {
  checked: number;
  matched: number;
  discrepancies: ReconciliationDiscrepancy[];
  errors: string[];
}

const BATCH_SIZE = 200;

/** Statuses of a record whose payments were captured. */
const CAPTURED_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  'captured',
  'partially_refunded',
  'refunded',
]);

function discrepancy(
  record: PaymentRecord,
  provider: PaymentProviderId,
  paymentId: string,
  field: string,
  localValue: string,
  providerValue: string,
): ReconciliationDiscrepancy {
  return {
    paymentRecordId: record.id,
    provider,
    providerPaymentId: paymentId,
    field,
    localValue,
    providerValue,
    stripePaymentIntentId: paymentId,
    stripeValue: providerValue,
  };
}

type RecordLookup =
  | { kind: 'skipped' }
  | { kind: 'error'; paymentId: string; error: string }
  | {
      kind: 'read';
      record: PaymentRecord;
      provider: PaymentProviderId;
      states: Array<{ charge: PaymentCharge; state: ProviderPaymentState }>;
    };

/**
 * Compares payment records of the last `lookbackHours` with the provider each
 * is pinned to (its `provider` column), per charge (F14): the hold and each
 * top-up of `metadata.topUps` is read from the provider. The record status is
 * checked against the hold; the captured amount of each charge against what
 * the provider captured for it. Providers without a status lookup (async
 * providers, the simulated one) are skipped; their operations and refunds
 * that no webhook confirmed for 24 hours are reported as
 * `pending_confirmation` discrepancies instead. A provider that is not
 * configured in this process adds one error and its records are skipped.
 * Lookups run in parallel per batch of 200 records; a failed lookup is an
 * error, not a discrepancy.
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

  async function lookup(record: PaymentRecord): Promise<RecordLookup> {
    const holdId = record.providerPaymentId as string;
    if (record.provider == null) {
      return { kind: 'error', paymentId: holdId, error: 'Payment record has no provider' };
    }
    const provider = await providerFor(record.provider);
    if (provider?.getPaymentState == null || !provider.capabilities.stateLookup) {
      return { kind: 'skipped' };
    }
    const getState = provider.getPaymentState.bind(provider);
    const states: Array<{ charge: PaymentCharge; state: ProviderPaymentState }> = [];
    for (const charge of paymentCharges(record)) {
      try {
        states.push({ charge, state: await getState(charge.paymentId) });
      } catch (err) {
        return {
          kind: 'error',
          paymentId: charge.paymentId,
          error: errorMessage(err, 'Unknown error', 2000),
        };
      }
    }
    return { kind: 'read', record, provider: record.provider, states };
  }

  let lastId = 0;
  for (;;) {
    const batch = await recordsWithPayments(since, lastId, BATCH_SIZE);
    const last = batch[batch.length - 1];
    if (last == null) break;
    lastId = last.id;

    const lookups = await Promise.all(batch.map(lookup));

    for (const read of lookups) {
      if (read.kind === 'skipped') continue;
      result.checked++;
      if (read.kind === 'error') {
        result.errors.push(`Failed to retrieve ${read.paymentId}: ${read.error}`);
        ctx.logger.warn(
          { paymentId: read.paymentId, error: read.error },
          'Failed to read the payment during reconciliation',
        );
        continue;
      }
      const { record, provider, states } = read;
      const hold = states.find((s) => s.charge.kind === 'hold');
      const acceptable = hold?.state.acceptableLocalStatuses;
      if (hold != null && acceptable != null && !acceptable.has(record.status)) {
        result.discrepancies.push(
          discrepancy(
            record,
            provider,
            hold.charge.paymentId,
            'status',
            record.status,
            `${hold.state.providerStatus} (acceptable local: ${[...acceptable].join('|')})`,
          ),
        );
        continue;
      }
      // The received amount does not drop on refunds, so it also compares
      // for partially refunded and refunded records.
      let differs = false;
      if (CAPTURED_STATUSES.has(record.status) && record.capturedAmountCents != null) {
        for (const { charge, state } of states) {
          if (state.capturedCents == null || state.capturedCents === charge.capturedCents) continue;
          differs = true;
          result.discrepancies.push(
            discrepancy(
              record,
              provider,
              charge.paymentId,
              'capturedAmountCents',
              String(charge.capturedCents),
              String(state.capturedCents),
            ),
          );
        }
      }
      if (!differs) result.matched++;
    }
    if (batch.length < BATCH_SIZE) break;
  }

  await addPendingConfirmations(result, ctx);

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

/** An async operation or refund older than this without its webhook is reported. */
export const PENDING_CONFIRMATION_HOURS = 24;
/** Pending refunds are looked for in records of this many days. */
const PENDING_REFUND_LOOKBACK_DAYS = 90;
const PENDING_CONFIRMATION_LIMIT = 500;

/**
 * Async providers have no status lookup (`stateLookup: false`), so their
 * captures, cancels and refunds are confirmed only by webhook. One the
 * provider has not confirmed for PENDING_CONFIRMATION_HOURS is a
 * `pending_confirmation` discrepancy (warn): the webhook may be lost or
 * misconfigured, and the provider's webhook log tells what happened.
 */
async function addPendingConfirmations(
  result: ReconciliationResult,
  ctx: PaymentContext,
): Promise<void> {
  const olderThan = new Date(Date.now() - PENDING_CONFIRMATION_HOURS * 3600_000);
  const since = new Date(Date.now() - PENDING_REFUND_LOOKBACK_DAYS * 86_400_000);
  const records = await recordsAwaitingConfirmation(olderThan, since, PENDING_CONFIRMATION_LIMIT);
  for (const record of records) {
    const provider = record.provider ?? 'unknown';
    const paymentId = record.providerPaymentId ?? '';
    const found: ReconciliationDiscrepancy[] = [];
    if (
      record.pendingOperation != null &&
      record.pendingOperationAt != null &&
      record.pendingOperationAt < olderThan
    ) {
      found.push({
        ...discrepancy(
          record,
          provider,
          paymentId,
          'pendingOperation',
          `${record.pendingOperation} ${record.pendingOperationRef ?? ''} requested ${record.pendingOperationAt.toISOString()}`.trim(),
          'not confirmed by webhook',
        ),
        kind: 'pending_confirmation',
      });
    }
    for (const refund of record.providerRefunds) {
      if (refund.state !== 'pending' || new Date(refund.requestedAt) >= olderThan) continue;
      found.push({
        ...discrepancy(
          record,
          provider,
          refund.paymentId,
          'providerRefunds',
          `refund ${refund.refundId} of ${String(refund.amountCents)} requested ${refund.requestedAt}`,
          'not confirmed by webhook',
        ),
        kind: 'pending_confirmation',
      });
    }
    for (const d of found) {
      ctx.logger.warn(
        { paymentRecordId: record.id, provider, field: d.field, localValue: d.localValue },
        'Payment operation not confirmed by the provider for 24 hours; check its webhook log',
      );
    }
    result.discrepancies.push(...found);
  }
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
