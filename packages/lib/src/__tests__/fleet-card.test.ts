// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  cardMonthlyRemainingCents,
  isUnassignedFleetCard,
  isUnbillableFleetCard,
} from '../fleet-card.js';

describe('cardMonthlyRemainingCents', () => {
  it('is the limit minus the spend of the month, never below 0', () => {
    expect(cardMonthlyRemainingCents(10_000, 0)).toBe(10_000);
    expect(cardMonthlyRemainingCents(10_000, 2_500)).toBe(7_500);
    expect(cardMonthlyRemainingCents(10_000, 10_000)).toBe(0);
    expect(cardMonthlyRemainingCents(10_000, 12_000)).toBe(0);
  });
});

const ON = { fleetEnabled: true, accountBillingEnabled: true };

describe('isUnassignedFleetCard', () => {
  it('is a card of a fleet that no member holds', () => {
    expect(isUnassignedFleetCard({ fleetId: 'flt_1', driverId: null })).toBe(true);
    expect(isUnassignedFleetCard({ fleetId: 'flt_1', driverId: 'drv_1' })).toBe(false);
    expect(isUnassignedFleetCard({ fleetId: null, driverId: 'drv_1' })).toBe(false);
    expect(isUnassignedFleetCard({ fleetId: null, driverId: null })).toBe(false);
  });
});

describe('isUnbillableFleetCard', () => {
  it('bills an unassigned card only while Fleets and the fleet account billing are on', () => {
    const card = { fleetId: 'flt_1', driverId: null };
    expect(isUnbillableFleetCard(card, ON)).toBe(false);
    expect(isUnbillableFleetCard(card, { ...ON, fleetEnabled: false })).toBe(true);
    expect(isUnbillableFleetCard(card, { ...ON, accountBillingEnabled: false })).toBe(true);
    // A missing fleet row (left join) cannot bill.
    expect(isUnbillableFleetCard(card, { ...ON, accountBillingEnabled: null })).toBe(true);
  });

  it('decides by the fleet alone, whoever holds the card, and never refuses a driver card', () => {
    const off = { fleetEnabled: false, accountBillingEnabled: false };
    const memberCard = { fleetId: 'flt_1', driverId: 'drv_1' };
    expect(isUnbillableFleetCard(memberCard, off)).toBe(true);
    expect(isUnbillableFleetCard(memberCard, ON)).toBe(false);
    const driverCard = { fleetId: null, driverId: 'drv_1' };
    expect(isUnbillableFleetCard(driverCard, off)).toBe(false);
  });
});
