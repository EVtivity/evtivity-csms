// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PubSubClient } from '@evtivity/lib';

vi.mock('@evtivity/database', async (importOriginal) => ({
  getDefaultMaxPowerW: vi.fn(() => Promise.resolve(11000)),
  operatorStationSql: (await importOriginal<typeof import('@evtivity/database')>())
    .operatorStationSql,
}));

import {
  chargingNeedsProfileId,
  computeAndSendChargingProfile,
  renegotiateChargingNeedsProfile,
  evMaxPowerW,
  requestedEnergyWh,
  scheduleLimitW,
} from '../services/charging-profile-computer.js';

const sqlCalls: string[] = [];
const sqlValues: unknown[][] = [];
let sqlResults: unknown[][] = [];

function createSqlMock(...results: unknown[][]): unknown {
  sqlCalls.length = 0;
  sqlValues.length = 0;
  sqlResults = results;
  let index = 0;
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push(strings.join('?'));
    sqlValues.push(values);
    const result = sqlResults[index] ?? [];
    index++;
    return Promise.resolve(result);
  };
  return Object.assign(fn, {
    json: (v: unknown) => v,
    unsafe: (text: string) => ({ unsafe: text }),
  });
}

const NOW = new Date('2026-10-13T10:00:00.000Z');

function sentCommand(pubsub: PubSubClient): Record<string, unknown> {
  const call = vi.mocked(pubsub.publish).mock.calls.find((c) => c[0] === 'ocpp_commands');
  return JSON.parse(call?.[1] as string) as Record<string, unknown>;
}

describe('evMaxPowerW', () => {
  it('multiplies AC current and voltage, by three for three-phase', () => {
    const ac = { evMaxCurrent: 16, evMaxVoltage: 230, energyAmount: 1, evMinCurrent: 6 };
    expect(
      evMaxPowerW({ requestedEnergyTransfer: 'AC_single_phase', acChargingParameters: ac }, 0),
    ).toBe(3680);
    expect(
      evMaxPowerW({ requestedEnergyTransfer: 'AC_three_phase', acChargingParameters: ac }, 0),
    ).toBe(11040);
  });

  it('uses DC evMaxPower, else current times voltage', () => {
    expect(
      evMaxPowerW(
        {
          requestedEnergyTransfer: 'DC',
          dcChargingParameters: { evMaxCurrent: 200, evMaxVoltage: 400, evMaxPower: 50000 },
        },
        0,
      ),
    ).toBe(50000);
    expect(
      evMaxPowerW(
        {
          requestedEnergyTransfer: 'DC',
          dcChargingParameters: { evMaxCurrent: 100, evMaxVoltage: 400 },
        },
        0,
      ),
    ).toBe(40000);
  });

  it('uses the ISO 15118-20 maxChargePower for any transfer mode', () => {
    expect(
      evMaxPowerW(
        { requestedEnergyTransfer: 'AC_BPT', v2xChargingParameters: { maxChargePower: 6000 } },
        0,
      ),
    ).toBe(6000);
  });

  it('falls back to the configured default without EV parameters', () => {
    expect(evMaxPowerW({ requestedEnergyTransfer: 'AC_single_phase' }, 7400)).toBe(7400);
  });
});

describe('requestedEnergyWh', () => {
  it('reads energyAmount of the AC and DC parameters and the V2X target', () => {
    expect(requestedEnergyWh({ acChargingParameters: { energyAmount: 5000 } })).toBe(5000);
    expect(requestedEnergyWh({ dcChargingParameters: { energyAmount: 20000 } })).toBe(20000);
    expect(requestedEnergyWh({ v2xChargingParameters: { evTargetEnergyRequest: 8000 } })).toBe(
      8000,
    );
    expect(requestedEnergyWh({ energyAmount: 5000 })).toBeNull();
  });
});

describe('scheduleLimitW', () => {
  it('takes the lowest of EV, connector and site', () => {
    expect(
      scheduleLimitW({
        evMaxW: 22000,
        connectorMaxW: 11000,
        siteAvailableW: 7000,
        energyWh: null,
        departureTime: null,
        now: NOW,
      }),
    ).toBe(7000);
  });

  it('lowers the limit to the rate that delivers the energy by departure', () => {
    expect(
      scheduleLimitW({
        evMaxW: 22000,
        connectorMaxW: null,
        siteAvailableW: null,
        energyWh: 10000,
        departureTime: '2026-10-13T14:00:00.000Z',
        now: NOW,
      }),
    ).toBe(2500);
  });
});

describe('chargingNeedsProfileId', () => {
  it('is stable per transaction and in the upper int32 range', () => {
    const id = chargingNeedsProfileId('CS-1', 'tx-1');
    expect(chargingNeedsProfileId('CS-1', 'tx-1')).toBe(id);
    expect(chargingNeedsProfileId('CS-1', 'tx-2')).not.toBe(id);
    expect(id).toBeGreaterThanOrEqual(0x40000000);
    expect(id).toBeLessThanOrEqual(0x7fffffff);
  });
});

describe('computeAndSendChargingProfile', () => {
  let pubsub: PubSubClient;

  beforeEach(() => {
    pubsub = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('sends a TxProfile for the transaction with startSchedule and the departure rate', async () => {
    const sql = createSqlMock([{ max_power_kw: 22 }], []);
    await computeAndSendChargingProfile(
      sql as never,
      pubsub,
      {
        stationUuid: 'sta_1',
        stationOcppId: 'CS-1',
        evseId: 1,
        transactionId: 'tx-1',
        chargingNeeds: {
          requestedEnergyTransfer: 'AC_three_phase',
          departureTime: '2026-10-13T12:00:00.000Z',
          acChargingParameters: {
            energyAmount: 5000,
            evMinCurrent: 6,
            evMaxCurrent: 32,
            evMaxVoltage: 230,
          },
        },
        maxScheduleTuples: 3,
      },
      NOW,
    );

    const command = sentCommand(pubsub);
    expect(command.action).toBe('SetChargingProfile');
    const id = chargingNeedsProfileId('CS-1', 'tx-1');
    expect(command.payload).toEqual({
      evseId: 1,
      chargingProfile: {
        id,
        stackLevel: 1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        transactionId: 'tx-1',
        chargingSchedule: [
          {
            id,
            startSchedule: NOW.toISOString(),
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 2500 }],
          },
        ],
      },
    });
    // The CSMS schedule is not stored as an EV charging schedule, but kept on
    // the needs row to check the EV schedule against (K15.FR.11/12).
    expect(sqlCalls.some((q) => q.includes('ev_charging_schedules'))).toBe(false);
    const storeIndex = sqlCalls.findIndex((q) => q.includes('SET csms_charging_profile'));
    expect(sqlValues[storeIndex]?.[0]).toEqual({ payload: command.payload, renegotiations: 0 });
  });

  it('subtracts the latest draw of other sessions at the same site only', async () => {
    const sql = createSqlMock(
      [{ max_power_kw: 50 }],
      [{ max_power_kw: 20, site_id: 'sit_1' }],
      [{ current_draw: 15000 }],
    );
    await computeAndSendChargingProfile(
      sql as never,
      pubsub,
      {
        stationUuid: 'sta_1',
        stationOcppId: 'CS-1',
        evseId: 1,
        transactionId: 'tx-1',
        chargingNeeds: {
          requestedEnergyTransfer: 'DC',
          dcChargingParameters: { evMaxCurrent: 200, evMaxVoltage: 400 },
        },
      },
      NOW,
    );
    const profile = (sentCommand(pubsub).payload as Record<string, unknown>).chargingProfile as {
      chargingSchedule: Array<{ chargingSchedulePeriod: unknown[] }>;
    };
    expect(profile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 5000 },
    ]);
    const drawQuery = sqlCalls[2] ?? '';
    expect(drawQuery).toContain('st.site_id = ?');
    expect(drawQuery).toContain('DISTINCT ON (mv.session_id)');
    // Sessions at conformance test stations do not count against the site limit.
    expect(sqlValues[2]).toContainEqual({ unsafe: 'st.is_conformance = false' });
  });

  it('sends dynamic control needs one TxProfile schedule within maxScheduleTuples (K19.FR.07)', async () => {
    const sql = createSqlMock([], []);
    await computeAndSendChargingProfile(
      sql as never,
      pubsub,
      {
        stationUuid: 'sta_1',
        stationOcppId: 'CS-1',
        evseId: 1,
        transactionId: 'tx-1',
        chargingNeeds: {
          requestedEnergyTransfer: 'AC_BPT',
          controlMode: 'DynamicControl',
          v2xChargingParameters: { maxChargePower: 5000, maxDischargePower: 5000 },
        },
        maxScheduleTuples: 1,
      },
      NOW,
    );
    const payload = sentCommand(pubsub).payload as {
      evseId: number;
      chargingProfile: {
        chargingProfilePurpose: string;
        transactionId: string;
        chargingSchedule: Array<Record<string, unknown>>;
      };
    };
    expect(payload.evseId).toBe(1);
    expect(payload.chargingProfile.chargingProfilePurpose).toBe('TxProfile');
    expect(payload.chargingProfile.transactionId).toBe('tx-1');
    expect(payload.chargingProfile.chargingSchedule).toHaveLength(1);
    const schedule = payload.chargingProfile.chargingSchedule[0]!;
    expect(schedule['chargingSchedulePeriod']).toEqual([{ startPeriod: 0, limit: 5000 }]);
    // No price schedule, so no list can exceed maxScheduleTuples (K17.FR.19).
    expect(schedule['absolutePriceSchedule']).toBeUndefined();
    expect(schedule['priceLevelSchedule']).toBeUndefined();
  });

  it('uses the configured default power for an EV without parameters', async () => {
    const sql = createSqlMock([], []);
    await computeAndSendChargingProfile(
      sql as never,
      pubsub,
      {
        stationUuid: 'sta_1',
        stationOcppId: 'CS-1',
        evseId: 1,
        transactionId: 'tx-1',
        chargingNeeds: { requestedEnergyTransfer: 'AC_single_phase' },
      },
      NOW,
    );
    const profile = (sentCommand(pubsub).payload as Record<string, unknown>).chargingProfile as {
      chargingSchedule: Array<{ chargingSchedulePeriod: unknown[] }>;
    };
    expect(profile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 11000 },
    ]);
  });
});

describe('renegotiateChargingNeedsProfile', () => {
  const pubsub = (): PubSubClient => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const input = { stationUuid: 'sta_1', stationOcppId: 'CS-1', evseId: 1 };

  it('sends the stored profile again while renegotiations remain', async () => {
    const payload = { evseId: 1, chargingProfile: { id: 7, transactionId: 'tx-1' } };
    const sql = createSqlMock([{ csms_charging_profile: { payload, renegotiations: 1 } }]);
    const ps = pubsub();
    await expect(renegotiateChargingNeedsProfile(sql as never, ps, input)).resolves.toBe(true);
    expect(sentCommand(ps)).toMatchObject({ action: 'SetChargingProfile', payload });
    expect(sqlCalls[0]).toContain("'{renegotiations}'");
  });

  it('sends nothing when the limit is reached or no profile is stored', async () => {
    const sql = createSqlMock([]);
    const ps = pubsub();
    await expect(renegotiateChargingNeedsProfile(sql as never, ps, input)).resolves.toBe(false);
    expect(ps.publish).not.toHaveBeenCalled();
  });
});
