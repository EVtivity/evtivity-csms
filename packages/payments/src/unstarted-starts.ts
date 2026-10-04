// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, sql } from 'drizzle-orm';
import { db, failUnstartedRemoteSession, guestSessions } from '@evtivity/database';
import type { UnstartedSession } from '@evtivity/database';
import type { PaymentContext } from './context.js';
import { GUEST_REFERENCE_PREFIX } from './guest-payments.js';
import { cancelKey } from './idempotency-keys.js';
import { pinnedProvider } from './pinning.js';
import { cancelOpenSessionHold } from './session-payments.js';
import type { OpenHoldCancelOutcome } from './session-payments.js';

/**
 * Remote starts the station accepted but never turned into a transaction
 * (the driver did not plug in before the station's connection timeout). The
 * worker runs these when the start's timeout job fires. Nothing is captured
 * and no receipt is sent: the session fails at cost 0 and its hold is
 * cancelled. A start whose transaction began meanwhile is left alone. Both
 * are safe to run again (a retried job): the hold cancel only moves an open
 * hold and carries its cancel key.
 */

const NO_EV_CONNECTED = 'No EV connected after the remote start';

export type UnstartedStartOutcome =
  | { outcome: 'failed' | 'closed'; session: UnstartedSession; hold: OpenHoldCancelOutcome }
  | { outcome: 'skipped' | 'not_found' };

/**
 * A driver's portal start: fails the session (`EVConnectTimeout`, cost 0,
 * only while still active and without a reported transaction, P5) and then
 * cancels its open hold (`cancel_<paymentId>`). The session is failed first
 * (P4), so a provider error leaves no billable session; the error is thrown
 * and a retry finds the session `closed` and cancels again.
 */
export async function closeUnstartedRemoteStart(
  sessionId: string,
  ctx: PaymentContext,
): Promise<UnstartedStartOutcome> {
  const result = await failUnstartedRemoteSession(sessionId);
  if (result.outcome === 'skipped' || result.outcome === 'not_found') return result;
  const hold = await cancelOpenSessionHold(sessionId, NO_EV_CONNECTED, ctx);
  return { ...result, hold };
}

export type UnstartedGuestOutcome =
  | { outcome: 'failed' | 'closed'; holdCancelled: boolean }
  | { outcome: 'skipped' | 'not_found' };

/**
 * A guest start: a guest session still `payment_authorized` (its start was
 * sent, no charging session was linked) becomes `failed` and its hold is
 * cancelled (`cancel_<paymentId>`, the key of every cancel of that
 * payment). A guest session that charges, ended, or expired is left
 * alone. A retry of a session this already failed cancels again.
 */
export async function failUnstartedGuestSession(
  guestSessionId: number,
  ctx: PaymentContext,
): Promise<UnstartedGuestOutcome> {
  const unstarted = and(
    eq(guestSessions.id, guestSessionId),
    sql`${guestSessions.startRequestedAt} IS NOT NULL`,
    sql`${guestSessions.chargingSessionId} IS NULL`,
  );
  const columns = {
    provider: guestSessions.provider,
    paymentId: guestSessions.providerPaymentId,
    sessionToken: guestSessions.sessionToken,
  };
  let outcome: 'failed' | 'closed' = 'failed';
  let [guest] = await db
    .update(guestSessions)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(and(unstarted, eq(guestSessions.status, 'payment_authorized')))
    .returning(columns);
  if (guest == null) {
    [guest] = await db
      .select(columns)
      .from(guestSessions)
      .where(and(unstarted, eq(guestSessions.status, 'failed')));
    if (guest == null) {
      const [exists] = await db
        .select({ id: guestSessions.id })
        .from(guestSessions)
        .where(eq(guestSessions.id, guestSessionId));
      return { outcome: exists == null ? 'not_found' : 'skipped' };
    }
    outcome = 'closed';
  }
  if (guest.paymentId == null) return { outcome, holdCancelled: false };
  const provider = await pinnedProvider(ctx.registry, guest.provider);
  await provider.cancelHold({
    paymentId: guest.paymentId,
    merchantReference: `${GUEST_REFERENCE_PREFIX}${guest.sessionToken}`,
    idempotencyKey: cancelKey(guest.paymentId),
  });
  ctx.logger.info({ guestSessionId, reason: NO_EV_CONNECTED }, 'Guest hold cancelled');
  return { outcome, holdCancelled: true };
}
