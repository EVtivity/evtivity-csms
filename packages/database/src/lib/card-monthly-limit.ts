// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { cardMonthlyRemainingCents } from '@evtivity/lib';
import { getCompanyCurrency, getSystemTimezone } from './system-settings.js';
import type { FleetCreditTransaction } from './fleet-credit-limit.js';

type Sql = postgres.Sql | postgres.TransactionSql;

/** A fleet card's monthly spending limit against what it spent this month. */
export interface CardMonthlyLimitCheck {
  tokenId: string;
  limitCents: number;
  /** The card's sessions of the month: ended at their final cost, running at what they reserve. */
  spentCents: number;
  /** What the card may still spend this month, never below 0. */
  remainingCents: number;
  /**
   * The cost ceiling of the session the check reserved for, as stored, else
   * null (no reservation asked, or the session is not the card's).
   */
  ceilingCents: number | null;
}

interface SpendOptions {
  excludeSessionId?: string | null | undefined;
  excludeTransaction?: FleetCreditTransaction | null | undefined;
}

/**
 * The card's spend of the current calendar month in the system timezone, in
 * cents of the company currency: sessions started this month, ended ones at
 * their final cost and active ones at their cost ceiling, else their running
 * cost (what they may still take). Sessions in another currency are left out.
 */
async function queryCardMonthSpend(
  sql: Sql,
  tokenId: string,
  options: SpendOptions,
): Promise<number> {
  const [currency, timezone] = await Promise.all([getCompanyCurrency(), getSystemTimezone()]);
  const excludeSessionId = options.excludeSessionId ?? null;
  const excludeStationId = options.excludeTransaction?.stationId ?? null;
  const excludeTransactionId = options.excludeTransaction?.transactionId ?? null;
  const rows = await sql<Array<{ spent: string | null }>>`
    SELECT SUM(CASE WHEN cs.status = 'active'
                    THEN COALESCE(cs.cost_ceiling_cents, GREATEST(COALESCE(cs.current_cost_cents, 0), 0))
                    ELSE GREATEST(COALESCE(cs.final_cost_cents, 0), 0) END) AS spent
    FROM charging_sessions cs
    WHERE cs.token_id = ${tokenId}
      AND upper(cs.currency) = ${currency}
      AND cs.started_at >= (date_trunc('month', now() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone})
      AND (${excludeSessionId}::text IS NULL OR cs.id <> ${excludeSessionId}::text)
      AND (${excludeStationId}::text IS NULL OR NOT EXISTS (
        SELECT 1 FROM charging_stations st
        WHERE st.id = cs.station_id
          AND st.station_id = ${excludeStationId}::text
          AND cs.transaction_id = ${excludeTransactionId}::text
      ))
  `;
  return Number(rows[0]?.spent ?? 0);
}

/**
 * The monthly limit of a card and its spend, without a lock: the Authorize
 * answer and the card list, which reserve nothing. Null when the card has no
 * limit (or does not exist).
 */
export async function readCardMonthlyLimit(
  sql: Sql,
  tokenId: string,
  options: SpendOptions = {},
): Promise<CardMonthlyLimitCheck | null> {
  const [token] = await sql<Array<{ monthly_limit_cents: number | null }>>`
    SELECT monthly_limit_cents FROM driver_tokens WHERE id = ${tokenId}
  `;
  if (token?.monthly_limit_cents == null) return null;
  const limitCents = token.monthly_limit_cents;
  const spentCents = await queryCardMonthSpend(sql, tokenId, options);
  return {
    tokenId,
    limitCents,
    spentCents,
    remainingCents: cardMonthlyRemainingCents(limitCents, spentCents),
    ceilingCents: null,
  };
}

/**
 * The monthly limit check of a card's session at its start (the payment
 * gate). Under the row lock of the card's fleet, the one the fleet credit
 * check takes, so starts of the fleet's cards are decided one after the
 * other. With `reserveForSessionId` the session is left out of the spend and
 * its cost ceiling becomes the smaller of the ceiling it has (a fleet credit
 * reservation) and what the card may still spend, so concurrent sessions of
 * the card never spend more than its limit. Null when the card has no limit.
 * Errors propagate: the gate runs again (the limit check is critical).
 */
export async function checkCardMonthlyLimit(
  sql: postgres.Sql,
  tokenId: string,
  options: { reserveForSessionId?: string | undefined } = {},
): Promise<CardMonthlyLimitCheck | null> {
  // Most cards have no limit: decided before any transaction or lock.
  const [token] = await sql<Array<{ monthly_limit_cents: number | null }>>`
    SELECT monthly_limit_cents FROM driver_tokens WHERE id = ${tokenId}
  `;
  if (token?.monthly_limit_cents == null) return null;
  return sql.begin(async (tx) => {
    await tx`
      SELECT f.id FROM fleets f
      JOIN driver_tokens dt ON dt.fleet_id = f.id
      WHERE dt.id = ${tokenId}
      FOR UPDATE OF f
    `;
    const reserveFor = options.reserveForSessionId ?? null;
    const check = await readCardMonthlyLimit(tx, tokenId, { excludeSessionId: reserveFor });
    if (check == null) return null;
    if (reserveFor == null) return check;
    const [row] = await tx<Array<{ cost_ceiling_cents: number | string | null }>>`
      UPDATE charging_sessions
      SET cost_ceiling_cents = LEAST(COALESCE(cost_ceiling_cents, ${check.remainingCents}::int),
                                     ${check.remainingCents}::int),
          updated_at = now()
      WHERE id = ${reserveFor} AND token_id = ${tokenId}
      RETURNING cost_ceiling_cents
    `;
    const result: CardMonthlyLimitCheck = {
      ...check,
      ceilingCents: row?.cost_ceiling_cents != null ? Number(row.cost_ceiling_cents) : null,
    };
    return result;
  });
}

/**
 * Whether a session's cost ceiling is its card's monthly limit: the card has
 * a limit and what it may still spend (this session left out) is not above
 * the ceiling. A stop at the ceiling then names the card limit, not the fleet
 * credit. False without a ceiling or a limit.
 */
export async function cardLimitBindsSession(
  sql: Sql,
  sessionId: string,
  ceilingCents: number | null = null,
): Promise<boolean> {
  const [session] = await sql<
    Array<{ token_id: string | null; cost_ceiling_cents: number | string | null }>
  >`
    SELECT token_id, cost_ceiling_cents FROM charging_sessions WHERE id = ${sessionId}
  `;
  if (session?.token_id == null) return false;
  const ceiling =
    ceilingCents ??
    (session.cost_ceiling_cents != null ? Number(session.cost_ceiling_cents) : null);
  if (ceiling == null) return false;
  const check = await readCardMonthlyLimit(sql, session.token_id, { excludeSessionId: sessionId });
  return check != null && check.remainingCents <= ceiling;
}

/** What the member notice of a fleet card at its monthly limit names. */
export interface CardMonthlyLimitNoticeTarget {
  driverId: string;
  idToken: string;
  tokenType: string;
  label: string | null;
  fleetName: string;
  limitCents: number;
}

/**
 * Claims the notice of a fleet card that reached its monthly limit: once per
 * card, calendar month (system timezone) and limit, so repeated refusals or
 * stops send one notice and a raised limit reached again sends another. Only
 * a card given to a member (a driver and a fleet) with a limit is claimed;
 * an unassigned card notifies nobody. Returns what the notice names, or null
 * when nothing was claimed.
 */
export async function claimCardMonthlyLimitNotice(
  sql: Sql,
  tokenId: string,
): Promise<CardMonthlyLimitNoticeTarget | null> {
  const timezone = await getSystemTimezone();
  const rows = await sql<
    Array<{
      driver_id: string;
      id_token: string;
      token_type: string;
      label: string | null;
      fleet_name: string;
      limit_cents: number;
    }>
  >`
    WITH card AS (
      SELECT dt.id, dt.driver_id, dt.id_token, dt.token_type, dt.label,
             dt.monthly_limit_cents, f.name AS fleet_name
      FROM driver_tokens dt
      JOIN fleets f ON f.id = dt.fleet_id
      WHERE dt.id = ${tokenId}
        AND dt.driver_id IS NOT NULL
        AND dt.monthly_limit_cents IS NOT NULL
    ), claimed AS (
      INSERT INTO card_monthly_limit_notices (token_id, period_start, limit_cents)
      SELECT id, date_trunc('month', now() AT TIME ZONE ${timezone})::date, monthly_limit_cents
      FROM card
      ON CONFLICT (token_id, period_start, limit_cents) DO NOTHING
      RETURNING token_id
    )
    SELECT card.driver_id, card.id_token, card.token_type, card.label, card.fleet_name,
           card.monthly_limit_cents AS limit_cents
    FROM card JOIN claimed ON claimed.token_id = card.id
  `;
  const row = rows[0];
  if (row == null) return null;
  return {
    driverId: row.driver_id,
    idToken: row.id_token,
    tokenType: row.token_type,
    label: row.label,
    fleetName: row.fleet_name,
    limitCents: row.limit_cents,
  };
}

/**
 * The spend of this month of several cards, for the card list: one query,
 * ended sessions at their final cost and running ones at their running cost
 * (what they cost so far). Cards without a session this month are absent.
 */
export async function cardsMonthSpend(sql: Sql, tokenIds: string[]): Promise<Map<string, number>> {
  const spent = new Map<string, number>();
  if (tokenIds.length === 0) return spent;
  const [currency, timezone] = await Promise.all([getCompanyCurrency(), getSystemTimezone()]);
  const rows = await sql<Array<{ token_id: string; spent: string | null }>>`
    SELECT cs.token_id,
           SUM(CASE WHEN cs.status = 'active'
                    THEN GREATEST(COALESCE(cs.current_cost_cents, 0), 0)
                    ELSE GREATEST(COALESCE(cs.final_cost_cents, 0), 0) END) AS spent
    FROM charging_sessions cs
    WHERE cs.token_id = ANY(${tokenIds}::text[])
      AND upper(cs.currency) = ${currency}
      AND cs.started_at >= (date_trunc('month', now() AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone})
    GROUP BY cs.token_id
  `;
  for (const row of rows) spent.set(row.token_id, Number(row.spent ?? 0));
  return spent;
}
