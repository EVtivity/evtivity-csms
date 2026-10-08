// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';

/** A transaction limit the station reported reaching (OCPP 2.1 trigger reasons). */
export type SessionLimitReached = 'cost' | 'energy' | 'time';

const LIMIT_TRIGGERS: Record<string, SessionLimitReached> = {
  CostLimitReached: 'cost',
  EnergyLimitReached: 'energy',
  TimeLimitReached: 'time',
};

/**
 * The transaction limit the station last reported reaching for the session,
 * or null. A station that reaches its maxCost (the guest hold), maxEnergy or
 * maxTime suspends charging (SuspendedEVSE), so the portal tells the driver
 * why the session went idle instead of showing only "Idle". An OCPP 1.6
 * station has no transaction limit, and a 2.1 station may ignore it: the CSMS
 * stops the transaction at the session's cost ceiling (stopped_reason
 * GuestHoldExhausted for a guest's hold, PrepaidCreditExhausted for a prepaid
 * token's credit, AccountCreditLimit for the fleet credit an account session
 * reserved), which reports the cost limit too. An account start the fleet
 * credit limit refused is faulted with AccountCreditLimit and never ran to a
 * limit, so it reports none.
 */
export async function sessionLimitReached(sessionId: string): Promise<SessionLimitReached | null> {
  const [row] = await client<Array<{ trigger_reason: string | null }>>`
    SELECT COALESCE(
      (SELECT trigger_reason FROM transaction_events
       WHERE session_id = ${sessionId}
         AND trigger_reason IN ('CostLimitReached', 'EnergyLimitReached', 'TimeLimitReached')
       ORDER BY seq_no DESC
       LIMIT 1),
      (SELECT 'CostLimitReached' FROM charging_sessions
       WHERE id = ${sessionId}
         AND (stopped_reason IN ('GuestHoldExhausted', 'PrepaidCreditExhausted')
              OR (stopped_reason = 'AccountCreditLimit' AND status <> 'faulted')))
    ) AS trigger_reason
  `;
  return row?.trigger_reason != null ? (LIMIT_TRIGGERS[row.trigger_reason] ?? null) : null;
}
