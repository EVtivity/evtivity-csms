// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PubSubClient } from '@evtivity/lib';

const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];
let sqlResults: Array<unknown[]> = [];
let sqlCallIndex = 0;

function createSqlMock() {
  sqlCalls.length = 0;
  sqlResults = [];
  sqlCallIndex = 0;

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    sqlCalls.push({ strings: [...strings], values });
    const idx = sqlCallIndex;
    sqlCallIndex++;
    const result = sqlResults[idx] ?? [];
    return Promise.resolve(Object.assign([...result], { count: result.length || 1 }));
  };

  return sqlFn as unknown;
}

vi.mock('postgres', () => {
  const factory = () => createSqlMock();
  return { default: factory };
});

describe('computeAndSendChargingProfile', () => {
  let mockPubSub: PubSubClient;
  let computeAndSendChargingProfile: typeof import('../services/charging-profile-computer.js').computeAndSendChargingProfile;

  beforeEach(async () => {
    sqlCalls.length = 0;
    sqlResults = [];
    sqlCallIndex = 0;
    vi.clearAllMocks();

    mockPubSub = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const mod = await import('../services/charging-profile-computer.js');
    computeAndSendChargingProfile = mod.computeAndSendChargingProfile;
  });

  function setupSqlResults(...results: unknown[][]) {
    sqlResults = results;
    sqlCallIndex = 0;
    sqlCalls.length = 0;
  }

  it('computes AC single-phase profile', async () => {
    const sql = createSqlMock();
    setupSqlResults(
      [{ max_power_kw: 22 }], // connector query
      [], // site power limit (no rows)
      [], // INSERT ev_charging_schedules
    );
    await computeAndSendChargingProfile(sql as never, mockPubSub, {
      stationUuid: 'sta_test',
      stationOcppId: 'CS-TEST',
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_single_phase',
        acChargingParameters: { evMaxCurrent: 32, evMaxVoltage: 230 },
      },
      maxScheduleTuples: 10,
    });

    expect(mockPubSub.publish).toHaveBeenCalledWith(
      'ocpp_commands',
      expect.stringContaining('SetChargingProfile'),
    );
  });

  it('computes AC three-phase profile', async () => {
    const sql = createSqlMock();
    setupSqlResults(
      [{ max_power_kw: 22 }], // connector
      [], // site power limit
      [], // INSERT schedule
    );
    await computeAndSendChargingProfile(sql as never, mockPubSub, {
      stationUuid: 'sta_test',
      stationOcppId: 'CS-TEST',
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_three_phase',
        acChargingParameters: { evMaxCurrent: 32, evMaxVoltage: 230 },
      },
    });

    expect(mockPubSub.publish).toHaveBeenCalled();
  });

  it('computes DC profile', async () => {
    const sql = createSqlMock();
    setupSqlResults(
      [{ max_power_kw: 150 }], // connector
      [], // site power limit
      [], // INSERT schedule
    );
    await computeAndSendChargingProfile(sql as never, mockPubSub, {
      stationUuid: 'sta_test',
      stationOcppId: 'CS-TEST',
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'DC',
        dcChargingParameters: { evMaxCurrent: 300, evMaxVoltage: 500 },
      },
    });

    expect(mockPubSub.publish).toHaveBeenCalled();
  });

  it('caps at connector max power', async () => {
    // Connector limited to 7 kW, EV wants 22 kW
    const sql = createSqlMock();
    setupSqlResults(
      [{ max_power_kw: 7 }], // connector
      [], // no site power limit
      [], // INSERT schedule
    );
    await computeAndSendChargingProfile(sql as never, mockPubSub, {
      stationUuid: 'sta_test',
      stationOcppId: 'CS-TEST',
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_single_phase',
        acChargingParameters: { evMaxCurrent: 100, evMaxVoltage: 230 },
      },
    });

    const publishCall = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(publishCall[1] as string);
    const periods = payload.payload.chargingProfile.chargingSchedule[0].chargingSchedulePeriod;
    // Should be capped at 7000 W
    expect(periods[0].limit).toBe(7000);
  });

  it('caps at site available power', async () => {
    const sql = createSqlMock();
    setupSqlResults(
      [{ max_power_kw: 100 }], // connector
      [{ max_power_kw: 50 }], // site power limit = 50 kW
      [{ current_draw: 40000 }], // other stations drawing 40 kW
      [], // INSERT schedule
    );
    await computeAndSendChargingProfile(sql as never, mockPubSub, {
      stationUuid: 'sta_test',
      stationOcppId: 'CS-TEST',
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_single_phase',
        acChargingParameters: { evMaxCurrent: 100, evMaxVoltage: 230 },
      },
    });

    const publishCall = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(publishCall[1] as string);
    const periods = payload.payload.chargingProfile.chargingSchedule[0].chargingSchedulePeriod;
    // Site max 50 kW, 40 kW in use -> 10 kW available
    expect(periods[0].limit).toBe(10000);
  });

  it('uses EV max when no site power limits configured', async () => {
    const sql = createSqlMock();
    setupSqlResults(
      [], // no connector rows
      [], // no site power limit
      [], // INSERT schedule
    );
    await computeAndSendChargingProfile(sql as never, mockPubSub, {
      stationUuid: 'sta_test',
      stationOcppId: 'CS-TEST',
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_single_phase',
        acChargingParameters: { evMaxCurrent: 16, evMaxVoltage: 230 },
      },
    });

    const publishCall = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(publishCall[1] as string);
    const periods = payload.payload.chargingProfile.chargingSchedule[0].chargingSchedulePeriod;
    // 16A * 230V = 3680 W
    expect(periods[0].limit).toBe(3680);
  });

  it('computes departure time schedule', async () => {
    const sql = createSqlMock();
    setupSqlResults(
      [{ max_power_kw: 100 }], // connector
      [], // no site power limit
      [], // INSERT schedule
    );

    // Departure in 2 hours, need 10000 Wh -> 5000 W required
    const departureTime = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    await computeAndSendChargingProfile(sql as never, mockPubSub, {
      stationUuid: 'sta_test',
      stationOcppId: 'CS-TEST',
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_single_phase',
        acChargingParameters: { evMaxCurrent: 32, evMaxVoltage: 230 },
        departureTime,
        energyAmount: 10000,
      },
    });

    const publishCall = (mockPubSub.publish as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(publishCall[1] as string);
    const periods = payload.payload.chargingProfile.chargingSchedule[0].chargingSchedulePeriod;
    // Should be around 5000 W (10000 Wh / 2 hours * 1000)
    expect(periods[0].limit).toBeGreaterThan(4000);
    expect(periods[0].limit).toBeLessThan(6000);
  });
});
