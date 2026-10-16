// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import {
  client,
  moveSessionBillingRecipient,
  sessionAuditLog,
  writeAudit,
} from '@evtivity/database';
import type {
  AccountInvoiceRecipient,
  SessionBillingMove,
  SessionBillingMoveOutcome,
} from '@evtivity/database';
import { AppError } from '@evtivity/lib';
import type { AuditActorInfo } from '../lib/audit-actor.js';

export interface SessionBillingContext {
  actor: AuditActorInfo;
  log: FastifyBaseLogger;
}

/**
 * Moves unbilled account sessions between the fleet invoice and the member's
 * own invoice (discussion #12). The database writer
 * (`moveSessionBillingRecipient`) holds the guards; this service writes one
 * `session.billing_reassigned` audit row per moved session, with the
 * recipient before and after (fail-open, P9). Sessions already billed to the
 * recipient and refused ones write nothing.
 */
export async function moveSessionsBilling(
  sessionIds: string[],
  recipient: AccountInvoiceRecipient,
  ctx: SessionBillingContext,
): Promise<SessionBillingMove[]> {
  const moves = await moveSessionBillingRecipient(client, sessionIds, recipient);
  for (const move of moves) {
    if (move.outcome !== 'moved') continue;
    await writeAudit(
      { table: sessionAuditLog, idColumn: 'session_id' },
      {
        entityId: move.sessionId,
        entityIdSnapshot: move.sessionId,
        action: 'billing_reassigned',
        ...ctx.actor,
        before: { recipient: move.from, memberBilled: move.from === 'member' },
        after: {
          recipient,
          memberBilled: recipient === 'member',
          fleetId: move.fleetId,
          driverId: move.driverId,
        },
      },
      undefined,
      ctx.log,
    );
  }
  return moves;
}

/** The API error of a refused single-session move, or null when it moved or was unchanged. */
export function sessionBillingMoveError(outcome: SessionBillingMoveOutcome): AppError | null {
  switch (outcome) {
    case 'moved':
    case 'unchanged':
      return null;
    case 'not_found':
      return new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    case 'not_on_account':
      return new AppError(
        'The session is not billed on account to a fleet',
        409,
        'SESSION_NOT_ON_ACCOUNT',
      );
    case 'invoiced':
      return new AppError(
        'The session is on an invoice; credit the invoice to release it first',
        409,
        'SESSION_ALREADY_INVOICED',
      );
    case 'billing_off':
      return new AppError('The fleet does not bill on account', 409, 'FLEET_ACCOUNT_BILLING_OFF');
    case 'not_member':
      return new AppError(
        'The driver is no longer a member of the fleet',
        409,
        'DRIVER_NOT_FLEET_MEMBER',
      );
  }
}
