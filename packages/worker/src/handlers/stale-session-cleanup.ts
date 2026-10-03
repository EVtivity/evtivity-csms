// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { eq, and, lte } from 'drizzle-orm';
import {
  db,
  client,
  chargingSessions,
  chargingStations,
  getStaleSessionTimeoutHours,
  writeReservationAudit,
  closeOpenSegment,
  priceSessionAt,
  sessionIdleMinutesAt,
} from '@evtivity/database';
import type { SessionCostBreakdown } from '@evtivity/lib';
import type { Logger } from 'pino';
import { getPubSub } from '@evtivity/api/src/lib/pubsub.js';

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
      currentCostCents: chargingSessions.currentCostCents,
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
    .where(and(eq(chargingSessions.status, 'active'), lte(chargingSessions.updatedAt, cutoff)));

  if (staleSessions.length === 0) {
    return;
  }

  log.info({ count: staleSessions.length, timeoutHours }, 'Found stale sessions to clean up');

  for (const session of staleSessions) {
    try {
      // Use the last updated_at as the session end time
      const endedAt = session.updatedAt;
      const energyWh = Number(session.energyDeliveredWh ?? 0);

      // Close the open tariff segment and price the session at its last
      // update with the one cost assembly the OCPP final cost uses (segments,
      // idle grace, and the reservation holding fee).
      let breakdown: SessionCostBreakdown | null = null;
      if (session.tariffId != null && session.startedAt != null) {
        const idleMinutes = sessionIdleMinutesAt(
          { idleStartedAt: session.idleStartedAt, idleMinutes: Number(session.idleMinutes) },
          endedAt,
        );
        await closeOpenSegment(client, session.id, endedAt, energyWh, idleMinutes);
        breakdown = await priceSessionAt(client, session.id, endedAt, energyWh);
      }
      const finalCostCents = breakdown?.grossCents ?? session.currentCostCents;

      // Mark session as faulted. Without a new price the last running cost
      // (stored with its split) becomes the final cost.
      await db
        .update(chargingSessions)
        .set({
          status: 'faulted',
          stoppedReason: 'StaleSession',
          endedAt,
          finalCostCents,
          currentCostCents: finalCostCents,
          ...(breakdown != null
            ? {
                netCents: breakdown.netCents,
                taxCents: breakdown.taxCents,
                costBreakdown: breakdown,
              }
            : {}),
          updatedAt: new Date(),
        })
        // A session that ended meanwhile keeps its own end and cost (P5).
        .where(and(eq(chargingSessions.id, session.id), eq(chargingSessions.status, 'active')));

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
          const commandId = crypto.randomUUID();
          const pubsub = getPubSub();
          const notification = JSON.stringify({
            commandId,
            stationId: session.stationOcppId,
            action: 'RequestStopTransaction',
            payload: { transactionId: session.transactionId },
            ...(session.ocppProtocol != null ? { version: session.ocppProtocol } : {}),
          });
          await pubsub.publish('ocpp_commands', notification);
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
          finalCostCents,
        },
        'Closed stale session',
      );
    } catch (err: unknown) {
      log.error({ sessionId: session.id, error: err }, 'Failed to close stale session');
    }
  }

  log.info({ count: staleSessions.length }, 'Stale session cleanup complete');
}
