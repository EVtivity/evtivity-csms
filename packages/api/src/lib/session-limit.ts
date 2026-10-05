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
 * station has no transaction limit: the CSMS stops a guest transaction at its
 * hold (stopped_reason GuestHoldExhausted), which reports the cost limit too.
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
       WHERE id = ${sessionId} AND stopped_reason = 'GuestHoldExhausted')
    ) AS trigger_reason
  `;
  return row?.trigger_reason != null ? (LIMIT_TRIGGERS[row.trigger_reason] ?? null) : null;
}
