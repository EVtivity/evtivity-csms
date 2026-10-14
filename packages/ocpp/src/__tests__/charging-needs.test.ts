// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => Promise.resolve(true)),
  rows: [] as Array<{ transactionId: string }>,
}));

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'where', 'orderBy']) chain[m] = () => chain;
  chain['limit'] = () => Promise.resolve(mocks.rows);
  return {
    db: chain,
    chargingSessions: {},
    evses: {},
    evChargingNeeds: {},
    isIso15118Enabled: mocks.enabled,
  };
});

import {
  evScheduleWithinLimits,
  scheduledChargingTransaction,
} from '../services/charging-needs.js';
import type { ChargingNeedsProfilePayload } from '../services/charging-needs.js';

describe('scheduledChargingTransaction', () => {
  beforeEach(() => {
    mocks.enabled.mockResolvedValue(true);
    mocks.rows = [{ transactionId: 'tx-1' }];
  });

  it('returns the active transaction of the EVSE', async () => {
    await expect(
      scheduledChargingTransaction('sta_1', 1, { requestedEnergyTransfer: 'DC' }),
    ).resolves.toBe('tx-1');
  });

  it('returns null when the EVSE has no active transaction', async () => {
    mocks.rows = [];
    await expect(scheduledChargingTransaction('sta_1', 1, {})).resolves.toBeNull();
  });

  it('returns null when ISO 15118 smart charging is turned off', async () => {
    mocks.enabled.mockResolvedValue(false);
    await expect(scheduledChargingTransaction('sta_1', 1, {})).resolves.toBeNull();
  });

  it('returns null for dynamic control and for an unknown station', async () => {
    await expect(
      scheduledChargingTransaction('sta_1', 1, { controlMode: 'DynamicControl' }),
    ).resolves.toBeNull();
    await expect(scheduledChargingTransaction(null, 1, {})).resolves.toBeNull();
  });
});

describe('evScheduleWithinLimits', () => {
  const csms = (periods: Array<{ startPeriod: number; limit: number }>, unit = 'W') =>
    ({
      evseId: 1,
      chargingProfile: {
        id: 1,
        stackLevel: 1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        transactionId: 'tx-1',
        chargingSchedule: [
          {
            startSchedule: '2026-10-13T10:00:00.000Z',
            chargingRateUnit: unit,
            chargingSchedulePeriod: periods,
          },
        ],
      },
    }) as ChargingNeedsProfilePayload;
  const ev = (periods: Array<{ startPeriod: number; limit: number }>, unit = 'W') => ({
    chargingRateUnit: unit,
    chargingSchedulePeriod: periods,
  });
  const TB = '2026-10-13T10:00:00.000Z';

  it('accepts an EV schedule at or below the CSMS limit', () => {
    expect(
      evScheduleWithinLimits(
        TB,
        ev([{ startPeriod: 0, limit: 7000 }]),
        csms([{ startPeriod: 0, limit: 7400 }]),
      ),
    ).toBe(true);
    expect(
      evScheduleWithinLimits(
        TB,
        ev([{ startPeriod: 0, limit: 7400 }]),
        csms([{ startPeriod: 0, limit: 7400 }]),
      ),
    ).toBe(true);
  });

  it('rejects an EV schedule above the CSMS limit at any point', () => {
    expect(
      evScheduleWithinLimits(
        TB,
        ev([
          { startPeriod: 0, limit: 7000 },
          { startPeriod: 1800, limit: 11000 },
        ]),
        csms([{ startPeriod: 0, limit: 7400 }]),
      ),
    ).toBe(false);
  });

  it('compares at the CSMS period changes too, with the EV time base', () => {
    // The CSMS lowers the limit at 10:30; the EV keeps 7000 W from 10:15.
    const lowered = csms([
      { startPeriod: 0, limit: 11000 },
      { startPeriod: 1800, limit: 3000 },
    ]);
    expect(
      evScheduleWithinLimits(
        '2026-10-13T10:15:00.000Z',
        ev([{ startPeriod: 0, limit: 7000 }]),
        lowered,
      ),
    ).toBe(false);
    expect(
      evScheduleWithinLimits(
        '2026-10-13T10:15:00.000Z',
        ev([{ startPeriod: 0, limit: 3000 }]),
        lowered,
      ),
    ).toBe(true);
  });

  it('accepts a schedule in another rate unit, which the station already checked', () => {
    expect(
      evScheduleWithinLimits(
        TB,
        ev([{ startPeriod: 0, limit: 32 }], 'A'),
        csms([{ startPeriod: 0, limit: 10 }]),
      ),
    ).toBe(true);
  });
});
