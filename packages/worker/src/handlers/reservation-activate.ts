// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

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
  alertStationWatchersIfAvailable,
} from '@evtivity/database';
import type { OcppCommand, PubSubClient } from '@evtivity/lib';
import { createLogger, publishOcppCommand } from '@evtivity/lib';
import { refreshFleetReservationStatuses } from '@evtivity/services/fleet-reservation-status';
import { applyReservationCancellation } from '@evtivity/services/reservation-cancel';
import type { ReservationCancelReason } from '@evtivity/services/reservation-cancel';
import { notifyReservationDriver } from '@evtivity/services/reservation-notify';
import { reserveNowPayload } from '@evtivity/services/reservation.service';

const log = createLogger('reservation-activate');

interface ActivationRow {
  id: string;
  reservationId: number;
  status: string;
  startsAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
  driverId: string | null;
  tokenId: string | null;
  stationDbId: string;
  stationOcppId: string;
  siteId: string | null;
  isOnline: boolean;
  evseDbId: string | null;
}

/**
 * Cancels a scheduled reservation the station cannot take at activation
 * (offline, EVSE in use, faulted) as system through the shared cancel
 * (audit `station_rejected` with the reason, SSE, station-watch alert, no
 * fee), then tells the driver. A lost race (the row is no longer scheduled)
 * does nothing.
 */
async function cancelAtActivation(
  reservation: ActivationRow,
  reason: ReservationCancelReason,
  pubsub: PubSubClient,
): Promise<void> {
  const result = await applyReservationCancellation({
    reservationDbId: reservation.id,
    siteId: reservation.siteId,
    driverId: reservation.driverId,
    startsAt: reservation.startsAt ?? reservation.createdAt,
    createdAt: reservation.createdAt,
    actor: 'system',
    reason,
    auditAction: 'station_rejected',
    chargeFee: false,
    pubsub,
    logger: log,
  });
  if (!result.cancelled) return;
  await notifyReservationDriver(
    'reservation.Cancelled',
    {
      reservationDbId: reservation.id,
      reservationOcppId: reservation.reservationId,
      stationOcppId: reservation.stationOcppId,
      driverId: reservation.driverId,
      expiresAt: reservation.expiresAt,
    },
    { cancellationFeeFormatted: '' },
    { pubsub, logger: log },
  );
}

export async function handleReservationActivate(job: Job, pubsub: PubSubClient): Promise<void> {
  const { reservationDbId } = job.data as { reservationDbId: string };

  // Load reservation with station and EVSE info
  const [reservation] = await db
    .select({
      id: reservations.id,
      reservationId: reservations.reservationId,
      status: reservations.status,
      startsAt: reservations.startsAt,
      createdAt: reservations.createdAt,
      expiresAt: reservations.expiresAt,
      driverId: reservations.driverId,
      tokenId: reservations.tokenId,
      stationDbId: reservations.stationId,
      stationOcppId: chargingStations.stationId,
      siteId: chargingStations.siteId,
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
          stationId: reservation.stationDbId,
          siteId: reservation.siteId,
          sessionId: null,
        }),
      )
      .catch((err: unknown) => {
        // fail-open: the Reservations page refreshes on its next fetch (P9).
        log.warn({ err, reservationDbId }, 'reservation.changed publish failed');
      });
  };

  // Check if already expired
  if (reservation.expiresAt <= new Date()) {
    const expiredRows = await db
      .update(reservations)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(reservations.id, reservationDbId), eq(reservations.status, 'scheduled')))
      .returning({ id: reservations.id, fleetReservationId: reservations.fleetReservationId });
    if (expiredRows.length > 0) {
      await refreshFleetReservationStatuses(
        expiredRows.map((r) => r.fleetReservationId),
        log,
      );
      await writeReservationAudit({
        reservationId: reservationDbId,
        action: 'expired',
        actor: 'system',
        driverIdBefore: reservation.driverId,
        driverIdAfter: reservation.driverId,
        statusBefore: 'scheduled',
        statusAfter: 'expired',
        // Never on the station: not a no-show (RESERVATION_EXPIRY_REASONS).
        reason: 'not_on_station',
        notes: 'expired before scheduled activation',
      });
      notifyReservationChanged();
      // The lapsed reservation no longer holds the EVSE: alert watching drivers
      // when the station is now free by the shared rule. Fail-open.
      try {
        await alertStationWatchersIfAvailable(client, reservation.stationDbId);
      } catch (err) {
        log.warn({ err, reservationDbId }, 'Station-watch check after reservation expiry failed');
      }
    }
    log.info({ reservationDbId }, 'Scheduled reservation expired before activation');
    return;
  }

  // An offline station cannot take the hold: cancel so the driver knows,
  // instead of a scheduled reservation silently disappearing.
  if (!reservation.isOnline) {
    log.warn(
      { reservationDbId, stationId: reservation.stationOcppId },
      'Station offline, cancelling scheduled reservation',
    );
    await cancelAtActivation(reservation, 'station_offline_at_activation', pubsub);
    return;
  }

  // Re-validate connector state at activation time. The create-time guard
  // only fires when the start is within `reservation.activeSessionCheckHours`
  // of "now"; far-future reservations skip that check on the assumption the
  // EVSE will free up by activation. If the assumption breaks (in-flight
  // session ran long, driver showed up early and plugged in, station fault),
  // the worker must catch it here -- otherwise ReserveNow lands on a
  // busy/faulted connector, the station rejects, the projection cancels, and
  // the driver gets a "cancelled" notification at exactly the moment they
  // expected to charge.
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
          .returning({ id: reservations.id, fleetReservationId: reservations.fleetReservationId });
        if (flipped.length > 0) {
          await refreshFleetReservationStatuses(
            flipped.map((r) => r.fleetReservationId),
            log,
          );
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

    log.warn(
      {
        reservationDbId,
        stationId: reservation.stationOcppId,
        cancelReason,
        connectorStatuses: connectorRows.map((c) => c.status),
      },
      'Reserved EVSE not available at activation, cancelling',
    );
    await cancelAtActivation(reservation, cancelReason, pubsub);
    return;
  }

  // ReserveNow carries the bound token (E14), or the driver id as Central
  // for a driver without one. No `version`: the command listener translates
  // the 2.1 payload for an OCPP 1.6 station (reservationId, connectorId,
  // idTag, expiryDate).
  const command: OcppCommand = {
    stationId: reservation.stationOcppId,
    action: 'ReserveNow',
    payload: await reserveNowPayload({
      reservationId: reservation.reservationId,
      expiresAt: reservation.expiresAt,
      evseId: reservation.evseDbId,
      tokenId: reservation.tokenId,
      driverId: reservation.driverId,
    }),
  };

  // Flip status BEFORE publish so a concurrent run cannot double-send: the
  // guarded update succeeds only while the row is still 'scheduled'.
  const updated = await db
    .update(reservations)
    .set({ status: 'active', updatedAt: new Date() })
    .where(and(eq(reservations.id, reservationDbId), eq(reservations.status, 'scheduled')))
    .returning({ id: reservations.id, fleetReservationId: reservations.fleetReservationId });

  if (updated.length === 0) {
    log.info(
      { reservationDbId },
      'Reservation already activated (or no longer scheduled); skipping ReserveNow publish',
    );
    return;
  }
  await refreshFleetReservationStatuses(
    updated.map((r) => r.fleetReservationId),
    log,
  );

  // Conditional UPDATE guarantees exactly one writer wins, so audit fires
  // exactly once per scheduled->active transition.
  await writeReservationAudit({
    reservationId: reservationDbId,
    action: 'activated',
    actor: 'system',
    driverIdBefore: reservation.driverId,
    driverIdAfter: reservation.driverId,
    statusBefore: 'scheduled',
    statusAfter: 'active',
    notes: 'scheduled activation',
  });

  try {
    await publishOcppCommand(pubsub, command);
  } catch (err) {
    // Nothing reached the station (G5): put the row back to `scheduled` so
    // the BullMQ retry sends ReserveNow once. The guard leaves a row the
    // station already accepted, or one cancelled meanwhile, alone.
    const reverted = await db
      .update(reservations)
      .set({ status: 'scheduled', updatedAt: new Date() })
      .where(
        and(
          eq(reservations.id, reservationDbId),
          eq(reservations.status, 'active'),
          isNull(reservations.stationAckAt),
        ),
      )
      .returning({ id: reservations.id, fleetReservationId: reservations.fleetReservationId });
    if (reverted.length > 0) {
      await refreshFleetReservationStatuses(
        reverted.map((r) => r.fleetReservationId),
        log,
      );
      await writeReservationAudit(
        {
          reservationId: reservationDbId,
          action: 'updated',
          actor: 'system',
          driverIdBefore: reservation.driverId,
          driverIdAfter: reservation.driverId,
          statusBefore: 'active',
          statusAfter: 'scheduled',
          notes: 'activation reverted: ReserveNow publish failed',
        },
        undefined,
        log,
      );
    }
    log.warn(
      { err, reservationDbId, reverted: reverted.length > 0 },
      'ReserveNow publish failed; rethrown for the BullMQ retry',
    );
    throw err;
  }
  notifyReservationChanged();

  log.info(
    {
      reservationDbId,
      stationId: reservation.stationOcppId,
      reservationId: reservation.reservationId,
    },
    'Scheduled reservation activated and ReserveNow sent',
  );
}
