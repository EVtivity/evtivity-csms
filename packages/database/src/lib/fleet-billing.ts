// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { isFleetEnabled } from './fleet-setting.js';
import type { SessionBillingMode } from '../schema/charging.js';

/**
 * The first release that stamps sessions and reads the stamp. Account billing
 * can be turned on only while no older process may run (the release guard,
 * releaseUpgradePending): pods of v0.1.40 neither stamp nor filter account
 * sessions out of driver invoices.
 */
export const ACCOUNT_BILLING_MIN_VERSION = '0.1.41';

/** The fleet a driver's sessions are billed to (charge on account). */
export interface AccountBilling {
  fleetId: string;
  fleetName: string;
}

/** A driver's fleet membership as the billing rule reads it. */
export interface BillingMembership {
  /** fleet_drivers.id, the tie-break after createdAt. */
  membershipId: number;
  fleetId: string;
  fleetName: string;
  accountBillingEnabled: boolean;
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
      account_billing_opt_out: boolean;
      created_at: Date | string;
    }>
  >`
    SELECT fd.id, f.id AS fleet_id, f.name AS fleet_name, f.account_billing_enabled,
           fd.account_billing_opt_out, fd.created_at
    FROM fleet_drivers fd
    JOIN fleets f ON f.id = fd.fleet_id
    WHERE fd.driver_id = ${driverId}
  `;
  return rows.map((r) => ({
    membershipId: r.id,
    fleetId: r.fleet_id,
    fleetName: r.fleet_name,
    accountBillingEnabled: r.account_billing_enabled,
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
  return winner == null ? null : { fleetId: winner.fleetId, fleetName: winner.fleetName };
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

/** The stamp columns for a resolver result (the portal start writes them on insert). */
export function sessionBillingColumns(billing: AccountBilling | null): {
  billingMode: SessionBillingMode;
  billingFleetId: string | null;
} {
  return billing == null
    ? { billingMode: 'card', billingFleetId: null }
    : { billingMode: 'account', billingFleetId: billing.fleetId };
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
  const { billingMode, billingFleetId } = sessionBillingColumns(resolved);
  const rows = await sql<
    Array<{
      billing_mode: string | null;
      billing_fleet_id: string | null;
      fleet_name: string | null;
    }>
  >`
    WITH stamped AS (
      UPDATE charging_sessions
      SET billing_mode = ${billingMode}, billing_fleet_id = ${billingFleetId}, updated_at = now()
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
