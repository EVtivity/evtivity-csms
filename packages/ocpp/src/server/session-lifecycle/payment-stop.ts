// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import { faultUnbilledSession } from '@evtivity/database';
import {
  dispatchOneShotStationMessage,
  notificationMoney,
  publishOcppCommand,
} from '@evtivity/lib';
import type { StationMessageState } from '@evtivity/lib';
import { dispatchDriverNotification, ALL_TEMPLATES_DIRS } from '../notification-dispatcher.js';
import type { ProjectionDeps } from '../projection-support/context.js';

/** What the claim of a ceiling stop returns for the driver's prepaid notice. */
interface CeilingStopRow {
  /** The session's driver, else the token's. */
  driver_id: string | null;
  id_token: string | null;
  cost_ceiling_cents: number | null;
  currency: string;
  site_name: string | null;
}

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
  const { sessionId, transactionId, ocppStationId } = target;

  // A session at its cost ceiling (a prepaid token's credit or a guest's
  // hold, see the MeterValues cost loop): mark the stop request on the session before
  // publishing, once. The session stays active until the station ends the
  // transaction, which keeps this stopped_reason (COALESCE) and settles.
  // The claim is shared with a 2.1 station's CostLimitReached report
  // (notePrepaidCostLimitReached), so the prepaid notices go out once.
  let ceilingStop: CeilingStopRow | null = null;
  if (reason === 'PrepaidCreditExhausted' || reason === 'GuestHoldExhausted') {
    try {
      ceilingStop = await claimCeilingStop(sql, sessionId, reason, false);
      if (ceilingStop == null) return;
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

  if (reason === 'PrepaidCreditExhausted') {
    // Only the call that claimed the stop gets here.
    if (ceilingStop != null) await sendPrepaidExhaustedNotices(deps, target, ceilingStop);
  } else {
    // A guest paid by card at the QR checkout; the hold ended the session
    // as the checkout said. No station message.
    const stateByReason: Record<PaymentStopReason, StationMessageState | null> = {
      PaymentFailed: 'payment_failed',
      MissingPaymentMethod: 'payment_required',
      GuestPaymentNotAuthorized: 'guest_unauthorized',
      AnonymousSession: 'unauthorized',
      PrepaidCreditExhausted: 'prepaid_exhausted',
      GuestHoldExhausted: null,
    };
    const messageState = stateByReason[reason];
    if (messageState != null) await showStopMessage(deps, target, messageState);
  }

  // The audit helper logs its own failures (fail-open).
  if (faulted) {
    await notify.auditLinkedReservationFault(sessionId, `faulted: ${reason}`);
  }
}

/**
 * A 2.1 station reported reaching the cost limit (TransactionEvent
 * triggerReason CostLimitReached, E16.FR.05) of a session with a prepaid
 * token's credit as its ceiling (C17.FR.03): the station suspended it, so the
 * CSMS does not stop it. Claims the session with the same stopped_reason
 * claim as `stopSessionForPayment` (PrepaidCreditExhausted), so the station
 * message and the driver notice go out once per session, whichever comes
 * first, and a later CSMS stop finds the session claimed and sends nothing.
 * A guest session (no token) is left alone. Returns true when it claimed.
 * A failed claim throws (the caller decides the retry); the notices are
 * fail-open.
 */
export async function notePrepaidCostLimitReached(
  deps: ProjectionDeps,
  target: StopTarget,
): Promise<boolean> {
  const row = await claimCeilingStop(deps.sql, target.sessionId, 'PrepaidCreditExhausted', true);
  if (row == null) return false;
  await sendPrepaidExhaustedNotices(deps, target, row);
  return true;
}

/**
 * Records the ceiling stop on an active session that has none yet and returns
 * what the driver's prepaid notice needs, or null when another call claimed
 * it. `prepaidOnly` also requires a token and a ceiling (a prepaid session).
 */
async function claimCeilingStop(
  sql: postgres.Sql,
  sessionId: string,
  reason: 'PrepaidCreditExhausted' | 'GuestHoldExhausted',
  prepaidOnly: boolean,
): Promise<CeilingStopRow | null> {
  const claimed = await sql<CeilingStopRow[]>`
    WITH claimed AS (
      UPDATE charging_sessions
      SET stopped_reason = ${reason}, updated_at = now()
      WHERE id = ${sessionId} AND status = 'active' AND stopped_reason IS NULL
        AND (NOT ${prepaidOnly} OR (token_id IS NOT NULL AND cost_ceiling_cents IS NOT NULL))
      RETURNING id, driver_id, token_id, station_id, cost_ceiling_cents, currency
    )
    SELECT COALESCE(claimed.driver_id, dt.driver_id) AS driver_id,
           dt.id_token, claimed.cost_ceiling_cents,
           UPPER(claimed.currency) AS currency, s.name AS site_name
    FROM claimed
    LEFT JOIN driver_tokens dt ON dt.id = claimed.token_id
    LEFT JOIN charging_stations st ON st.id = claimed.station_id
    LEFT JOIN sites s ON s.id = st.site_id
  `;
  return claimed[0] ?? null;
}

/**
 * The prepaid_exhausted station message and the driver's
 * `prepaid.CreditExhausted` notice. Fire-and-forget and fail-open (P9).
 */
async function sendPrepaidExhaustedNotices(
  deps: ProjectionDeps,
  target: StopTarget,
  row: CeilingStopRow,
): Promise<void> {
  const { sql, eventBus, pubsub, logger } = deps;
  await showStopMessage(deps, target, 'prepaid_exhausted');
  if (row.driver_id == null) return;
  const currency = row.currency;
  // Fail-open (P9): the notice runs in the background and logs its failure.
  void eventBus.track(
    dispatchDriverNotification(
      sql,
      'prepaid.CreditExhausted',
      row.driver_id,
      {
        idToken: row.id_token ?? '',
        siteName: row.site_name ?? '',
        stationId: target.ocppStationId,
        transactionId: target.transactionId,
        creditFormatted:
          row.cost_ceiling_cents != null ? notificationMoney(row.cost_ceiling_cents, currency) : '',
        currency,
      },
      ALL_TEMPLATES_DIRS,
      pubsub,
    ).catch((err: unknown) => {
      logger.warn(
        { err, sessionId: target.sessionId },
        'Prepaid credit exhausted notice failed; continuing',
      );
    }),
  );
}

/**
 * Pushes a one-shot driver-facing message to the station screen so the
 * physical UX matches the email/SMS notification fan-out. The template body
 * is operator-editable in Settings -> Integration -> Station Messages,
 * rendered with the standard StationMessageContext, and dispatched via
 * dispatchOneShotStationMessage. Fail-open (P9).
 */
async function showStopMessage(
  deps: ProjectionDeps,
  target: StopTarget,
  state: StationMessageState,
): Promise<void> {
  const { sql, pubsub, logger } = deps;
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
        stationOcppId: target.ocppStationId,
        stationDbId: target.stationDbId,
        state,
        context: {
          companyName,
          stationOcppId: target.ocppStationId,
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
    logger.warn({ err, state }, 'Failed to publish payment-failure display message');
  }
}
