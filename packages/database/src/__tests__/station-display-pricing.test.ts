// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const mocks = vi.hoisted(() => ({ kinds: vi.fn(), tariff: vi.fn() }));

vi.mock('../lib/charging-kind.js', () => ({ loadStationEvseKinds: mocks.kinds }));
vi.mock('../lib/tariff-resolution.js', () => ({ resolveStationTariff: mocks.tariff }));

import { resolveStationDisplayPricing } from '../lib/station-display-pricing.js';

const sql = {} as postgres.Sql;

function tariff(id: string, pricePerKwh: string): Record<string, unknown> {
  return {
    id,
    pricePerKwh,
    pricePerMinute: null,
    pricePerSession: null,
    idleFeePricePerMinute: null,
    taxRate: '0',
  };
}

let byKind: Record<string, Record<string, unknown> | null> = {};

beforeEach(() => {
  byKind = {};
  mocks.tariff.mockImplementation((q: { chargingKind: string | null }) =>
    Promise.resolve(byKind[q.chargingKind ?? 'both'] ?? null),
  );
});

describe('resolveStationDisplayPricing', () => {
  it('shows the only kind of a DC-only station', async () => {
    mocks.kinds.mockResolvedValue(new Map([['e1', 'dc']]));
    byKind['dc'] = tariff('t_dc', '0.55');
    byKind['both'] = tariff('t_both', '0.30');
    const out = await resolveStationDisplayPricing(sql, 'sta');
    expect(out).toEqual({ tariff: byKind['dc'], byKind: null });
  });

  it('shows one price when AC and DC agree', async () => {
    mocks.kinds.mockResolvedValue(
      new Map([
        ['e1', 'ac'],
        ['e2', 'dc'],
      ]),
    );
    byKind['ac'] = tariff('t_ac', '0.40');
    byKind['dc'] = tariff('t_dc', '0.40');
    const out = await resolveStationDisplayPricing(sql, 'sta');
    expect(out).toEqual({ tariff: byKind['ac'], byKind: null });
  });

  it('shows AC and DC side by side when they differ, also for a mixed EVSE', async () => {
    mocks.kinds.mockResolvedValue(new Map([['e1', 'mixed']]));
    byKind['ac'] = tariff('t_ac', '0.30');
    byKind['dc'] = tariff('t_dc', '0.55');
    const out = await resolveStationDisplayPricing(sql, 'sta', 'drv');
    expect(out).toEqual({ tariff: byKind['ac'], byKind: { ac: byKind['ac'], dc: byKind['dc'] } });
    expect(mocks.tariff).toHaveBeenCalledWith(
      { stationUuid: 'sta', driverUuid: 'drv', chargingKind: 'dc' },
      sql,
    );
  });

  it('shows the Both tariff for a station without typed connectors', async () => {
    mocks.kinds.mockResolvedValue(new Map([['e1', null]]));
    byKind['both'] = tariff('t_both', '0.30');
    const out = await resolveStationDisplayPricing(sql, 'sta');
    expect(out).toEqual({ tariff: byKind['both'], byKind: null });
  });
});
