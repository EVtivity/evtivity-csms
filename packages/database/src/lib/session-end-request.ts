// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';

/**
 * Pub/sub channel the API publishes on when it ends a session the station no
 * longer reports (a ghost session, `TxNotFound`). The OCPP server ends it
 * through the normal session end: final cost, settlement, receipt.
 */
export const SESSION_END_REQUEST_CHANNEL = 'session_end_requests';

/**
 * Why the CSMS ended an active session the station did not end:
 * - `Superseded`: a new transaction started on the same EVSE.
 * - `GhostRecovered`: the station answered a stop with `TxNotFound`.
 */
export const CSMS_SESSION_END_REASONS = ['Superseded', 'GhostRecovered'] as const;

/**
 * The stopped reason of a session whose CSMS end failed too often: the OCPP
 * sweep faulted it unbilled (`giveUpSessionEnd`). An operator can re-bill it
 * (`session-rebill.ts`).
 */
export const SESSION_END_FAILED_REASON = 'EndRequestFailed';

export type CsmsSessionEndReason = (typeof CSMS_SESSION_END_REASONS)[number];

export interface SessionEndRequestMessage {
  sessionId: string;
  reason: CsmsSessionEndReason;
}

/**
 * Records a request to end an active session the normal way, durably, before
 * the request is published (P4): the OCPP sweep finds it even if the message
 * is lost, and the stale-session cleanup skips it. Returns false when the
 * session is not active (it ended meanwhile, P5).
 */
export async function recordSessionEndRequest(
  sql: postgres.Sql,
  sessionId: string,
  reason: CsmsSessionEndReason,
): Promise<boolean> {
  const rows = await sql`
    UPDATE charging_sessions
    SET end_request_reason = ${reason}
    WHERE id = ${sessionId} AND status = 'active'
    RETURNING id
  `;
  return rows.length > 0;
}
