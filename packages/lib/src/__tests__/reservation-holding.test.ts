// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { reservationHoldingMinutes } from '../reservation-holding.js';

describe('reservationHoldingMinutes', () => {
  it('counts from the start to the expiry, whole minutes rounded up', () => {
    expect(
      reservationHoldingMinutes({
        startsAt: '2026-10-09T10:00:00Z',
        createdAt: '2026-10-09T08:00:00Z',
        expiresAt: '2026-10-09T10:30:01Z',
      }),
    ).toBe(31);
  });

  it('counts an instant reservation from its creation', () => {
    expect(
      reservationHoldingMinutes({
        startsAt: null,
        createdAt: new Date('2026-10-09T08:00:00Z'),
        expiresAt: new Date('2026-10-09T08:30:00Z'),
      }),
    ).toBe(30);
  });

  it('is 0 for an expiry before the start or an invalid date', () => {
    expect(
      reservationHoldingMinutes({
        startsAt: '2026-10-09T10:00:00Z',
        createdAt: '2026-10-09T08:00:00Z',
        expiresAt: '2026-10-09T09:00:00Z',
      }),
    ).toBe(0);
    expect(
      reservationHoldingMinutes({ startsAt: 'x', createdAt: 'y', expiresAt: '2026-10-09' }),
    ).toBe(0);
  });
});
