// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, lte, isNull } from 'drizzle-orm';
import {
  db,
  client,
  chargingSessions,
  chargingStations,
  getStaleSessionTimeoutHours,
  writeReservationAudit,
  closeOpenSegment,
  faultUnbilledSession,
  sessionIdleMinutesAt,
} from '@evtivity/database';
import { publishOcppCommand } from '@evtivity/lib';
import { cancelOpenSessionHold } from '@evtivity/payments';
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

  // Find active sessions not updated since the cutoff
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
    try {
      // Use the last updated_at as the session end time
      const endedAt = session.updatedAt;
      const energyWh = Number(session.energyDeliveredWh ?? 0);

      // Close the open tariff segment at the last update, so the segment
      // trail shows how long the session ran.
      if (session.tariffId != null && session.startedAt != null) {
        const idleMinutes = sessionIdleMinutesAt(
          { idleStartedAt: session.idleStartedAt, idleMinutes: Number(session.idleMinutes) },
          endedAt,
        );
        await closeOpenSegment(client, session.id, endedAt, energyWh, idleMinutes);
      }

      // A stale session is faulted and not billed (owner decision, audit
      // N6): its cost is zeroed with the status, like the payment gate's stop
      // (P4). A session that ended meanwhile keeps its own end and cost (P5).
      // No receipt or completion notification is sent.
      const faulted = await faultUnbilledSession(client, {
        sessionId: session.id,
        reason: 'StaleSession',
        endedAt,
      });

      // Its open hold (a portal start whose 1.6 ConnectionTimeOut expired, a
      // session the station lost) is cancelled now instead of staying held
      // until the provider expires it (P4). Only when this run faulted it.
      // Fail-open (P9): the record stays pre_authorized and the hold expires
      // at the provider.
      if (faulted) {
        try {
          await cancelOpenSessionHold(session.id, 'Stale session faulted', paymentContext(log));
        } catch (holdErr: unknown) {
          log.warn(
            { sessionId: session.id, err: holdErr },
            'Failed to cancel the hold of a stale session',
          );
        }
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
      if (session.stationIsOnline) {
        try {
          await publishOcppCommand(getPubSub(), {
            stationId: session.stationOcppId,
            action: 'RequestStopTransaction',
            payload: { transactionId: session.transactionId },
            version: session.ocppProtocol,
          });
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
