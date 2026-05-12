// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Job } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import {
  client,
  db,
  reservations,
  chargingStations,
  evses,
  writeReservationAudit,
} from '@evtivity/database';
import type { PubSubClient } from '@evtivity/lib';
import { createLogger, dispatchDriverNotification } from '@evtivity/lib';

const log = createLogger('reservation-activate');

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
      ocppProtocol: chargingStations.ocppProtocol,
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
    }

    const driverId = cancelled[0]?.driverId ?? null;
    if (driverId != null) {
      try {
        await dispatchDriverNotification(
          client,
          'reservation.Cancelled',
          driverId,
          {
            reservationId: reservation.reservationId,
            stationId: reservation.stationOcppId,
            cancellationFeeFormatted: '',
          },
          ALL_TEMPLATES_DIRS,
          pubsub,
        );
      } catch (err) {
        log.warn(
          { err, driverId, reservationDbId },
          'Failed to dispatch offline-station cancel notification',
        );
      }
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
