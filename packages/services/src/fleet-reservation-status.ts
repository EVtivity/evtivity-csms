// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { and, eq, notInArray } from 'drizzle-orm';
import { db, fleetReservations, reservations } from '@evtivity/database';
import type { ServiceLogger } from '@evtivity/lib';

/**
 * The status of a fleet booking (`fleet_reservations.status`), derived from
 * its slot reservations. This module is the only writer of the column after
 * the insert (P3); the CHECK `fleet_reservations_status_check` holds the set.
 */
export const FLEET_RESERVATION_STATUSES = [
  'scheduled',
  'active',
  'partial',
  'completed',
  'expired',
  'cancelled',
] as const;
export type FleetReservationStatus = (typeof FLEET_RESERVATION_STATUSES)[number];

/** Sticky (P5): once stored, no later slot change moves the booking away from these. */
export const FLEET_RESERVATION_TERMINAL_STATUSES = ['completed', 'expired', 'cancelled'] as const;

const LIVE_SLOT = new Set(['scheduled', 'active', 'in_use']);
const LOST_SLOT = new Set(['cancelled', 'expired']);

export function isTerminalFleetReservationStatus(status: string): boolean {
  return (FLEET_RESERVATION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The status a new booking is inserted with, before its slots exist. */
export function initialFleetReservationStatus(
  startsAt: Date | null,
  now: Date = new Date(),
): FleetReservationStatus {
  return startsAt != null && startsAt.getTime() > now.getTime() ? 'scheduled' : 'active';
}

/**
 * The booking status from its slots' statuses:
 * - a slot still live (`scheduled`, `active`, `in_use`): `partial` when
 *   another slot was lost (`cancelled`, `expired`), else `active` when one is
 *   on its station (`active`, `in_use`), else `scheduled`;
 * - every slot ended: `completed` when one was used, else `expired` when one
 *   expired, else `cancelled` (also a booking without any slot).
 */
export function deriveFleetReservationStatus(
  slotStatuses: readonly string[],
): FleetReservationStatus {
  const live = slotStatuses.filter((s) => LIVE_SLOT.has(s));
  if (live.length > 0) {
    if (slotStatuses.some((s) => LOST_SLOT.has(s))) return 'partial';
    if (live.some((s) => s !== 'scheduled')) return 'active';
    return 'scheduled';
  }
  if (slotStatuses.includes('used')) return 'completed';
  if (slotStatuses.includes('expired')) return 'expired';
  return 'cancelled';
}

/**
 * Writes the booking's derived status and returns the stored status (null when
 * the booking does not exist). The booking row is locked first, so concurrent
 * slot changes write one after the other and the last one reads every
 * committed slot. A terminal status is never changed. Throws on a database
 * error: the routes call it directly; slot writers use
 * `refreshFleetReservationStatuses`.
 */
export async function syncFleetReservationStatus(
  fleetReservationId: string,
): Promise<FleetReservationStatus | null> {
  return db.transaction(async (tx) => {
    const [booking] = await tx
      .select({ status: fleetReservations.status })
      .from(fleetReservations)
      .where(eq(fleetReservations.id, fleetReservationId))
      .for('update');
    if (booking == null) return null;
    if (isTerminalFleetReservationStatus(booking.status)) {
      return booking.status as FleetReservationStatus;
    }
    const slots = await tx
      .select({ status: reservations.status })
      .from(reservations)
      .where(eq(reservations.fleetReservationId, fleetReservationId));
    const next = deriveFleetReservationStatus(slots.map((s) => s.status));
    if (next !== booking.status) {
      await tx
        .update(fleetReservations)
        .set({ status: next, updatedAt: new Date() })
        .where(
          and(
            eq(fleetReservations.id, fleetReservationId),
            notInArray(fleetReservations.status, [...FLEET_RESERVATION_TERMINAL_STATUSES]),
          ),
        );
    }
    return next;
  });
}

/**
 * Called by every writer of a slot's status (create, activation, cancel,
 * expiry, session link and end) with the slots' fleet booking ids; ids that
 * are null (not a fleet slot) are skipped. Fail-open (P9): the booking status
 * is display only, and the slot change it follows is already stored.
 */
export async function refreshFleetReservationStatuses(
  fleetReservationIds: Iterable<string | null | undefined>,
  logger?: ServiceLogger,
): Promise<void> {
  const ids = new Set<string>();
  for (const id of fleetReservationIds) if (id != null) ids.add(id);
  for (const id of ids) {
    try {
      await syncFleetReservationStatus(id);
    } catch (err) {
      logger?.warn({ err, fleetReservationId: id }, 'Fleet reservation status refresh failed');
    }
  }
}
