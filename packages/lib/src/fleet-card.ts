// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A fleet RFID card no member holds (`driver_tokens.fleet_id` set,
 * `driver_id` null): its sessions are billed on account to its fleet.
 */
export function isUnassignedFleetCard(card: {
  fleetId: string | null;
  driverId: string | null;
}): boolean {
  return card.fleetId != null && card.driverId == null;
}

/**
 * The one billability rule of a fleet card: every session of a card the fleet
 * owns is billed on account to that fleet, whoever holds it, so it may charge
 * only while Fleets is on and its fleet has account billing on. A member is
 * never charged for a fleet card. The local authorization lists, the
 * authorize pipeline and the payment gate decide with it. False for a card
 * without a fleet.
 */
export function isUnbillableFleetCard(
  card: { fleetId: string | null },
  fleet: { fleetEnabled: boolean; accountBillingEnabled: boolean | null },
): boolean {
  return card.fleetId != null && (!fleet.fleetEnabled || fleet.accountBillingEnabled !== true);
}

/** The reason stored on a fleet card a member held when it left or was deactivated. */
export const FLEET_CARD_RELEASE_REASON = 'Taken back when the member left the fleet';

/** The reason stored on a fleet card an operator deactivated for good. */
export const FLEET_CARD_DEACTIVATE_REASON = 'Deactivated by an operator';

/** The largest monthly spending limit of a fleet card, in cents (1,000,000.00). */
export const FLEET_CARD_MONTHLY_LIMIT_MAX_CENTS = 100_000_000;

/** The authorization reason of a card refused for its monthly spending limit. */
export const CARD_MONTHLY_LIMIT_REASON = 'card_monthly_limit';

/**
 * What a card with a monthly limit may still spend this month: the limit
 * minus the card's sessions of the month (ended at their final cost, running
 * at what they reserve), never below 0.
 */
export function cardMonthlyRemainingCents(limitCents: number, spentCents: number): number {
  return Math.max(limitCents - spentCents, 0);
}
