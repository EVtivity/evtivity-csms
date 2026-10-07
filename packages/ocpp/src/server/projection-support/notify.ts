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
import type { ProjectionLookups } from './lookups.js';

export interface ProjectionNotifier {
  auditLinkedReservationFault(sessionId: string, reason: string): Promise<void>;
  dispatchIdlingNotification(
    sessionId: string,
    stationId: string,
    transactionId: string,
    idleAt: string,
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

export interface ProjectionNotifierDeps {
  sql: postgres.Sql;
  eventBus: EventBus;
  pubsub: PubSubClient;
  logger: Logger;
  lookups: ProjectionLookups;
}

export function createProjectionNotifier(deps: ProjectionNotifierDeps): ProjectionNotifier {
  const { sql, eventBus, pubsub, logger, lookups } = deps;

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

  // Dispatch IdlingStarted notification for both driver and guest sessions.
  // Used by TransactionEvent Updated (chargingState) and StatusNotification (1.6 fallback).
  async function dispatchIdlingNotification(
    sessionId: string,
    stationId: string,
    transactionId: string,
    idleAt: string,
  ): Promise<void> {
    // The station reported the vehicle idle (2.1 chargingState, 1.6 status).
    // One statement marks the session idle (keeping a period already open) and
    // claims the period by copying its start into idle_notified_at; only the
    // claiming call gets a row and notifies. So two events of one period
    // (ChargingStateChanged then CostLimitReached, repeated SuspendedEV) notify
    // once, a meter reading cannot end the period between the mark and the
    // claim (the meter fallbacks never clear a claimed period), and a later
    // period has a new idle_started_at and notifies again.
    // The idle fee and tax rate that apply now: the open tariff segment's
    // snapshot (split billing), else the session's.
    const idleSession = await sql`
      WITH claimed AS (
        UPDATE charging_sessions
        SET idle_started_at = COALESCE(idle_started_at, ${idleAt}::timestamptz),
            idle_notified_at = COALESCE(idle_started_at, ${idleAt}::timestamptz),
            updated_at = now()
        WHERE id = ${sessionId} AND status = 'active'
          AND idle_notified_at IS DISTINCT FROM COALESCE(idle_started_at, ${idleAt}::timestamptz)
        RETURNING id, idle_started_at
      )
      SELECT cs.driver_id, claimed.idle_started_at,
             CASE WHEN seg.price_snapshot THEN seg.idle_fee_price_per_minute
                  ELSE cs.tariff_idle_fee_price_per_minute END AS idle_fee_price_per_minute,
             CASE WHEN seg.price_snapshot THEN seg.tax_rate
                  ELSE cs.tariff_tax_rate END AS tax_rate,
             cs.tax_basis, d.price_display, UPPER(cs.currency) AS currency
      FROM charging_sessions cs
      JOIN claimed ON claimed.id = cs.id
      LEFT JOIN drivers d ON d.id = cs.driver_id
      LEFT JOIN LATERAL (
        SELECT price_snapshot, idle_fee_price_per_minute, tax_rate
        FROM session_tariff_segments
        WHERE session_id = cs.id AND ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1
      ) seg ON true
      WHERE cs.id = ${sessionId}
    `;
    const idleRow = idleSession[0];
    if (idleRow == null) return;

    const stationUuid = await lookups.resolveStationUuid(stationId);
    const gracePeriodMinutes = await getIdlingGracePeriodMinutes();
    const idleFeeRate = idleRow.idle_fee_price_per_minute as string | null;
    const idleSiteName = stationUuid != null ? await lookups.resolveSiteName(stationUuid) : null;

    // The idle fee is shown as the driver chose in the portal, else as the
    // company setting says. Guests have no choice and follow the setting.
    const priceDisplay = resolvePriceDisplay(idleRow.price_display, await getCompanyPriceDisplay());
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
      // Guest session: check for guest email
      const guestRows = await sql`
        SELECT guest_email FROM guest_sessions
        WHERE charging_session_id = ${sessionId} AND guest_email != ''
        LIMIT 1
      `;
      const guestRow = guestRows[0];
      if (guestRow != null) {
        void eventBus.track(
          dispatchSystemNotification(
            sql,
            'session.IdlingStarted',
            { email: guestRow.guest_email as string },
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
    dispatchIdlingNotification,
    notifyChange,
    publishStationMessageTransaction,
    notifyOcpiPush,
    linkCpoRoamingSession,
  };
}
