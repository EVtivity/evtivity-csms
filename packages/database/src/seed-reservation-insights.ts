// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import {
  AI_INSIGHT_SETTING_KEYS,
  INSIGHT_KIND_FALLBACKS,
  RESERVATION_INSIGHT_TRIGGERS,
  reservationRuleInsightFor,
} from '@evtivity/lib/ai-insights';
import type {
  InsightConfidence,
  ReservationInsightKind,
  ReservationInsightTriggerAction,
  RuleInsight,
} from '@evtivity/lib/ai-insights';
import { isUiLanguage } from '@evtivity/lib';
import { createId } from './lib/id.js';
import { writeReservationAudit } from './lib/reservation-audit.js';
import type { ReservationAuditAction } from './lib/reservation-audit.js';
import { computeInsightScopeCounts } from './lib/insight-scope.js';

// Demo reservation insights (the Reservations and AI insights pages): one
// reservation audit trigger row of each kind, on reservations in the state
// the real code path leaves them, and the rule insight the worker stores for
// it, so a fresh demo stack shows reservation insights without a model call.
// The trigger rows are written by writeReservationAudit (reason in
// after.reason) and the insights have the shape of the insight scan
// (subject reservation, trigger key `<kind>:<audit id>`) and of a rule
// insight of generateInsight (status open, generated_by rule, no text row).
// A station fault during a hold has no known cause, so it gets the kind's
// fallback at confidence low, as the worker stores it without a model.
// Idempotent (P7): fixed reservation ids, an audit row is written only when
// its reservation has none of that action, the fee record is unique per
// reservation and charge type, and insights skip a trigger key seen before.

/** The fixed ids of the demo reservations (`rsv_` plus 12 characters). */
export const RESERVATION_INSIGHT_DEMO_IDS = {
  rejected: 'rsv_aidemo000001',
  cancelFailed: 'rsv_aidemo000002',
  stationFaulted: 'rsv_aidemo000003',
  noShowFeeFailed: 'rsv_aidemo000004',
} as const;

const MINUTE_MS = 60_000;
const NO_SHOW_FEE_DECLINE = 'Your card was declined.';

export interface DemoAuditTrigger {
  action: ReservationAuditAction;
  actor: 'operator' | 'system';
  statusBefore?: string;
  statusAfter?: string;
  reason: string;
  notes?: string;
}

export interface DemoReservation {
  id: string;
  /** The OCPP reservation id. */
  ocppId: number;
  status: 'cancelled' | 'expired';
  cancelledBy: 'operator' | 'system' | null;
  cancelReason: string | null;
  noShowFeeState: 'none' | 'failed';
  createdAt: Date;
  expiresAt: Date;
  /** When the station accepted ReserveNow; null when it never did. */
  stationAckAt: Date | null;
  /** The audit rows, in order. */
  audits: DemoAuditTrigger[];
  /** A declined no-show fee record. */
  declinedNoShowFee: boolean;
}

/** The demo reservations, relative to the seed run. */
export function reservationInsightDemoPlan(now: Date): DemoReservation[] {
  const ago = (minutes: number): Date => new Date(now.getTime() - minutes * MINUTE_MS);
  return [
    {
      // The station refused ReserveNow: the EVSE was occupied.
      id: RESERVATION_INSIGHT_DEMO_IDS.rejected,
      ocppId: 9001,
      status: 'cancelled',
      cancelledBy: 'system',
      cancelReason: 'station_rejected_occupied',
      noShowFeeState: 'none',
      createdAt: ago(300),
      expiresAt: ago(240),
      stationAckAt: null,
      audits: [
        {
          action: 'station_rejected',
          actor: 'system',
          statusBefore: 'active',
          statusAfter: 'cancelled',
          reason: 'station_rejected_occupied',
        },
      ],
      declinedNoShowFee: false,
    },
    {
      // An operator cancel the offline station could not receive.
      id: RESERVATION_INSIGHT_DEMO_IDS.cancelFailed,
      ocppId: 9002,
      status: 'cancelled',
      cancelledBy: 'operator',
      cancelReason: 'operator_manual',
      noShowFeeState: 'none',
      createdAt: ago(240),
      expiresAt: ago(150),
      stationAckAt: ago(239),
      audits: [
        {
          action: 'cancelled',
          actor: 'operator',
          statusBefore: 'active',
          statusAfter: 'cancelled',
          reason: 'operator_manual',
        },
        {
          action: 'station_cancel_failed',
          actor: 'system',
          reason: 'station_offline',
          notes: 'station offline',
        },
      ],
      declinedNoShowFee: false,
    },
    {
      // The station faulted while it held the EVSE: cancelled as system, no fee.
      id: RESERVATION_INSIGHT_DEMO_IDS.stationFaulted,
      ocppId: 9003,
      status: 'cancelled',
      cancelledBy: 'system',
      cancelReason: 'station_unavailable_during_hold',
      noShowFeeState: 'none',
      createdAt: ago(180),
      expiresAt: ago(90),
      stationAckAt: ago(179),
      audits: [
        {
          action: 'station_faulted',
          actor: 'system',
          statusBefore: 'active',
          statusAfter: 'cancelled',
          reason: 'station_unavailable_during_hold',
          notes: 'station faulted',
        },
      ],
      declinedNoShowFee: false,
    },
    {
      // A no-show: the station accepted the hold, the driver never came, and
      // the no-show fee was declined.
      id: RESERVATION_INSIGHT_DEMO_IDS.noShowFeeFailed,
      ocppId: 9004,
      status: 'expired',
      cancelledBy: null,
      cancelReason: null,
      noShowFeeState: 'failed',
      createdAt: ago(150),
      expiresAt: ago(60),
      stationAckAt: ago(149),
      audits: [
        {
          action: 'expired',
          actor: 'system',
          statusBefore: 'active',
          statusAfter: 'expired',
          reason: 'no_show',
        },
        { action: 'fee_failed', actor: 'system', reason: 'declined' },
      ],
      declinedNoShowFee: true,
    },
  ];
}

/**
 * The insight the worker stores for a trigger row without a model: the rule
 * of a known cause (confidence high), else the kind's fallback (confidence low).
 */
export function demoRuleInsight(
  action: ReservationInsightTriggerAction,
  reason: string,
): { kind: ReservationInsightKind; rule: RuleInsight; confidence: InsightConfidence } {
  const kind = RESERVATION_INSIGHT_TRIGGERS[action];
  const rule = reservationRuleInsightFor(action, reason);
  return rule != null
    ? { kind, rule, confidence: 'high' }
    : { kind, rule: INSIGHT_KIND_FALLBACKS[kind], confidence: 'low' };
}

function isTriggerAction(action: string): action is ReservationInsightTriggerAction {
  return Object.hasOwn(RESERVATION_INSIGHT_TRIGGERS, action);
}

export interface ReservationInsightDemoInput {
  stationId: string;
  evseId: string | null;
  driverId: string;
  currency: string;
  now: Date;
}

async function primaryLanguage(sql: postgres.Sql): Promise<string> {
  const [row] = await sql<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = ${AI_INSIGHT_SETTING_KEYS.primaryLanguage}
  `;
  return isUiLanguage(row?.value) ? row.value : 'en';
}

/** The id of the reservation's first audit row of an action, writing it when missing. */
async function ensureAudit(
  sql: postgres.Sql,
  reservation: DemoReservation,
  driverId: string,
  audit: DemoAuditTrigger,
  notes: string | null,
): Promise<number> {
  const find = async (): Promise<number | undefined> => {
    const [row] = await sql<{ id: number }[]>`
      SELECT id FROM reservation_audit_log
      WHERE reservation_id = ${reservation.id} AND action::text = ${audit.action}
      ORDER BY id LIMIT 1
    `;
    return row?.id;
  };
  const existing = await find();
  if (existing != null) return existing;
  await writeReservationAudit({
    reservationId: reservation.id,
    action: audit.action,
    actor: audit.actor,
    ...(audit.statusBefore != null
      ? {
          driverIdBefore: driverId,
          driverIdAfter: driverId,
          statusBefore: audit.statusBefore,
          statusAfter: audit.statusAfter ?? null,
        }
      : {}),
    reason: audit.reason,
    notes,
  });
  const id = await find();
  if (id == null) {
    throw new Error(`Demo reservation audit row ${audit.action} for ${reservation.id} not written`);
  }
  return id;
}

/** The declined no-show fee record of a reservation (one per reservation and charge type). */
async function ensureDeclinedNoShowFee(
  sql: postgres.Sql,
  reservationId: string,
  input: ReservationInsightDemoInput,
): Promise<number> {
  const [method] = await sql<{ provider: string; customer_id: string; method_id: string }[]>`
    SELECT provider, provider_customer_id AS customer_id,
      provider_payment_method_id AS method_id
    FROM driver_payment_methods
    WHERE driver_id = ${input.driverId} AND is_default
    LIMIT 1
  `;
  await sql`
    INSERT INTO payment_records (
      driver_id, provider, provider_customer_id, provider_payment_method_id, payment_source,
      currency, tax_rate, status, failure_reason, charge_type, reservation_id
    )
    VALUES (
      ${input.driverId}, ${method?.provider ?? 'simulated'}, ${method?.customer_id ?? null},
      ${method?.method_id ?? null}, 'operator', ${input.currency}, '0', 'failed',
      ${NO_SHOW_FEE_DECLINE}, 'reservation_no_show', ${reservationId}
    )
    ON CONFLICT (reservation_id, charge_type) WHERE reservation_id IS NOT NULL DO NOTHING
  `;
  const [row] = await sql<{ id: number }[]>`
    SELECT id FROM payment_records
    WHERE reservation_id = ${reservationId} AND charge_type = 'reservation_no_show'
  `;
  if (row == null) throw new Error(`Demo no-show fee record for ${reservationId} not written`);
  return row.id;
}

/**
 * Seeds the demo reservations, their trigger audit rows and the stored rule
 * insights. Returns the number of insights it created (0 on a rerun).
 */
export async function seedReservationInsightsDemo(
  sql: postgres.Sql,
  input: ReservationInsightDemoInput,
): Promise<number> {
  const [station] = await sql<{ site_id: string | null }[]>`
    SELECT site_id FROM charging_stations WHERE id = ${input.stationId}
  `;
  if (station == null) throw new Error(`Demo station ${input.stationId} not found`);
  const siteId = station.site_id;
  const language = await primaryLanguage(sql);
  // The same query as the insight analysis (computeInsightScope in @evtivity/services).
  const scope = await computeInsightScopeCounts({ siteId }, sql);

  let created = 0;
  for (const r of reservationInsightDemoPlan(input.now)) {
    await sql`
      INSERT INTO reservations (
        id, reservation_id, station_id, evse_id, driver_id, status, expires_at, created_at,
        updated_at, cancelled_by, cancel_reason, station_ack_at, no_show_fee_state
      )
      VALUES (
        ${r.id}, ${r.ocppId}, ${input.stationId}, ${input.evseId}, ${input.driverId},
        ${r.status}, ${r.expiresAt}, ${r.createdAt}, ${input.now}, ${r.cancelledBy},
        ${r.cancelReason}, ${r.stationAckAt}, ${r.noShowFeeState}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    const feeRecordId = r.declinedNoShowFee
      ? await ensureDeclinedNoShowFee(sql, r.id, input)
      : null;

    for (const audit of r.audits) {
      const notes =
        audit.action === 'fee_failed' && feeRecordId != null
          ? `no-show fee, payment record ${String(feeRecordId)}: ${NO_SHOW_FEE_DECLINE}`
          : (audit.notes ?? null);
      const auditId = await ensureAudit(sql, r, input.driverId, audit, notes);
      if (!isTriggerAction(audit.action)) continue;

      const { kind, rule, confidence } = demoRuleInsight(audit.action, audit.reason);
      const inserted = await sql`
        INSERT INTO ai_insights (
          id, kind, subject_type, subject_id, station_id, reservation_id, site_id, trigger_key,
          status, category, confidence, fixes, scope, evidence_refs, basis_at, primary_language,
          generated_by
        )
        VALUES (
          ${createId('aiInsight')}, ${kind}, 'reservation', ${r.id}, ${input.stationId}, ${r.id},
          ${siteId}, ${`${kind}:${String(auditId)}`}, 'open', ${rule.category}, ${confidence},
          ${sql.json(rule.fixes.map((code) => ({ code })))}, ${sql.json(scope)}, ${sql.json([])},
          ${input.now}, ${language}, 'rule'
        )
        ON CONFLICT ON CONSTRAINT uq_ai_insights_trigger DO NOTHING
        RETURNING id
      `;
      created += inserted.length;
    }
  }
  return created;
}
