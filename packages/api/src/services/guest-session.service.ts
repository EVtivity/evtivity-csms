// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db, client } from '@evtivity/database';
import { guestSessions, chargingSessions, paymentRecords } from '@evtivity/database';
import { getStripeConfig, capturePayment, cancelPaymentIntent } from './stripe.service.js';
import { chargingStations } from '@evtivity/database';
import { dispatchSystemNotification } from '@evtivity/lib';
import type { FastifyBaseLogger } from 'fastify';
import { ALL_TEMPLATES_DIRS } from '../lib/template-dirs.js';

interface CsmsEvent {
  type: string;
  sessionId?: string;
  stationId?: string;
  transactionId?: string;
  idToken?: { idToken: string; type: string };
  [key: string]: unknown;
}

export async function handleGuestSessionEvent(
  event: CsmsEvent,
  logger: FastifyBaseLogger,
): Promise<void> {
  // Handle session started: link guest session to charging session
  // Match by idToken value only (not type) because OCPP 1.6 doesn't send token type
  if (event.type === 'TransactionStarted' && event.idToken?.idToken != null) {
    await linkGuestSession(event, logger);
  }

  // Handle session ended: capture or cancel payment
  if (event.type === 'TransactionEnded' && event.sessionId != null) {
    await finalizeGuestPayment(event.sessionId, logger);
  }
}

async function linkGuestSession(event: CsmsEvent, logger: FastifyBaseLogger): Promise<void> {
  const tokenValue = event.idToken?.idToken;
  if (tokenValue == null) return;

  // Look up guest session by session token (idToken value)
  const [guest] = await db
    .select()
    .from(guestSessions)
    .where(
      and(
        eq(guestSessions.sessionToken, tokenValue),
        eq(guestSessions.status, 'payment_authorized'),
      ),
    );

  if (guest == null) return;

  // Find the charging session
  if (event.sessionId == null) return;

  await db
    .update(guestSessions)
    .set({
      chargingSessionId: event.sessionId,
      status: 'charging',
      updatedAt: new Date(),
    })
    .where(eq(guestSessions.id, guest.id));

  // Create payment record for guest session (if payment was taken)
  if (guest.stripePaymentIntentId != null) {
    const [station] = await db
      .select({ siteId: chargingStations.siteId })
      .from(chargingStations)
      .where(eq(chargingStations.stationId, guest.stationOcppId));

    const config = await getStripeConfig(station?.siteId ?? null);

    await db.insert(paymentRecords).values({
      sessionId: event.sessionId,
      driverId: null,
      sitePaymentConfigId: config?.configId ?? null,
      stripePaymentIntentId: guest.stripePaymentIntentId,
      paymentSource: 'guest',
      currency: config?.currency ?? 'USD',
      preAuthAmountCents: guest.preAuthAmountCents,
      status: 'pre_authorized',
    });
  }

  logger.info(
    { guestSessionId: guest.id, chargingSessionId: event.sessionId },
    'Linked guest session to charging session',
  );
}

async function finalizeGuestPayment(sessionId: string, logger: FastifyBaseLogger): Promise<void> {
  // Find guest session linked to this charging session
  const [guest] = await db
    .select({
      id: guestSessions.id,
      guestEmail: guestSessions.guestEmail,
      stationOcppId: guestSessions.stationOcppId,
    })
    .from(guestSessions)
    .where(eq(guestSessions.chargingSessionId, sessionId));

  if (guest == null) return;

  // Read payment intent from payment_records (source of truth once session is linked)
  const [pr] = await db
    .select({
      id: paymentRecords.id,
      stripePaymentIntentId: paymentRecords.stripePaymentIntentId,
      status: paymentRecords.status,
    })
    .from(paymentRecords)
    .where(eq(paymentRecords.sessionId, sessionId))
    .limit(1);

  // Idempotency guard: if the payment is already in a terminal state, a prior
  // job already finalized it. A duplicate BullMQ delivery (jobId retention
  // expired between the original and a late re-enqueue) would otherwise call
  // Stripe again and log a misleading capture failure when Stripe rejects the
  // already-captured intent. Stripe's idempotency key on capture still prevents
  // double-charging; this just short-circuits before the noisy network call.
  if (
    pr != null &&
    (pr.status === 'captured' || pr.status === 'cancelled' || pr.status === 'failed')
  ) {
    logger.info(
      { guestSessionId: guest.id, paymentRecordId: pr.id, status: pr.status },
      'Skipping guest payment finalization, already terminal',
    );
    return;
  }

  // No payment record means free session: mark completed, send receipt, and return
  if (pr?.stripePaymentIntentId == null) {
    await db
      .update(guestSessions)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(guestSessions.id, guest.id));
    logger.info({ guestSessionId: guest.id }, 'Free guest session completed');
    await sendGuestReceipt(guest, sessionId, logger);
    return;
  }

  // Get final cost from charging session
  const [session] = await db
    .select({
      finalCostCents: chargingSessions.finalCostCents,
      stationId: chargingSessions.stationId,
    })
    .from(chargingSessions)
    .where(eq(chargingSessions.id, sessionId));

  if (session == null) return;

  // Get site for Stripe config
  const [station] = await db
    .select({ siteId: chargingStations.siteId })
    .from(chargingStations)
    .where(eq(chargingStations.id, session.stationId));

  const config = await getStripeConfig(station?.siteId ?? null);
  if (config == null) {
    logger.error({ guestSessionId: guest.id }, 'No Stripe config for guest payment capture');
    await db
      .update(guestSessions)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(guestSessions.id, guest.id));
    return;
  }

  try {
    const finalCost = session.finalCostCents ?? 0;

    if (finalCost > 0) {
      await capturePayment(config, pr.stripePaymentIntentId, finalCost, `capture_${String(pr.id)}`);
      logger.info({ guestSessionId: guest.id, amountCents: finalCost }, 'Captured guest payment');

      await db
        .update(paymentRecords)
        .set({ status: 'captured', capturedAmountCents: finalCost, updatedAt: new Date() })
        .where(eq(paymentRecords.id, pr.id));
    } else {
      await cancelPaymentIntent(config, pr.stripePaymentIntentId);
      logger.info({ guestSessionId: guest.id }, 'Cancelled zero-cost guest payment intent');

      await db
        .update(paymentRecords)
        .set({ status: 'cancelled', capturedAmountCents: 0, updatedAt: new Date() })
        .where(eq(paymentRecords.id, pr.id));
    }

    await db
      .update(guestSessions)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(guestSessions.id, guest.id));

    await sendGuestReceipt(guest, sessionId, logger);
  } catch (err: unknown) {
    logger.error({ err, guestSessionId: guest.id }, 'Failed to finalize guest payment');

    const reason = err instanceof Error ? err.message.slice(0, 500) : 'Unknown payment error';
    await db
      .update(paymentRecords)
      .set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
      .where(eq(paymentRecords.id, pr.id));

    // Re-throw so BullMQ records the job as failed and retries per its
    // attempts policy (3 attempts with exponential backoff). On the final
    // attempt the worker's failed-job hook (see createGuestSessionWorker)
    // flips the guest session to `failed` so the portal's GuestSession
    // page exits its waiting-for-terminal-status loop. The Stripe pre-auth
    // hold expires on its own after 7 days; we don't need to keep the
    // guest_sessions row in `charging` to recover.
    throw err;
  }
}

async function sendGuestReceipt(
  guest: { id: number; guestEmail: string; stationOcppId: string },
  sessionId: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  if (guest.guestEmail === '') return;

  try {
    const [session] = await db
      .select({
        energyDeliveredWh: chargingSessions.energyDeliveredWh,
        finalCostCents: chargingSessions.finalCostCents,
        currency: chargingSessions.currency,
        startedAt: chargingSessions.startedAt,
        endedAt: chargingSessions.endedAt,
      })
      .from(chargingSessions)
      .where(eq(chargingSessions.id, sessionId));

    if (session == null) return;

    const startedAt = session.startedAt != null ? new Date(session.startedAt) : new Date();
    const endedAt = session.endedAt != null ? new Date(session.endedAt) : new Date();
    const durationMinutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60000);

    await dispatchSystemNotification(
      client,
      'session.Receipt',
      { email: guest.guestEmail },
      {
        stationId: guest.stationOcppId,
        energyDeliveredWh:
          session.energyDeliveredWh != null ? Number(session.energyDeliveredWh) : 0,
        finalCostCents: session.finalCostCents ?? 0,
        currency: session.currency ?? 'USD',
        durationMinutes,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      },
      ALL_TEMPLATES_DIRS,
    );

    logger.info({ guestSessionId: guest.id }, 'Guest receipt notification sent');
  } catch (err: unknown) {
    logger.error({ err, guestSessionId: guest.id }, 'Failed to send guest receipt notification');
  }
}
