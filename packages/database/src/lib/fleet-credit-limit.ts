// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { getCompanyCurrency, getSystemTimezone } from './system-settings.js';
import { resolveAccountBilling } from './fleet-billing.js';
import { getFleetCreditReservationCents } from './fleet-credit-settings.js';
import { FLEET_CREDIT_LIMIT_NOTICE_KINDS } from '../schema/drivers.js';
import type { FleetCreditLimitNoticeKind } from '../schema/drivers.js';

/** The default warning percent of a fleet credit limit (fleets.credit_limit_warning_percent). */
export const DEFAULT_CREDIT_LIMIT_WARNING_PERCENT = 80;

/**
 * An account session's cost ceiling grows by another slice once the headroom
 * left under it (ceiling minus priced cost) falls below this percent of the
 * slice, or below twice the cost the last meter reading added, whichever is
 * larger (plan S8, bounded reservation).
 */
export const CEILING_EXTEND_HEADROOM_PERCENT = 20;

/**
 * What a fleet owes or will owe on account, in cents of the company currency
 * (sessions in another currency are left out). Only sessions billed on
 * account count: stamped `account` for the fleet and without a payment record
 * (`features/fleet-billing.md`, billing state).
 */
export interface FleetCreditExposure {
  /** Ended sessions on no invoice yet: their final cost. */
  unbilledCents: number;
  /** Sessions on an unpaid invoice (issued, or a draft): their final cost. */
  invoicedCents: number;
  /** Active sessions: their running cost. */
  runningCents: number;
  /** The sum of the three. */
  totalCents: number;
  currency: string;
}

/** Where a fleet's exposure stands against its limit. */
export type FleetCreditLevel = 'ok' | 'warning' | 'reached';

/** A fleet's credit limit and its exposure, read under the fleet row lock at a start. */
export interface FleetCreditCheck {
  fleetId: string;
  fleetName: string;
  limitCents: number;
  warningPercent: number;
  exposure: FleetCreditExposure;
  level: FleetCreditLevel;
  /**
   * The credit a new account session may still use (plan S8): the limit minus
   * the ended sessions (unbilled and invoiced) and what the active sessions
   * reserve (their cost ceiling, else their running cost), never below 0.
   * Concurrent sessions together never take more than the limit.
   */
  remainingCents: number;
  /**
   * The cost ceiling of the session the check reserved credit for
   * (`reserveForSessionId`), as stored: the smaller of the credit left and the
   * reservation slice (`fleet.creditReservationCents`), written once, so a
   * rerun returns the first reservation. Null when the check reserved nothing.
   */
  ceilingCents: number | null;
}

/**
 * The first reservation of an account session: the smaller of the credit
 * left and the slice, so one session never holds the whole limit and the
 * fleet's other drivers can start while it charges.
 */
export function sessionReservationCents(remainingCents: number, sliceCents: number): number {
  return Math.max(Math.min(remainingCents, sliceCents), 0);
}

/** The inputs of ceilingExtensionDue. */
export interface CeilingExtensionInput {
  /** The cost at this reading before the ceiling caps it. */
  pricedCents: number;
  ceilingCents: number;
  /** The reservation slice (`fleet.creditReservationCents`). */
  sliceCents: number;
  /** The cost the last meter reading added; 0 when not known. */
  lastReadingCents?: number | undefined;
}

/**
 * Whether an account session's ceiling should grow: the headroom left under
 * it (ceiling minus the priced cost, before the ceiling caps it) is below the
 * larger of CEILING_EXTEND_HEADROOM_PERCENT of the slice and twice the cost
 * the last reading added. The second bound grows the ceiling early for
 * readings large enough to reach it before a 2.1 station gets the grown limit
 * on the next response. Integer math.
 */
export function ceilingExtensionDue(input: CeilingExtensionInput): boolean {
  const headroomCents = input.ceilingCents - input.pricedCents;
  if (headroomCents * 100 < input.sliceCents * CEILING_EXTEND_HEADROOM_PERCENT) return true;
  return headroomCents < 2 * Math.max(input.lastReadingCents ?? 0, 0);
}

/**
 * The grown ceiling: one slice above the larger of the current ceiling and the
 * priced cost (a reading can jump past the ceiling), at most what the fleet
 * has left for this session (`availableCents`, null without a limit), and
 * never below the current ceiling (a ceiling only grows, P5).
 */
export function extendedCeilingCents(input: {
  currentCents: number;
  pricedCents: number;
  sliceCents: number;
  availableCents: number | null;
}): number {
  const wanted = Math.max(input.currentCents, input.pricedCents) + input.sliceCents;
  const capped = input.availableCents == null ? wanted : Math.min(wanted, input.availableCents);
  return Math.max(input.currentCents, capped);
}

type Sql = postgres.Sql | postgres.TransactionSql;

/**
 * The level of an exposure against a limit: `reached` at or above the limit
 * (a start is refused), `warning` at or above `warningPercent` of it, else
 * `ok`. Integer math, so 80 % of 1001 cents is reached at 801 cents.
 */
export function fleetCreditLevel(
  exposureCents: number,
  limitCents: number,
  warningPercent: number,
): FleetCreditLevel {
  if (exposureCents >= limitCents) return 'reached';
  if (exposureCents * 100 >= limitCents * warningPercent) return 'warning';
  return 'ok';
}

/** The exposure plus what the fleet's active sessions reserve (ceiling, else running cost). */
interface ExposureWithReservations {
  exposure: FleetCreditExposure;
  /** Active sessions at their cost ceiling, else their running cost. */
  activeReservedCents: number;
}

async function queryFleetExposure(
  sql: Sql,
  fleetId: string,
  excludeSessionId: string | null,
): Promise<ExposureWithReservations> {
  const currency = await getCompanyCurrency();
  const rows = await sql<
    Array<{
      unbilled: string | null;
      invoiced: string | null;
      running: string | null;
      reserved: string | null;
    }>
  >`
    SELECT
      SUM(CASE WHEN cs.status <> 'active' AND cs.invoice_id IS NULL
               THEN COALESCE(cs.final_cost_cents, 0) ELSE 0 END) AS unbilled,
      SUM(CASE WHEN cs.status <> 'active' AND i.status IN ('draft', 'issued')
               THEN COALESCE(cs.final_cost_cents, 0) ELSE 0 END) AS invoiced,
      SUM(CASE WHEN cs.status = 'active'
               THEN GREATEST(COALESCE(cs.current_cost_cents, 0), 0) ELSE 0 END) AS running,
      SUM(CASE WHEN cs.status = 'active'
               THEN COALESCE(cs.cost_ceiling_cents, GREATEST(COALESCE(cs.current_cost_cents, 0), 0))
               ELSE 0 END) AS reserved
    FROM charging_sessions cs
    LEFT JOIN invoices i ON i.id = cs.invoice_id
    WHERE cs.billing_fleet_id = ${fleetId}
      AND cs.billing_mode = 'account'
      AND upper(cs.currency) = ${currency}
      AND (${excludeSessionId}::text IS NULL OR cs.id <> ${excludeSessionId}::text)
      AND NOT EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = cs.id)
  `;
  const row = rows[0];
  const unbilledCents = Number(row?.unbilled ?? 0);
  const invoicedCents = Number(row?.invoiced ?? 0);
  const runningCents = Number(row?.running ?? 0);
  return {
    exposure: {
      unbilledCents,
      invoicedCents,
      runningCents,
      totalCents: unbilledCents + invoicedCents + runningCents,
      currency,
    },
    activeReservedCents: Number(row?.reserved ?? 0),
  };
}

/**
 * The fleet's exposure (FleetCreditExposure). `excludeSessionId` leaves out
 * the session being started, so its own check sees what the fleet owed
 * before it.
 */
export async function loadFleetCreditExposure(
  sql: Sql,
  fleetId: string,
  options: { excludeSessionId?: string | undefined } = {},
): Promise<FleetCreditExposure> {
  return (await queryFleetExposure(sql, fleetId, options.excludeSessionId ?? null)).exposure;
}

/**
 * The credit left for a new account session: the limit minus the ended
 * sessions and the active sessions' reservations, never below 0.
 */
export function fleetCreditRemaining(
  limitCents: number,
  exposure: Pick<FleetCreditExposure, 'unbilledCents' | 'invoicedCents'>,
  activeReservedCents: number,
): number {
  return Math.max(
    limitCents - exposure.unbilledCents - exposure.invoicedCents - activeReservedCents,
    0,
  );
}

interface FleetLimitRow {
  name: string;
  credit_limit_cents: number | null;
  credit_limit_warning_percent: number;
}

async function creditCheckFor(
  sql: Sql,
  fleetId: string,
  fleet: FleetLimitRow | undefined,
  excludeSessionId: string | null,
): Promise<Omit<FleetCreditCheck, 'ceilingCents'> | null> {
  if (fleet?.credit_limit_cents == null) return null;
  const limitCents = fleet.credit_limit_cents;
  const warningPercent = fleet.credit_limit_warning_percent;
  const { exposure, activeReservedCents } = await queryFleetExposure(
    sql,
    fleetId,
    excludeSessionId,
  );
  return {
    fleetId,
    fleetName: fleet.name,
    limitCents,
    warningPercent,
    exposure,
    level: fleetCreditLevel(exposure.totalCents, limitCents, warningPercent),
    remainingCents: fleetCreditRemaining(limitCents, exposure, activeReservedCents),
  };
}

/**
 * The credit check of an account start for the fleet: locks the fleet row
 * (`FOR UPDATE`) and reads its limit and exposure in one transaction, so a
 * start is decided against a limit no concurrent change is writing and
 * concurrent starts of the fleet are checked one after the other. With
 * `reserveForSessionId` (the payment gate at Started, plan S8) the session is
 * left out of the exposure and gets a bounded reservation as its cost ceiling
 * in the same transaction: the smaller of the credit left and the slice
 * (`sliceCents`, default the `fleet.creditReservationCents` setting), written
 * once (a rerun keeps the first ceiling). The next start of the fleet counts
 * the session at its ceiling, so concurrent sessions together never take more
 * than the limit, and the rest of the limit stays free for the fleet's other
 * drivers; the ceiling grows while the session charges
 * (extendFleetSessionCeiling). A ceiling of 0 means no credit is left. Null
 * when the fleet has no limit (or no longer exists): the start is allowed
 * without a ceiling. Errors propagate: the caller refuses or stops the start
 * on its own terms (P9, the limit check is critical).
 */
export async function checkFleetCreditLimit(
  sql: postgres.Sql,
  fleetId: string,
  options: {
    excludeSessionId?: string | undefined;
    reserveForSessionId?: string | undefined;
    sliceCents?: number | undefined;
  } = {},
): Promise<FleetCreditCheck | null> {
  const sliceCents =
    options.reserveForSessionId != null
      ? (options.sliceCents ?? (await getFleetCreditReservationCents()))
      : 0;
  return sql.begin(async (tx) => {
    const [fleet] = await tx<FleetLimitRow[]>`
      SELECT name, credit_limit_cents, credit_limit_warning_percent
      FROM fleets WHERE id = ${fleetId}
      FOR UPDATE
    `;
    const reserveFor = options.reserveForSessionId ?? null;
    const check = await creditCheckFor(
      tx,
      fleetId,
      fleet,
      reserveFor ?? options.excludeSessionId ?? null,
    );
    if (check == null) return null;
    let ceilingCents: number | null = null;
    if (reserveFor != null) {
      // Write-once: COALESCE keeps a ceiling an earlier run stored and
      // returns it, so a rerun of the gate never reserves twice.
      const reservation = sessionReservationCents(check.remainingCents, sliceCents);
      const [row] = await tx<Array<{ cost_ceiling_cents: number | string | null }>>`
        UPDATE charging_sessions
        SET cost_ceiling_cents = COALESCE(cost_ceiling_cents, ${reservation}),
            updated_at = now()
        WHERE id = ${reserveFor}
          AND billing_mode = 'account'
          AND billing_fleet_id = ${fleetId}
        RETURNING cost_ceiling_cents
      `;
      ceilingCents = row?.cost_ceiling_cents != null ? Number(row.cost_ceiling_cents) : null;
    }
    const result: FleetCreditCheck = { ...check, ceilingCents };
    return result;
  });
}

/** The outcome of extendFleetSessionCeiling. */
export interface FleetCeilingExtension {
  /** The ceiling before the call. */
  previousCents: number;
  /** The ceiling after the call (equal to previousCents when it did not grow). */
  ceilingCents: number;
  /** The ceiling grew. */
  grown: boolean;
}

/**
 * Grows the cost ceiling of a running account session (plan S8, bounded
 * reservation) under the same fleet row lock and exposure calculation as
 * checkFleetCreditLimit: once the extension is due (ceilingExtensionDue,
 * checked again under the lock, so a rerun never grows it twice), the ceiling
 * grows by one slice
 * (extendedCeilingCents), at most to what the fleet has left for this session
 * (the limit minus the ended sessions and the other active sessions'
 * reservations). A ceiling only grows. `grown: false` with a due extension
 * means the fleet has no credit left: the caller stops the session at its
 * ceiling. A fleet whose limit was removed grows the ceiling without a cap.
 * Null when the session is not a running account session of the fleet with a
 * ceiling, or the fleet no longer exists. Errors propagate (the caller decides
 * whether a failure may stop the session).
 */
export async function extendFleetSessionCeiling(
  sql: postgres.Sql,
  fleetId: string,
  sessionId: string,
  options: {
    pricedCents: number;
    sliceCents?: number | undefined;
    lastReadingCents?: number | undefined;
  },
): Promise<FleetCeilingExtension | null> {
  const sliceCents = options.sliceCents ?? (await getFleetCreditReservationCents());
  return sql.begin(async (tx) => {
    const [fleet] = await tx<FleetLimitRow[]>`
      SELECT name, credit_limit_cents, credit_limit_warning_percent
      FROM fleets WHERE id = ${fleetId}
      FOR UPDATE
    `;
    if (fleet == null) return null;
    const [session] = await tx<Array<{ cost_ceiling_cents: number | string | null }>>`
      SELECT cost_ceiling_cents FROM charging_sessions
      WHERE id = ${sessionId}
        AND status = 'active'
        AND billing_mode = 'account'
        AND billing_fleet_id = ${fleetId}
      FOR UPDATE
    `;
    if (session?.cost_ceiling_cents == null) return null;
    const currentCents = Number(session.cost_ceiling_cents);
    const unchanged: FleetCeilingExtension = {
      previousCents: currentCents,
      ceilingCents: currentCents,
      grown: false,
    };
    const due = ceilingExtensionDue({
      pricedCents: options.pricedCents,
      ceilingCents: currentCents,
      sliceCents,
      lastReadingCents: options.lastReadingCents,
    });
    if (!due) return unchanged;

    let availableCents: number | null = null;
    if (fleet.credit_limit_cents != null) {
      const { exposure, activeReservedCents } = await queryFleetExposure(tx, fleetId, sessionId);
      availableCents = fleetCreditRemaining(
        fleet.credit_limit_cents,
        exposure,
        activeReservedCents,
      );
    }
    const next = extendedCeilingCents({
      currentCents,
      pricedCents: options.pricedCents,
      sliceCents,
      availableCents,
    });
    if (next <= currentCents) return unchanged;
    await tx`
      UPDATE charging_sessions
      SET cost_ceiling_cents = ${next}, updated_at = now()
      WHERE id = ${sessionId}
    `;
    const grown: FleetCeilingExtension = {
      previousCents: currentCents,
      ceilingCents: next,
      grown: true,
    };
    return grown;
  });
}

/**
 * Whether the fleet's warning and reached notices of the current calendar
 * month (system timezone) are both claimed: reads the primary-key rows of
 * fleet_credit_limit_notices, so the running notice check skips the fleet's
 * exposure aggregate once nothing is left to send this month (P6).
 */
export async function fleetCreditNoticesClaimed(sql: Sql, fleetId: string): Promise<boolean> {
  const timezone = await getSystemTimezone();
  const rows = await sql<Array<{ claimed: number | string }>>`
    SELECT count(*)::int AS claimed
    FROM fleet_credit_limit_notices
    WHERE fleet_id = ${fleetId}
      AND period_start = date_trunc('month', now() AT TIME ZONE ${timezone})::date
  `;
  return Number(rows[0]?.claimed ?? 0) >= FLEET_CREDIT_LIMIT_NOTICE_KINDS.length;
}

/**
 * The fleet's credit limit and exposure without the row lock: for the
 * fleet's notices while a session runs and the Authorize check, which reserve
 * nothing. Null when the fleet has no limit (or no longer exists).
 */
export async function readFleetCreditLimit(
  sql: Sql,
  fleetId: string,
): Promise<FleetCreditCheck | null> {
  const [fleet] = await sql<FleetLimitRow[]>`
    SELECT name, credit_limit_cents, credit_limit_warning_percent
    FROM fleets WHERE id = ${fleetId}
  `;
  const check = await creditCheckFor(sql, fleetId, fleet, null);
  return check == null ? null : { ...check, ceilingCents: null };
}

/** A driver's account billing with a credit limit: the fleet and the credit left for a start. */
export interface DriverAccountCredit {
  fleetId: string;
  remainingCents: number;
}

/**
 * The credit a driver who charges on account can still start with: null when
 * the driver pays by card (`resolveAccountBilling`) or the billing fleet has
 * no limit. Read without the fleet row lock: the Authorize answer (plan S8,
 * NoCredit) reserves nothing; the payment gate decides at Started.
 */
export async function loadDriverAccountCredit(
  sql: postgres.Sql,
  driverId: string,
): Promise<DriverAccountCredit | null> {
  const billing = await resolveAccountBilling(sql, driverId);
  if (billing == null) return null;
  const check = await readFleetCreditLimit(sql, billing.fleetId);
  return check == null ? null : { fleetId: check.fleetId, remainingCents: check.remainingCents };
}

/**
 * Claims a credit limit notice of the fleet for the current calendar month in
 * the system timezone: true for the one call that inserted the claim row,
 * false when the notice of this kind went out this month already (P7: once
 * per fleet, month and kind).
 */
export async function claimFleetCreditLimitNotice(
  sql: postgres.Sql,
  check: Pick<FleetCreditCheck, 'fleetId' | 'limitCents' | 'exposure'>,
  kind: FleetCreditLimitNoticeKind,
): Promise<boolean> {
  const timezone = await getSystemTimezone();
  const rows = await sql`
    INSERT INTO fleet_credit_limit_notices (fleet_id, period_start, kind, exposure_cents, limit_cents)
    VALUES (
      ${check.fleetId},
      date_trunc('month', now() AT TIME ZONE ${timezone})::date,
      ${kind},
      ${check.exposure.totalCents},
      ${check.limitCents}
    )
    ON CONFLICT (fleet_id, period_start, kind) DO NOTHING
    RETURNING fleet_id
  `;
  return rows.length > 0;
}

/** A fleet's billing contacts and the language of their notices. */
export interface FleetBillingContacts {
  /** `fleets.billing_contact_emails`: stored trimmed, lowercased, without duplicates. */
  emails: string[];
  /** `fleets.invoice_language`; null when the fleet does not exist. */
  language: string | null;
}

/**
 * The fleet billing profile's contacts, who get the credit limit notices in
 * the fleet's invoice language. A fleet without contacts (or one that no
 * longer exists) has none: the notices then go to the operators who manage
 * fleets (`fleets:write`).
 */
export async function loadFleetBillingContacts(
  sql: Sql,
  fleetId: string,
): Promise<FleetBillingContacts> {
  const rows = await sql<Array<{ billing_contact_emails: string[]; invoice_language: string }>>`
    SELECT billing_contact_emails, invoice_language
    FROM fleets
    WHERE id = ${fleetId}
  `;
  const row = rows[0];
  if (row == null) return { emails: [], language: null };
  return { emails: row.billing_contact_emails, language: row.invoice_language };
}
