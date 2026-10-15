// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, lte, isNull, sql } from 'drizzle-orm';
import {
  db,
  client,
  chargingSessions,
  chargingStations,
  getStaleSessionTimeoutHours,
  writeReservationAudit,
  closeSegmentsAt,
  faultUnbilledSession,
  sessionIdleMinutesAt,
  publishOcpiSessionPush,
  writeCsmsSessionAudit,
  STALE_CLEANUP_IN_TRANSACTION_STATUSES,
} from '@evtivity/database';
import { publishOcppCommand } from '@evtivity/lib';
import { cancelOpenSessionHold, failGuestSessionOfFaultedSession } from '@evtivity/payments';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { paymentContext } from '../lib/payments.js';

export async function staleSessionCleanupHandler(log: Logger): Promise<void> {
  const timeoutHours = await getStaleSessionTimeoutHours();
  if (timeoutHours <= 0) {
    log.debug('Stale session cleanup disabled (timeout <= 0)');
    return;
  }

  const cutoff = new Date(Date.now() - timeoutHours * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const inTransactionStatuses = sql.join(
    STALE_CLEANUP_IN_TRANSACTION_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );

  // Find active sessions not updated since the cutoff. A session whose station
  // is online and still reports the transaction (its connector in a
  // transaction status, or a transaction event received after the cutoff) is
  // not stale (owner decision 2026-10-14): only sessions on an offline or
  // silent station are faulted.
  const staleSessions = await db
    .select({
      id: chargingSessions.id,
      stationId: chargingSessions.stationId,
      driverId: chargingSessions.driverId,
      transactionId: chargingSessions.transactionId,
      startedAt: chargingSessions.startedAt,
      updatedAt: chargingSessions.updatedAt,
      energyDeliveredWh: chargingSessions.energyDeliveredWh,
      tariffId: chargingSessions.tariffId,
      idleStartedAt: chargingSessions.idleStartedAt,
      idleMinutes: chargingSessions.idleMinutes,
      reservationId: chargingSessions.reservationId,
      stationIsOnline: chargingStations.isOnline,
      stationOcppId: chargingStations.stationId,
      ocppProtocol: chargingStations.ocppProtocol,
      stillReported: sql<boolean>`(${chargingStations.isOnline} AND (
        EXISTS (
          SELECT 1 FROM connectors c
          WHERE (c.id = ${chargingSessions.connectorId}
              OR (${chargingSessions.connectorId} IS NULL AND c.evse_id = ${chargingSessions.evseId}))
            AND c.status::text IN (${inTransactionStatuses})
        )
        OR EXISTS (
          SELECT 1 FROM transaction_events te
          WHERE te.session_id = ${chargingSessions.id}
            AND te.created_at > ${cutoffIso}::timestamptz
        )
      ))`,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .where(
      and(
        eq(chargingSessions.status, 'active'),
        lte(chargingSessions.updatedAt, cutoff),
        // A session the operator asked to end billed (ghost, superseded) is
        // ended by the OCPP server, never faulted here.
        isNull(chargingSessions.endRequestReason),
      ),
    );

  if (staleSessions.length === 0) {
    return;
  }

  log.info({ count: staleSessions.length, timeoutHours }, 'Found stale sessions to clean up');

  for (const session of staleSessions) {
    if (session.stillReported) {
      log.info(
        {
          sessionId: session.id,
          stationId: session.stationId,
          transactionId: session.transactionId,
          lastUpdate: session.updatedAt.toISOString(),
        },
        'Stale session skipped: the online station still reports its transaction',
      );
      continue;
    }
    try {
      // Use the last updated_at as the session end time
      const endedAt = session.updatedAt;
      const energyWh = Number(session.energyDeliveredWh ?? 0);

      // A stale session is faulted and not billed (owner decision, audit
      // N6): its cost is zeroed with the status, like the payment gate's stop
      // (P4). A session that ended meanwhile keeps its own end and cost (P5).
      // No receipt or completion notification is sent.
      const faulted = await faultUnbilledSession(client, {
        sessionId: session.id,
        reason: 'StaleSession',
        endedAt,
        // A meter value or event that refreshed the session after the list
        // was read keeps it running.
        notUpdatedSince: cutoff,
      });

      // The tariff segments end at the last update, so the segment trail
      // shows how long the session ran. Only when this run faulted it: a
      // session that ended meanwhile keeps the segments its end closed.
      if (faulted && session.tariffId != null && session.startedAt != null) {
        const idleMinutes = sessionIdleMinutesAt(
          { idleStartedAt: session.idleStartedAt, idleMinutes: Number(session.idleMinutes) },
          endedAt,
        );
        await closeSegmentsAt(client, session.id, endedAt, energyWh, idleMinutes);
      }

      // Its open hold (a portal start whose 1.6 ConnectionTimeOut expired, a
      // session the station lost) is cancelled now instead of staying held
      // until the provider expires it (P4). Only when this run faulted it.
      // Fail-open (P9): the record stays pre_authorized and the hold expires
      // at the provider.
      if (faulted) {
        try {
          await cancelOpenSessionHold(
            session.id,
            'Stale session faulted',
            paymentContext(log, 'stale-session-cleanup'),
          );
        } catch (holdErr: unknown) {
          log.warn(
            { sessionId: session.id, err: holdErr },
            'Failed to cancel the hold of a stale session',
          );
        }
        // A guest session of the faulted session fails with it, so the guest
        // page stops showing it as charging (fail-open, logged inside).
        await failGuestSessionOfFaultedSession(
          session.id,
          paymentContext(log, 'stale-session-cleanup'),
        );
      }

      // Audit the reservation linkage so the reservation timeline shows why
      // this session terminated. Mirrors the projection-side fault paths.
      if (session.reservationId != null) {
        try {
          await writeReservationAudit(
            {
              reservationId: session.reservationId,
              action: 'session_failed',
              actor: 'system',
              notes: `session ${session.id}: faulted: StaleSession`,
            },
            undefined,
            log,
          );
        } catch (auditErr: unknown) {
          log.warn(
            { sessionId: session.id, reservationId: session.reservationId, err: auditErr },
            'Failed to write session_failed reservation audit on stale cleanup',
          );
        }
      }

      // Send RequestStopTransaction to online stations to clear the station-side transaction
      let stopSent = false;
      if (session.stationIsOnline) {
        try {
          await publishOcppCommand(getPubSub(), {
            stationId: session.stationOcppId,
            action: 'RequestStopTransaction',
            payload: { transactionId: session.transactionId },
            version: session.ocppProtocol,
          });
          stopSent = true;
          log.info(
            { sessionId: session.id, transactionId: session.transactionId },
            'Sent RequestStopTransaction for stale session on online station',
          );
        } catch (stopErr: unknown) {
          log.warn(
            { sessionId: session.id, error: stopErr },
            'Failed to send RequestStopTransaction for stale session',
          );
        }
      }

      // A roaming session's partner gets the INVALID session (fail-open).
      if (faulted) await publishOcpiSessionPush(getPubSub(), session.id, log);

      // Only the run whose fault changed the session audits it (P7).
      if (faulted) {
        await writeCsmsSessionAudit(
          {
            sessionId: session.id,
            action: 'faulted',
            actor: 'system',
            actorLabel: 'stale-session-cleanup',
            before: { status: 'active' },
            after: { status: 'faulted', stoppedReason: 'StaleSession', finalCostCents: 0 },
            notes: [
              `No update since ${session.updatedAt.toISOString()} (timeout ${String(timeoutHours)} h)`,
              ...(stopSent
                ? [`RequestStopTransaction sent for transaction ${session.transactionId}`]
                : []),
            ].join('; '),
          },
          undefined,
          log,
        );
      }

      log.info(
        {
          sessionId: session.id,
          stationId: session.stationId,
          transactionId: session.transactionId,
          stationOnline: session.stationIsOnline,
          lastUpdate: session.updatedAt.toISOString(),
          faulted,
        },
        'Closed stale session',
      );
    } catch (err: unknown) {
      log.error({ sessionId: session.id, error: err }, 'Failed to close stale session');
    }
  }

  log.info({ count: staleSessions.length }, 'Stale session cleanup complete');
}
