// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import { db, client } from '@evtivity/database';
import { guestSessions, chargingSessions, paymentRecords } from '@evtivity/database';
import { getStripeConfig, capturePayment, cancelPaymentIntent } from './stripe.service.js';
import { chargingStations } from '@evtivity/database';
import { dispatchSystemNotification } from '@evtivity/lib';
import type { FastifyBaseLogger } from 'fastify';
import type { PubSubClient, Subscription } from '@evtivity/lib';
import { ALL_TEMPLATES_DIRS } from '../lib/template-dirs.js';

const EVENTS_CHANNEL = 'csms_events';

interface CsmsEvent {
  type: string;
  sessionId?: string;
  stationId?: string;
  transactionId?: string;
  idToken?: { idToken: string; type: string };
  [key: string]: unknown;
}

export function startGuestSessionListener(
  pubsub: PubSubClient,
  logger: FastifyBaseLogger,
): () => void {
  let stopped = false;
  let subscription: Subscription | null = null;

  async function init(): Promise<void> {
    try {
      subscription = await pubsub.subscribe(EVENTS_CHANNEL, (payload: string) => {
        if (stopped) return;

        let event: CsmsEvent;
        try {
          event = JSON.parse(payload) as CsmsEvent;
        } catch {
          return;
        }

        void handleGuestSessionEvent(event, logger).catch((err: unknown) => {
          logger.error({ err, event }, 'Guest session event handler error');
        });
      });

      if (stopped) {
        void subscription.unsubscribe().catch(() => {});
        return;
      }

      logger.info('Guest session listener started');
    } catch (err: unknown) {
      logger.error({ err }, 'Failed to start guest session listener');
    }
  }

  void init();

  return () => {
    stopped = true;
    if (subscription != null) {
      void subscription.unsubscribe().catch(() => {});
    }
  };
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
    })
    .from(paymentRecords)
    .where(eq(paymentRecords.sessionId, sessionId))
    .limit(1);

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
      await capturePayment(config, pr.stripePaymentIntentId, finalCost);
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

    // Keep guest session in charging status so the retry queue can reattempt capture.
    // The guest-session-events BullMQ queue handles retries with exponential backoff
    // (3 attempts, 5s base delay). If all retries fail, the dead-letter queue catches it.
    logger.warn(
      { guestSessionId: guest.id, paymentRecordId: pr.id },
      'Guest payment capture failed, pending retry via BullMQ',
    );
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
