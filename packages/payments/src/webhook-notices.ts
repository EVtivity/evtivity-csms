// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { chargingSessions, chargingStations, client, db, sites } from '@evtivity/database';
import { dispatchDriverNotification, notificationMoney } from '@evtivity/lib';
import type { PubSubClient } from '@evtivity/lib';
import type { PaymentLogger } from './context.js';
import { dispatchFeeRefundNotification } from './fee-refund-notice.js';
import type { PaymentWebhookNotice } from './webhooks.js';

export interface WebhookNoticeDeps {
  /** Notification template directories of the calling process. */
  templatesDirs: string[];
  /** The process's pub/sub client, for the operator UI refresh (`csms_events`). */
  pubsub: PubSubClient | null;
  logger: PaymentLogger;
}

interface SessionRef {
  transactionId: string | null;
  stationOcppId: string | null;
  stationUuid: string | null;
  siteId: string | null;
  siteName: string | null;
}

const NO_SESSION: SessionRef = {
  transactionId: null,
  stationOcppId: null,
  stationUuid: null,
  siteId: null,
  siteName: null,
};

async function sessionRef(sessionId: string | null): Promise<SessionRef> {
  if (sessionId == null) return NO_SESSION;
  const [row] = await db
    .select({
      transactionId: chargingSessions.transactionId,
      stationOcppId: chargingStations.stationId,
      stationUuid: chargingStations.id,
      siteId: chargingStations.siteId,
      siteName: sites.name,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
    .leftJoin(sites, eq(sites.id, chargingStations.siteId))
    .where(eq(chargingSessions.id, sessionId));
  return row ?? NO_SESSION;
}

/**
 * Tells the driver and the operator UI what a payment webhook changed
 * (`ingestPaymentWebhook` returns the notices; the API webhook route and the
 * worker's delivery job call this). A capture that failed after the session
 * ended sends `payment.CaptureFailed` (the driver may already hold a receipt,
 * D-A6); a confirmed async refund sends `payment.Refunded` (a reservation fee
 * refund `payment.FeeRefunded`); a session settled
 * after its authorisation adjustment sends `session.PaymentReceived`. Every record
 * change refreshes the operator UI (`payment.settled` on `csms_events`).
 * Everything here is fail-open (P9): a failure is logged at warn.
 */
export async function dispatchPaymentWebhookNotices(
  notices: PaymentWebhookNotice[],
  deps: WebhookNoticeDeps,
): Promise<void> {
  for (const notice of notices) {
    const record = notice.record;
    try {
      const session = await sessionRef(record.sessionId);
      if (notice.kind === 'capture_failed' && record.driverId != null) {
        await dispatchDriverNotification(
          client,
          'payment.CaptureFailed',
          record.driverId,
          {
            stationId: session.stationOcppId ?? '',
            transactionId: session.transactionId ?? '',
            amountFormatted: notificationMoney(record.capturedAmountCents ?? 0, record.currency),
            reason: (notice.reason ?? 'Capture failed').slice(0, 200),
          },
          deps.templatesDirs,
          deps.pubsub ?? undefined,
        );
      }
      if (notice.kind === 'session_paid' && record.driverId != null) {
        await dispatchDriverNotification(
          client,
          'session.PaymentReceived',
          record.driverId,
          {
            siteName: session.siteName ?? '',
            stationId: session.stationOcppId ?? '',
            transactionId: session.transactionId ?? '',
            amountCents: notice.amountCents,
            amountFormatted: notificationMoney(notice.amountCents, record.currency),
            currency: record.currency,
          },
          deps.templatesDirs,
          deps.pubsub ?? undefined,
        );
      }
      // A reservation fee refund has its own event (no session to name).
      if (notice.kind === 'refund_succeeded' && record.chargeType !== 'session') {
        await dispatchFeeRefundNotification(record, notice.amountCents, deps);
      }
      if (
        notice.kind === 'refund_succeeded' &&
        record.driverId != null &&
        record.chargeType === 'session'
      ) {
        await dispatchDriverNotification(
          client,
          'payment.Refunded',
          record.driverId,
          {
            amountCents: notice.amountCents,
            amountFormatted: notificationMoney(notice.amountCents, record.currency),
            currency: record.currency,
            transactionId: record.sessionId,
          },
          deps.templatesDirs,
          deps.pubsub ?? undefined,
        );
      }
      if (deps.pubsub != null) {
        await deps.pubsub.publish(
          'csms_events',
          JSON.stringify({
            eventType: 'payment.settled',
            stationId: session.stationUuid,
            siteId: session.siteId,
            sessionId: record.sessionId,
            paymentRecordId: record.id,
            change: notice.kind,
          }),
        );
      }
    } catch (err) {
      deps.logger.warn(
        { err, paymentRecordId: record.id, kind: notice.kind },
        'Payment webhook notification failed; continuing',
      );
    }
  }
}
