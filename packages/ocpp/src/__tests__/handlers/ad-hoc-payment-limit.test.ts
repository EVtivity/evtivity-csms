// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: Record<string, unknown>[] = [];
const whereFn = vi.fn(() => Promise.resolve(rows));
const fromFn = vi.fn(() => ({ where: whereFn }));
const selectFn = vi.fn(() => ({ from: fromFn }));

vi.mock('@evtivity/database', () => ({
  db: { select: selectFn },
  guestSessions: {
    sessionToken: 'session_token',
    stationOcppId: 'station_ocpp_id',
    status: 'status',
    maxCostCents: 'max_cost_cents',
    maxEnergyWh: 'max_energy_wh',
    maxTimeSeconds: 'max_time_seconds',
  },
}));

const inArrayFn = vi.fn((col: unknown, values: unknown) => ({ type: 'inArray', col, values }));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  inArray: inArrayFn,
}));

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
});

describe('findAdHocTransactionLimit', () => {
  it('returns null when the idToken is not an open ad hoc payment at the station', async () => {
    const { findAdHocTransactionLimit } = await import('../../handlers/ad-hoc-payment-limit.js');
    expect(await findAdHocTransactionLimit('CS-1', 'PSP-1')).toBeNull();
    expect(inArrayFn).toHaveBeenCalledWith('status', ['payment_authorized', 'charging']);
  });

  it('maps the stored limits to transactionLimit (maxCost in major units)', async () => {
    rows = [{ maxCostCents: 1815, maxEnergyWh: 20000, maxTimeSeconds: 3600 }];
    const { findAdHocTransactionLimit } = await import('../../handlers/ad-hoc-payment-limit.js');
    expect(await findAdHocTransactionLimit('CS-1', 'PSP-1')).toEqual({
      maxCost: 18.15,
      maxEnergy: 20000,
      maxTime: 3600,
    });
  });

  it('returns only the limits that are set', async () => {
    rows = [{ maxCostCents: null, maxEnergyWh: 20000, maxTimeSeconds: null }];
    const { findAdHocTransactionLimit } = await import('../../handlers/ad-hoc-payment-limit.js');
    expect(await findAdHocTransactionLimit('CS-1', 'PSP-1')).toEqual({ maxEnergy: 20000 });
  });

  it('returns null when the payment has no limit', async () => {
    rows = [{ maxCostCents: null, maxEnergyWh: null, maxTimeSeconds: null }];
    const { findAdHocTransactionLimit } = await import('../../handlers/ad-hoc-payment-limit.js');
    expect(await findAdHocTransactionLimit('CS-1', 'PSP-1')).toBeNull();
  });
});
