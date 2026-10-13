// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Reservation evidence (v0.1.45, plan 2026-10-11 section 4.2): the
 * reservation (status, times, cancel reason, fee state, station
 * acknowledgement, EVSE), its audit rows, the OCPP reservation messages of its
 * station (ReserveNow and CancelReservation with their replies,
 * ReservationStatusUpdate, and the StatusNotifications of its EVSE in the
 * hold's window), the station facts (`station.ts`) and the fee payment
 * records. Every column is listed by name.
 *
 * - The driver appears only as a keyed hash (`driverRef`, HMAC with the server
 *   secret like the authorization subjects), never by id or name.
 * - OCPP messages carry the action and direction only. A status the station
 *   reported is a payload string: untrusted. ReserveNow requests carry the
 *   driver's token, so request payloads are never read.
 * - Payment records never carry provider ids; the failure text is untrusted.
 * - Audit notes can hold a station error or a provider message: untrusted.
 * - Site scope: the pack is the reservation's own station only.
 */

import { client, toIsoOrNull } from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import { reservationAuditReason } from '@evtivity/lib/ai-insights';
import type { EvidenceItem, EvidencePack, UntrustedEvidence } from './pack.js';
import { untrustedString } from './pack.js';
import { keyedSubjectHash } from '@evtivity/lib';
import { loadStationEvidenceRows, buildStationEvidence } from './station.js';
import type { StationEvidenceRows } from './station.js';

export const RESERVATION_AUDIT_LIMIT = 20;
export const RESERVATION_MESSAGE_LIMIT = 20;
export const RESERVATION_STATUS_NOTIFICATION_LIMIT = 10;

export interface ReservationFactsRow {
  id: string;
  reservation_id: number;
  station_id: string;
  site_id: string | null;
  evse_ocpp_id: number | null;
  driver_id: string | null;
  has_token: boolean;
  status: string;
  starts_at: RawTimestamp;
  expires_at: RawTimestamp;
  created_at: RawTimestamp;
  updated_at: RawTimestamp;
  cancelled_by: string | null;
  cancel_reason: string | null;
  station_ack_at: RawTimestamp;
  no_show_fee_state: string;
  cancellation_fee_cents: number;
}

export interface ReservationAuditRow {
  id: number;
  action: string;
  actor: string;
  after: unknown;
  notes: string | null;
  created_at: RawTimestamp;
}

export interface ReservationMessageRow {
  id: number;
  action: string | null;
  direction: string;
  message_type: number;
  /** The reported status of an inbound message (station supplied). */
  status: string | null;
  error_code: string | null;
  created_at: RawTimestamp;
}

export interface ReservationPaymentRow {
  id: number;
  charge_type: string;
  status: string;
  currency: string;
  pre_auth_amount_cents: number | null;
  captured_amount_cents: number | null;
  failure_reason: string | null;
}

export interface ReservationEvidenceRows {
  reservation: ReservationFactsRow;
  audit: ReservationAuditRow[];
  messages: ReservationMessageRow[];
  payments: ReservationPaymentRow[];
  station: StationEvidenceRows | null;
}

/**
 * A stable reference to the driver that cannot be matched to the driver id
 * without the server secret (`keyedSubjectHash`).
 */
export function driverRef(driverId: string | null, secret: string): string | null {
  if (driverId == null) return null;
  return `driver:${keyedSubjectHash(driverId, secret)}`;
}

/**
 * Builds the pack from the rows (pure, unit tested). `secret` keys the driver
 * hash (`SETTINGS_ENCRYPTION_KEY`).
 */
export function buildReservationEvidence(
  rows: ReservationEvidenceRows,
  now: Date,
  secret: string,
): EvidencePack {
  const r = rows.reservation;
  const items: EvidenceItem[] = [];
  const untrusted: UntrustedEvidence[] = [];
  for (const a of rows.audit) {
    const id = `audit:${String(a.id)}`;
    items.push({
      id,
      kind: 'reservation_audit',
      data: {
        action: a.action,
        actor: a.actor,
        reason: reservationAuditReason(a.after),
        at: toIsoOrNull(a.created_at),
      },
    });
    const notes = untrustedString(id, 'reservation_audit_note', a.notes);
    if (notes != null) untrusted.push(notes);
  }
  for (const m of rows.messages) {
    const id = `ocpp:${String(m.id)}`;
    items.push({
      id,
      kind: 'ocpp_message',
      data: {
        action: m.action,
        direction: m.direction,
        messageType: m.message_type === 2 ? 'call' : m.message_type === 3 ? 'result' : 'error',
        errorCode: m.error_code,
        at: toIsoOrNull(m.created_at),
      },
    });
    const status = untrustedString(id, 'station_reported_status', m.status);
    if (status != null) untrusted.push(status);
  }
  for (const p of rows.payments) {
    const id = `payment:${String(p.id)}`;
    items.push({
      id,
      kind: 'reservation_fee_payment',
      data: {
        chargeType: p.charge_type,
        status: p.status,
        currency: p.currency,
        preAuthAmountCents: p.pre_auth_amount_cents,
        capturedAmountCents: p.captured_amount_cents,
      },
    });
    const failure = untrustedString(id, 'payment_failure_reason', p.failure_reason);
    if (failure != null) untrusted.push(failure);
  }
  let stationFacts: Record<string, unknown> | null = null;
  if (rows.station != null) {
    const station = buildStationEvidence(rows.station, now);
    stationFacts = station.facts;
    items.push(...station.items);
    untrusted.push(...station.untrusted);
  }
  return {
    subject: { type: 'reservation', id: r.id, siteId: r.site_id },
    facts: {
      reservationId: r.reservation_id,
      status: r.status,
      startsAt: toIsoOrNull(r.starts_at),
      expiresAt: toIsoOrNull(r.expires_at),
      createdAt: toIsoOrNull(r.created_at),
      updatedAt: toIsoOrNull(r.updated_at),
      cancelledBy: r.cancelled_by,
      cancelReason: r.cancel_reason,
      stationAckAt: toIsoOrNull(r.station_ack_at),
      noShowFeeState: r.no_show_fee_state,
      cancellationFeeCents: r.cancellation_fee_cents,
      evseId: r.evse_ocpp_id,
      driverRef: driverRef(r.driver_id, secret),
      hasToken: r.has_token,
      station: stationFacts,
    },
    items,
    untrusted,
  };
}

/** Reads the reservation evidence rows; null when the reservation is gone. */
export async function loadReservationEvidenceRows(
  reservationId: string,
): Promise<ReservationEvidenceRows | null> {
  const [reservation] = await client<ReservationFactsRow[]>`
    SELECT r.id, r.reservation_id, r.station_id, cs.site_id, e.evse_id AS evse_ocpp_id,
      r.driver_id, r.token_id IS NOT NULL AS has_token, r.status::text AS status, r.starts_at,
      r.expires_at, r.created_at, r.updated_at, r.cancelled_by::text AS cancelled_by,
      r.cancel_reason::text AS cancel_reason, r.station_ack_at, r.no_show_fee_state,
      r.cancellation_fee_cents
    FROM reservations r
    JOIN charging_stations cs ON cs.id = r.station_id
    LEFT JOIN evses e ON e.id = r.evse_id
    WHERE r.id = ${reservationId}
  `;
  if (reservation == null) return null;
  const evse = reservation.evse_ocpp_id == null ? null : String(reservation.evse_ocpp_id);
  const [audit, messages, statusNotifications, payments, station] = await Promise.all([
    client<ReservationAuditRow[]>`
      SELECT id, action::text AS action, actor::text AS actor, after, notes, created_at
      FROM reservation_audit_log WHERE reservation_id = ${reservationId}
      ORDER BY id DESC LIMIT ${RESERVATION_AUDIT_LIMIT}
    `,
    // The reservation's own calls on its own station (the OCPP reservation id
    // is reused across stations), their replies, and ReservationStatusUpdate.
    client<ReservationMessageRow[]>`
      WITH calls AS (
        SELECT message_id FROM ocpp_message_logs
        WHERE station_id = ${reservation.station_id} AND message_type = 2
          AND action IN ('ReserveNow', 'CancelReservation', 'ReservationStatusUpdate')
          AND (
            (payload #>> '{}')::jsonb @> jsonb_build_object('id', ${reservation.reservation_id}::int)
            OR (payload #>> '{}')::jsonb
              @> jsonb_build_object('reservationId', ${reservation.reservation_id}::int)
          )
      )
      SELECT l.id, l.action, l.direction::text AS direction, l.message_type,
        CASE WHEN l.direction = 'inbound' THEN coalesce(
          (l.payload #>> '{}')::jsonb ->> 'status',
          (l.payload #>> '{}')::jsonb ->> 'reservationUpdateStatus'
        ) END AS status,
        l.error_code, l.created_at
      FROM ocpp_message_logs l
      WHERE l.station_id = ${reservation.station_id}
        AND l.message_id IN (SELECT message_id FROM calls)
      ORDER BY l.created_at DESC, l.id DESC LIMIT ${RESERVATION_MESSAGE_LIMIT}
    `,
    // The EVSE's StatusNotifications from shortly before the hold to its end.
    client<ReservationMessageRow[]>`
      SELECT l.id, l.action, l.direction::text AS direction, l.message_type,
        coalesce(l.payload ->> 'connectorStatus', l.payload ->> 'status') AS status,
        l.error_code, l.created_at
      FROM ocpp_message_logs l
      WHERE l.station_id = ${reservation.station_id} AND l.action = 'StatusNotification'
        AND l.direction = 'inbound' AND l.message_type = 2
        AND (${evse}::text IS NULL
          OR coalesce(l.payload ->> 'evseId', l.payload ->> 'connectorId') = ${evse})
        AND l.created_at >= ${toIsoOrNull(reservation.created_at)}::timestamptz - interval '5 minutes'
        AND l.created_at <= greatest(
          ${toIsoOrNull(reservation.expires_at)}::timestamptz,
          ${toIsoOrNull(reservation.updated_at)}::timestamptz
        ) + interval '5 minutes'
      ORDER BY l.created_at DESC, l.id DESC LIMIT ${RESERVATION_STATUS_NOTIFICATION_LIMIT}
    `,
    client<ReservationPaymentRow[]>`
      SELECT id, charge_type, status::text AS status, currency, pre_auth_amount_cents,
        captured_amount_cents, failure_reason
      FROM payment_records WHERE reservation_id = ${reservationId}
      ORDER BY id DESC
    `,
    loadStationEvidenceRows(reservation.station_id),
  ]);
  const ordered = [...messages, ...statusNotifications].sort(
    (a, b) =>
      (toIsoOrNull(b.created_at) ?? '').localeCompare(toIsoOrNull(a.created_at) ?? '') ||
      b.id - a.id,
  );
  return { reservation, audit, messages: ordered, payments, station };
}

export async function collectReservationEvidence(
  reservationId: string,
  secret: string,
  now: Date = new Date(),
): Promise<{ pack: EvidencePack; stationId: string } | null> {
  const rows = await loadReservationEvidenceRows(reservationId);
  if (rows == null) return null;
  return {
    pack: buildReservationEvidence(rows, now, secret),
    stationId: rows.reservation.station_id,
  };
}
