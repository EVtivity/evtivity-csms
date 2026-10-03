// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  calculateSessionCost,
  calculateSplitSessionCost,
  toSessionCostBreakdown,
} from '@evtivity/lib';
import type { TariffInput } from '@evtivity/lib';
import { chargedCostBreakdown, taxTotals } from '@evtivity/lib/price-display';
import { idleMinutesAt, ocpiCdrCost, ocpiSessionCost } from '../services/session-cost-split.js';

type SessionCostSource = Parameters<typeof ocpiCdrCost>[0];

const tariff: TariffInput = {
  pricePerKwh: '0.30',
  pricePerMinute: null,
  pricePerSession: '1.00',
  idleFeePricePerMinute: null,
  reservationFeePerMinute: null,
  taxRate: '0.19',
};

// 10 kWh x 0.30 + 1.00 session fee = 400 net, 19% = 76, charged 476.
const stored = toSessionCostBreakdown(calculateSessionCost(tariff, 10_000, 60));

const session: SessionCostSource = {
  id: 'ses_1',
  status: 'completed',
  currentCostCents: 476,
  finalCostCents: 476,
  tariffTaxRate: '0.19',
  idleStartedAt: null,
  idleMinutes: '0',
  // Stored breakdowns are read back from jsonb.
  costBreakdown: JSON.parse(JSON.stringify(stored)) as unknown,
};

describe('ocpiCdrCost', () => {
  it('reads the stored breakdown: total and per-dimension costs per rate', () => {
    const cost = ocpiCdrCost(session);
    expect(cost.total).toEqual([{ taxRate: 0.19, netCents: 400, taxCents: 76 }]);
    // Line tax 76 spread by net: 300 -> 57, 100 -> 19.
    expect(cost.energy).toEqual([{ taxRate: 0.19, netCents: 300, taxCents: 57 }]);
    expect(cost.fixed).toEqual([{ taxRate: 0.19, netCents: 100, taxCents: 19 }]);
    expect(cost.time).toBeUndefined();
    expect(cost.parking).toBeUndefined();
    expect(cost.reservation).toBeUndefined();
  });

  it('splits a split-billed session per rate, with each dimension adding up to the total', () => {
    const breakdown = toSessionCostBreakdown(
      calculateSplitSessionCost(
        [
          {
            tariff,
            durationMinutes: 30,
            energyDeliveredWh: 5000,
            idleMinutes: 0,
            isFirstSegment: true,
          },
          {
            tariff: { ...tariff, taxRate: '0.07' },
            durationMinutes: 30,
            energyDeliveredWh: 5000,
            idleMinutes: 0,
            isFirstSegment: false,
          },
        ],
        0,
        10,
      ),
    );
    const cost = ocpiCdrCost({
      ...session,
      finalCostCents: breakdown.grossCents,
      costBreakdown: breakdown,
    });
    expect(taxTotals(cost.total).grossCents).toBe(breakdown.grossCents);
    expect(cost.total.map((l) => l.taxRate)).toEqual([0.07, 0.19]);
    const dimensionGross = [cost.energy, cost.fixed, cost.reservation].reduce(
      (sum, lines) => sum + taxTotals(lines ?? []).grossCents,
      0,
    );
    expect(dimensionGross).toBe(breakdown.grossCents);
  });

  it('keeps the gross of each dimension on the gross basis', () => {
    const gross: TariffInput = { ...tariff, pricePerKwh: '0.357', pricePerSession: '1.19' };
    const breakdown = toSessionCostBreakdown(
      calculateSessionCost(gross, 10_000, 60, 0, 0, 0, 'gross'),
    );
    const cost = ocpiCdrCost({
      ...session,
      finalCostCents: breakdown.grossCents,
      costBreakdown: breakdown,
    });
    // 357 + 119 = 476 gross: 400 net and 76 tax, spread by gross amount.
    expect(cost.energy).toEqual([{ taxRate: 0.19, netCents: 300, taxCents: 57 }]);
    expect(cost.fixed).toEqual([{ taxRate: 0.19, netCents: 100, taxCents: 19 }]);
  });

  it('reports only the total when the breakdown has no components (backfilled sessions)', () => {
    const cost = ocpiCdrCost({
      ...session,
      costBreakdown: chargedCostBreakdown(476, 0.19, 'net'),
    });
    expect(cost).toEqual({ total: [{ taxRate: 0.19, netCents: 400, taxCents: 76 }] });
  });

  it('splits the final cost at the snapshot rate when no breakdown is stored for it', () => {
    expect(ocpiCdrCost({ ...session, finalCostCents: 1190, costBreakdown: stored })).toEqual({
      total: [{ taxRate: 0.19, netCents: 1000, taxCents: 190 }],
    });
    expect(ocpiCdrCost({ ...session, costBreakdown: null, tariffTaxRate: null })).toEqual({
      total: [{ taxRate: 0, netCents: 476, taxCents: 0 }],
    });
    expect(ocpiCdrCost({ ...session, finalCostCents: null, costBreakdown: null })).toEqual({
      total: [],
    });
  });
});

describe('ocpiSessionCost', () => {
  it('reports the final cost of a completed session from its breakdown', () => {
    expect(ocpiSessionCost(session)).toEqual([{ taxRate: 0.19, netCents: 400, taxCents: 76 }]);
  });

  it('reports the running cost of an active session and null before it has one', () => {
    const running = chargedCostBreakdown(238, 0.19, 'net');
    expect(
      ocpiSessionCost({
        ...session,
        status: 'active',
        currentCostCents: 238,
        finalCostCents: null,
        costBreakdown: running,
      }),
    ).toEqual(running.taxLines);
    expect(
      ocpiSessionCost({
        ...session,
        status: 'active',
        currentCostCents: null,
        finalCostCents: null,
      }),
    ).toBeNull();
  });
});

describe('idleMinutesAt', () => {
  it('adds an open idle period to the accumulated minutes', () => {
    expect(
      idleMinutesAt(
        { ...session, idleMinutes: '2.5', idleStartedAt: new Date('2026-09-01T10:00:00Z') },
        new Date('2026-09-01T10:10:00Z'),
      ),
    ).toBe(12.5);
    expect(idleMinutesAt(session, new Date())).toBe(0);
  });
});
