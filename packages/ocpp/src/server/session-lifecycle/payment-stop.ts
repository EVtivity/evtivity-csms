// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { faultUnbilledSession } from '@evtivity/database';
import { dispatchOneShotStationMessage, publishOcppCommand } from '@evtivity/lib';
import type { StationMessageState } from '@evtivity/lib';
import type { ProjectionDeps } from '../projection-support/context.js';

export interface StopTarget {
  sessionId: string;
  transactionId: string;
  ocppStationId: string;
  stationDbId: string;
}

export type PaymentStopReason =
  | 'PaymentFailed'
  | 'MissingPaymentMethod'
  | 'GuestPaymentNotAuthorized'
  | 'AnonymousSession'
  | 'PrepaidCreditExhausted'
  | 'GuestHoldExhausted';

/** True when the station reported reaching the cost limit of the session (E16.FR.05). */
export async function costLimitReported(sql: postgres.Sql, sessionId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM transaction_events
    WHERE session_id = ${sessionId} AND trigger_reason = 'CostLimitReached'
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Stops the session by publishing RequestStopTransaction. For
 * payment-failure reasons (PaymentFailed, MissingPaymentMethod) we first
 * eagerly mark the DB row faulted and close its tariff segment, then
 * publish (P4), so the operator UI clears the connector even if the
 * process dies before the publish, the station ignores the stop, or the
 * message is lost. This is the ghost-session prevention path: a card
 * declined at the gate must not leave a stranded `active` session that no
 * event can ever close. A failed fault is logged and the stop is still
 * published: stopping the unpaid charge matters more than the row, and the
 * station's TransactionEvent.Ended then closes the session.
 *
 * Anonymous and guest-not-authorized stops only publish the OCPP command;
 * the natural TransactionEvent.Ended that follows handles the DB
 * transition. Eager cleanup for those would race the legitimate Ended
 * handler.
 *
 * PrepaidCreditExhausted and GuestHoldExhausted record stopped_reason
 * first and publish only when they claimed the session, so repeated
 * MeterValues send one stop.
 */
export async function stopSessionForPayment(
  deps: ProjectionDeps,
  target: StopTarget,
  reason: PaymentStopReason,
): Promise<void> {
  const { sql, pubsub, logger, notify } = deps;
  const { sessionId, transactionId, ocppStationId, stationDbId } = target;

  // A session at its cost ceiling (a prepaid token's credit or a guest's
  // hold, see the MeterValues cost loop): mark the stop request on the session before
  // publishing, once. The session stays active until the station ends the
  // transaction, which keeps this stopped_reason (COALESCE) and settles.
  if (reason === 'PrepaidCreditExhausted' || reason === 'GuestHoldExhausted') {
    try {
      const claimed = await sql`
        UPDATE charging_sessions
        SET stopped_reason = ${reason}, updated_at = now()
        WHERE id = ${sessionId} AND status = 'active' AND stopped_reason IS NULL
        RETURNING id
      `;
      if (claimed.length === 0) return;
    } catch (err) {
      logger.error({ err, sessionId }, 'Failed to record the payment stop of the session');
      return;
    }
  }

  const eagerCleanup = reason === 'PaymentFailed' || reason === 'MissingPaymentMethod';
  let faulted = false;
  if (eagerCleanup) {
    try {
      // Zero out cost columns: the driver never authorized payment so we
      // must not display or persist a session-fee charge. Without this,
      // the cost calc on the Ended event (or MeterValues if a stray one
      // arrives) applies pricePerSession + tax and the portal Recent
      // Sessions list shows a phantom $0.81 next to a 0 kWh row.
      faulted = await faultUnbilledSession(sql, {
        sessionId,
        reason,
        endedAt: new Date(),
      });
      await sql`
        UPDATE session_tariff_segments
        SET ended_at = now(),
            duration_minutes = EXTRACT(EPOCH FROM (now() - started_at)) / 60
        WHERE session_id = ${sessionId} AND ended_at IS NULL
      `;
    } catch (err) {
      logger.error({ err, sessionId, reason }, 'Failed to mark session faulted');
    }
  }

  try {
    await publishOcppCommand(pubsub, {
      stationId: ocppStationId,
      action: 'RequestStopTransaction',
      payload: { transactionId },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to publish RequestStopTransaction');
  }

  // Push a one-shot driver-facing message to the station screen so the
  // physical UX matches the email/SMS notification fan-out. The template
  // body is operator-editable in Settings -> Integration -> Station
  // Messages, rendered with the standard StationMessageContext, and
  // dispatched via dispatchOneShotStationMessage so any future
  // event-driven station message can reuse the same path.
  const stateByReason: Record<PaymentStopReason, StationMessageState | null> = {
    PaymentFailed: 'payment_failed',
    MissingPaymentMethod: 'payment_required',
    GuestPaymentNotAuthorized: 'guest_unauthorized',
    AnonymousSession: 'unauthorized',
    // No station message template exists for an exhausted prepaid credit
    // or guest hold.
    PrepaidCreditExhausted: null,
    GuestHoldExhausted: null,
  };
  const messageState = stateByReason[reason];
  if (messageState != null) {
    try {
      const settingRows = await sql`
        SELECT key, value FROM settings
        WHERE key IN ('company.name', 'company.supportPhone', 'stationMessage.eventMessageTtlSeconds')
      `;
      const settingsMap = new Map<string, unknown>();
      for (const row of settingRows) {
        settingsMap.set(row['key'] as string, row['value']);
      }
      const companyName = (settingsMap.get('company.name') as string | undefined) ?? 'EVtivity';
      const supportPhone = settingsMap.get('company.supportPhone') as string | undefined;
      const ttlSetting = settingsMap.get('stationMessage.eventMessageTtlSeconds');
      const ttlSeconds = typeof ttlSetting === 'number' && ttlSetting > 0 ? ttlSetting : 30;
      await dispatchOneShotStationMessage(
        pubsub,
        sql,
        {
          stationOcppId: ocppStationId,
          stationDbId,
          state: messageState,
          context: {
            companyName,
            stationOcppId: ocppStationId,
            ...(supportPhone != null && supportPhone !== '' ? { supportPhone } : {}),
          },
        },
        {
          ttlSeconds,
          // Defensive in-process clear for OCPP 1.6 (no native endDateTime)
          // and 2.1 firmwares that ignore endDateTime. Same window so the
          // operator can tune one knob.
          autoClearMs: ttlSeconds * 1000,
        },
      );
    } catch (err) {
      logger.warn({ err, reason }, 'Failed to publish payment-failure display message');
    }
  }

  // The audit helper logs its own failures (fail-open).
  if (faulted) {
    await notify.auditLinkedReservationFault(sessionId, `faulted: ${reason}`);
  }
}
