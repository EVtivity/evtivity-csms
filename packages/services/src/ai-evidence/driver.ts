// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Driver support evidence (driver AI support, plan v0.1.45 section 2.5):
 * the pack one support case analysis reads. Strict scope (threats T1, T10):
 * the driver id comes from the case row only, never from a request or the
 * model; every query first selects rows owned by that driver, then reads
 * whitelisted columns listed by name. Data window (decision E9): the case's
 * linked sessions plus the driver's last 10 sessions in 30 days, payments and
 * reservations in 30 days, the driver's tokens masked to the last 4
 * characters, and the stations of those rows (public identity, site name,
 * current availability, last fault time). The case station appears only when
 * the driver has a session or reservation there.
 *
 * Left out by design: internal notes, operator messages, the assignee,
 * provider payment and customer ids, full token values, group ids, meter
 * values, tariff internals, vendor error text, firmware, configuration and
 * other drivers' rows. Driver-written text (subject, description) and the
 * provider's payment failure text go only into the untrusted list.
 */

import { client, stationAvailabilitySql, toIsoOrNull } from '@evtivity/database';
import type { RawTimestamp } from '@evtivity/database';
import type { EvidenceItem, EvidencePack, UntrustedEvidence } from './pack.js';
import { untrustedString } from './pack.js';

/** The driver's own recent sessions added to the linked ones (E9). */
export const DRIVER_EVIDENCE_RECENT_SESSIONS = 10;
/** Days of sessions, payments and reservations in the pack (E9). */
export const DRIVER_EVIDENCE_WINDOW_DAYS = 30;
/** Most payments and reservations in the pack. */
export const DRIVER_EVIDENCE_ROW_LIMIT = 20;

export interface DriverCaseRow {
  id: string;
  driver_id: string | null;
  station_id: string | null;
  category: string;
  subject: string;
  description: string;
  created_at: RawTimestamp;
}

export interface DriverSessionRow {
  id: string;
  linked: boolean;
  station_id: string;
  station_identity: string;
  site_name: string | null;
  evse_number: number | null;
  connector_type: string | null;
  status: string;
  stopped_reason: string | null;
  started_at: RawTimestamp;
  ended_at: RawTimestamp;
  energy_delivered_wh: string | null;
  final_cost_cents: number | null;
  current_cost_cents: number | null;
  currency: string;
  payment_status: string | null;
}

export interface DriverTokenRow {
  id: string;
  token_type: string;
  id_token: string;
  is_active: boolean;
  prepaid_balance_cents: number | null;
}

export interface DriverPaymentRow {
  id: number;
  charge_type: string | null;
  amount_cents: number | null;
  currency: string;
  status: string;
  failure_reason: string | null;
  created_at: RawTimestamp;
}

export interface DriverReservationRow {
  id: string;
  station_id: string;
  status: string;
  cancel_reason: string | null;
  starts_at: RawTimestamp;
  expires_at: RawTimestamp;
  cancellation_fee_cents: number | null;
}

export interface DriverStationRow {
  id: string;
  station_identity: string;
  site_name: string | null;
  availability: string;
  last_fault_at: RawTimestamp;
}

export interface DriverEvidenceRows {
  supportCase: DriverCaseRow & { driver_id: string };
  sessions: DriverSessionRow[];
  tokens: DriverTokenRow[];
  payments: DriverPaymentRow[];
  reservations: DriverReservationRow[];
  stations: DriverStationRow[];
}

/** The last 4 characters of a token value, never more (`****1234`). */
export function tokenTail(value: string): string {
  return `****${value.replace(/[^A-Za-z0-9]/g, '').slice(-4)}`;
}

export function buildDriverEvidence(rows: DriverEvidenceRows): EvidencePack {
  const c = rows.supportCase;
  const items: EvidenceItem[] = [];
  const untrusted: UntrustedEvidence[] = [];
  const stationIdentity = new Map(rows.stations.map((s) => [s.id, s.station_identity]));

  for (const s of rows.sessions) {
    items.push({
      id: `session:${s.id}`,
      kind: s.linked ? 'linked_session' : 'recent_session',
      data: {
        status: s.status,
        stoppedReason: s.stopped_reason,
        startedAt: toIsoOrNull(s.started_at),
        endedAt: toIsoOrNull(s.ended_at),
        energyDeliveredWh: s.energy_delivered_wh,
        costCents: s.final_cost_cents ?? s.current_cost_cents,
        currency: s.currency,
        station: s.station_identity,
        site: s.site_name,
        evse: s.evse_number,
        connectorType: s.connector_type,
        paymentStatus: s.payment_status,
      },
    });
  }
  for (const t of rows.tokens) {
    items.push({
      id: `card:${t.id}`,
      kind: 'driver_card',
      data: {
        type: t.token_type,
        lastFour: tokenTail(t.id_token),
        active: t.is_active,
        prepaidBalanceCents: t.prepaid_balance_cents,
      },
    });
  }
  for (const p of rows.payments) {
    const id = `payment:${String(p.id)}`;
    items.push({
      id,
      kind: 'payment',
      data: {
        type: p.charge_type,
        amountCents: p.amount_cents,
        currency: p.currency,
        status: p.status,
        at: toIsoOrNull(p.created_at),
      },
    });
    const failure = untrustedString(id, 'payment_failure_reason', p.failure_reason);
    if (failure != null) untrusted.push(failure);
  }
  for (const r of rows.reservations) {
    items.push({
      id: `reservation:${r.id}`,
      kind: 'reservation',
      data: {
        status: r.status,
        cancelReason: r.cancel_reason,
        startsAt: toIsoOrNull(r.starts_at),
        expiresAt: toIsoOrNull(r.expires_at),
        feeCents: r.cancellation_fee_cents,
        station: stationIdentity.get(r.station_id) ?? null,
      },
    });
  }
  for (const s of rows.stations) {
    items.push({
      id: `station:${s.id}`,
      kind: 'station',
      data: {
        station: s.station_identity,
        site: s.site_name,
        availability: s.availability,
        lastFaultAt: toIsoOrNull(s.last_fault_at),
      },
    });
  }

  const subject = untrustedString(`case:${c.id}`, 'driver_case_subject', c.subject);
  if (subject != null) untrusted.unshift(subject);
  const description = untrustedString(`case:${c.id}`, 'driver_case_description', c.description);
  if (description != null) untrusted.splice(subject != null ? 1 : 0, 0, description);

  return {
    subject: { type: 'support_case', id: c.id, siteId: null },
    facts: {
      category: c.category,
      openedAt: toIsoOrNull(c.created_at),
      station: c.station_id != null ? (stationIdentity.get(c.station_id) ?? null) : null,
      linkedSessions: rows.sessions.filter((s) => s.linked).map((s) => `session:${s.id}`),
    },
    items,
    untrusted,
  };
}

/** Reads the evidence rows of a case; null when the case is gone or has no driver. */
export async function loadDriverEvidenceRows(caseId: string): Promise<DriverEvidenceRows | null> {
  const [supportCase] = await client<DriverCaseRow[]>`
    SELECT id, driver_id, station_id, category::text AS category, subject, description, created_at
    FROM support_cases WHERE id = ${caseId}
  `;
  if (supportCase?.driver_id == null) return null;
  const driverId = supportCase.driver_id;
  const window = `${String(DRIVER_EVIDENCE_WINDOW_DAYS)} days`;

  const [sessions, tokens, payments, reservations] = await Promise.all([
    client<DriverSessionRow[]>`
      WITH picked AS (
        SELECT s.id, true AS linked
        FROM support_case_sessions l
        JOIN charging_sessions s ON s.id = l.session_id
        WHERE l.case_id = ${caseId} AND s.driver_id = ${driverId}
        UNION
        SELECT id, false AS linked FROM (
          SELECT s.id FROM charging_sessions s
          WHERE s.driver_id = ${driverId}
            AND s.started_at > now() - ${window}::interval
          ORDER BY s.started_at DESC, s.id DESC
          LIMIT ${DRIVER_EVIDENCE_RECENT_SESSIONS}
        ) recent
      ), ids AS (
        SELECT id, bool_or(linked) AS linked FROM picked GROUP BY id
      )
      SELECT s.id, ids.linked, s.station_id, cs.station_id AS station_identity,
        si.name AS site_name, e.evse_id AS evse_number, cn.connector_type,
        s.status::text AS status, s.stopped_reason, s.started_at, s.ended_at,
        s.energy_delivered_wh::text AS energy_delivered_wh, s.final_cost_cents,
        s.current_cost_cents, s.currency,
        (SELECT p.status::text FROM payment_records p
          WHERE p.session_id = s.id AND p.driver_id = ${driverId}
          ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS payment_status
      FROM ids
      JOIN charging_sessions s ON s.id = ids.id AND s.driver_id = ${driverId}
      JOIN charging_stations cs ON cs.id = s.station_id
      LEFT JOIN sites si ON si.id = cs.site_id
      LEFT JOIN evses e ON e.id = s.evse_id
      LEFT JOIN connectors cn ON cn.id = s.connector_id
      ORDER BY s.started_at DESC NULLS LAST, s.id DESC
    `,
    client<DriverTokenRow[]>`
      SELECT id, token_type::text AS token_type, id_token, is_active, prepaid_balance_cents
      FROM driver_tokens WHERE driver_id = ${driverId}
      ORDER BY created_at DESC, id DESC LIMIT ${DRIVER_EVIDENCE_ROW_LIMIT}
    `,
    client<DriverPaymentRow[]>`
      SELECT id, charge_type::text AS charge_type,
        COALESCE(captured_amount_cents, pre_auth_amount_cents) AS amount_cents,
        currency, status::text AS status, failure_reason, created_at
      FROM payment_records
      WHERE driver_id = ${driverId} AND created_at > now() - ${window}::interval
      ORDER BY created_at DESC, id DESC LIMIT ${DRIVER_EVIDENCE_ROW_LIMIT}
    `,
    client<DriverReservationRow[]>`
      SELECT id, station_id, status::text AS status, cancel_reason, starts_at, expires_at,
        cancellation_fee_cents
      FROM reservations
      WHERE driver_id = ${driverId} AND created_at > now() - ${window}::interval
      ORDER BY created_at DESC, id DESC LIMIT ${DRIVER_EVIDENCE_ROW_LIMIT}
    `,
  ]);

  // Stations of the rows above only: stations the driver used. The case
  // station is in the pack only when it is one of them, since a driver can
  // type any station identity on a case.
  const stationIds = [
    ...new Set([...sessions.map((s) => s.station_id), ...reservations.map((r) => r.station_id)]),
  ];
  const stations =
    stationIds.length === 0
      ? []
      : await client<DriverStationRow[]>`
          SELECT cs.id, cs.station_id AS station_identity, si.name AS site_name,
            ${client.unsafe(stationAvailabilitySql('cs'))} AS availability,
            (SELECT max(l.timestamp) FROM port_status_log l
              WHERE l.station_id = cs.id AND l.new_status = 'faulted') AS last_fault_at
          FROM charging_stations cs
          LEFT JOIN sites si ON si.id = cs.site_id
          WHERE cs.id = ANY(${stationIds})
          ORDER BY cs.station_id
        `;

  return {
    supportCase: { ...supportCase, driver_id: driverId },
    sessions,
    tokens,
    payments,
    reservations,
    stations,
  };
}

/**
 * The evidence pack of a support case, or null when there is nothing to
 * analyze: the case is gone or belongs to no driver. A case with only its
 * description is still analyzed (the driver asked a question).
 */
export async function collectDriverSupportEvidence(caseId: string): Promise<EvidencePack | null> {
  const rows = await loadDriverEvidenceRows(caseId);
  if (rows == null) return null;
  return buildDriverEvidence(rows);
}
