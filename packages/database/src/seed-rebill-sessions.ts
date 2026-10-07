// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { DEFAULT_TAX_BASIS } from '@evtivity/lib';
import { writeAudit } from './lib/audit.js';
import { createId } from './lib/id.js';
import { SESSION_END_FAILED_REASON } from './lib/session-end-request.js';
import {
  faultUnbilledSession,
  openFirstTariffSegment,
  snapshotSessionTariff,
  type TariffPriceSnapshot,
} from './lib/session-pricing.js';
import { claimSessionRebill, completeRebilledSession, priceRebill } from './lib/session-rebill.js';
import { sessionAuditLog } from './schema/audit.js';

// Demo sessions for the re-bill states (the session detail Billing card): one
// session the CSMS gave up ending (faulted, stopped reason EndRequestFailed,
// cost zeroed, hold cancelled), which an operator can bill, and one an
// operator re-billed whose card was declined (completed, rebill_status
// manual). Both go through the real code paths: the tariff snapshot and
// first segment of the Started projection, the give-up of the OCPP session
// end sweep (faultUnbilledSession, segment closed without an end reading),
// and the re-bill (claim, price, complete). Idempotent (P7): the sessions are
// keyed by (station_id, transaction_id), and a rerun that finds them changes
// nothing.

/** The transaction ids of the demo re-bill sessions. */
export const REBILL_DEMO_TRANSACTIONS = {
  faulted: 'txn_rebill_faulted',
  manual: 'txn_rebill_manual',
} as const;

/** The CSMS end attempts before the sweep gives up (SESSION_END_MAX_ATTEMPTS in the OCPP server). */
const END_ATTEMPTS = 5;
const HOLD_CENTS = 5000;
const DECLINE_REASON = 'Your card was declined.';
const MINUTE_MS = 60_000;

export interface RebillDemoScenario {
  transactionId: string;
  startedAt: Date;
  /** When the sweep gave up ending the session (the fault time). */
  faultedAt: Date;
  meterStartWh: number;
  /** Energy.Active.Import.Register readings, the first at the start. */
  readings: Array<{ at: Date; registerWh: number }>;
}

function scenario(
  transactionId: string,
  startedAt: Date,
  meterStartWh: number,
  whPerReading: number,
): RebillDemoScenario {
  // A reading every 10 minutes for an hour, then the station went silent and
  // the CSMS gave up ending the session half an hour later.
  const readings = Array.from({ length: 7 }, (_, i) => ({
    at: new Date(startedAt.getTime() + i * 10 * MINUTE_MS),
    registerWh: meterStartWh + i * whPerReading,
  }));
  return {
    transactionId,
    startedAt,
    faultedAt: new Date(startedAt.getTime() + 90 * MINUTE_MS),
    meterStartWh,
    readings,
  };
}

/** The two demo scenarios, relative to the seed run. */
export function rebillDemoScenarios(now: Date): {
  faulted: RebillDemoScenario;
  manual: RebillDemoScenario;
} {
  return {
    faulted: scenario(
      REBILL_DEMO_TRANSACTIONS.faulted,
      new Date(now.getTime() - 3 * 60 * MINUTE_MS),
      120_000,
      3_000,
    ),
    manual: scenario(
      REBILL_DEMO_TRANSACTIONS.manual,
      new Date(now.getTime() - 26 * 60 * MINUTE_MS),
      340_000,
      4_000,
    ),
  };
}

export interface RebillDemoInput {
  stationId: string;
  evseId: string;
  driverId: string;
  /** The driver's default saved method (provider simulated). */
  customerId: string;
  methodId: string;
  currency: string;
  tariff: TariffPriceSnapshot;
  /** The operator the manual billing audit row names. */
  actorUserId: string | null;
  now: Date;
}

/**
 * A session the CSMS gave up ending, as the sweep leaves it. Null when it
 * already exists.
 */
async function seedGivenUpSession(
  sql: postgres.Sql,
  input: RebillDemoInput,
  plan: RebillDemoScenario,
): Promise<{ sessionId: string; paymentRecordId: number; holdId: string } | null> {
  const last = plan.readings[plan.readings.length - 1];
  const energyWh = (last?.registerWh ?? plan.meterStartWh) - plan.meterStartWh;
  const inserted = await sql`
    INSERT INTO charging_sessions (
      id, station_id, evse_id, driver_id, transaction_id, status, started_at,
      meter_start, energy_delivered_wh, currency, end_request_reason, end_attempts
    )
    VALUES (
      ${createId('session')}, ${input.stationId}, ${input.evseId}, ${input.driverId},
      ${plan.transactionId}, 'active', ${plan.startedAt}, ${plan.meterStartWh},
      ${energyWh}, ${input.currency}, 'GhostRecovered', ${END_ATTEMPTS}
    )
    ON CONFLICT (station_id, transaction_id) DO NOTHING
    RETURNING id
  `;
  const sessionId = inserted[0]?.id as string | undefined;
  if (sessionId == null) return null;

  // TransactionEvent Started: the tariff snapshot and the first segment.
  await snapshotSessionTariff(sql, sessionId, input.tariff, DEFAULT_TAX_BASIS);
  await openFirstTariffSegment(sql, sessionId, input.tariff, plan.startedAt);

  for (const reading of plan.readings) {
    await sql`
      INSERT INTO meter_values (
        station_id, evse_id, session_id, timestamp, measurand, unit, value, context, location
      )
      VALUES (
        ${input.stationId}, ${input.evseId}, ${sessionId}, ${reading.at},
        'Energy.Active.Import.Register', 'Wh', ${reading.registerWh},
        ${reading.at.getTime() === plan.startedAt.getTime() ? 'Transaction.Begin' : 'Sample.Periodic'},
        'Outlet'
      )
      ON CONFLICT DO NOTHING
    `;
  }

  // The payment gate's card hold, cancelled when the sweep gave up.
  const holdId = `pi_sim_${plan.transactionId}`;
  const [record] = await sql`
    INSERT INTO payment_records (
      session_id, driver_id, provider, provider_payment_id, provider_customer_id,
      provider_payment_method_id, payment_source, currency, pre_auth_amount_cents, status
    )
    VALUES (
      ${sessionId}, ${input.driverId}, 'simulated', ${holdId}, ${input.customerId},
      ${input.methodId}, 'web_portal', ${input.currency}, ${HOLD_CENTS}, 'cancelled'
    )
    ON CONFLICT (session_id) DO NOTHING
    RETURNING id
  `;

  // giveUpSessionEnd: fault unbilled, close the open segment without a reading.
  await faultUnbilledSession(sql, {
    sessionId,
    reason: SESSION_END_FAILED_REASON,
    endedAt: plan.faultedAt,
  });
  await sql`
    UPDATE session_tariff_segments
    SET ended_at = ${plan.faultedAt},
        duration_minutes = EXTRACT(EPOCH FROM (${plan.faultedAt}::timestamptz - started_at)) / 60
    WHERE session_id = ${sessionId} AND ended_at IS NULL
  `;
  return { sessionId, paymentRecordId: record?.id as number, holdId };
}

/**
 * Seeds the faulted session an operator can bill and the session left to
 * manual billing. Returns the session ids created (none on a rerun).
 */
export async function seedRebillSessions(
  sql: postgres.Sql,
  input: RebillDemoInput,
): Promise<string[]> {
  const plans = rebillDemoScenarios(input.now);
  const created: string[] = [];

  const faulted = await seedGivenUpSession(sql, input, plans.faulted);
  if (faulted != null) created.push(faulted.sessionId);

  const manual = await seedGivenUpSession(sql, input, plans.manual);
  if (manual == null) return created;
  created.push(manual.sessionId);

  // The operator's re-bill (session-rebill.service.ts): claim, price at the
  // last meter value, decline on the saved card, complete as manual.
  if (!(await claimSessionRebill(sql, manual.sessionId))) return created;
  const pricing = await priceRebill(sql, manual.sessionId);
  if (pricing == null) return created;
  const { breakdown, endedAt } = pricing;
  const requestedAt = new Date(plans.manual.faultedAt.getTime() + 2 * 60 * MINUTE_MS);
  const request = {
    provider: 'simulated',
    customerId: input.customerId,
    methodId: input.methodId,
    grossCents: breakdown.grossCents,
    currency: input.currency,
    feeTaxRate: Number(input.tariff.taxRate ?? 0),
    platformFeePercent: 0,
    payoutAccountId: null,
  };
  // claimRebillRecord takes over the cancelled hold's record, then the
  // decline marks it failed (markChargeFailed).
  await sql`
    UPDATE payment_records
    SET status = 'failed',
        provider_payment_id = NULL,
        pre_auth_amount_cents = NULL,
        captured_amount_cents = NULL,
        failure_reason = ${DECLINE_REASON},
        metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({
          rebill: {
            requestedAt: requestedAt.toISOString(),
            request,
            previousStatus: 'cancelled',
            previousProvider: 'simulated',
            previousPaymentId: manual.holdId,
            previousFailureReason: null,
          },
        })}::jsonb,
        updated_at = now()
    WHERE id = ${manual.paymentRecordId} AND status = 'cancelled'
  `;
  await completeRebilledSession(sql, {
    sessionId: manual.sessionId,
    breakdown,
    endedAt,
    outcome: 'manual',
  });
  await writeAudit(
    { table: sessionAuditLog, idColumn: 'session_id' },
    {
      entityId: manual.sessionId,
      entityIdSnapshot: manual.sessionId,
      action: 'manual_billing',
      actor: 'operator',
      actorUserId: input.actorUserId,
      before: { status: 'faulted', stoppedReason: SESSION_END_FAILED_REASON, finalCostCents: 0 },
      after: {
        status: 'completed',
        rebillStatus: 'manual',
        result: 'manual',
        manualReason: 'payment_failed',
        finalCostCents: breakdown.grossCents,
        currency: input.currency,
        endedAt: endedAt.toISOString(),
        paymentRecordId: manual.paymentRecordId,
        failureReason: DECLINE_REASON,
      },
      notes: null,
    },
  );
  return created;
}
