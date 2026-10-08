// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import type { EventBus, Logger, PubSubClient } from '@evtivity/lib';
import {
  isRoamingEnabled,
  getIdlingGracePeriodMinutes,
  getCompanyPriceDisplay,
  writeReservationAudit,
} from '@evtivity/database';
import {
  notificationUnitPrice,
  notificationTaxRate,
  priceForDisplay,
  resolvePriceDisplay,
  resolveTaxBasis,
} from '@evtivity/lib';
import {
  dispatchDriverNotification,
  dispatchSystemNotification,
  ALL_TEMPLATES_DIRS,
} from '../notification-dispatcher.js';

export interface ProjectionNotifier {
  auditLinkedReservationFault(sessionId: string, reason: string): Promise<void>;
  dispatchDueIdlingNotification(
    sessionId: string,
    stationId: string,
    transactionId: string,
    at: string,
  ): Promise<void>;
  notifyChange(
    eventType: string,
    stationId: string | null,
    siteId: string | null,
    sessionId?: string | null,
    extra?: Record<string, unknown>,
  ): Promise<void>;
  publishStationMessageTransaction(
    screen: { stationUuid: string; stationId: string; protocol: string | null },
    sessionId: string,
    kind: 'started' | 'updated' | 'ended',
    chargingState: string | null,
  ): Promise<void>;
  notifyOcpiPush(
    type: 'location' | 'session' | 'cdr' | 'tariff',
    ids: { siteId?: string; sessionId?: string; cdrId?: string; tariffId?: string },
  ): Promise<void>;
  linkCpoRoamingSession(sessionId: string, idToken: string): Promise<void>;
}

/**
 * How long an idle period lasts before session.IdlingStarted goes out (owner
 * rule 2026-10-08): an EV that reports full and ends the transaction a moment
 * later gets no idling notice. The idle fee still follows the grace period.
 */
export const IDLE_NOTICE_MIN_SECONDS = 60;

export interface ProjectionNotifierDeps {
  sql: postgres.Sql;
  eventBus: EventBus;
  pubsub: PubSubClient;
  logger: Logger;
}

export function createProjectionNotifier(deps: ProjectionNotifierDeps): ProjectionNotifier {
  const { sql, eventBus, pubsub, logger } = deps;

  // Write a `session_failed` reservation audit row when a charging session
  // that was linked to a reservation ends in a non-success state. Covers the
  // four fault paths that bypass the normal TransactionEvent.Ended flow:
  // stale-session sweep, EVConnectTimeout on Started, payment-gate eager
  // cleanup, and the Ended-handler timeout/faulted branch. No-op when the
  // session has no reservation_id. Best-effort; audit failure does not roll
  // back the underlying session state change.
  async function auditLinkedReservationFault(sessionId: string, reason: string): Promise<void> {
    try {
      const rows = await sql<{ reservation_id: string | null }[]>`
        SELECT reservation_id FROM charging_sessions WHERE id = ${sessionId} LIMIT 1
      `;
      const reservationId = rows[0]?.reservation_id ?? null;
      if (reservationId == null) return;
      await writeReservationAudit(
        {
          reservationId,
          action: 'session_failed',
          actor: 'system',
          notes: `session ${sessionId}: ${reason}`,
        },
        undefined,
        logger,
      );
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to write session_failed reservation audit');
    }
  }

  // Dispatch session.IdlingStarted for both driver and guest sessions, once
  // an idle period has lasted IDLE_NOTICE_MIN_SECONDS (owner rule
  // 2026-10-08, finding JB-2). Every projection that sees an event or a
  // meter reading of an active session calls it with that event's timestamp
  // before it applies its own idle open or close: the first one at or after
  // the minimum, while the period is still open, sends the notice, also when
  // that event ends the period (a resume, the transaction end). A period that
  // ends sooner sends nothing, whichever signal opened it (2.1 chargingState,
  // 1.6 status, the meter fallbacks), so 1.6 and 2.1 behave the same.
  // The claim copies the period start into idle_notified_at: only the
  // claiming call gets a row and notifies, so a period notifies once and a
  // later period (a new idle_started_at) notifies again.
  // Retry safety (event-projections.md, "Retry on a lost database
  // connection"): the settings are read before the claim, and the claim
  // statement itself returns everything the notice needs (the idle fee and
  // tax rate that apply now, from the open tariff segment's snapshot under
  // split billing, else the session's; the site name; a guest's email).
  // After the claim only the fail-open dispatch runs, so no lost connection
  // can fail a rerun between the claim and the send and lose the notice.
  async function dispatchDueIdlingNotification(
    sessionId: string,
    stationId: string,
    transactionId: string,
    at: string,
  ): Promise<void> {
    const gracePeriodMinutes = await getIdlingGracePeriodMinutes();
    const companyPriceDisplay = await getCompanyPriceDisplay();
    const idleSession = await sql`
      WITH claimed AS (
        UPDATE charging_sessions
        SET idle_notified_at = idle_started_at,
            updated_at = now()
        WHERE id = ${sessionId} AND status = 'active'
          AND idle_started_at IS NOT NULL
          AND idle_notified_at IS DISTINCT FROM idle_started_at
          AND ${at}::timestamptz >= idle_started_at + make_interval(secs => ${IDLE_NOTICE_MIN_SECONDS})
        RETURNING id, idle_started_at
      )
      SELECT cs.driver_id, claimed.idle_started_at,
             CASE WHEN seg.price_snapshot THEN seg.idle_fee_price_per_minute
                  ELSE cs.tariff_idle_fee_price_per_minute END AS idle_fee_price_per_minute,
             CASE WHEN seg.price_snapshot THEN seg.tax_rate
                  ELSE cs.tariff_tax_rate END AS tax_rate,
             cs.tax_basis, d.price_display, UPPER(cs.currency) AS currency,
             site.name AS site_name, guest.guest_email
      FROM charging_sessions cs
      JOIN claimed ON claimed.id = cs.id
      LEFT JOIN drivers d ON d.id = cs.driver_id
      LEFT JOIN charging_stations st ON st.id = cs.station_id
      LEFT JOIN sites site ON site.id = st.site_id
      LEFT JOIN LATERAL (
        SELECT price_snapshot, idle_fee_price_per_minute, tax_rate
        FROM session_tariff_segments
        WHERE session_id = cs.id AND ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1
      ) seg ON true
      LEFT JOIN LATERAL (
        SELECT gs.guest_email FROM guest_sessions gs
        WHERE gs.charging_session_id = cs.id AND gs.guest_email != ''
        LIMIT 1
      ) guest ON cs.driver_id IS NULL
      WHERE cs.id = ${sessionId}
    `;
    const idleRow = idleSession[0];
    if (idleRow == null) return;

    const idleFeeRate = idleRow.idle_fee_price_per_minute as string | null;
    const idleSiteName = idleRow.site_name as string | null;

    // The idle fee is shown as the driver chose in the portal, else as the
    // company setting says. Guests have no choice and follow the setting.
    const priceDisplay = resolvePriceDisplay(idleRow.price_display, companyPriceDisplay);
    const idleFee = idleFeeRate != null ? Number(idleFeeRate) : 0;
    const taxRate = idleRow.tax_rate != null ? Number(idleRow.tax_rate) : 0;
    const taxBasis = resolveTaxBasis(idleRow.tax_basis);

    const templateVars = {
      siteName: idleSiteName ?? '',
      stationId,
      transactionId,
      idleStartedAt: idleRow.idle_started_at as string,
      gracePeriodMinutes,
      // The rate as stored, in the session's tax basis. Empty when there is no idle fee (null or 0), so
      // templates that test {{#if idleFeePricePerMinute}} skip the fee text:
      // the string '0' or '0.00' is truthy in Handlebars.
      idleFeePricePerMinute: idleFee > 0 && idleFeeRate != null ? idleFeeRate : '',
      // Empty when there is no idle fee, so templates can test it with #if.
      idleFeeFormatted:
        idleFee > 0
          ? notificationUnitPrice(
              priceForDisplay(idleFee, taxRate, priceDisplay, taxBasis),
              idleRow.currency as string,
            )
          : '',
      idleFeeIncludesTax: priceDisplay === 'gross',
      taxRatePercent: taxRate > 0 ? notificationTaxRate(taxRate) : '',
      currency: idleRow.currency as string,
    };

    if (idleRow.driver_id != null) {
      void eventBus.track(
        dispatchDriverNotification(
          sql,
          'session.IdlingStarted',
          idleRow.driver_id as string,
          templateVars,
          ALL_TEMPLATES_DIRS,
          pubsub,
        ),
      );
    } else {
      // Guest session: the guest's email, read by the claim.
      const guestEmail = idleRow.guest_email as string | null;
      if (guestEmail != null) {
        void eventBus.track(
          dispatchSystemNotification(
            sql,
            'session.IdlingStarted',
            { email: guestEmail },
            templateVars,
            ALL_TEMPLATES_DIRS,
          ),
        );
      }
    }
  }

  async function notifyChange(
    eventType: string,
    stationId: string | null,
    siteId: string | null,
    sessionId?: string | null,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const payload = JSON.stringify({
        eventType,
        stationId,
        siteId,
        sessionId: sessionId ?? null,
        ...(extra ?? {}),
      });
      await pubsub.publish('csms_events', payload);
    } catch (err) {
      logger.debug({ err, eventType, stationId }, 'SSE notification publish failed; continuing');
    }
  }

  // Asks the api to re-render the station screen of an OCPP 2.x transaction.
  async function publishStationMessageTransaction(
    screen: { stationUuid: string; stationId: string; protocol: string | null },
    sessionId: string,
    kind: 'started' | 'updated' | 'ended',
    chargingState: string | null,
  ): Promise<void> {
    if (screen.protocol == null || !screen.protocol.startsWith('ocpp2')) return;
    try {
      await pubsub.publish(
        'station_message_transaction',
        JSON.stringify({
          sessionId,
          internalStationId: screen.stationUuid,
          stationOcppId: screen.stationId,
          ocppProtocol: screen.protocol,
          eventType: kind,
          chargingState,
        }),
      );
    } catch (err) {
      logger.debug(
        { err, sessionId, kind },
        'Station-message transaction publish failed; continuing',
      );
    }
  }

  async function notifyOcpiPush(
    type: 'location' | 'session' | 'cdr' | 'tariff',
    ids: { siteId?: string; sessionId?: string; cdrId?: string; tariffId?: string },
  ): Promise<void> {
    try {
      if (!(await isRoamingEnabled())) return;
      const payload = JSON.stringify({ type, ...ids });
      await pubsub.publish('ocpi_push', payload);
    } catch (err) {
      logger.debug({ err, type }, 'OCPI push publish failed; continuing');
    }
  }

  // A session started with a partner's (eMSP's) token is our CPO session for
  // that partner. The link row in ocpi_roaming_sessions is what the OCPI
  // server serves on GET /cpo/sessions, pushes to the partner, and resolves
  // STOP_SESSION and CDRs with. The OCPI Session id is the charging session
  // id: OCPI needs it unique for the CPO, and a transactionId is unique per
  // station only (links written before 0.1.38 keep their transaction id).
  // Written here, before the push is published, so a lost push still leaves
  // the session visible to the partner's next pull. ON CONFLICT keeps it to
  // one link per session when Started is processed twice.
  async function linkCpoRoamingSession(sessionId: string, idToken: string): Promise<void> {
    try {
      await sql`
        INSERT INTO ocpi_roaming_sessions
          (partner_id, ocpi_session_id, charging_session_id, token_uid, status, currency)
        SELECT t.partner_id, ${sessionId}, ${sessionId}, t.uid, 'ACTIVE', cs.currency
        FROM ocpi_external_tokens t
        JOIN charging_sessions cs ON cs.id = ${sessionId}
        WHERE t.uid = ${idToken} AND t.is_valid = true
        ORDER BY t.updated_at DESC
        LIMIT 1
        ON CONFLICT (charging_session_id) WHERE charging_session_id IS NOT NULL DO NOTHING
      `;
    } catch (err) {
      logger.warn({ err, sessionId }, 'OCPI roaming session link failed; continuing');
    }
  }

  return {
    auditLinkedReservationFault,
    dispatchDueIdlingNotification,
    notifyChange,
    publishStationMessageTransaction,
    notifyOcpiPush,
    linkCpoRoamingSession,
  };
}
