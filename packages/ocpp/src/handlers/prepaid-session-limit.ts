// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client, extendFleetSessionCeiling } from '@evtivity/database';

/**
 * The credit a prepaid session may spend: the cost ceiling the Started
 * projection reserved for it (`linkPrepaidToken`, the balance minus what the
 * token's other active and unsettled sessions reserve). The 2.1
 * TransactionEventResponse sends it as `transactionLimit.maxCost`
 * (C17.FR.03). Returns null when the session of this transaction at the
 * station is not linked to the token yet or has no ceiling.
 */
export async function prepaidSessionCeilingCents(
  stationId: string,
  transactionId: string,
  tokenId: string,
): Promise<number | null> {
  const [row] = await client`
    SELECT cs.cost_ceiling_cents
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    WHERE st.station_id = ${stationId}
      AND cs.transaction_id = ${transactionId}
      AND cs.token_id = ${tokenId}
    LIMIT 1
  `;
  const ceiling = row?.['cost_ceiling_cents'] as number | string | null | undefined;
  return ceiling != null ? Number(ceiling) : null;
}

/**
 * Records the cost ceiling the Started response sent the station as
 * `transactionLimit.maxCost` for an account session, so a ceiling that grows
 * later (plan S8, bounded reservation) is sent once on the next
 * TransactionEventResponse (takeGrownAccountCeiling, E16.FR.02).
 */
export async function markAccountCeilingSent(
  stationId: string,
  transactionId: string,
  ceilingCents: number,
): Promise<void> {
  await client`
    UPDATE charging_sessions cs
    SET cost_ceiling_sent_cents = ${ceilingCents}
    FROM charging_stations st
    WHERE st.id = cs.station_id
      AND st.station_id = ${stationId}
      AND cs.transaction_id = ${transactionId}
      AND cs.billing_mode = 'account'
  `;
}

/**
 * The grown cost ceiling of a running account session that the station has
 * not been sent yet, claimed as sent in the same statement, so it goes out
 * once (E16.FR.02: the CSMS includes a changed limit once, in the first
 * possible TransactionEventResponse). Only for a session whose station got
 * the first limit at Started (cost_ceiling_sent_cents set); null when nothing
 * new is to be sent.
 */
export async function takeGrownAccountCeiling(
  stationId: string,
  transactionId: string,
): Promise<number | null> {
  const [row] = await client`
    UPDATE charging_sessions cs
    SET cost_ceiling_sent_cents = cs.cost_ceiling_cents
    FROM charging_stations st
    WHERE st.id = cs.station_id
      AND st.station_id = ${stationId}
      AND cs.transaction_id = ${transactionId}
      AND cs.billing_mode = 'account'
      AND cs.status = 'active'
      AND cs.cost_ceiling_sent_cents IS NOT NULL
      AND cs.cost_ceiling_cents > cs.cost_ceiling_sent_cents
    RETURNING cs.cost_ceiling_cents
  `;
  const ceiling = row?.['cost_ceiling_cents'] as number | string | null | undefined;
  return ceiling != null ? Number(ceiling) : null;
}

/**
 * A 2.1 station suspended an account session at the limit it was sent
 * (TransactionEvent Updated, triggerReason CostLimitReached, E16.FR.05). The
 * station resumes when the limit is raised (E16 scenario 2, step 4a), so the
 * ceiling grows now, under the fleet row lock (extendFleetSessionCeiling, from
 * the larger of the sent limit and the running cost), and the same response
 * sends it (takeGrownAccountCeiling). A ceiling that grew earlier but was not
 * sent yet counts as raised too. Returns true when the ceiling is above what
 * the station reached, false when the fleet has no credit left or the session
 * is not a running, unclaimed account session that got a limit. Errors
 * propagate.
 */
export async function raiseAccountCeilingAtCostLimit(
  stationId: string,
  transactionId: string,
): Promise<boolean> {
  const [row] = await client`
    SELECT cs.id, cs.billing_fleet_id, cs.cost_ceiling_sent_cents, cs.current_cost_cents
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    WHERE st.station_id = ${stationId}
      AND cs.transaction_id = ${transactionId}
      AND cs.billing_mode = 'account'
      AND cs.billing_fleet_id IS NOT NULL
      AND cs.status = 'active'
      AND cs.stopped_reason IS NULL
      AND cs.cost_ceiling_cents IS NOT NULL
      AND cs.cost_ceiling_sent_cents IS NOT NULL
    LIMIT 1
  `;
  if (row == null) return false;
  const reachedCents = Math.max(
    Number(row['cost_ceiling_sent_cents']),
    Number(row['current_cost_cents'] ?? 0),
  );
  const extension = await extendFleetSessionCeiling(
    client,
    row['billing_fleet_id'] as string,
    row['id'] as string,
    { pricedCents: reachedCents },
  );
  return extension != null && extension.ceilingCents > reachedCents;
}

/**
 * The credit an account session may spend (plan S8): the cost ceiling the
 * payment gate reserved for it from its billing fleet's credit limit
 * (`checkFleetCreditLimit`, the limit minus what the fleet's ended and other
 * active sessions take). The 2.1 TransactionEventResponse sends it as
 * `transactionLimit.maxCost`. Returns null when the session of this
 * transaction at the station is not billed on account or has no ceiling (its
 * fleet has no limit, or the gate has not reserved it yet).
 */
export async function accountSessionCeilingCents(
  stationId: string,
  transactionId: string,
): Promise<number | null> {
  const [row] = await client`
    SELECT cs.cost_ceiling_cents
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    WHERE st.station_id = ${stationId}
      AND cs.transaction_id = ${transactionId}
      AND cs.billing_mode = 'account'
    LIMIT 1
  `;
  const ceiling = row?.['cost_ceiling_cents'] as number | string | null | undefined;
  return ceiling != null ? Number(ceiling) : null;
}
