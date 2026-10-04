// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { chargedCostBreakdown } from '@evtivity/lib';

const priceSessionAtMock = vi.fn();
vi.mock('@evtivity/database', () => ({
  priceSessionAt: priceSessionAtMock,
}));

const { transactionCostAt, isUnbilledTimeoutEnd } = await import('../server/session-cost.js');

/** A tagged-template sql mock answering by the first matching query fragment. */
function makeSql(answers: Array<[string, Record<string, unknown>[]]>): postgres.Sql {
  const fn = (strings: TemplateStringsArray): Promise<Record<string, unknown>[]> => {
    const text = strings.join('?');
    const match = answers.find(([fragment]) => text.includes(fragment));
    return Promise.resolve(match?.[1] ?? []);
  };
  return fn as unknown as postgres.Sql;
}

const baseSession = {
  id: 'ses_1',
  tariff_id: 'trf_1',
  final_cost_cents: null,
};

beforeEach(() => {
  priceSessionAtMock.mockReset();
  priceSessionAtMock.mockResolvedValue(chargedCostBreakdown(250, 0, 'net'));
});

describe('transactionCostAt', () => {
  const params = {
    stationId: 'CS-1',
    transactionId: 'tx-1',
    at: new Date('2026-06-04T01:00:00Z'),
    meterRegisterWh: 15000,
  };

  it('prices the session with the one cost assembly at the event time', async () => {
    const sql = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'active', energy_delivered_wh: null, meter_start: null }],
      ],
    ]);
    await expect(transactionCostAt(sql, { ...params, meterRegisterWh: null })).resolves.toEqual({
      totalCostCents: 250,
      calculated: true,
    });
    expect(priceSessionAtMock).toHaveBeenCalledWith(sql, 'ses_1', params.at, 0);
  });

  it('returns null for an unknown session', async () => {
    await expect(transactionCostAt(makeSql([]), params)).resolves.toBeNull();
    expect(priceSessionAtMock).not.toHaveBeenCalled();
  });

  it('uses the Ended register reading when it is higher than the stored energy', async () => {
    const sql = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'active', energy_delivered_wh: '1000', meter_start: 10000 }],
      ],
    ]);
    await transactionCostAt(sql, params);
    expect(priceSessionAtMock).toHaveBeenCalledWith(sql, 'ses_1', params.at, 5000);
  });

  it('keeps the stored energy when the register reading is missing or below meter_start', async () => {
    const sql = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'active', energy_delivered_wh: '1000', meter_start: 10000 }],
      ],
    ]);
    await transactionCostAt(sql, { ...params, meterRegisterWh: null });
    expect(priceSessionAtMock).toHaveBeenLastCalledWith(sql, 'ses_1', params.at, 1000);
    await transactionCostAt(sql, { ...params, meterRegisterWh: 9000 });
    expect(priceSessionAtMock).toHaveBeenLastCalledWith(sql, 'ses_1', params.at, 1000);
  });

  it('reports a session without a tariff as free', async () => {
    const sql = makeSql([
      ['FROM charging_sessions s', [{ ...baseSession, status: 'active', tariff_id: null }]],
    ]);
    await expect(transactionCostAt(sql, params)).resolves.toEqual({
      totalCostCents: 0,
      calculated: false,
    });
    expect(priceSessionAtMock).not.toHaveBeenCalled();
  });

  it('reports a session the assembly cannot price as free', async () => {
    priceSessionAtMock.mockResolvedValue(null);
    const sql = makeSql([
      ['FROM charging_sessions s', [{ ...baseSession, status: 'active', meter_start: null }]],
    ]);
    await expect(transactionCostAt(sql, params)).resolves.toEqual({
      totalCostCents: 0,
      calculated: false,
    });
  });

  it('reports the stored cost of a faulted session without recomputing it', async () => {
    const sql = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'faulted', final_cost_cents: 0, meter_start: 10000 }],
      ],
    ]);
    await expect(transactionCostAt(sql, params)).resolves.toEqual({
      totalCostCents: 0,
      calculated: false,
    });
    const failed = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'failed', final_cost_cents: null, meter_start: 10000 }],
      ],
    ]);
    await expect(transactionCostAt(failed, params)).resolves.toEqual({
      totalCostCents: 0,
      calculated: false,
    });
    expect(priceSessionAtMock).not.toHaveBeenCalled();
  });

  it('costs 0 for an EVConnectTimeout end without energy (C20.FR.03)', async () => {
    const sql = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'active', energy_delivered_wh: null, meter_start: 10000 }],
      ],
    ]);
    await expect(
      transactionCostAt(sql, {
        ...params,
        meterRegisterWh: 10000,
        end: { triggerReason: 'EVConnectTimeout', stoppedReason: 'Timeout' },
      }),
    ).resolves.toEqual({ totalCostCents: 0, calculated: false });
    expect(priceSessionAtMock).not.toHaveBeenCalled();
  });

  it('prices a timeout end that delivered energy, and other ends', async () => {
    const sql = makeSql([
      [
        'FROM charging_sessions s',
        [{ ...baseSession, status: 'active', energy_delivered_wh: null, meter_start: 10000 }],
      ],
    ]);
    await expect(
      transactionCostAt(sql, {
        ...params,
        end: { triggerReason: 'EVConnectTimeout', stoppedReason: 'Timeout' },
      }),
    ).resolves.toEqual({ totalCostCents: 250, calculated: true });
    await expect(
      transactionCostAt(sql, {
        ...params,
        meterRegisterWh: 10000,
        end: { triggerReason: 'EVDeparted', stoppedReason: 'EVDisconnected' },
      }),
    ).resolves.toEqual({ totalCostCents: 250, calculated: true });
  });
});

describe('isUnbilledTimeoutEnd', () => {
  it('matches a timeout trigger or stop reason without energy only', () => {
    expect(
      isUnbilledTimeoutEnd({
        triggerReason: 'EVConnectTimeout',
        stoppedReason: undefined,
        energyWh: 0,
      }),
    ).toBe(true);
    expect(
      isUnbilledTimeoutEnd({
        triggerReason: 'StopAuthorized',
        stoppedReason: 'Timeout',
        energyWh: 0,
      }),
    ).toBe(true);
    expect(
      isUnbilledTimeoutEnd({
        triggerReason: 'EVConnectTimeout',
        stoppedReason: 'Timeout',
        energyWh: 1,
      }),
    ).toBe(false);
    expect(
      isUnbilledTimeoutEnd({ triggerReason: 'Local', stoppedReason: 'Local', energyWh: 0 }),
    ).toBe(false);
    expect(isUnbilledTimeoutEnd({ triggerReason: null, stoppedReason: null, energyWh: 0 })).toBe(
      false,
    );
  });
});
