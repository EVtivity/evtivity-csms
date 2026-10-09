// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import type { DomainEvent } from '@evtivity/lib';
import {
  writeReservationAudit,
  isSiteFreeVendEnabledByStation,
  getElectricityRatePeriodsForSite,
  getCompanyCurrency,
  applyEvseChargingState,
  getCompanyTaxBasis,
  snapshotSessionTariff,
  openFirstTariffSegment,
  repriceSessionForDriver,
  resolveStationTariff,
  priceSessionAt,
  loadSessionPricing,
  storeFinalCost,
  closeOpenSegment,
  sessionIdleMinutesAt,
  pgConnectionErrorKind,
  SESSION_END_FAILED_REASON,
} from '@evtivity/database';
import type { TariffPriceSnapshot } from '@evtivity/database';
import type { ProjectionDeps } from '../projection-support/context.js';
import type { ProjectionAttempt } from '../projection-retry.js';
import { runPaymentGate } from './payment-gate.js';
import { noteCostLimitReached } from './payment-stop.js';
import { settleTransactionEnded } from './settlement.js';
import type { SessionLifecycleState } from './state.js';
import { getString } from '../projection-support/payload.js';
import { requestCsmsSessionEnd, SESSION_ENDED_BY_CSMS } from '../csms-session-end.js';
import {
  generateId,
  calculateCo2AvoidedKg,
  resolveElectricityRate,
  calculateElectricityCostCents,
  notificationMoney,
  costIncludesTax,
  reconcileCostBreakdown,
  chargedCostBreakdown,
} from '@evtivity/lib';
import { dispatchDriverNotification, ALL_TEMPLATES_DIRS } from '../notification-dispatcher.js';
import { projectionLane, sessionGatedKey, sessionPricedKey } from '../projection-queue.js';
import { isUnbilledTimeoutEnd } from '../session-cost.js';

const CHARGING_STATE_TO_STATUS: Record<string, string> = {
  Charging: 'charging',
  EVConnected: 'ev_connected',
  SuspendedEV: 'suspended_ev',
  SuspendedEVSE: 'suspended_evse',
  Idle: 'idle',
  Discharging: 'discharging',
};

const SESSION_UPDATE_THROTTLE_MS = 15 * 60 * 1000;

// How long a transaction projection waits for the station lane to create an
// EVSE the station just reported (see the Started insert).
const EVSE_LANE_WAIT_MS = 5000;

function getSessionId(rows: postgres.RowList<postgres.Row[]>): string | null {
  const row = rows[0];
  if (row == null) return null;
  return row.id as string;
}

/** The fields of a TransactionEvent every event type reads. */
interface TransactionEventContext {
  event: DomainEvent;
  /** The projection run, for the steps a rerun must not repeat. */
  attempt: ProjectionAttempt;
  payload: DomainEvent['payload'];
  stationId: string;
  stationUuid: string;
  transactionId: string;
  seqNo: number;
  triggerReason: string;
  timestamp: string;
  payloadJson: string;
}

/** What resolveStartedSession resolved for the session, read by completeStartedSession. */
/**
 * How long an ended prepaid session without its debit still reserves its cost
 * from the token's balance (`linkPrepaidToken`).
 */
const UNSETTLED_RESERVATION_HOURS = 24;

interface StartedContext {
  sessionId: string;
  isFreeVend: boolean;
  driverUuid: string | null;
  isRoamingSession: boolean;
  guestStatus: string | null;
  guestEmail: string | null;
  tokenLookup: {
    id: string;
    driverId: string | null;
    /** The credit a prepaid token's session may spend (its cost ceiling); null when not prepaid. */
    prepaidCreditCents: number | null;
  } | null;
  sessionTariff: TariffPriceSnapshot | null;
  linkedReservationId: string | null;
}

/**
 * The TransactionEvent projection: Started, Updated and Ended, and the end of
 * a session the CSMS ends because the station will not.
 */
export class TransactionProjector {
  constructor(
    private readonly deps: ProjectionDeps,
    private readonly state: SessionLifecycleState,
  ) {}

  async project(event: DomainEvent, attempt: ProjectionAttempt): Promise<void> {
    const payload = event.payload;
    const eventType = payload.eventType as string;
    const stationId = payload.stationId as string;
    const stationUuid = await this.deps.lookups.resolveStationUuid(stationId);
    if (stationUuid == null) return;

    const transactionId = payload.transactionId as string;
    const seqNo = payload.seqNo as number;
    const triggerReason = payload.triggerReason as string;
    const timestamp = payload.timestamp as string;
    const payloadJson = JSON.stringify(payload);

    const tx: TransactionEventContext = {
      event,
      attempt,
      payload,
      stationId,
      stationUuid,
      transactionId,
      seqNo,
      triggerReason,
      timestamp,
      payloadJson,
    };

    if (eventType === 'Started') {
      await this.projectStarted(tx);
    } else if (eventType === 'Updated') {
      await this.projectUpdated(tx);
    } else if (eventType === 'Ended') {
      await this.projectEnded(tx);
    }
  }

  private async publishTransactionScreen(
    tx: TransactionEventContext,
    sessionId: string,
    kind: 'started' | 'updated' | 'ended',
    chargingState: string | null,
  ): Promise<void> {
    const { stationId } = tx;
    try {
      const [stationRow] = await this.deps.sql`
          SELECT ocpp_protocol FROM charging_stations WHERE id = ${tx.stationUuid}
        `;
      const protocol = (stationRow?.ocpp_protocol as string | null | undefined) ?? null;
      await this.deps.notify.publishStationMessageTransaction(
        { stationUuid: tx.stationUuid, stationId, protocol },
        sessionId,
        kind,
        chargingState,
      );
    } catch (err) {
      this.deps.logger.debug(
        { err, sessionId, kind },
        'Station protocol lookup failed; continuing',
      );
    }
  }

  /**
   * True when the station already sent this event: the transaction's session
   * has a transaction_events row with the same event type, seqNo, timestamp and
   * triggerReason. A station resends an event it got no response to (OCPP
   * 2.1 E13.FR.02, 1.6 section 3.7.1 for StartTransaction and
   * StopTransaction) and replays its offline queue after a reconnect
   * (E04.FR.02), under a new message id (finding JB-6). A resent event is
   * answered normally and its projection is skipped: no second row, and no
   * second idle, cost, settlement or notice. seqNo alone would do for a
   * station that follows E 1.3.2.1 (seqNo increases by 1 per event); the
   * full identity keeps a different event of a station that reuses a seqNo,
   * and the CSMS end (`csms-session-end.ts`, MAX(seq_no) + 1) never matches
   * the station's own Ended.
   *
   * Race-safe without a unique key on the large table: every event of one
   * transaction projects on its transaction lane, one at a time, so the
   * first delivery wrote its row before the resend is checked. Memoized: a
   * projection retry keeps the first answer although the first run has
   * since written this event's row.
   */
  private isResentEvent(
    tx: TransactionEventContext,
    eventType: 'started' | 'updated' | 'ended',
  ): Promise<boolean> {
    return tx.attempt.memo(`${eventType}:resent`, async () => {
      const rows = await this.deps.sql`
        SELECT te.session_id FROM transaction_events te
        JOIN charging_sessions cs ON cs.id = te.session_id
        WHERE cs.station_id = ${tx.stationUuid}
          AND cs.transaction_id = ${tx.transactionId}
          AND te.event_type = ${eventType}
          AND te.seq_no = ${tx.seqNo}
          AND te.timestamp = ${tx.timestamp}::timestamptz
          AND te.trigger_reason = ${tx.triggerReason}
        LIMIT 1
      `;
      const sessionId = rows[0]?.session_id as string | undefined;
      if (sessionId == null) return false;
      this.deps.logger.info(
        {
          stationId: tx.stationId,
          transactionId: tx.transactionId,
          sessionId,
          eventType,
          seqNo: tx.seqNo,
        },
        'Resent TransactionEvent already projected; skipped',
      );
      return true;
    });
  }

  private async projectStarted(tx: TransactionEventContext): Promise<void> {
    const { event, payload, stationId, stationUuid, transactionId, triggerReason, timestamp } = tx;
    // For remote starts, link back to the session created by the portal/API
    // instead of creating a duplicate.
    // The connector the station reports for the transaction (1.6 connectorId,
    // 2.1 evse.connectorId). When it is missing or matches no connector, an
    // EVSE with a single connector uses that one. Applied in the insert and
    // the remote-start link.
    const reportedConnector = typeof payload.connectorId === 'number' ? payload.connectorId : null;
    let sessionId: string | null = null;
    if (triggerReason === 'RemoteStart') {
      // Atomic pick-and-link in one statement so concurrent Started events
      // (different transactionIds, parallel projection queues) cannot both
      // claim the same pending row. Without FOR UPDATE SKIP LOCKED, two
      // simultaneous portal starts on the same station would both UPDATE
      // the same row and the second would orphan the first's linkage.
      // Only a transactionId new for the station links a session: a Started
      // the station sends again (a resend after a lost response, E13.FR.02,
      // or an offline replay, E04.FR.02) is the same transaction and falls
      // through to the insert, whose ON CONFLICT returns the session already
      // holding it. Only a remote start still waiting for its transaction
      // (no transaction_events row) is linked, so a session never moves to
      // another transaction.
      const linked = await this.deps.sql`
          WITH target AS (
            SELECT pending.id FROM charging_sessions pending
            WHERE pending.station_id = ${stationUuid}
              AND pending.remote_start_id IS NOT NULL
              AND pending.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM transaction_events te WHERE te.session_id = pending.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM charging_sessions holder
                WHERE holder.station_id = ${stationUuid}
                  AND holder.transaction_id = ${transactionId}
              )
            ORDER BY pending.started_at DESC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE charging_sessions cs
          SET transaction_id = ${transactionId},
              connector_id = COALESCE(cs.connector_id, (
                SELECT c.id FROM connectors c
                WHERE c.evse_id = cs.evse_id
                  AND (c.connector_id = ${reportedConnector}
                    OR (SELECT count(*) FROM connectors c2 WHERE c2.evse_id = cs.evse_id) = 1)
                LIMIT 1
              )),
              updated_at = now()
          FROM target
          WHERE cs.id = target.id
          RETURNING cs.id
        `;
      if (linked[0] != null) {
        sessionId = linked[0].id as string;
      }
    }

    if (sessionId == null) {
      const newSessionId = generateId('session');
      const ocppEvseId =
        typeof payload.evseId === 'number'
          ? payload.evseId
          : typeof payload.evseId === 'string'
            ? parseInt(payload.evseId, 10)
            : 0;
      let txEvseUuid = await this.deps.lookups.resolveEvseUuid(stationUuid, ocppEvseId);
      if (txEvseUuid == null && ocppEvseId > 0 && projectionLane(event) !== stationId) {
        // The EVSE is created by the projection of the station's first
        // StatusNotification, which runs on the station lane, while this
        // event runs on the transaction lane. A new station that reports the
        // EVSE and starts a transaction right after would get a session
        // without its EVSE and connector, which nothing fills in later. The
        // station sent that StatusNotification before this event, so its
        // projection is already queued: wait for the station lane (bounded)
        // and look again. An event already on the station lane never waits
        // for its own lane.
        await this.state.projectionQueue.settled([stationId], EVSE_LANE_WAIT_MS);
        txEvseUuid = await this.deps.lookups.resolveEvseUuid(stationUuid, ocppEvseId, true);
      }
      // OCPP 1.6 StartTransaction carries meterStart; OCPP 2.1 TransactionEvent Started does
      // not. Insert NULL when absent so the MeterValues handler captures the first energy
      // reading as meter_start. Inserting 0 here would defeat that guard and cause
      // energy_delivered_wh to be computed against the station's lifetime register.
      const meterStartVal = payload.meterStart != null ? Number(payload.meterStart) : null;
      // Resolve the roaming-token state BEFORE the INSERT so is_roaming is
      // set atomically with row creation. Any consumer that reads the
      // session row between INSERT and a downstream UPDATE will see the
      // correct value. Driver/free-vend resolution still happens after
      // the insert because it has more side effects (token linkage,
      // payment gate).
      const earlyIdToken = payload.idToken as string | null;
      let initialIsRoaming = false;
      if (earlyIdToken != null) {
        try {
          const roamCheck = await this.deps.sql`
              SELECT 1 FROM ocpi_external_tokens
              WHERE uid = ${earlyIdToken} AND is_valid = true
              LIMIT 1
            `;
          initialIsRoaming = roamCheck.length > 0;
        } catch (err) {
          // A lost connection goes to the projection retry: defaulting to
          // non-roaming would insert a roaming session the gate then stops.
          // A read outside a `once` step, so a rerun is safe. On the last
          // run it defaults as before: a session row the gate may stop is
          // safer than no session row for a transaction the station runs.
          if (pgConnectionErrorKind(err) != null && !tx.attempt.isLast) throw err;
          this.deps.logger.debug(
            { err, idToken: earlyIdToken },
            'OCPI external-token lookup failed; defaulting to non-roaming',
          );
          initialIsRoaming = false;
        }
      }
      // Atomic insert + capture: ON CONFLICT DO UPDATE with a no-op (touches
      // updated_at) lets RETURNING fire on both the insert and the conflict
      // path, eliminating the race window where a separate SELECT could
      // miss the row if a concurrent process (stale-session cleanup,
      // operator delete) removed it between INSERT and SELECT.
      // The session is billed in the company currency at its start.
      const initialCurrency = await getCompanyCurrency();
      const inserted = await this.deps.sql`
          INSERT INTO charging_sessions (id, station_id, evse_id, connector_id, transaction_id, status, started_at, meter_start, is_roaming, currency)
          VALUES (${newSessionId}, ${stationUuid}, ${txEvseUuid}, (
            SELECT c.id FROM connectors c
            WHERE c.evse_id = ${txEvseUuid}
              AND (c.connector_id = ${reportedConnector}
                OR (SELECT count(*) FROM connectors c2 WHERE c2.evse_id = ${txEvseUuid}) = 1)
            LIMIT 1
          ), ${transactionId}, 'active', ${timestamp}, ${meterStartVal}, ${initialIsRoaming}, ${initialCurrency})
          ON CONFLICT (station_id, transaction_id) DO UPDATE SET updated_at = now()
          RETURNING id
        `;
      sessionId = getSessionId(inserted);
    }
    let gateFailure: { err: unknown } | null = null;
    if (sessionId != null && (await this.isResentEvent(tx, 'started'))) {
      // The first delivery ran the Started step: the session has its tariff
      // snapshot and gate decision, so a handler waiting to answer this
      // resend with the running cost or the ceiling goes on.
      this.state.projectionQueue.signal(sessionPricedKey(stationId, transactionId));
      this.state.projectionQueue.signal(sessionGatedKey(stationId, transactionId));
      return;
    }
    if (sessionId != null) {
      // A rerun reuses what the first run resolved: the reservation it moved
      // to in_use and a guest it saw before TransactionStarted moved the guest
      // session to charging would otherwise read differently and stop the
      // session.
      const startedSessionId = sessionId;
      const started = await tx.attempt.memo('started:context', () =>
        this.resolveStartedSession(tx, startedSessionId),
      );
      gateFailure = await this.completeStartedSession(tx, started);
    }

    // Drain buffered out-of-order events for this transaction
    const buffered = this.state.txBuffer.drain(stationId, transactionId);
    for (const bufferedEvent of buffered) {
      void this.deps.eventBus.publish(bufferedEvent);
    }

    // Refresh station display with the in-progress transaction message.
    // Defer to the api-side listener so the renderer + push logic stays
    // in one place and we don't pull the renderer into the OCPP package.
    if (sessionId != null) {
      const startedChargingState = (payload.chargingState as string | undefined) ?? null;
      await this.publishTransactionScreen(tx, sessionId, 'started', startedChargingState);
    }

    if (gateFailure != null) throw gateFailure.err;
  }

  /**
   * The Started step up to the priced signal: supersede, EVSE state, the
   * transaction event row, free vend, driver, token, guest hold, vehicle,
   * tariff snapshot and reservation link.
   */
  private async resolveStartedSession(
    tx: TransactionEventContext,
    sessionId: string,
  ): Promise<StartedContext> {
    const {
      payload,
      stationId,
      stationUuid,
      transactionId,
      seqNo,
      triggerReason,
      timestamp,
      payloadJson,
    } = tx;
    // Close stale active sessions on the same EVSE (if any).
    // A new transaction starting means any previous session on this EVSE ended
    // without a proper Ended event (e.g., station rebooted, connection lost).
    // Such a session is ended the normal way, as completed with its
    // final cost, settlement, and receipt (owner decision 2026-10-04):
    // requestCsmsSessionEnd claims it while it is still active (P5) and
    // queues a CSMS end behind this event.
    const stale = await this.deps.sql`
          SELECT id FROM charging_sessions
          WHERE station_id = ${stationUuid} AND status = 'active'
            AND id != ${sessionId}
            AND evse_id = (SELECT evse_id FROM charging_sessions WHERE id = ${sessionId})
        `;
    for (const r of stale) {
      const staleId = r['id'] as string;
      try {
        await requestCsmsSessionEnd(this.deps.sql, this.deps.eventBus, staleId, 'Superseded');
      } catch (err: unknown) {
        this.deps.logger.error({ err, sessionId: staleId }, 'Failed to end a superseded session');
      }
    }

    // Set connector to 'ev_connected' on transaction start (cable connected).
    // Only applies to OCPP 2.1 where the Started event carries
    // `chargingState: 'EVConnected'`. For OCPP 1.6 the StatusNotification
    // projection already wrote the correct fine-grained status (e.g.
    // 'charging') and this block must not overwrite it.
    // Skip when EVConnectTimeout: the EV was never actually connected.
    if (
      triggerReason !== 'EVConnectTimeout' &&
      (payload.chargingState as string | undefined) === 'EVConnected'
    ) {
      const startEvseRows = await this.deps.sql`
            SELECT evse_id FROM charging_sessions WHERE id = ${sessionId}
          `;
      const startEvseUuid = startEvseRows[0]?.evse_id as string | null;
      if (startEvseUuid != null) {
        // Preserve operator-set terminal/disabled states. A faulted or
        // unavailable connector should not be reset to ev_connected just
        // because a session started on it; the operator wants the bad
        // state visible until they explicitly clear it.
        await applyEvseChargingState(this.deps.sql, startEvseUuid, 'ev_connected', timestamp);
        // Notify portal SSE: chargingState enrichment changes
        // connectors.status without sending a StatusNotification, so the
        // 'session.started' event below is not enough -- the portal SSE
        // forwarder only relays 'station.status'.
        const startStationStatusSiteId = await this.deps.lookups.resolveSiteId(stationUuid);
        await this.deps.notify.notifyChange(
          'station.status',
          stationUuid,
          startStationStatusSiteId,
        );
      }
    }

    // EVConnectTimeout: station timed out waiting for EV to connect after remote start
    if (triggerReason === 'EVConnectTimeout') {
      await this.deps.sql`
            UPDATE charging_sessions
            SET status = 'failed', stopped_reason = 'EVConnectTimeout', updated_at = now()
            WHERE id = ${sessionId}
          `;
      this.deps.logger.info(
        { stationId, transactionId, sessionId },
        'Session marked failed: EVConnectTimeout on Started',
      );
      await tx.attempt.once('started:reservation-fault', () =>
        this.deps.notify.auditLinkedReservationFault(sessionId, 'failed: EVConnectTimeout'),
      );
    }

    await tx.attempt.once('started:transaction-event', async () => {
      try {
        await this.deps.sql`
            INSERT INTO transaction_events (session_id, event_type, seq_no, timestamp, trigger_reason, payload)
            VALUES (${sessionId}, 'started', ${seqNo}, ${timestamp}, ${triggerReason}, ${payloadJson})
          `;
      } catch (txEvtErr: unknown) {
        // A statement that never reached the server goes to the projection
        // retry. One interrupted mid-statement may have committed, so the
        // projection is not retried: it continues to the gate (P11), at the
        // cost of a possible duplicate log row if the station resends.
        if (pgConnectionErrorKind(txEvtErr) === 'not-sent') throw txEvtErr;
        this.deps.logger.warn(
          { err: txEvtErr, sessionId, transactionId },
          'Failed to insert transaction_event (session may have been deleted)',
        );
      }
    });

    // Check if site has free-vend enabled (skip driver resolution and payment gate)
    const isFreeVend = await isSiteFreeVendEnabledByStation(stationId);

    let driverUuid: string | null = null;
    // Seed from the DB so a remote-start session (created by the API with
    // is_roaming already set) and a station-initiated session (where the
    // INSERT path resolved the OCPI token eagerly) both produce the
    // correct gate input. Without this, the in-memory flag could diverge
    // from the row a downstream consumer reads.
    const initialRoamRows = await this.deps.sql`
          SELECT is_roaming FROM charging_sessions WHERE id = ${sessionId}
        `;
    const isRoamingSession = initialRoamRows[0]?.is_roaming === true;
    let guestStatus: string | null = null;
    let guestEmail: string | null = null;
    let tokenLookup: {
      id: string;
      driverId: string | null;
      prepaidCreditCents: number | null;
    } | null = null;
    // The tariff snapshotted on the session (null: no tariff applies).
    let sessionTariff: TariffPriceSnapshot | null = null;

    if (isFreeVend) {
      // Mark session as free-vend and skip driver resolution + payment
      // gate. driver_id is preserved as-is: if the portal start endpoint
      // (authenticated or guest) inserted the row with a driverId, that
      // is a legitimate "who initiated this session" record and the
      // portal's per-driver session queries depend on it. Truly
      // anonymous free-vend starts (RFID-less plug-in) already have
      // driver_id IS NULL from the INSERT path.
      await this.deps.sql`
            UPDATE charging_sessions
            SET free_vend = true, updated_at = now()
            WHERE id = ${sessionId}
          `;
    } else {
      // Resolve driver from idToken if not already set (e.g., RFID tap)
      const sessionRows = await this.deps
        .sql`SELECT driver_id FROM charging_sessions WHERE id = ${sessionId}`;
      driverUuid = sessionRows[0]?.driver_id as string | null;

      const idTokenValue = payload.idToken as string | null;

      // Always look up the token row when an idToken is present, so the
      // session gets linked to the matching driver_tokens entry even when
      // driver_id was pre-set by the API (e.g. portal-authenticated start).
      // The link is what powers the "Token" row on the session detail.
      if (idTokenValue != null) {
        const tokenRows = await this.deps.sql`
              SELECT id, driver_id, prepaid_balance_cents FROM driver_tokens
              WHERE id_token = ${idTokenValue} AND is_active = true
              LIMIT 1
            `;
        const r = tokenRows[0];
        if (r != null) {
          tokenLookup = await this.linkDriverToken(sessionId, {
            id: r.id as string,
            driverId: (r.driver_id as string | null) ?? null,
            prepaid: r.prepaid_balance_cents != null,
          });
        }
      }

      if (driverUuid == null) {
        // Token resolution chain: driver_tokens -> ocpi_external_tokens -> guest_sessions.
        // The OCPI branch is already resolved eagerly during the session
        // INSERT path and reflected on isRoamingSession; no need to
        // re-query ocpi_external_tokens here.
        if (tokenLookup?.driverId != null) {
          driverUuid = tokenLookup.driverId;
          await this.deps.sql`
                UPDATE charging_sessions SET driver_id = ${driverUuid}, updated_at = now()
                WHERE id = ${sessionId}
              `;
        }

        // If still unresolved and idToken present, check guest sessions
        if (driverUuid == null && !isRoamingSession && idTokenValue != null) {
          const guest = await this.linkGuestSession(sessionId, idTokenValue);
          if (guest != null) {
            guestStatus = guest.status;
            guestEmail = guest.email;
          }
        }
      }

      // Auto-link the driver's most recent vehicle to this session so the
      // portal session detail page shows estimated miles without prompting.
      // The driver can override later via PATCH /v1/portal/sessions/:id/vehicle.
      if (driverUuid != null) {
        await this.linkLastVehicle(sessionId, driverUuid);
      }

      // Resolve the tariff for this station and snapshot its prices and the
      // company tax basis on the session, with the first tariff segment.
      // The session is priced from these snapshots only (issue #33). The
      // payment gate decides free or paid from this same tariff. A rerun
      // keeps the tariff it resolved first; the snapshot UPDATE repeats
      // safely, and the first segment is opened once.
      const tariffDriverUuid = driverUuid;
      const tariff = await tx.attempt.memo('started:tariff', () =>
        resolveStationTariff({ stationUuid, driverUuid: tariffDriverUuid }, this.deps.sql),
      );
      sessionTariff = tariff;
      if (tariff != null) {
        await snapshotSessionTariff(this.deps.sql, sessionId, tariff, await getCompanyTaxBasis());
        await tx.attempt.once('started:tariff-segment', async () => {
          try {
            await openFirstTariffSegment(this.deps.sql, sessionId, tariff, timestamp);
          } catch (err) {
            // An interrupted INSERT may have committed and is not retried:
            // escaping would skip the payment gate (P11), so it warns and
            // goes on, as the transaction event insert does. A statement that
            // never reached the server goes to the retry.
            if (pgConnectionErrorKind(err) !== 'interrupted') throw err;
            this.deps.logger.warn(
              { err, sessionId, transactionId },
              'First tariff segment insert interrupted; continuing to the payment gate',
            );
          }
        });
      }
    }

    // Link reservation to session if reservationId present
    let linkedReservationId: string | null = null;
    const ocppReservationId = payload.reservationId as number | undefined;
    if (ocppReservationId != null) {
      try {
        // The active reservation, or the one this session is already linked
        // to: a rerun after the first run moved it to in_use, or a remote
        // start the reservation activation linked before Started (that first
        // run now passes reserved: true to the gate, so the holding fee is
        // billed).
        const reservationRows = await this.deps.sql`
              SELECT r.id, r.token_id FROM reservations r
              WHERE r.reservation_id = ${ocppReservationId}
                AND r.station_id = ${stationUuid}
                AND (
                  r.status = 'active'
                  OR r.id = (SELECT cs.reservation_id FROM charging_sessions cs WHERE cs.id = ${sessionId})
                )
              ORDER BY (r.status = 'active') ASC
              LIMIT 1
            `;
        const reservationUuid = reservationRows[0]?.id as string | undefined;
        const reservationTokenId = reservationRows[0]?.token_id as string | null | undefined;
        if (reservationUuid != null) {
          await this.deps.sql`
                UPDATE charging_sessions SET reservation_id = ${reservationUuid}, updated_at = now()
                WHERE id = ${sessionId}
              `;
          linkedReservationId = reservationUuid;
          // Conditional UPDATE -- only one writer flips active→in_use. Audit
          // the transition iff we won the race (RETURNING is empty when
          // the row was already in_use/cancelled/expired).
          const usedRows = await this.deps.sql`
                UPDATE reservations SET status = 'in_use', updated_at = now()
                WHERE id = ${reservationUuid} AND status = 'active'
                RETURNING id, driver_id
              `;
          if (usedRows.length > 0) {
            await writeReservationAudit({
              reservationId: reservationUuid,
              action: 'used',
              actor: 'system',
              driverIdBefore: (usedRows[0]?.driver_id as string | null) ?? null,
              driverIdAfter: (usedRows[0]?.driver_id as string | null) ?? null,
              statusBefore: 'active',
              statusAfter: 'in_use',
              notes: `session ${sessionId}`,
            });
            await this.deps.notify.notifyChange(
              'reservation.changed',
              stationUuid,
              null,
              sessionId,
            );
          }

          // If the reservation was bound to a specific token, verify the
          // session was started with that token. We log + persist a metadata
          // marker rather than blocking the session: the OCPP transaction
          // is already underway and tearing it down here would just leave
          // the EV charging without a billable session record.
          if (reservationTokenId != null) {
            const sessionRow = await this.deps.sql`
                  SELECT token_id FROM charging_sessions WHERE id = ${sessionId} LIMIT 1
                `;
            const actualTokenId = (sessionRow[0]?.token_id as string | null | undefined) ?? null;
            if (actualTokenId !== reservationTokenId) {
              this.deps.logger.warn(
                {
                  sessionId,
                  reservationUuid,
                  expectedTokenId: reservationTokenId,
                  actualTokenId,
                },
                'Reservation fulfilled by different token than reserved',
              );
              await this.deps.sql`
                    UPDATE charging_sessions
                    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                      'reservationTokenMismatch', jsonb_build_object(
                        'expected', ${reservationTokenId},
                        'actual', ${actualTokenId}
                      )
                    ),
                    updated_at = now()
                    WHERE id = ${sessionId}
                  `;
            }
          }
        }
      } catch (err) {
        // A lost connection goes to the projection retry. These statements
        // run outside a `once` step, so even an interrupted one is retried,
        // and the rerun finds the reservation through the session's link.
        // On the last run it continues: the gate must still run (P11), at
        // the cost of a missing reservation link.
        if (pgConnectionErrorKind(err) != null && !tx.attempt.isLast) throw err;
        this.deps.logger.debug(
          { err, sessionId },
          'Reservation linking failed; continuing session creation',
        );
      }
    }

    return {
      sessionId,
      isFreeVend,
      driverUuid,
      isRoamingSession,
      guestStatus,
      guestEmail,
      tokenLookup,
      sessionTariff,
      linkedReservationId,
    };
  }

  /**
   * Links a session to its driver token (`token_id`). A prepaid token's credit
   * is the most the session may cost (C17.FR.03): it is the session's cost
   * ceiling, like a guest's card hold, stamped before the first running cost
   * so the cost assembly never bills more than the credit (P4). A session
   * without credit is stopped by the payment gate. Repeats safely: the
   * reservation leaves the session's own ceiling out.
   */
  private async linkDriverToken(
    sessionId: string,
    token: { id: string; driverId: string | null; prepaid: boolean },
  ): Promise<NonNullable<StartedContext['tokenLookup']>> {
    if (token.prepaid) {
      const prepaidCreditCents = await this.linkPrepaidToken(sessionId, token.id);
      return { id: token.id, driverId: token.driverId, prepaidCreditCents };
    }
    await this.deps.sql`
      UPDATE charging_sessions
      SET token_id = ${token.id}, updated_at = now()
      WHERE id = ${sessionId}
    `;
    return { id: token.id, driverId: token.driverId, prepaidCreditCents: null };
  }

  /**
   * The guest checkout or ad hoc payment of the session's idToken, or null.
   * The guest's card authorization is the ceiling for the cost (OCPP 2.1 C25
   * step 9): a guest has no saved card for a top-up. A lower maxCost the guest
   * chose (C25.FR.06) is the ceiling instead (finding J5): the 2.1 station got
   * it as transactionLimit.maxCost (findAdHocTransactionLimit), and the CSMS
   * stops a 1.6 transaction at it. Stamped now, before the first running cost,
   * so the cost assembly never bills more than the ceiling (P4). Repeats
   * safely.
   */
  private async linkGuestSession(
    sessionId: string,
    idToken: string,
  ): Promise<{ status: string; email: string | null } | null> {
    const guestRows = await this.deps.sql`
      SELECT status, guest_email, pre_auth_amount_cents, provider_payment_id,
             max_cost_cents
      FROM guest_sessions
      WHERE session_token = ${idToken}
      LIMIT 1
    `;
    const guest = guestRows[0];
    if (guest == null) return null;
    const status = guest.status as string;
    const holdCents = guest.pre_auth_amount_cents as number | null;
    const maxCostCents = guest.max_cost_cents as number | null;
    if (
      holdCents != null &&
      guest.provider_payment_id != null &&
      (status === 'payment_authorized' || status === 'charging')
    ) {
      const ceilingCents = maxCostCents != null ? Math.min(holdCents, maxCostCents) : holdCents;
      await this.deps.sql`
        UPDATE charging_sessions
        SET cost_ceiling_cents = ${ceilingCents}, updated_at = now()
        WHERE id = ${sessionId}
      `;
    }
    return { status, email: (guest.guest_email as string | null) ?? null };
  }

  /**
   * Tells the guest session service the transaction started with this
   * idToken, so linkGuestSession() in @evtivity/api links the guest checkout
   * (the guest portal waits on guest_sessions.charging_session_id). Once per
   * event; fail-open.
   */
  private async publishGuestTransactionStarted(
    tx: TransactionEventContext,
    sessionId: string,
    idToken: string,
    stage: 'started' | 'updated' | 'ended',
  ): Promise<void> {
    await tx.attempt.once(`${stage}:csms-transaction-started`, async () => {
      try {
        await this.deps.pubsub.publish(
          'csms_events',
          JSON.stringify({
            type: 'TransactionStarted',
            sessionId,
            stationId: tx.stationId,
            transactionId: tx.transactionId,
            idToken: {
              idToken,
              type: (tx.payload.tokenType as string | undefined) ?? 'ISO14443',
            },
          }),
        );
      } catch (err) {
        this.deps.logger.debug({ err, sessionId }, 'Guest session SSE publish failed; continuing');
      }
    });
  }

  /**
   * Auto-links the driver's most recent vehicle to this session so the portal
   * session detail page shows estimated miles without prompting. The driver
   * can override later via PATCH /v1/portal/sessions/:id/vehicle. Repeats
   * safely.
   */
  private async linkLastVehicle(sessionId: string, driverId: string): Promise<void> {
    const vehicleRows = await this.deps.sql`
      SELECT vehicle_id FROM charging_sessions
      WHERE driver_id = ${driverId}
        AND vehicle_id IS NOT NULL
        AND id != ${sessionId}
      ORDER BY started_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `;
    const lastVehicleId = vehicleRows[0]?.vehicle_id as string | undefined;
    if (lastVehicleId != null) {
      await this.deps.sql`
        UPDATE charging_sessions
        SET vehicle_id = ${lastVehicleId}, updated_at = now()
        WHERE id = ${sessionId}
      `;
    }
  }

  /**
   * Links the idToken a 2.1 station presents first after the transaction
   * started (E02.FR.01, E03.FR.01: cable plugged in first with TxStartPoint
   * EVConnected, so Started carried no idToken) the way the Started
   * projection resolves one (driver token, then OCPI roaming token, then guest
   * checkout): the driver token and driver, a prepaid token's reserved credit
   * as the cost ceiling (`linkPrepaidToken`, under the token row lock), the
   * driver's last vehicle and station watch, the session.Started notice
   * (Updated only: on Ended the transaction is already over), a roaming
   * session's OCPI link, a guest's ceiling and guest link, and the payment
   * gate for the token (an unknown token is stopped as anonymous, as at
   * Started). Runs only for the sessions the Started gate left waiting: an
   * active, unclaimed, non-free-vend session without a token or roaming flag
   * none of whose earlier events carried an idToken or a remoteStartId or was
   * a RemoteStart, either without a driver (resolved from the idToken) or
   * taken over by a portal remote start (F01: driver and remote_start_id set
   * by the portal start route, linked by the idToken or the matching
   * remoteStartId of the event after the RequestStartTransaction). So a
   * session started with a token (every OCPP 1.6 session: StartTransaction
   * requires the idTag, and StopTransaction's idTag is who stopped it), a
   * remote start linked at Started, and a repeated idToken change nothing. A
   * linked driver's own tariff reprices the session from its start before the
   * gate (repriceSessionForDriver). The read is memoized and comes before this event's
   * transaction_events row, so a rerun links the same token again (each write
   * repeats safely) and keeps the first gate decision. Returns the gate
   * failure for the caller to rethrow.
   */
  private async linkFirstPresentedToken(
    tx: TransactionEventContext,
    sessionId: string,
    stage: 'updated' | 'ended',
  ): Promise<{ err: unknown } | null> {
    const idTokenValue = getString(tx.payload, 'idToken');
    const remoteStartId =
      typeof tx.payload.remoteStartId === 'number' ? tx.payload.remoteStartId : null;
    if (idTokenValue == null && remoteStartId == null) return null;
    const pending = await tx.attempt.memo(`${stage}:first-token`, async () => {
      // Two kinds of waiting session: one the station started without any
      // driver (resolved from the idToken), and one a portal remote start
      // took over while it waited (driver and remote_start_id set by the
      // portal start route, F01: linked by the idToken or the remoteStartId
      // of the event after the RequestStartTransaction). A session whose
      // Started was a remote start, and every session an earlier event
      // carried an idToken or a remoteStartId for, is never linked here.
      const [row] = await this.deps.sql`
        SELECT cs.reservation_id, cs.started_at,
               cs.driver_id AS remote_start_driver_id,
               dt.id AS token_id, dt.driver_id AS token_driver_id,
               dt.prepaid_balance_cents IS NOT NULL AS prepaid,
               cs.driver_id IS NULL AND EXISTS (
                 SELECT 1 FROM ocpi_external_tokens ot
                 WHERE ot.uid = ${idTokenValue} AND ot.is_valid = true
               ) AS roaming
        FROM charging_sessions cs
        LEFT JOIN driver_tokens dt
          ON cs.driver_id IS NULL AND dt.id_token = ${idTokenValue} AND dt.is_active = true
        WHERE cs.id = ${sessionId}
          AND cs.status = 'active'
          AND cs.stopped_reason IS NULL
          AND cs.token_id IS NULL
          AND NOT cs.free_vend
          AND NOT cs.is_roaming
          AND (
            (cs.driver_id IS NULL AND cs.remote_start_id IS NULL
              AND ${idTokenValue}::text IS NOT NULL)
            OR (cs.driver_id IS NOT NULL AND cs.remote_start_id IS NOT NULL
              AND (${remoteStartId}::integer IS NULL OR cs.remote_start_id = ${remoteStartId}))
          )
          AND NOT EXISTS (
            SELECT 1 FROM transaction_events te
            WHERE te.session_id = cs.id
              AND (te.payload->>'idToken' IS NOT NULL
                OR te.payload->>'remoteStartId' IS NOT NULL
                OR te.trigger_reason = 'RemoteStart')
          )
        LIMIT 1
      `;
      if (row == null) return null;
      return {
        reserved: row.reservation_id != null,
        startedAt: new Date(row.started_at as string | Date).toISOString(),
        remoteStartDriverId: (row.remote_start_driver_id as string | null) ?? null,
        token:
          row.token_id != null
            ? {
                id: row.token_id as string,
                driverId: (row.token_driver_id as string | null) ?? null,
                prepaid: row.prepaid === true,
              }
            : null,
        roaming: row.roaming === true,
      };
    });
    if (pending == null) return null;

    const { stationId, stationUuid, transactionId } = tx;
    // The resolution chain of the Started step: driver_tokens ->
    // ocpi_external_tokens -> guest_sessions. A portal remote start already
    // names its driver (its idToken is the Central driver id).
    let tokenLookup: StartedContext['tokenLookup'] = null;
    let driverUuid: string | null = null;
    let isRoaming = false;
    let guest: { status: string; email: string | null } | null = null;
    if (pending.remoteStartDriverId != null) {
      driverUuid = pending.remoteStartDriverId;
    } else if (pending.token != null) {
      tokenLookup = await this.linkDriverToken(sessionId, pending.token);
      if (tokenLookup.driverId != null) {
        driverUuid = tokenLookup.driverId;
        await this.deps.sql`
          UPDATE charging_sessions SET driver_id = ${driverUuid}, updated_at = now()
          WHERE id = ${sessionId}
        `;
      }
    } else if (pending.roaming && idTokenValue != null) {
      isRoaming = true;
      await this.deps.sql`
        UPDATE charging_sessions SET is_roaming = true, updated_at = now()
        WHERE id = ${sessionId}
      `;
      await this.deps.notify.linkCpoRoamingSession(sessionId, idTokenValue);
    } else if (idTokenValue != null) {
      guest = await this.linkGuestSession(sessionId, idTokenValue);
    }
    if (driverUuid == null && !isRoaming && idTokenValue != null) {
      await this.publishGuestTransactionStarted(tx, sessionId, idTokenValue, stage);
    }
    this.deps.logger.info(
      {
        sessionId,
        stationId,
        transactionId,
        tokenId: tokenLookup?.id ?? null,
        remoteStart: pending.remoteStartDriverId != null,
        stage,
      },
      'Linked the idToken first presented after the transaction started',
    );

    const siteId = await this.deps.lookups.resolveSiteId(stationUuid);
    if (driverUuid != null) {
      // The session was snapshotted at Started without a driver: the tariff
      // of the driver (driver or fleet pricing group) prices it from its
      // start, before the gate decides free or paid from it. Repeats safely.
      await repriceSessionForDriver(this.deps.sql, {
        sessionId,
        stationUuid,
        driverUuid,
        basis: await getCompanyTaxBasis(),
      });
      await this.linkLastVehicle(sessionId, driverUuid);
      await this.clearStationWatch(stationUuid, sessionId);
      if (stage === 'updated') {
        const driverIdForNotify = driverUuid;
        const siteName = await this.deps.lookups.resolveSiteName(stationUuid);
        await tx.attempt.once(`${stage}:session-started-notification`, () =>
          dispatchDriverNotification(
            this.deps.sql,
            'session.Started',
            driverIdForNotify,
            {
              siteName: siteName ?? '',
              stationId,
              transactionId,
              startedAt: pending.startedAt,
            },
            ALL_TEMPLATES_DIRS,
            this.deps.pubsub,
          ),
        );
      }
    }

    // The gate decides from the session's tariff snapshot (the driver's, when
    // repriced above).
    const pricing = await loadSessionPricing(this.deps.sql, sessionId);
    const sessionTariff: TariffPriceSnapshot | null =
      pricing?.tariffId != null ? { id: pricing.tariffId, ...pricing.tariff } : null;
    try {
      await tx.attempt.memo(`${stage}:gate`, () =>
        runPaymentGate(this.deps, {
          sessionId,
          transactionId,
          driverId: driverUuid,
          stationDbId: stationUuid,
          ocppStationId: stationId,
          siteId: siteId ?? null,
          isRoaming,
          idToken: idTokenValue ?? undefined,
          guestStatus: guest?.status ?? null,
          guestEmail: guest?.email ?? null,
          prepaidBalanceCents: tokenLookup?.prepaidCreditCents ?? null,
          reserved: pending.reserved,
          sessionTariff,
          transactionEnded: stage === 'ended',
        }),
      );
    } catch (err: unknown) {
      return { err };
    }
    return null;
  }

  /**
   * A 2.1 session that started without an idToken (cable plugged in first,
   * E02) and is charging although no event authorized it (a station with
   * authorization disabled, or one that ignores the CSMS answer): nobody pays
   * for it, so the payment gate stops it as anonymous (`AnonymousSession`,
   * the station message `unauthorized`). The `stopped_reason` claim makes it
   * once per session; the Ended COALESCE keeps the reason. A driver, guest,
   * roaming or free vend session, and one an event carried an idToken for,
   * is never claimed.
   */
  private async stopUnauthorizedSession(
    tx: TransactionEventContext,
    sessionId: string,
    stage: 'started' | 'updated',
  ): Promise<{ err: unknown } | null> {
    const claimed = await tx.attempt.once(
      `${stage}:unauthorized-claim`,
      () => this.deps.sql`
        UPDATE charging_sessions cs
        SET stopped_reason = 'AnonymousSession', updated_at = now()
        WHERE cs.id = ${sessionId}
          AND cs.status = 'active'
          AND cs.stopped_reason IS NULL
          AND cs.token_id IS NULL
          AND cs.driver_id IS NULL
          AND NOT cs.is_roaming
          AND NOT cs.free_vend
          AND NOT EXISTS (
            SELECT 1 FROM transaction_events te
            WHERE te.session_id = cs.id AND te.payload->>'idToken' IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM guest_sessions g WHERE g.charging_session_id = cs.id
          )
        RETURNING cs.id
      `,
    );
    if (claimed.length === 0) return null;
    const siteId = await this.deps.lookups.resolveSiteId(tx.stationUuid);
    try {
      await tx.attempt.memo(`${stage}:unauthorized-gate`, () =>
        runPaymentGate(this.deps, {
          sessionId,
          transactionId: tx.transactionId,
          driverId: null,
          stationDbId: tx.stationUuid,
          ocppStationId: tx.stationId,
          siteId: siteId ?? null,
          isRoaming: false,
          idToken: undefined,
          guestStatus: null,
          guestEmail: null,
          prepaidBalanceCents: null,
          reserved: false,
          sessionTariff: null,
        }),
      );
    } catch (err: unknown) {
      return { err };
    }
    return null;
  }

  /**
   * Links a session to its prepaid token and stamps the credit it may spend as
   * its cost ceiling (C17.FR.03): the balance minus what the token's other
   * sessions may still take from it, never below zero. Those are the active
   * sessions (their ceiling, else their running cost) and the ended ones not
   * yet settled (their final cost): the Ended projection completes a session
   * before the settlement debits it. A session the CSMS gave up ending
   * (EndRequestFailed, faulted at cost 0) reserves its ceiling, else its
   * running cost, until it is re-billed, with no time limit: the re-bill
   * debits it later. The token row lock serializes sessions of
   * one token that start at once, and the settlement's debit waits for it, so
   * the ceilings never add up to more than the balance. The ceiling is fixed
   * here: a balance edit during the session applies to the next one. Returns
   * null, linking without a ceiling, when the token is no longer prepaid.
   */
  private async linkPrepaidToken(sessionId: string, tokenId: string): Promise<number | null> {
    const companyCurrency = await getCompanyCurrency();
    return this.deps.sql.begin(async (sql) => {
      const tokenRows = await sql`
        SELECT prepaid_balance_cents FROM driver_tokens WHERE id = ${tokenId} FOR UPDATE
      `;
      const balance = tokenRows[0]?.prepaid_balance_cents as number | string | null | undefined;
      if (balance == null) {
        await sql`
          UPDATE charging_sessions SET token_id = ${tokenId}, updated_at = now()
          WHERE id = ${sessionId}
        `;
        return null;
      }
      // An ended session counts until its debit (a payment_records row), for
      // at most UNSETTLED_RESERVATION_HOURS: the settlement runs right
      // after the Ended projection and retries for minutes, so an older
      // unsettled session failed for good and is reconciled by hand instead
      // of holding the credit forever. Only company-currency sessions are
      // debited. A session the CSMS gave up ending (EndRequestFailed) is
      // faulted with its cost zeroed but stays re-billable (the re-bill's
      // eligibility: rebill_status not billed or manual, not free vend, a
      // tariff), so it reserves its ceiling, else its running cost, with no
      // time limit: the re-bill debits it whenever the operator runs it.
      const reservedRows = await sql`
        SELECT COALESCE(SUM(
                 CASE WHEN o.status = 'active' OR o.rebillable
                      THEN COALESCE(o.cost_ceiling_cents, o.current_cost_cents, 0)
                      ELSE COALESCE(o.final_cost_cents, o.cost_ceiling_cents,
                                    o.current_cost_cents, 0)
                 END), 0)::integer AS reserved_cents
        FROM (
          SELECT cs.status, cs.ended_at, cs.cost_ceiling_cents, cs.current_cost_cents,
                 cs.final_cost_cents,
                 upper(cs.currency) = ${companyCurrency}
                   AND NOT EXISTS (SELECT 1 FROM payment_records pr WHERE pr.session_id = cs.id)
                   AS unsettled,
                 cs.status = 'faulted'
                   AND cs.stopped_reason = ${SESSION_END_FAILED_REASON}
                   AND (cs.rebill_status IS NULL OR cs.rebill_status = 'in_progress')
                   AND NOT cs.free_vend
                   AND cs.tariff_id IS NOT NULL
                   AS rebillable
          FROM charging_sessions cs
          WHERE cs.token_id = ${tokenId}
            AND cs.id <> ${sessionId}
        ) o
        WHERE o.status = 'active'
          OR (o.unsettled AND o.rebillable)
          OR (
            o.unsettled
            AND o.ended_at > now() - make_interval(hours => ${UNSETTLED_RESERVATION_HOURS})
          )
      `;
      const creditCents = Math.max(
        Number(balance) - Number(reservedRows[0]?.reserved_cents ?? 0),
        0,
      );
      await sql`
        UPDATE charging_sessions
        SET token_id = ${tokenId}, cost_ceiling_cents = ${creditCents}, updated_at = now()
        WHERE id = ${sessionId}
      `;
      return creditCents;
    });
  }

  /**
   * The Started step from the priced signal on: notifications, the payment
   * gate and the station-watch clear. Returns a gate failure for the caller
   * to rethrow after the buffer drain and the station screen.
   */
  private async completeStartedSession(
    tx: TransactionEventContext,
    started: StartedContext,
  ): Promise<{ err: unknown } | null> {
    const { payload, stationId, stationUuid, transactionId, timestamp } = tx;
    const {
      sessionId,
      isFreeVend,
      driverUuid,
      isRoamingSession,
      guestStatus,
      guestEmail,
      tokenLookup,
      sessionTariff,
      linkedReservationId,
    } = started;
    // A payment gate failure, held until the rest of the Started step has run
    // and returned for projectStarted to rethrow after the buffer drain and
    // the station screen.
    let gateFailure: { err: unknown } | null = null;

    // The session has its tariff snapshot and reservation: the 2.1 handler
    // can answer the Started event with the running cost (OCTT TC_E_109).
    this.state.projectionQueue.signal(sessionPricedKey(stationId, transactionId));

    const siteId = await this.deps.lookups.resolveSiteId(stationUuid);
    await this.deps.notify.notifyChange('session.started', stationUuid, siteId, sessionId);
    const roamingIdToken = payload.idToken as string | null | undefined;
    if (isRoamingSession && roamingIdToken != null) {
      await this.deps.notify.linkCpoRoamingSession(sessionId, roamingIdToken);
    }
    // Both repeat safely on a rerun: the link is ON CONFLICT DO NOTHING, and
    // the push sends the session's current state again.
    await this.deps.notify.notifyOcpiPush('session', { sessionId });

    // Notify guest session service for linking. Runs for both free-vend
    // and paid sessions: the guest portal polls /v1/portal/guest/status
    // and stays on "Starting charging" until guest_sessions.charging_session_id
    // is set, which only happens when this event fires and is handled
    // by linkGuestSession() in @evtivity/api.
    const idTokenForGuest = payload.idToken as string | null;
    if (idTokenForGuest != null) {
      await this.publishGuestTransactionStarted(tx, sessionId, idTokenForGuest, 'started');
    }

    if (!isFreeVend) {
      // Driver notification: transaction started (awaited so it is recorded before the payment gate
      // can fire a PreAuthFailed notification, preserving chronological order in the portal drawer)
      const driverIdForNotify = driverUuid;
      if (driverIdForNotify != null) {
        const startedSiteName = await this.deps.lookups.resolveSiteName(stationUuid);
        await tx.attempt.once('started:session-started-notification', () =>
          dispatchDriverNotification(
            this.deps.sql,
            'session.Started',
            driverIdForNotify,
            {
              siteName: startedSiteName ?? '',
              stationId,
              transactionId,
              startedAt: timestamp,
            },
            ALL_TEMPLATES_DIRS,
            this.deps.pubsub,
          ),
        );
      }

      // Payment gate: pre-authorize or stop session if payment not possible.
      // Called here (not as a separate subscriber) to guarantee the session exists.
      // Awaited is safe because the EventBus already runs handlers fire-and-forget.
      // A failure stays fail-loud (rethrown at the end of the Started step,
      // logged by safeSubscribe), but the watch clear, the buffer drain and
      // the station screen below still run, so buffered events are not stuck.
      // A rerun keeps the first decision; a gate that failed runs again, and
      // its hold key (preauth_<sessionId>) makes the provider charge once.
      //
      // Cable plugged in first (E02, TxStartPoint EVConnected): a 2.1
      // transaction starts without an idToken, and the station sends the
      // idToken in the next event after authorization (E02.FR.01, E03.FR.01)
      // and offers energy only then. Such a session is not anonymous yet: the
      // gate waits for that event (linkFirstPresentedToken). One already
      // charging without authorization is stopped now (stopUnauthorizedSession),
      // and one that starts charging later is stopped then (Updated).
      const awaitingAuthorization =
        payload.idToken == null && driverUuid == null && !isRoamingSession && guestStatus == null;
      if (awaitingAuthorization) {
        if (getString(payload, 'chargingState') === 'Charging') {
          gateFailure = await this.stopUnauthorizedSession(tx, sessionId, 'started');
        } else {
          this.deps.logger.info(
            { sessionId, stationId, transactionId },
            'Transaction started without an idToken; payment gate waits for its authorization',
          );
        }
      } else {
        try {
          await tx.attempt.memo('started:gate', () =>
            runPaymentGate(this.deps, {
              sessionId,
              transactionId,
              driverId: driverUuid,
              stationDbId: stationUuid,
              ocppStationId: stationId,
              siteId: siteId ?? null,
              isRoaming: isRoamingSession,
              idToken: payload.idToken as string | undefined,
              guestStatus,
              guestEmail,
              prepaidBalanceCents: tokenLookup?.prepaidCreditCents ?? null,
              reserved: linkedReservationId != null,
              sessionTariff,
            }),
          );
        } catch (err: unknown) {
          gateFailure = { err };
        }
      }
    }

    // The gate ran (or does not apply): an account session has its reserved
    // cost ceiling, which the 2.1 handler sends as transactionLimit.maxCost
    // (plan S8). A failed gate signals too: the handler then finds no ceiling.
    this.state.projectionQueue.signal(sessionGatedKey(stationId, transactionId));

    // A driver who starts charging at a station they were watching no
    // longer needs the "now free" alert (they can start on a startable but
    // not-yet-available connector, which never fires the watch). Clears only
    // the starting driver's own watch; other drivers watching this station
    // keep theirs. The null-driver subquery matches no rows, so guest/
    // anonymous starts are a no-op. Kept last in the Started block so it
    // never reorders the writes above. Fail-open.
    await this.clearStationWatch(stationUuid, sessionId);
    return gateFailure;
  }

  /** Clears the session driver's watch of this station (see the Started step). Fail-open. */
  private async clearStationWatch(stationUuid: string, sessionId: string): Promise<void> {
    try {
      await this.deps.sql`
        DELETE FROM station_watches
        WHERE station_id = ${stationUuid}
          AND driver_id = (SELECT driver_id FROM charging_sessions WHERE id = ${sessionId})
      `;
    } catch (err) {
      this.deps.logger.warn({ err, stationUuid }, 'Station-watch clear-on-start failed');
    }
  }

  // A 2.1 station reported reaching the cost limit (triggerReason
  // CostLimitReached, E16.FR.05) of a session whose ceiling is a prepaid
  // token's credit (C17.FR.03) or an account session's reserved fleet credit
  // (plan S8). The station suspends or ends the transaction itself, so the
  // CSMS does not stop it: it shows the prepaid_exhausted (account:
  // account_credit_limit) station message and sends prepaid.CreditExhausted
  // (account: payment.AccountCreditLimit), once per session (the stop claim
  // shared with stopSessionForPayment). An account session whose ceiling the
  // handler raised at this report (payload accountCeilingRaised, Updated
  // only) is not claimed: the response sent the raised limit and the station
  // resumes. A once step: a rerun never
  // claims again. Inside it only a statement that never reached the server
  // is retried; an interrupted claim may have committed, so it warns.
  private async notePrepaidCostLimit(
    tx: TransactionEventContext,
    sessionId: string,
    stage: 'updated' | 'ended',
  ): Promise<void> {
    await tx.attempt.once(`${stage}:prepaid-cost-limit`, async () => {
      try {
        await noteCostLimitReached(
          this.deps,
          {
            sessionId,
            transactionId: tx.transactionId,
            ocppStationId: tx.stationId,
            stationDbId: tx.stationUuid,
          },
          { accountCeilingRaised: stage === 'updated' && tx.payload.accountCeilingRaised === true },
        );
      } catch (err: unknown) {
        if (pgConnectionErrorKind(err) === 'not-sent') throw err;
        this.deps.logger.warn(
          { err, sessionId, transactionId: tx.transactionId },
          'Prepaid cost limit notice failed; continuing',
        );
      }
    });
  }

  private async projectUpdated(tx: TransactionEventContext): Promise<void> {
    const {
      event,
      payload,
      stationId,
      stationUuid,
      transactionId,
      seqNo,
      triggerReason,
      timestamp,
      payloadJson,
    } = tx;
    const updatedRows = await this.deps.sql`
        SELECT id, evse_id, status FROM charging_sessions
        WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
      `;
    const updatedRow = updatedRows[0];
    const sessionId = updatedRow != null ? (updatedRow.id as string) : null;
    const sessionEvseUuid = updatedRow != null ? (updatedRow.evse_id as string | null) : null;
    // A queued Updated delivered after the Ended changes neither the idle
    // state nor the connector of the ended session (P5).
    const sessionActive = updatedRow != null && updatedRow.status === 'active';
    if (sessionId != null && (await this.isResentEvent(tx, 'updated'))) return;
    if (sessionId != null) {
      // An idToken first presented after the transaction started (cable
      // plugged in first, E02.FR.01, E03.FR.01): link it and run its gate as
      // the Started step would, before this event's transaction_events row.
      // A gate failure is rethrown after the station screen.
      const gateFailure = sessionActive
        ? await this.linkFirstPresentedToken(tx, sessionId, 'updated')
        : null;

      await tx.attempt.once('updated:transaction-event', async () => {
        try {
          await this.deps.sql`
            INSERT INTO transaction_events (session_id, event_type, seq_no, timestamp, trigger_reason, payload)
            VALUES (${sessionId}, 'updated', ${seqNo}, ${timestamp}, ${triggerReason}, ${payloadJson})
          `;
        } catch (txEvtErr: unknown) {
          // Only a statement that never reached the server is retried; an
          // interrupted one may have committed and goes on (see Started).
          if (pgConnectionErrorKind(txEvtErr) === 'not-sent') throw txEvtErr;
          this.deps.logger.warn(
            { err: txEvtErr, sessionId, transactionId },
            'Failed to insert transaction_event (session may have been deleted)',
          );
        }
      });

      if (triggerReason === 'CostLimitReached') {
        await this.notePrepaidCostLimit(tx, sessionId, 'updated');
      }

      // A session that started without an idToken and charges although no
      // event authorized it is stopped as anonymous, once.
      let unauthorizedFailure: { err: unknown } | null = null;
      if (
        sessionActive &&
        payload.idToken == null &&
        getString(payload, 'chargingState') === 'Charging'
      ) {
        unauthorizedFailure = await this.stopUnauthorizedSession(tx, sessionId, 'updated');
      }

      // Idle detection from chargingState (OCPP 2.1). Idle fees accrue only
      // while the EV suspends (SuspendedEV). Any other state (Charging, a
      // station-side SuspendedEVSE, EVConnected, Idle) closes an open period
      // at the event timestamp. Both UPDATEs touch only an active session.
      // First, an idle period open for IDLE_NOTICE_MIN_SECONDS at this event
      // notifies the driver or guest, before this event can end it (JB-2).
      if (sessionActive) {
        await this.deps.notify.dispatchDueIdlingNotification(
          sessionId,
          stationId,
          transactionId,
          timestamp,
        );
      }
      const chargingState = getString(payload, 'chargingState');
      if (chargingState != null) {
        if (chargingState === 'SuspendedEV') {
          await this.deps.sql`
              UPDATE charging_sessions
              SET idle_started_at = ${timestamp}, updated_at = now()
              WHERE id = ${sessionId} AND status = 'active' AND idle_started_at IS NULL
            `;
        } else {
          await this.deps.sql`
              UPDATE charging_sessions
              SET idle_minutes = idle_minutes + GREATEST(0, EXTRACT(EPOCH FROM (${timestamp}::timestamptz - idle_started_at)) / 60),
                  idle_started_at = NULL,
                  updated_at = now()
              WHERE id = ${sessionId} AND status = 'active' AND idle_started_at IS NOT NULL
            `;
        }
      }

      // Update connector status from chargingState (OCPP 2.1 enrichment).
      // Portal SSE forwarder only relays 'station.status', so the
      // 'session.updated' notify below isn't enough -- we publish here too.
      if (chargingState != null && sessionActive) {
        const connectorStatus = CHARGING_STATE_TO_STATUS[chargingState];
        if (connectorStatus != null && sessionEvseUuid != null) {
          await applyEvseChargingState(this.deps.sql, sessionEvseUuid, connectorStatus, timestamp);
          const updatedStationStatusSiteId = await this.deps.lookups.resolveSiteId(stationUuid);
          await this.deps.notify.notifyChange(
            'station.status',
            stationUuid,
            updatedStationStatusSiteId,
          );
        }
      }

      const siteId = await this.deps.lookups.resolveSiteId(stationUuid);
      await this.deps.notify.notifyChange('session.updated', stationUuid, siteId, sessionId);
      await this.deps.notify.notifyOcpiPush('session', { sessionId });

      // Driver notification: transaction updated (throttled to once per 15 min via DB).
      // Gate on status = 'active' so a stray TransactionEvent.Updated that
      // arrives after the payment gate stopped the session (faulted/failed)
      // does not fire a phantom "session update" notification.
      // The claim keeps its first result on a rerun, so a rerun after a later
      // failure still sends the notice it claimed. An interrupted claim that
      // committed reads as already claimed on the rerun, and that notice is
      // skipped (it is throttled, the next one follows).
      const throttleResult = await tx.attempt.memo(
        'updated:notify-claim',
        () => this.deps.sql`
          UPDATE charging_sessions
          SET last_update_notified_at = now()
          WHERE id = ${sessionId}
            AND driver_id IS NOT NULL
            AND status = 'active'
            AND (last_update_notified_at IS NULL
              OR last_update_notified_at < now() - make_interval(secs => ${SESSION_UPDATE_THROTTLE_MS / 1000}))
          RETURNING driver_id, energy_delivered_wh, current_cost_cents, started_at,
                    tariff_tax_rate, UPPER(currency) AS currency
        `,
      );
      const updatedSession = throttleResult[0];
      if (updatedSession != null) {
        const startedAtDate = new Date(updatedSession.started_at as string);
        const durationMinutes = Math.round((Date.now() - startedAtDate.getTime()) / 60000);
        const updatedSiteName = await this.deps.lookups.resolveSiteName(stationUuid);
        // Fire-and-forget as before; once records that it was sent.
        await tx.attempt.once('updated:session-updated-notification', () => {
          void this.deps.eventBus.track(
            dispatchDriverNotification(
              this.deps.sql,
              'session.Updated',
              updatedSession.driver_id as string,
              {
                siteName: updatedSiteName ?? '',
                stationId,
                transactionId,
                energyDeliveredWh: updatedSession.energy_delivered_wh as number,
                currentCostCents: updatedSession.current_cost_cents as number,
                costFormatted: notificationMoney(
                  (updatedSession.current_cost_cents as number | null) ?? 0,
                  updatedSession.currency as string,
                ),
                // Templates label the cost "incl. tax" only when it contains tax.
                costIncludesTax: costIncludesTax(
                  updatedSession.current_cost_cents as number | null,
                  updatedSession.tariff_tax_rate as string | null,
                ),
                currency: updatedSession.currency as string,
                durationMinutes,
              },
              ALL_TEMPLATES_DIRS,
              this.deps.pubsub,
            ),
          );
          return Promise.resolve();
        });
      }

      const updatedChargingState = getString(payload, 'chargingState');
      await this.publishTransactionScreen(tx, sessionId, 'updated', updatedChargingState);
      if (gateFailure != null) throw gateFailure.err;
      if (unauthorizedFailure != null) throw unauthorizedFailure.err;
    } else {
      this.state.txBuffer.add(stationId, transactionId, event);
    }
  }

  private async projectEnded(tx: TransactionEventContext): Promise<void> {
    const {
      event,
      payload,
      stationId,
      stationUuid,
      transactionId,
      seqNo,
      triggerReason,
      timestamp,
      payloadJson,
    } = tx;
    const stoppedReason = getString(payload, 'stoppedReason');

    if (await this.isResentEvent(tx, 'ended')) return;

    // An idToken (or a portal remote start's remoteStartId) first presented
    // in the Ended event (E03.FR.01: the event after authorization can be
    // the last one): link it and run its gate
    // while the session is still active, so the settlement debits a prepaid
    // token or captures the card hold. A gate failure is rethrown at the end.
    let gateFailure: { err: unknown } | null = null;
    if (payload.idToken != null || payload.remoteStartId != null) {
      const [activeSession] = await this.deps.sql`
        SELECT id FROM charging_sessions
        WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
          AND status = 'active'
      `;
      if (activeSession != null) {
        gateFailure = await this.linkFirstPresentedToken(tx, activeSession.id as string, 'ended');
      }
    }

    // Check if this session was stopped due to a payment failure (pre-auth or missing payment method)
    const failedPaymentRows = await this.deps.sql`
        SELECT id FROM payment_records
        WHERE session_id = (
          SELECT id FROM charging_sessions
          WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
        )
          AND status = 'failed'
        LIMIT 1
      `;
    const hasPaymentFailure = failedPaymentRows.length > 0;

    // A station that ends the transaction at its cost limit: tell a prepaid
    // driver before the Ended UPDATE, while the session is still active.
    if (triggerReason === 'CostLimitReached') {
      const [limitSession] = await this.deps.sql`
        SELECT id FROM charging_sessions
        WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
      `;
      if (limitSession != null) {
        await this.notePrepaidCostLimit(tx, limitSession.id as string, 'ended');
      }
    }

    // An idle period open for IDLE_NOTICE_MIN_SECONDS at the end notifies
    // the driver before the Ended UPDATE folds it; a shorter one (an EV that
    // reports full and ends the transaction a moment later) sends nothing
    // (JB-2). A rerun after the UPDATE finds no active session.
    const [endingIdleSession] = await this.deps.sql`
        SELECT id FROM charging_sessions
        WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
          AND status = 'active' AND idle_started_at IS NOT NULL
      `;
    if (endingIdleSession != null) {
      await this.deps.notify.dispatchDueIdlingNotification(
        endingIdleSession.id as string,
        stationId,
        transactionId,
        timestamp,
      );
    }

    const endStatus = hasPaymentFailure ? 'faulted' : 'completed';
    const meterStopVal = payload.meterStop != null ? Number(payload.meterStop) : null;
    // Preserve a terminal status (faulted/failed) that the payment-gate
    // eager-cleanup already set. The pre-fix UPDATE unconditionally flipped
    // the session back to 'completed' for the MissingPaymentMethod path
    // (no payment_records row -> hasPaymentFailure false), which then let
    // the cost-calc block below apply pricePerSession against an
    // already-stopped session.
    //
    // OCPP 1.6 StopTransaction carries the final register reading. Energy
    // is otherwise only derived from periodic MeterValues, which lag behind
    // the stop (a 60s sample interval leaves up to a minute uncounted), so
    // use meterStop - meterStart as the final energy. Never lower the value
    // already derived from meter readings (e.g. a station reporting 0).
    await this.deps.sql`
        UPDATE charging_sessions
        SET status = CASE
              WHEN status IN ('faulted', 'failed') THEN status
              ELSE ${endStatus}
            END,
            ended_at = ${timestamp},
            -- An idle period still open at the end closes at the end (JC-2).
            idle_minutes = idle_minutes + COALESCE(
              GREATEST(0, EXTRACT(EPOCH FROM (${timestamp}::timestamptz - idle_started_at)) / 60), 0),
            idle_started_at = NULL,
            stopped_reason = COALESCE(stopped_reason, ${stoppedReason}),
            meter_stop = COALESCE(${meterStopVal}, meter_stop),
            energy_delivered_wh = CASE
              WHEN ${meterStopVal}::numeric IS NOT NULL AND meter_start IS NOT NULL
                AND ${meterStopVal}::numeric >= meter_start
              THEN GREATEST(COALESCE(energy_delivered_wh, 0), ${meterStopVal}::numeric - meter_start)
              ELSE energy_delivered_wh
            END,
            updated_at = now()
        WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
      `;

    const sessionRows = await this.deps.sql`
        SELECT id, evse_id, status, tariff_id, current_cost_cents, started_at, ended_at,
               energy_delivered_wh, currency, tariff_tax_rate, idle_started_at, idle_minutes,
               reservation_id, free_vend
        FROM charging_sessions
        WHERE station_id = ${stationUuid} AND transaction_id = ${transactionId}
      `;
    const sessionRow = sessionRows[0];
    if (sessionRow != null) {
      const sessionId = sessionRow.id as string;
      const endedEvseUuid = sessionRow.evse_id as string | null;

      // OCPP 2.1: chargingState is on transactionInfo of the Ended event (e.g. EVConnected
      // when the cable is still plugged after a remote stop). Mirror the Updated-handler
      // behaviour so the connector badge transitions out of 'charging' even when the
      // station does not send a follow-up StatusNotification.
      const endedChargingState = getString(payload, 'chargingState');
      if (endedChargingState != null) {
        const endedConnectorStatus = CHARGING_STATE_TO_STATUS[endedChargingState];
        if (endedConnectorStatus != null && endedEvseUuid != null) {
          await applyEvseChargingState(
            this.deps.sql,
            endedEvseUuid,
            endedConnectorStatus,
            timestamp,
          );
          const endedSiteId = await this.deps.lookups.resolveSiteId(stationUuid);
          await this.deps.notify.notifyChange('station.status', stationUuid, endedSiteId);
        }
      }

      // The EV never connected (EVConnectTimeout, no energy): the session
      // fails and is not billed (C20.FR.02/03). A faulted or failed status
      // the CASE guard preserved stays (P5). The cost is zeroed eagerly so
      // the settlement below cancels the hold, and `sessionStatus` carries
      // the status this update wrote: `sessionRow` was read before it.
      const isTimeoutEnd = isUnbilledTimeoutEnd({
        triggerReason,
        stoppedReason,
        energyWh: Number(sessionRow.energy_delivered_wh ?? 0),
      });
      let sessionStatus = sessionRow.status as string;
      if (isTimeoutEnd) {
        await this.deps.sql`
            UPDATE charging_sessions
            SET status = CASE WHEN status IN ('faulted', 'failed') THEN status ELSE 'failed' END,
                final_cost_cents = 0,
                current_cost_cents = 0,
                updated_at = now()
            WHERE id = ${sessionId}
          `;
        if (sessionStatus !== 'faulted') sessionStatus = 'failed';
      }

      // If this session was linked to a reservation and it ended in a
      // non-success state, write a follow-up audit row so the reservation
      // timeline shows the real outcome instead of leaving the prior `used`
      // transition as the last word. Reservation status stays `in_use` --
      // the driver did attempt to consume the reservation -- but the audit
      // log records why the attempt didn't produce a real charging session.
      if (endStatus === 'faulted' || isTimeoutEnd) {
        const failureReason = hasPaymentFailure
          ? `faulted (payment failure)${stoppedReason != null ? `: ${stoppedReason}` : ''}`
          : `failed (timeout)${stoppedReason != null ? `: ${stoppedReason}` : ''}`;
        await tx.attempt.once('ended:reservation-fault', () =>
          this.deps.notify.auditLinkedReservationFault(sessionId, failureReason),
        );
      }

      await tx.attempt.once('ended:transaction-event', async () => {
        try {
          await this.deps.sql`
            INSERT INTO transaction_events (session_id, event_type, seq_no, timestamp, trigger_reason, payload)
            VALUES (${sessionId}, 'ended', ${seqNo}, ${timestamp}, ${triggerReason}, ${payloadJson})
          `;
        } catch (txEvtErr: unknown) {
          // Only a statement that never reached the server is retried; an
          // interrupted one may have committed and goes on (see Started).
          if (pgConnectionErrorKind(txEvtErr) === 'not-sent') throw txEvtErr;
          this.deps.logger.warn(
            { err: txEvtErr, sessionId, transactionId },
            'Failed to insert transaction_event (session may have been deleted)',
          );
        }
      });

      // Compute final cost from snapshotted tariff rates. Skip when the
      // session was already faulted/failed by the payment gate (or any
      // other pre-stop path), or failed by the timeout end above: the
      // driver is not charged, so pricePerSession + tax would be a phantom
      // cost in Recent Sessions and the portal, and a capture of the hold.
      const skipCostCalc = sessionStatus === 'faulted' || sessionStatus === 'failed';
      const hasTariffSnapshot = sessionRow.tariff_id != null;
      if (sessionRow.free_vend === true && !skipCostCalc) {
        // Free vend: the session is not billed, so its final cost is a zero
        // with a zero split (finding J4), not unknown. A free vend session
        // has no tariff snapshot, so the branch below would leave it null.
        await storeFinalCost(
          this.deps.sql,
          sessionId,
          chargedCostBreakdown(0, 0, await getCompanyTaxBasis()),
        );
      } else if (hasTariffSnapshot && !skipCostCalc) {
        const endedAt = new Date(sessionRow.ended_at as string);
        const energyWh = Number(sessionRow.energy_delivered_wh ?? 0);
        const idleMinutes = sessionIdleMinutesAt(
          {
            idleStartedAt:
              sessionRow.idle_started_at != null
                ? new Date(sessionRow.idle_started_at as string)
                : null,
            idleMinutes: Number(sessionRow.idle_minutes ?? 0),
          },
          endedAt,
        );

        // Close the open tariff segment with the idle not yet attributed to
        // closed segments.
        await closeOpenSegment(this.deps.sql, sessionId, endedAt, energyWh, idleMinutes);

        // The one cost assembly prices the session from its snapshots. The
        // OCPP 2.1 handler priced it the same way and returned the result to
        // the station as totalCost (I03.FR.02); that amount is what is
        // charged, so the session and the station display agree. Should the
        // two ever differ, the breakdown is reconciled to the responded amount.
        const breakdown = await priceSessionAt(this.deps.sql, sessionId, endedAt, energyWh);
        if (breakdown != null) {
          const respondedCostCents = payload.finalCostCents;
          const responded =
            typeof respondedCostCents === 'number' &&
            Number.isInteger(respondedCostCents) &&
            respondedCostCents >= 0
              ? respondedCostCents
              : null;
          if (responded != null && responded !== breakdown.grossCents) {
            this.deps.logger.warn(
              { sessionId, respondedCostCents: responded, pricedCents: breakdown.grossCents },
              'Final cost differs from the totalCost sent to the station; charging the sent amount',
            );
          }
          await storeFinalCost(
            this.deps.sql,
            sessionId,
            responded != null
              ? reconcileCostBreakdown(
                  breakdown,
                  responded,
                  Number(sessionRow.tariff_tax_rate ?? 0),
                )
              : breakdown,
          );
        }
      }

      // Carbon footprint calculation. LEFT JOIN so we can distinguish
      // "site has no carbon region set" (silent skip, common default
      // state) from "site references a carbon region with no matching
      // factor row" (data anomaly worth logging - typo'd region_code
      // or a factor row deleted out-of-band).
      try {
        const carbonRows = await this.deps.sql`
            SELECT s.carbon_region_code, cif.carbon_intensity_kg_per_kwh
            FROM charging_stations cs
            JOIN sites s ON s.id = cs.site_id
            LEFT JOIN carbon_intensity_factors cif ON cif.region_code = s.carbon_region_code
            WHERE cs.id = ${stationUuid}
          `;
        const carbonRow = carbonRows[0];
        const regionCode = carbonRow?.['carbon_region_code'] as string | null | undefined;
        const intensityRaw = carbonRow?.['carbon_intensity_kg_per_kwh'] as
          | string
          | number
          | null
          | undefined;
        if (regionCode != null && intensityRaw == null) {
          this.deps.logger.warn(
            { sessionId, stationUuid, regionCode },
            'Carbon intensity factor missing for region; CO2 calculation skipped',
          );
        } else if (intensityRaw != null) {
          const intensity = Number(intensityRaw);
          const sessionEnergyWh = Number(sessionRow.energy_delivered_wh ?? 0);
          if (sessionEnergyWh > 0 && Number.isFinite(intensity) && intensity > 0) {
            // calculateCo2AvoidedKg clamps to >= 0 so dirty grids never
            // produce a negative "avoided" value.
            const co2Avoided = calculateCo2AvoidedKg(sessionEnergyWh, intensity);
            // Idempotency guard: TransactionEvent Ended can fire more than
            // once for a session (station retry, projection retry); the
            // co2 value must not be overwritten if it was already
            // computed against the same intensity factor.
            await this.deps.sql`
                UPDATE charging_sessions SET co2_avoided_kg = ${co2Avoided}, updated_at = now()
                WHERE id = ${sessionId} AND co2_avoided_kg IS NULL
              `;
          }
        }
      } catch (carbonErr: unknown) {
        // A lost connection goes to the projection retry (the UPDATE is
        // guarded, so the rerun writes it once). On the last run it warns and
        // continues, as do the electricity cost and reservation used steps,
        // so the session ended SSE, the OCPI push, the TransactionEnded
        // publish (guest finalization) and the station screen still run.
        if (pgConnectionErrorKind(carbonErr) != null && !tx.attempt.isLast) throw carbonErr;
        this.deps.logger.warn({ err: carbonErr, sessionId }, 'Failed to compute CO2 avoided');
      }

      const siteId = await this.deps.lookups.resolveSiteId(stationUuid);

      // Electricity cost (operator's wholesale cost). Forward-only: computed
      // once at session end against the site's TOU rate periods, never
      // backfilled. Fail-open: a missing rate config or any error leaves the
      // column null and never blocks session completion.
      if (siteId != null) {
        try {
          const periods = await getElectricityRatePeriodsForSite(siteId);
          if (periods.length > 0) {
            const [ctxRow] = await this.deps.sql`
                SELECT cs.ended_at, s.timezone
                FROM charging_sessions cs
                JOIN sites s ON s.id = ${siteId}
                WHERE cs.id = ${sessionId}
              `;
            const timezone = (ctxRow?.['timezone'] as string | null) ?? undefined;
            const endedAtValue = ctxRow?.['ended_at'] as string | Date | null | undefined;
            const ratedAt = endedAtValue != null ? new Date(endedAtValue) : new Date();
            const rate = resolveElectricityRate(periods, ratedAt, timezone);
            const sessionEnergyWh = Number(sessionRow.energy_delivered_wh ?? 0);
            if (rate != null && sessionEnergyWh > 0) {
              const electricityCostCents = calculateElectricityCostCents(
                sessionEnergyWh,
                rate.ratePerKwh,
              );
              await this.deps.sql`
                  UPDATE charging_sessions
                  SET electricity_cost_cents = ${electricityCostCents}, updated_at = now()
                  WHERE id = ${sessionId} AND electricity_cost_cents IS NULL
                `;
            }
          }
        } catch (electricityErr: unknown) {
          // A lost connection goes to the projection retry (guarded UPDATE).
          if (pgConnectionErrorKind(electricityErr) != null && !tx.attempt.isLast)
            throw electricityErr;
          this.deps.logger.warn(
            { err: electricityErr, sessionId },
            'electricity cost calculation failed',
          );
        }
      }

      await this.deps.notify.notifyChange('session.ended', stationUuid, siteId, sessionId);
      await this.deps.notify.notifyOcpiPush('session', { sessionId });

      // Transition in_use reservation to used when session ends
      const reservationUuidForEnd = sessionRow.reservation_id as string | null;
      if (reservationUuidForEnd != null) {
        await this.deps.sql`
            UPDATE reservations SET status = 'used', updated_at = now()
            WHERE id = ${reservationUuidForEnd} AND status = 'in_use'
          `.catch((err: unknown) => {
          // A lost connection goes to the projection retry (guarded UPDATE).
          if (pgConnectionErrorKind(err) != null && !tx.attempt.isLast) throw err;
          this.deps.logger.error({ err }, 'failed to transition reservation to used');
        });
        await this.deps.notify.notifyChange('reservation.changed', stationUuid, siteId, sessionId);
      }

      // Notify guest session service for payment finalization
      await tx.attempt.once('ended:csms-transaction-ended', async () => {
        try {
          const endPayload = JSON.stringify({
            type: 'TransactionEnded',
            sessionId,
            stationId,
            transactionId,
          });
          await this.deps.pubsub.publish('csms_events', endPayload);
        } catch (err) {
          this.deps.logger.debug(
            { err, sessionId },
            'Transaction-ended SSE publish failed; continuing',
          );
        }
      });

      // The driver's session.Completed and session.Receipt are sent after the
      // payment settlement (notifySessionEnded, from settleTransactionEnded), so
      // they can say when nothing was charged.

      // The station does not know a session the CSMS ended (superseded or
      // ghost), and may be in a new transaction: its screen is left alone.
      if (event.eventType !== SESSION_ENDED_BY_CSMS) {
        await this.publishTransactionScreen(tx, sessionRow.id as string, 'ended', null);
      }

      // Free the per-session CostUpdated throttle entry now that the
      // session is over. Without this the Map grows unbounded over the
      // process lifetime.
      this.state.costUpdated.forget(sessionRow.id as string);
    } else {
      this.state.txBuffer.add(stationId, transactionId, event);
    }
    if (gateFailure != null) throw gateFailure.err;
  }

  async endByCsms(event: DomainEvent, attempt: ProjectionAttempt): Promise<void> {
    const stationId = event.payload.stationId as string;
    const transactionId = event.payload.transactionId as string;
    // Transaction ids are unique per station only (N4).
    const [row] = await this.deps.sql`
      SELECT cs.status FROM charging_sessions cs
      JOIN charging_stations st ON st.id = cs.station_id
      WHERE st.station_id = ${stationId} AND cs.transaction_id = ${transactionId}
    `;
    if (row?.status !== 'active') return;
    await this.project(event, attempt);
    await settleTransactionEnded(this.deps, event, attempt);
  }
}
