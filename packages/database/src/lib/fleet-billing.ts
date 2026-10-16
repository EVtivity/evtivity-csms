// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { isFleetEnabled } from './fleet-setting.js';
import type { SessionBillingMode } from '../schema/charging.js';
import type { AccountInvoiceRecipient } from '../schema/drivers.js';

/**
 * The first release that stamps sessions and reads the stamp. Account billing
 * can be turned on only while no older process may run (the release guard,
 * releaseUpgradePending): pods of v0.1.40 neither stamp nor filter account
 * sessions out of driver invoices.
 */
export const ACCOUNT_BILLING_MIN_VERSION = '0.1.41';

/**
 * The first release that stamps member-billed sessions, leaves them off the
 * fleet invoice and invoices each member. A fleet can switch its invoices to
 * its members only while no older process may run: a v0.1.45 pod would stamp
 * the fleet's sessions for the fleet invoice and send member invoices to the
 * fleet contacts.
 */
export const MEMBER_INVOICE_MIN_VERSION = '0.1.46';

/** The fleet a driver's sessions are billed to (charge on account). */
export interface AccountBilling {
  fleetId: string;
  fleetName: string;
  /** Who the session's account invoice goes to: the fleet or the member driver. */
  recipient: AccountInvoiceRecipient;
}

/** A driver's fleet membership as the billing rule reads it. */
export interface BillingMembership {
  /** fleet_drivers.id, the tie-break after createdAt. */
  membershipId: number;
  fleetId: string;
  fleetName: string;
  accountBillingEnabled: boolean;
  invoiceRecipient: AccountInvoiceRecipient;
  optOut: boolean;
  createdAt: Date;
}

/** Every fleet membership of the driver with the fleet's billing switch. */
export async function loadBillingMemberships(
  sql: postgres.Sql,
  driverId: string,
): Promise<BillingMembership[]> {
  const rows = await sql<
    Array<{
      id: number;
      fleet_id: string;
      fleet_name: string;
      account_billing_enabled: boolean;
      account_invoice_recipient: string;
      account_billing_opt_out: boolean;
      created_at: Date | string;
    }>
  >`
    SELECT fd.id, f.id AS fleet_id, f.name AS fleet_name, f.account_billing_enabled,
           f.account_invoice_recipient, fd.account_billing_opt_out, fd.created_at
    FROM fleet_drivers fd
    JOIN fleets f ON f.id = fd.fleet_id
    WHERE fd.driver_id = ${driverId}
  `;
  return rows.map((r) => ({
    membershipId: r.id,
    fleetId: r.fleet_id,
    fleetName: r.fleet_name,
    accountBillingEnabled: r.account_billing_enabled,
    invoiceRecipient: r.account_invoice_recipient === 'member' ? 'member' : 'fleet',
    optOut: r.account_billing_opt_out,
    createdAt: new Date(r.created_at),
  }));
}

/**
 * The billing rule over a driver's memberships: a membership qualifies when
 * its fleet has account billing on and the member has not opted out; the
 * oldest qualifying one wins (createdAt, then membershipId, the order of the
 * pricing fleet in loadStationPricing). Null: the driver pays by card.
 */
export function pickAccountBilling(
  memberships: readonly BillingMembership[],
): AccountBilling | null {
  const winner = memberships
    .filter((m) => m.accountBillingEnabled && !m.optOut)
    .sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.membershipId - b.membershipId,
    )[0];
  return winner == null
    ? null
    : { fleetId: winner.fleetId, fleetName: winner.fleetName, recipient: winner.invoiceRecipient };
}

/**
 * The fleet a driver charges on account with, or null when the driver pays
 * by card. The one decision (plan S3): the OCPP payment gate, the portal
 * start, the billing state shown to drivers and operators, and the billing
 * change notice call it, and nothing else decides the mode. The rule is
 * pickAccountBilling; with fleets turned off (`fleet.enabled` false) every
 * driver pays by card. The billing fleet and the pricing fleet can differ.
 */
export async function resolveAccountBilling(
  sql: postgres.Sql,
  driverId: string,
): Promise<AccountBilling | null> {
  if (!(await isFleetEnabled())) return null;
  return pickAccountBilling(await loadBillingMemberships(sql, driverId));
}

/** The billing stamp of a driver session (charging_sessions.billing_mode, billing_fleet_id). */
export type SessionBilling =
  | { mode: 'card'; fleetId: null; fleetName: null }
  | { mode: 'account'; fleetId: string; fleetName: string };

/**
 * The stamp columns for a resolver result (the portal start writes them on
 * insert). An account session of a fleet that invoices its members is member
 * billed: it goes on the driver's own invoice, not the fleet invoice.
 */
export function sessionBillingColumns(billing: AccountBilling | null): {
  billingMode: SessionBillingMode;
  billingFleetId: string | null;
  memberBilled: boolean;
} {
  return billing == null
    ? { billingMode: 'card', billingFleetId: null, memberBilled: false }
    : {
        billingMode: 'account',
        billingFleetId: billing.fleetId,
        memberBilled: billing.recipient === 'member',
      };
}

/**
 * Stamps how a driver session is paid, once (write-once, P5): resolves the
 * driver's billing and writes it only while the session has no stamp
 * (`billing_mode IS NULL`). Returns the session's stamp, which is the one an
 * earlier writer (the portal start, an earlier gate run) chose when there is
 * one, so a later change of the fleet never changes a started session. The
 * caller rules out roaming, free vend and prepaid first: those sessions keep
 * no stamp. Null when the session does not exist.
 */
export async function stampSessionBilling(
  sql: postgres.Sql,
  sessionId: string,
  driverId: string,
): Promise<SessionBilling | null> {
  const resolved = await resolveAccountBilling(sql, driverId);
  const { billingMode, billingFleetId, memberBilled } = sessionBillingColumns(resolved);
  const rows = await sql<
    Array<{
      billing_mode: string | null;
      billing_fleet_id: string | null;
      fleet_name: string | null;
    }>
  >`
    WITH stamped AS (
      UPDATE charging_sessions
      SET billing_mode = ${billingMode}, billing_fleet_id = ${billingFleetId},
          member_billed = ${memberBilled}, updated_at = now()
      WHERE id = ${sessionId} AND billing_mode IS NULL
      RETURNING billing_mode, billing_fleet_id
    ),
    stamp AS (
      SELECT billing_mode, billing_fleet_id FROM stamped
      UNION ALL
      SELECT billing_mode, billing_fleet_id FROM charging_sessions
      WHERE id = ${sessionId} AND NOT EXISTS (SELECT 1 FROM stamped)
    )
    SELECT s.billing_mode, s.billing_fleet_id, f.name AS fleet_name
    FROM stamp s
    LEFT JOIN fleets f ON f.id = s.billing_fleet_id
  `;
  const row = rows[0];
  if (row == null) return null;
  return toSessionBilling(row.billing_mode, row.billing_fleet_id, row.fleet_name);
}

/**
 * A stored stamp as a SessionBilling. A session stamped 'account' always has
 * its fleet (charging_sessions_billing_fleet_check); an unknown or missing
 * mode is card.
 */
export function toSessionBilling(
  mode: string | null,
  fleetId: string | null,
  fleetName: string | null,
): SessionBilling {
  if (mode === 'account' && fleetId != null) {
    return { mode: 'account', fleetId, fleetName: fleetName ?? '' };
  }
  return { mode: 'card', fleetId: null, fleetName: null };
}

/** What a billing recipient move did to one session. */
export type SessionBillingMoveOutcome =
  /** Moved to the other invoice. */
  | 'moved'
  /** Already billed to that recipient; nothing written. */
  | 'unchanged'
  | 'not_found'
  /** Not billed on account to a fleet (card, prepaid, roaming, no driver), or paid by card. */
  | 'not_on_account'
  /** On an invoice: a credit note must release it first. */
  | 'invoiced'
  /** The fleet's account billing is off. */
  | 'billing_off'
  /** The driver is no longer a member of the fleet. */
  | 'not_member';

export interface SessionBillingMove {
  sessionId: string;
  outcome: SessionBillingMoveOutcome;
  driverId: string | null;
  fleetId: string | null;
  /** The recipient before the move (null when the session is not on account). */
  from: AccountInvoiceRecipient | null;
}

/**
 * Moves unbilled account sessions between the fleet invoice and the member's
 * own invoice (`member_billed`): the only writer of `member_billed` after the
 * write-once stamp. A session moves only when it is billed on account to a
 * fleet (stamp `account`, a driver, no payment record), is on no invoice
 * (`invoice_id IS NULL`: a session of an issued invoice is released by a
 * credit note first), its driver is still a member of the fleet, and the
 * fleet bills on account. One transaction, with the invoice issue's lock
 * order: the fleet rows (`FOR SHARE`, so an issue or a billing switch of the
 * fleet waits), then the sessions (`FOR UPDATE`). The UPDATE repeats the
 * guards, so a retried move writes nothing (P7). Returns one outcome per
 * distinct session id, in the order given.
 */
export async function moveSessionBillingRecipient(
  sql: postgres.Sql,
  sessionIds: string[],
  recipient: AccountInvoiceRecipient,
): Promise<SessionBillingMove[]> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return [];
  const memberBilled = recipient === 'member';
  return sql.begin(async (tx) => {
    const fleetRows = await tx<Array<{ billing_fleet_id: string }>>`
      SELECT DISTINCT billing_fleet_id FROM charging_sessions
      WHERE id = ANY(${ids}::text[]) AND billing_fleet_id IS NOT NULL
    `;
    const fleetIds = fleetRows.map((r) => r.billing_fleet_id).sort();
    const fleetRowsLocked =
      fleetIds.length === 0
        ? []
        : await tx<Array<{ id: string; account_billing_enabled: boolean }>>`
            SELECT id, account_billing_enabled FROM fleets
            WHERE id = ANY(${fleetIds}::text[])
            ORDER BY id
            FOR SHARE
          `;
    const billingOn = new Map(fleetRowsLocked.map((f) => [f.id, f.account_billing_enabled]));
    const rows = await tx<
      Array<{
        id: string;
        driver_id: string | null;
        billing_mode: string | null;
        billing_fleet_id: string | null;
        member_billed: boolean;
        invoice_id: string | null;
        has_payment: boolean;
        is_member: boolean;
      }>
    >`
      SELECT cs.id, cs.driver_id, cs.billing_mode, cs.billing_fleet_id, cs.member_billed,
             cs.invoice_id,
             EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = cs.id) AS has_payment,
             EXISTS (
               SELECT 1 FROM fleet_drivers fd
               WHERE fd.fleet_id = cs.billing_fleet_id AND fd.driver_id = cs.driver_id
             ) AS is_member
      FROM charging_sessions cs
      WHERE cs.id = ANY(${ids}::text[])
      ORDER BY cs.id
      FOR UPDATE OF cs
    `;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const moves: SessionBillingMove[] = ids.map((sessionId) => {
      const row = byId.get(sessionId);
      if (row == null) {
        return { sessionId, outcome: 'not_found', driverId: null, fleetId: null, from: null };
      }
      const onAccount =
        row.billing_mode === 'account' &&
        row.billing_fleet_id != null &&
        row.driver_id != null &&
        !row.has_payment;
      const base = {
        sessionId,
        driverId: row.driver_id,
        fleetId: row.billing_fleet_id,
        from: onAccount ? (row.member_billed ? 'member' : 'fleet') : null,
      } as const;
      let outcome: SessionBillingMoveOutcome;
      if (!onAccount) outcome = 'not_on_account';
      else if (row.invoice_id != null) outcome = 'invoiced';
      else if (row.member_billed === memberBilled) outcome = 'unchanged';
      else if (billingOn.get(row.billing_fleet_id ?? '') !== true) outcome = 'billing_off';
      else if (!row.is_member) outcome = 'not_member';
      else outcome = 'moved';
      return { ...base, outcome };
    });
    const movable = moves.filter((m) => m.outcome === 'moved').map((m) => m.sessionId);
    if (movable.length > 0) {
      await tx`
        UPDATE charging_sessions
        SET member_billed = ${memberBilled}, updated_at = now()
        WHERE id = ANY(${movable}::text[])
          AND billing_mode = 'account'
          AND driver_id IS NOT NULL
          AND invoice_id IS NULL
          AND member_billed = ${!memberBilled}
      `;
    }
    return moves;
  });
}

/**
 * The sessions of the given drivers that the fleet's invoice preview of a
 * period counts on the other side of `recipient`, and that a move to it can
 * take: billed on account to the fleet, no payment record, completed, on no
 * invoice, ended before `endsBefore` (the period end), currently billed to
 * the other recipient. Ids only; the move checks every guard again.
 */
export async function listMovableFleetSessions(
  sql: postgres.Sql,
  input: {
    fleetId: string;
    driverIds: string[];
    recipient: AccountInvoiceRecipient;
    endsBefore: Date;
  },
): Promise<string[]> {
  const drivers = [...new Set(input.driverIds)];
  if (drivers.length === 0) return [];
  const rows = await sql<Array<{ id: string }>>`
    SELECT cs.id FROM charging_sessions cs
    WHERE cs.billing_mode = 'account'
      AND cs.billing_fleet_id = ${input.fleetId}
      AND cs.driver_id = ANY(${drivers}::text[])
      AND cs.member_billed = ${input.recipient !== 'member'}
      AND cs.invoice_id IS NULL
      AND cs.status = 'completed'
      AND cs.ended_at < ${input.endsBefore}
      AND NOT EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = cs.id)
    ORDER BY cs.id
  `;
  return rows.map((r) => r.id);
}
