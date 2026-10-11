// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Session evidence: status and
 * stop reason,
 * the TransactionEvent trigger-reason timeline, the payment record status,
 * the station's cost against the CSMS cost, the first and last energy
 * readings and the linked authorize outcome. Every column is listed by name.
 * The payment failure text comes from the provider: untrusted.
 */

import { client, toIsoOrNull } from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import type { EvidenceItem, EvidencePack, UntrustedEvidence } from './pack.js';
import { untrustedString } from './pack.js';

export const SESSION_EVENT_LIMIT = 20;

export interface SessionFactsRow {
  id: string;
  station_id: string;
  site_id: string | null;
  status: string;
  stopped_reason: string | null;
  started_at: RawTimestamp;
  ended_at: RawTimestamp;
  energy_delivered_wh: string | null;
  final_cost_cents: number | null;
  current_cost_cents: number | null;
  station_cost_cents: number | null;
  station_cost_difference_cents: number | null;
  currency: string;
  is_roaming: boolean;
  token_id: string | null;
  updated_at: RawTimestamp;
}

export interface TransactionEventRow {
  id: number;
  event_type: string;
  trigger_reason: string;
  seq_no: number;
  offline: boolean;
  timestamp: RawTimestamp;
}

export interface PaymentRow {
  id: number;
  status: string;
  payment_source: string;
  pre_auth_amount_cents: number | null;
  captured_amount_cents: number | null;
  failure_reason: string | null;
}

export interface MeterReadingRow {
  id: number;
  value: string;
  unit: string | null;
  timestamp: RawTimestamp;
}

export interface LinkedAuthorizeRow {
  id: number;
  outcome: string;
  reason: string | null;
  token_type: string | null;
  created_at: RawTimestamp;
}

export interface SessionEvidenceRows {
  session: SessionFactsRow;
  events: TransactionEventRow[];
  payment: PaymentRow | null;
  firstReading: MeterReadingRow | null;
  lastReading: MeterReadingRow | null;
  authorize: LinkedAuthorizeRow | null;
}

export function buildSessionEvidence(rows: SessionEvidenceRows): EvidencePack {
  const s = rows.session;
  const items: EvidenceItem[] = [];
  const untrusted: UntrustedEvidence[] = [];
  for (const e of rows.events) {
    items.push({
      id: `tx:${String(e.id)}`,
      kind: 'transaction_event',
      data: {
        eventType: e.event_type,
        triggerReason: e.trigger_reason,
        seqNo: e.seq_no,
        offline: e.offline,
        at: toIsoOrNull(e.timestamp),
      },
    });
  }
  if (rows.payment != null) {
    const p = rows.payment;
    const id = `payment:${String(p.id)}`;
    items.push({
      id,
      kind: 'payment_record',
      data: {
        status: p.status,
        source: p.payment_source,
        preAuthAmountCents: p.pre_auth_amount_cents,
        capturedAmountCents: p.captured_amount_cents,
      },
    });
    const failure = untrustedString(id, 'payment_failure_reason', p.failure_reason);
    if (failure != null) untrusted.push(failure);
  }
  for (const [label, r] of [
    ['first', rows.firstReading],
    ['last', rows.lastReading],
  ] as const) {
    if (r == null) continue;
    items.push({
      id: `meter:${String(r.id)}`,
      kind: `${label}_energy_reading`,
      data: { value: r.value, unit: r.unit, at: toIsoOrNull(r.timestamp) },
    });
  }
  if (rows.authorize != null) {
    const a = rows.authorize;
    items.push({
      id: `auth:${String(a.id)}`,
      kind: 'authorize_attempt',
      data: {
        outcome: a.outcome,
        reason: a.reason,
        tokenType: a.token_type,
        at: toIsoOrNull(a.created_at),
      },
    });
  }
  return {
    subject: { type: 'session', id: s.id, siteId: s.site_id },
    facts: {
      status: s.status,
      stoppedReason: s.stopped_reason,
      startedAt: toIsoOrNull(s.started_at),
      endedAt: toIsoOrNull(s.ended_at),
      energyDeliveredWh: s.energy_delivered_wh,
      finalCostCents: s.final_cost_cents,
      currentCostCents: s.current_cost_cents,
      stationCostCents: s.station_cost_cents,
      stationCostDifferenceCents: s.station_cost_difference_cents,
      currency: s.currency,
      isRoaming: s.is_roaming,
    },
    items,
    untrusted,
  };
}

export async function loadSessionEvidenceRows(
  sessionId: string,
): Promise<SessionEvidenceRows | null> {
  const [session] = await client<SessionFactsRow[]>`
    SELECT s.id, s.station_id, cs.site_id, s.status::text AS status, s.stopped_reason,
      s.started_at, s.ended_at, s.energy_delivered_wh::text AS energy_delivered_wh,
      s.final_cost_cents, s.current_cost_cents, s.station_cost_cents,
      s.station_cost_difference_cents, s.currency, s.is_roaming, s.token_id, s.updated_at
    FROM charging_sessions s
    JOIN charging_stations cs ON cs.id = s.station_id
    WHERE s.id = ${sessionId}
  `;
  if (session == null) return null;
  const [events, payments, first, last, authorize] = await Promise.all([
    client<TransactionEventRow[]>`
      SELECT id, event_type::text AS event_type, trigger_reason, seq_no, offline, timestamp
      FROM transaction_events WHERE session_id = ${sessionId}
      ORDER BY timestamp DESC, id DESC LIMIT ${SESSION_EVENT_LIMIT}
    `,
    client<PaymentRow[]>`
      SELECT id, status::text AS status, payment_source, pre_auth_amount_cents,
        captured_amount_cents, failure_reason
      FROM payment_records WHERE session_id = ${sessionId} LIMIT 1
    `,
    client<MeterReadingRow[]>`
      SELECT id, value::text AS value, unit, timestamp FROM meter_values
      WHERE session_id = ${sessionId} AND measurand = 'Energy.Active.Import.Register'
      ORDER BY timestamp ASC, id ASC LIMIT 1
    `,
    client<MeterReadingRow[]>`
      SELECT id, value::text AS value, unit, timestamp FROM meter_values
      WHERE session_id = ${sessionId} AND measurand = 'Energy.Active.Import.Register'
      ORDER BY timestamp DESC, id DESC LIMIT 1
    `,
    // The attempt that started it: the matched token at this station, within
    // 10 minutes before the start (the authorize log's own correlation).
    session.token_id == null
      ? Promise.resolve([] as LinkedAuthorizeRow[])
      : client<LinkedAuthorizeRow[]>`
          SELECT a.id, a.outcome::text AS outcome, a.reason, a.token_type, a.created_at
          FROM authorize_attempts a
          JOIN charging_stations cs ON cs.station_id = a.station_id
          WHERE cs.id = ${session.station_id} AND a.matched_token_id = ${session.token_id}
            AND a.created_at <= coalesce(${toIsoOrNull(session.started_at)}::timestamptz, now())
            AND a.created_at > coalesce(${toIsoOrNull(session.started_at)}::timestamptz, now())
              - interval '10 minutes'
          ORDER BY a.created_at DESC LIMIT 1
        `,
  ]);
  return {
    session,
    events,
    payment: payments[0] ?? null,
    firstReading: first[0] ?? null,
    lastReading: last[0] ?? null,
    authorize: authorize[0] ?? null,
  };
}

export async function collectSessionEvidence(sessionId: string): Promise<{
  pack: EvidencePack;
  stoppedReason: string | null;
  stationId: string;
} | null> {
  const rows = await loadSessionEvidenceRows(sessionId);
  if (rows == null) return null;
  return {
    pack: buildSessionEvidence(rows),
    stoppedReason: rows.session.stopped_reason,
    stationId: rows.session.station_id,
  };
}
