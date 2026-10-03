// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db, getPlatformFeePercent, getStripeClient } from '@evtivity/database';
import { chargeShortfallTopUp, isSimulatedCustomer, sessionChargeTax } from '@evtivity/lib';
import type { Logger } from 'pino';
import { config } from '../lib/config.js';

interface PaymentCaptureShortfallRow extends Record<string, unknown> {
  pr_id: number;
  stripe_payment_intent_id: string | null;
  stripe_customer_id: string | null;
  captured_amount_cents: number | null;
  currency: string;
  final_cost_cents: number | null;
  tariff_tax_rate: string | null;
  cost_breakdown: unknown;
  site_id: string | null;
  session_id: string;
}

/**
 * Daily reconciliation pass for payment captures with a recoverable shortfall.
 *
 * Triggered when the original capture path took the top-up branch and the
 * second PaymentIntent (the delta beyond pre-auth) failed. Those records are
 * left with `status='captured'`, `captured_amount_cents = preAuthAmount`, and
 * a `failure_reason` mentioning the shortfall. We retry the top-up against
 * the same card. Successful retries clear `failure_reason` and bring
 * `captured_amount_cents` up to the session final cost.
 *
 * Idempotent via Stripe idempotency keys. Safe to run multiple times: cards
 * still failing leave the record unchanged for the next pass.
 */
export async function paymentCaptureRetryHandler(log: Logger): Promise<void> {
  // Only consider recent records (last 30 days) so we don't keep retrying
  // ancient declines forever. Failed cards typically don't recover after a
  // month.
  const rows = await db.execute<PaymentCaptureShortfallRow>(sql`
    SELECT pr.id AS pr_id,
           pr.stripe_payment_intent_id,
           pr.stripe_customer_id,
           pr.captured_amount_cents,
           pr.currency,
           cs.final_cost_cents,
           cs.tariff_tax_rate, cs.cost_breakdown,
           st.site_id,
           cs.id AS session_id
    FROM payment_records pr
    JOIN charging_sessions cs ON cs.id = pr.session_id
    JOIN charging_stations st ON st.id = cs.station_id
    WHERE pr.status = 'captured'
      AND pr.failure_reason IS NOT NULL
      AND pr.failure_reason LIKE 'Top-up declined:%'
      AND pr.captured_amount_cents IS NOT NULL
      AND cs.final_cost_cents IS NOT NULL
      AND cs.final_cost_cents > pr.captured_amount_cents
      AND pr.created_at > now() - interval '30 days'
    ORDER BY pr.created_at ASC
    LIMIT 100
  `);

  if (rows.length === 0) {
    log.debug('No payment records with capture shortfall to retry');
    return;
  }

  log.info({ count: rows.length }, 'Retrying capture top-up for payment records with shortfall');

  // The shared, cached platform client (the same one the OCPP capture uses).
  const stripe = await getStripeClient(config.SETTINGS_ENCRYPTION_KEY);
  if (stripe == null) {
    log.warn('Stripe is not configured; cannot retry capture');
    return;
  }

  let recovered = 0;
  let stillFailed = 0;

  for (const row of rows) {
    const shortfall = (row.final_cost_cents ?? 0) - (row.captured_amount_cents ?? 0);
    if (shortfall <= 0) continue;
    if (row.stripe_payment_intent_id == null) continue;
    if (row.stripe_customer_id != null && isSimulatedCustomer(row.stripe_customer_id)) continue;

    try {
      // Same card, same connected account, and the platform fee of the
      // increment on its net amount, as the capture on session end charges.
      const topUp = await chargeShortfallTopUp(stripe, {
        originalIntentId: row.stripe_payment_intent_id,
        capturedCents: row.captured_amount_cents ?? 0,
        finalCostCents: row.final_cost_cents ?? 0,
        taxRate: sessionChargeTax({
          finalCostCents: row.final_cost_cents,
          tariffTaxRate: row.tariff_tax_rate,
          costBreakdown: row.cost_breakdown,
        }),
        platformFeePercent: await getPlatformFeePercent(row.site_id),
        currency: row.currency,
        description: `Capture retry for session ${row.session_id}`,
        idempotencyKey: `topup_retry_${String(row.pr_id)}_${String(row.captured_amount_cents)}`,
      });

      await db.execute(sql`
        UPDATE payment_records
        SET captured_amount_cents = ${row.final_cost_cents},
            failure_reason = NULL,
            last_action_reason = ${`Cron retry top-up; recovered ${String(shortfall)}c via ${topUp.id}`},
            updated_at = now()
        WHERE id = ${row.pr_id}
      `);
      recovered++;
      log.info(
        { paymentRecordId: row.pr_id, shortfall, topUpIntentId: topUp.id },
        'Recovered capture shortfall via cron retry',
      );
    } catch (err: unknown) {
      stillFailed++;
      const message = err instanceof Error ? err.message.slice(0, 350) : 'Unknown error';
      log.warn(
        { paymentRecordId: row.pr_id, shortfall, err },
        'Capture retry failed; will try again next run',
      );
      await db
        .execute(
          sql`
          UPDATE payment_records
          SET failure_reason = ${`Top-up declined: ${message}; shortfall ${String(shortfall)}c (last retry ${new Date().toISOString()})`},
              updated_at = now()
          WHERE id = ${row.pr_id}
        `,
        )
        .catch((updateErr: unknown) => {
          // Non-critical: the record keeps its previous failure_reason and
          // is retried on the next run (P9, fail-open with a warning).
          log.warn(
            { err: updateErr, paymentRecordId: row.pr_id },
            'Failed to record the capture retry failure reason',
          );
        });
    }
  }

  log.info({ recovered, stillFailed, total: rows.length }, 'Capture retry pass complete');
}
