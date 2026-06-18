// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job } from 'bullmq';
import { eq, and, desc, isNull } from 'drizzle-orm';
import {
  client,
  db,
  reservations,
  chargingStations,
  chargingSessions,
  connectors,
  evses,
  writeReservationAudit,
} from '@evtivity/database';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger, dispatchDriverNotification } from '@evtivity/lib';

const log = createLogger('reservation-activate');

async function notifyDriverCancelled(
  driverId: string,
  reservationId: number,
  stationOcppId: string,
  reservationDbId: string,
  context: string,
  pubsub: PubSubClient,
): Promise<void> {
  try {
    await dispatchDriverNotification(
      client,
      'reservation.Cancelled',
      driverId,
      {
        reservationId,
        stationId: stationOcppId,
        cancellationFeeFormatted: '',
      },
      ALL_TEMPLATES_DIRS,
      pubsub,
    );
  } catch (err) {
    log.warn(
      { err, driverId, reservationDbId, context },
      'Failed to dispatch reservation.Cancelled notification',
    );
  }
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const API_TEMPLATES_DIR =
  process.env['API_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'api', 'src', 'templates');
const OCPP_TEMPLATES_DIR =
  process.env['OCPP_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');
const ALL_TEMPLATES_DIRS = [OCPP_TEMPLATES_DIR, API_TEMPLATES_DIR];

export async function handleReservationActivate(job: Job, pubsub: PubSubClient): Promise<void> {
  const { reservationDbId } = job.data as { reservationDbId: string };

  // Load reservation with station and EVSE info
  const [reservation] = await db
    .select({
      id: reservations.id,
      reservationId: reservations.reservationId,
      status: reservations.status,
      expiresAt: reservations.expiresAt,
      driverId: reservations.driverId,
      stationDbId: reservations.stationId,
      stationOcppId: chargingStations.stationId,
      isOnline: chargingStations.isOnline,
      evseDbId: reservations.evseId,
    })
    .from(reservations)
    .innerJoin(chargingStations, eq(reservations.stationId, chargingStations.id))
    .where(eq(reservations.id, reservationDbId));

  if (reservation == null) {
    log.warn({ reservationDbId }, 'Reservation not found, skipping activation');
    return;
  }

  if (reservation.status !== 'scheduled') {
    log.info(
      { reservationDbId, status: reservation.status },
      'Reservation is no longer scheduled, skipping activation',
    );
    return;
  }

  // Tell the CSMS so the Reservations page reloads itself. Best-effort.
  const notifyReservationChanged = (): void => {
    void pubsub
      .publish(
        'csms_events',
        JSON.stringify({
          eventType: 'reservation.changed',
          stationId: reservation.stationOcppId,
          siteId: null,
          sessionId: null,
        }),
      )
      .catch(() => {
        /* best-effort */
      });
  };

  // Check if already expired
  if (reservation.expiresAt <= new Date()) {
    const expiredRows = await db
      .update(reservations)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(reservations.id, reservationDbId), eq(reservations.status, 'scheduled')))
      .returning({ id: reservations.id });
    if (expiredRows.length > 0) {
      await writeReservationAudit({
        reservationId: reservationDbId,
        action: 'expired',
        actor: 'system',
        driverIdBefore: reservation.driverId,
        driverIdAfter: reservation.driverId,
        statusBefore: 'scheduled',
        statusAfter: 'expired',
        notes: 'expired before scheduled activation',
      });
      notifyReservationChanged();
    }
    log.info({ reservationDbId }, 'Scheduled reservation expired before activation');
    return;
  }

  // Check station is online
  if (!reservation.isOnline) {
    // System-path cancel: write actor + reason metadata so the audit reflects
    // why the reservation was killed. RETURNING driver_id lets us notify the
    // driver -- without this, a scheduled reservation against an offline
    // station would silently disappear from the portal.
    const cancelled = await db
      .update(reservations)
      .set({
        status: 'cancelled',
        cancelledBy: 'system',
        cancelReason: 'station_offline_at_activation',
        cancellationFeeCents: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(reservations.id, reservationDbId), eq(reservations.status, 'scheduled')))
      .returning({ driverId: reservations.driverId });
    log.warn(
      { reservationDbId, stationId: reservation.stationOcppId },
      'Station offline, cancelling scheduled reservation',
    );

    if (cancelled.length > 0) {
      await writeReservationAudit({
        reservationId: reservationDbId,
        action: 'cancelled',
        actor: 'system',
        driverIdBefore: reservation.driverId,
        driverIdAfter: reservation.driverId,
        statusBefore: 'scheduled',
        statusAfter: 'cancelled',
        notes: 'station_offline_at_activation',
      });
      notifyReservationChanged();
    }

    const driverId = cancelled[0]?.driverId ?? null;
    if (driverId != null) {
      await notifyDriverCancelled(
        driverId,
        reservation.reservationId,
        reservation.stationOcppId,
        reservationDbId,
        'station_offline_at_activation',
        pubsub,
      );
    }
    return;
  }

  // Re-validate connector state at activation time. The create-time guard in
  // packages/api/src/routes/reservations.ts only fires when the start is
  // within `reservation.activeSessionCheckHours` of "now"; far-future
  // reservations skip that check on the assumption the EVSE will free up by
  // activation. If the assumption breaks (in-flight session ran long, driver
  // showed up early and plugged in, station fault), the worker must catch it
  // here -- otherwise ReserveNow lands on a busy/faulted connector, the
  // station rejects, the projection cancels, and the driver gets a
  // "cancelled" notification at exactly the moment they expected to charge.
  const targetConditions = [eq(evses.stationId, reservation.stationDbId)];
  if (reservation.evseDbId != null) {
    targetConditions.push(eq(evses.id, reservation.evseDbId));
  }
  const connectorRows = await db
    .select({
      status: connectors.status,
    })
    .from(connectors)
    .innerJoin(evses, eq(connectors.evseId, evses.id))
    .where(and(...targetConditions));

  const hasAvailable = connectorRows.some((c) => c.status === 'available');

  if (!hasAvailable && connectorRows.length > 0) {
    // Before cancelling, check whether the reservation's own driver is
    // already charging on the reserved EVSE. They showed up early, plugged
    // in, and their session is in progress -- treat that as the reservation
    // being fulfilled rather than blocked. Link the session so the
    // TransactionEvent.Ended projection can later transition in_use -> used
    // when they unplug.
    if (reservation.driverId != null) {
      const sessionConditions = [
        eq(chargingSessions.stationId, reservation.stationDbId),
        eq(chargingSessions.driverId, reservation.driverId),
        isNull(chargingSessions.endedAt),
      ];
      if (reservation.evseDbId != null) {
        sessionConditions.push(eq(chargingSessions.evseId, reservation.evseDbId));
      }
      const [activeSession] = await db
        .select({ id: chargingSessions.id })
        .from(chargingSessions)
        .where(and(...sessionConditions))
        .orderBy(desc(chargingSessions.startedAt))
        .limit(1);
      if (activeSession != null) {
        const flipped = await db
          .update(reservations)
          .set({ status: 'in_use', updatedAt: new Date() })
          .where(and(eq(reservations.id, reservationDbId), eq(reservations.status, 'scheduled')))
          .returning({ id: reservations.id });
        if (flipped.length > 0) {
          await db
            .update(chargingSessions)
            .set({ reservationId: reservationDbId, updatedAt: new Date() })
            .where(eq(chargingSessions.id, activeSession.id));
          await writeReservationAudit({
            reservationId: reservationDbId,
            action: 'used',
            actor: 'system',
            driverIdBefore: reservation.driverId,
            driverIdAfter: reservation.driverId,
            statusBefore: 'scheduled',
            statusAfter: 'in_use',
            notes: `same-driver session ${activeSession.id} present at activation`,
          });
          log.info(
            {
              reservationDbId,
              sessionId: activeSession.id,
              stationId: reservation.stationOcppId,
            },
            'Same-driver session active on reserved EVSE; transitioning reservation to in_use without ReserveNow',
          );
          notifyReservationChanged();
        }
        return;
      }
    }

    // No same-driver session: cancel up front with a reason that matches
    // the connector state. `station_faulted_at_activation` if every
    // connector is non-operational, otherwise `evse_in_use_at_activation`
    // (covers cable-plugged-in-idle and different-driver-charging cases).
    const allFaultedOrUnavailable = connectorRows.every(
      (c) => c.status === 'faulted' || c.status === 'unavailable',
    );
    const cancelReason = allFaultedOrUnavailable
      ? ('station_faulted_at_activation' as const)
      : ('evse_in_use_at_activation' as const);

    const cancelled = await db
      .update(reservations)
      .set({
        status: 'cancelled',
        cancelledBy: 'system',
        cancelReason,
        cancellationFeeCents: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(reservations.id, reservationDbId), eq(reservations.status, 'scheduled')))
      .returning({ driverId: reservations.driverId });

    if (cancelled.length > 0) {
      await writeReservationAudit({
        reservationId: reservationDbId,
        action: 'cancelled',
        actor: 'system',
        driverIdBefore: reservation.driverId,
        driverIdAfter: reservation.driverId,
        statusBefore: 'scheduled',
        statusAfter: 'cancelled',
        notes: cancelReason,
      });
      notifyReservationChanged();
    }

    log.warn(
      {
        reservationDbId,
        stationId: reservation.stationOcppId,
        cancelReason,
        connectorStatuses: connectorRows.map((c) => c.status),
      },
      'Reserved EVSE not available at activation, cancelling',
    );

    const driverId = cancelled[0]?.driverId ?? null;
    if (driverId != null) {
      await notifyDriverCancelled(
        driverId,
        reservation.reservationId,
        reservation.stationOcppId,
        reservationDbId,
        cancelReason,
        pubsub,
      );
    }
    return;
  }

  // Resolve EVSE OCPP integer ID if an EVSE is assigned
  let evseOcppId: number | undefined;
  if (reservation.evseDbId != null) {
    const [evse] = await db
      .select({ evseId: evses.evseId })
      .from(evses)
      .where(eq(evses.id, reservation.evseDbId));
    if (evse != null) {
      evseOcppId = evse.evseId;
    }
  }

  // Build and send ReserveNow command
  const commandId = crypto.randomUUID();
  const ocppPayload: Record<string, unknown> = {
    id: reservation.reservationId,
    expiryDateTime: reservation.expiresAt.toISOString(),
    idToken: {
      idToken: reservation.driverId ?? 'operator',
      type: 'Central',
    },
  };
  if (evseOcppId != null) {
    ocppPayload['evseId'] = evseOcppId;
  }

  // Do NOT include `version` here. CommandListener treats a present `version`
  // as "caller already shaped the payload for that wire protocol -- skip
  // translation". This payload is in OCPP 2.1 form (id/evseId/idToken object/
  // expiryDateTime); for an OCPP 1.6 station those fields must be translated
  // to reservationId/connectorId/idTag/expiryDate. Omitting `version` routes
  // through `sendVersionAwareCommand`, which looks up the station's actual
  // protocol from the open connection and applies the right mapper.
  const notification = JSON.stringify({
    commandId,
    stationId: reservation.stationOcppId,
    action: 'ReserveNow',
    payload: ocppPayload,
  });

  // Flip status BEFORE publish so retries can't double-send. The guarded
  // update only succeeds when the row is still 'scheduled'; on retry after a
  // partial failure we'll see status='active' and skip the publish entirely.
  // BullMQ jobId dedup already guards against duplicate enqueues, but worker
  // retries (attempts: 3 in reservation-worker) can re-run the handler.
  const updated = await db
    .update(reservations)
    .set({ status: 'active', updatedAt: new Date() })
    .where(and(eq(reservations.id, reservationDbId), eq(reservations.status, 'scheduled')))
    .returning({ id: reservations.id });

  if (updated.length === 0) {
    log.info(
      { reservationDbId },
      'Reservation already activated (or no longer scheduled); skipping ReserveNow publish',
    );
    return;
  }
  notifyReservationChanged();

  // Conditional UPDATE guarantees exactly one writer wins, so audit fires
  // exactly once per scheduled→active transition.
  await writeReservationAudit({
    reservationId: reservationDbId,
    action: 'updated',
    actor: 'system',
    driverIdBefore: reservation.driverId,
    driverIdAfter: reservation.driverId,
    statusBefore: 'scheduled',
    statusAfter: 'active',
    notes: 'scheduled activation',
  });

  await pubsub.publish('ocpp_commands', notification);

  log.info(
    {
      reservationDbId,
      stationId: reservation.stationOcppId,
      reservationId: reservation.reservationId,
    },
    'Scheduled reservation activated and ReserveNow sent',
  );
}
