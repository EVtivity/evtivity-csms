// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PubSubClient, ServiceLogger } from '@evtivity/lib';
import { dispatchDriverNotification } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { client, toDate } from '@evtivity/database';
import { ALL_TEMPLATES_DIRS } from './template-dirs.js';

/** The reservation a driver notice is about. */
export interface ReservationNoticeTarget {
  /** Internal reservation row id (`rsv_...`). */
  reservationDbId: string;
  /** The OCPP reservation id the station and the driver see. */
  reservationOcppId: number;
  /** The station's OCPP identity. */
  stationOcppId: string;
  driverId: string | null;
  expiresAt?: Date | string | null | undefined;
}

/** The driver notices of a reservation (`reservation.*` events). */
export type ReservationNoticeEvent =
  | 'reservation.Created'
  | 'reservation.Cancelled'
  | 'reservation.Expiring'
  | 'reservation.Expired'
  | 'reservation.StationFaulted'
  | 'reservation.TakenByOther';

/**
 * The one variable set of every reservation notice (G17): `reservationId` is
 * the OCPP reservation id everywhere (the number the station shows),
 * `stationId` the station's OCPP identity, `expiresAt` ISO 8601 when known.
 * `reservationDbId` lets the notification log find the reservation (the
 * Expiring warning dedups on it) and is not shown in any template.
 */
export function reservationNoticeVariables(
  target: ReservationNoticeTarget,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const expiresAt = target.expiresAt == null ? undefined : toDate(target.expiresAt).toISOString();
  return {
    reservationId: target.reservationOcppId,
    reservationDbId: target.reservationDbId,
    stationId: target.stationOcppId,
    ...(expiresAt != null ? { expiresAt } : {}),
    ...extra,
  };
}

export interface ReservationNoticeOptions {
  pubsub?: PubSubClient | undefined;
  templatesDirs?: string[] | undefined;
  logger?: ServiceLogger | undefined;
}

/**
 * Sends a reservation notice to its driver. Fail-open (P9): the reservation
 * change is already stored, so a failed notice is logged and dropped.
 */
export async function notifyReservationDriver(
  eventType: ReservationNoticeEvent,
  target: ReservationNoticeTarget,
  extra: Record<string, unknown> = {},
  options: ReservationNoticeOptions = {},
): Promise<void> {
  if (target.driverId == null) return;
  try {
    await dispatchDriverNotification(
      client,
      eventType,
      target.driverId,
      reservationNoticeVariables(target, extra),
      options.templatesDirs ?? ALL_TEMPLATES_DIRS,
      options.pubsub ?? getPubSub(),
    );
  } catch (err) {
    options.logger?.warn(
      { err, eventType, reservationId: target.reservationDbId, driverId: target.driverId },
      'Reservation driver notice failed',
    );
  }
}

/**
 * The flags the `reservation.Cancelled` templates show for the two system
 * cancel reasons a driver needs explained: the station went offline or
 * faulted during the hold (`stationUnavailable`), or never answered the
 * reservation (`stationNoResponse`). Both carry no fee.
 */
export function cancelReasonNoticeFlags(reason: string): Record<string, boolean> {
  if (reason === 'station_unavailable_during_hold') return { stationUnavailable: true };
  if (reason === 'station_no_response') return { stationNoResponse: true };
  return {};
}
