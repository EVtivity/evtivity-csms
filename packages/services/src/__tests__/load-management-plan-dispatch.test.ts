// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PubSubClient, ServiceLogger } from '@evtivity/lib';

const dbMock = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    getSitePlan: vi.fn(),
    listPlanSessions: vi.fn(),
    isFleetChargingEnabled: vi.fn(),
    patchSitePlanEntries: vi.fn(async () => {
      calls.push('patch');
      return 1;
    }),
    select: vi.fn(),
    /** Results of the next db.select().from().where() reads, in order. */
    selectResults: [] as unknown[][],
  };
});

vi.mock('@evtivity/database', () => {
  const chain = (): unknown => {
    const c: Record<string, unknown> = {};
    c['from'] = () => c;
    c['where'] = () => Promise.resolve(dbMock.selectResults.shift() ?? []);
    return c;
  };
  dbMock.select.mockImplementation(() => chain());
  return {
    db: { select: dbMock.select },
    chargingStations: { id: {}, stationId: {} },
    evChargingNeeds: {},
    stationConfigurations: {},
    isOperatorStation: vi.fn(),
    getSitePlan: dbMock.getSitePlan,
    listPlanSessions: dbMock.listPlanSessions,
    isFleetChargingEnabled: dbMock.isFleetChargingEnabled,
    patchSitePlanEntries: dbMock.patchSitePlanEntries,
  };
});

import {
  PLAN_PROFILE_RETRY_MS,
  clearSitePlanProfiles,
  dispatchDepotPlanProfiles,
  measuredPhases,
  phasesOfEnergyTransfer,
  planProfileRate,
  planProfileSends,
  readPlanProfileInputs,
  storedSlots,
  withRejectedProfiles,
  type PlanProfileSendInput,
  type StoredPlanEntry,
} from '../charging-plan.service.js';
import type { HierarchyNode, StationPowerInfo } from '../load-management.service.js';
import type { PlanSessionRow } from '@evtivity/database';

const NOW = Date.UTC(2026, 10, 2, 1, 0, 0);
const MIN = 60_000;

const station: StationPowerInfo = {
  id: 'sta_a',
  stationId: 'DEPOT-01',
  circuitId: 'cir_a',
  currentDrawKw: 0,
  phasePowerKw: null,
  maxPowerKw: 50,
  loadPriority: 5,
  isOnline: true,
  hasActiveSession: true,
  departureTime: null,
  minPowerKw: 0,
  rateUnit: 'W',
  profileId: 1_000_000_000,
};

const session: PlanSessionRow = {
  id: 'ses_1',
  stationDbId: 'sta_a',
  evseDbId: 'evs_1',
  vehicleId: 'veh_1',
  transactionId: 'tx-1',
  energyDeliveredWh: 0,
  lastSocPercent: null,
  lastSocAt: null,
  evseMaxKw: 50,
  acCharging: false,
  evseNumber: 1,
};

const slotStarts = [NOW, NOW + 15 * MIN, NOW + 30 * MIN].map((ms) => new Date(ms).toISOString());

function entry(overrides: Partial<StoredPlanEntry> = {}): StoredPlanEntry {
  return {
    departureId: 'vdp_1',
    vehicleId: 'veh_1',
    sessionId: 'ses_1',
    stationDbId: 'sta_a',
    evseDbId: 'evs_1',
    minKw: 0,
    powerKw: [20, 20, 40],
    ...overrides,
  };
}

function input(overrides: Partial<PlanProfileSendInput> = {}): PlanProfileSendInput {
  return {
    entries: [entry()],
    sessions: [session],
    stations: [station],
    reservedKw: new Map(),
    rates: new Map([['sta_a', { rateUnit: 'W', voltageV: 230, phases: 3 }]]),
    stationMaxPeriods: new Map(),
    evseMaxTuples: new Map(),
    slots: storedSlots(slotStarts, 0),
    slotIndex: 0,
    nowMs: NOW,
    ...overrides,
  };
}

function makeLogger(): ServiceLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('planProfileSends', () => {
  it('sends the plan of a planned session that has none yet', () => {
    const [send] = planProfileSends(input());
    expect(send?.stationOcppId).toBe('DEPOT-01');
    expect(send?.payload.evseId).toBe(1);
    expect(send?.payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 20000 },
      { startPeriod: 1860, limit: 40000 },
    ]);
    expect(send?.profile).toMatchObject({ state: 'sent', slotStartMs: NOW });
  });

  it('sends nothing for an unchanged profile, or twice in one slot', () => {
    const [first] = planProfileSends(input());
    const later = NOW + 5 * MIN;
    expect(
      planProfileSends(input({ entries: [entry({ profile: first!.profile })], nowMs: later })),
    ).toEqual([]);
    // A changed plan in the same slot waits for the next slot.
    expect(
      planProfileSends(
        input({
          entries: [entry({ powerKw: [30, 30, 40], profile: first!.profile })],
          nowMs: later,
        }),
      ),
    ).toEqual([]);
  });

  it('sends again at the next slot boundary', () => {
    const [first] = planProfileSends(input());
    const sends = planProfileSends(
      input({
        entries: [entry({ profile: first!.profile })],
        slots: storedSlots(slotStarts, 1),
        slotIndex: 1,
        nowMs: NOW + 15 * MIN,
      }),
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.profile.slotStartMs).toBe(NOW + 15 * MIN);
  });

  it('retries a refused profile only after an hour', () => {
    const [first] = planProfileSends(input());
    const rejected = {
      ...first!.profile,
      state: 'rejected' as const,
      rejectedAt: new Date(NOW).toISOString(),
    };
    const at = (ms: number) =>
      planProfileSends(
        input({
          entries: [entry({ profile: rejected })],
          slots: storedSlots(slotStarts, 1),
          slotIndex: 1,
          nowMs: ms,
        }),
      );
    expect(at(NOW + 30 * MIN)).toEqual([]);
    expect(at(NOW + PLAN_PROFILE_RETRY_MS)).toHaveLength(1);
  });

  it('sends nothing to an offline or reserved station, or for an ended session', () => {
    expect(planProfileSends(input({ stations: [{ ...station, isOnline: false }] }))).toEqual([]);
    expect(planProfileSends(input({ reservedKw: new Map([['sta_a', 22]]) }))).toEqual([]);
    expect(planProfileSends(input({ sessions: [] }))).toEqual([]);
  });

  it('bounds the periods by the station and by the EV', () => {
    const many = entry({ powerKw: [10, 20, 30] });
    const [byStation] = planProfileSends(
      input({ entries: [many], stationMaxPeriods: new Map([['sta_a', 2]]) }),
    );
    expect(
      byStation?.payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod,
    ).toHaveLength(2);
    const [byEv] = planProfileSends(
      input({ entries: [many], evseMaxTuples: new Map([['sta_a:1', 1]]) }),
    );
    expect(byEv?.payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod).toHaveLength(
      1,
    );
  });

  it('sends a slot power under the session minimum as 0 or the minimum', () => {
    const [send] = planProfileSends(
      input({ entries: [entry({ minKw: 4.14, powerKw: [3, 1, 3] })] }),
    );
    expect(send?.payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 4140 },
      { startPeriod: 960, limit: 0 },
      { startPeriod: 1860, limit: 4140 },
    ]);
  });
});

describe('withRejectedProfiles', () => {
  it('marks the departure of a refused profile at risk', () => {
    const writes = withRejectedProfiles(
      [
        {
          departureId: 'vdp_1',
          readiness: 'on_track',
          readinessReason: null,
          plannedKwh: 10,
          deliveredKwh: 0,
          shortfallKwh: 0,
          predictedReadyAt: null,
        },
      ],
      [
        entry({
          profile: {
            id: 1,
            hash: 'h',
            slotStartMs: NOW,
            state: 'rejected',
            sentAt: new Date(NOW).toISOString(),
          },
        }),
      ],
    );
    expect(writes[0]).toMatchObject({ readiness: 'at_risk', readinessReason: 'profile_rejected' });
  });
});

describe('dispatchDepotPlanProfiles', () => {
  const hierarchy: HierarchyNode[] = [];
  let publish: ReturnType<typeof vi.fn>;
  let pubsub: PubSubClient;

  beforeEach(() => {
    dbMock.calls.length = 0;
    dbMock.isFleetChargingEnabled.mockResolvedValue(true);
    dbMock.getSitePlan.mockResolvedValue({
      computedAt: new Date(NOW),
      staleAt: null,
      trigger: 'slot_boundary',
      slotStarts,
      plan: [entry()],
    });
    dbMock.listPlanSessions.mockResolvedValue([session]);
    publish = vi.fn(async () => {
      dbMock.calls.push('publish');
    });
    pubsub = { publish, subscribe: vi.fn(), close: vi.fn() } as unknown as PubSubClient;
  });

  const ctx = () => ({
    siteId: 'sit_1',
    hierarchy,
    stations: [station],
    reservedKw: new Map<string, number>(),
    previous: null,
    log: makeLogger(),
    nowMs: NOW + MIN,
    pubsub,
  });

  it('stores the sent state before it publishes the profile', async () => {
    expect(await dispatchDepotPlanProfiles(ctx())).toBe(1);
    expect(dbMock.calls).toEqual(['patch', 'publish']);
    const [channel, message] = publish.mock.calls[0] as [string, string];
    expect(channel).toBe('ocpp_commands');
    expect(JSON.parse(message)).toMatchObject({
      stationId: 'DEPOT-01',
      action: 'SetChargingProfile',
      noQueue: true,
    });
  });

  it('puts the previous state back when the publish fails', async () => {
    publish.mockRejectedValueOnce(new Error('redis down'));
    const log = makeLogger();
    expect(await dispatchDepotPlanProfiles({ ...ctx(), log })).toBe(0);
    expect(dbMock.patchSitePlanEntries).toHaveBeenLastCalledWith('sit_1', [
      { sessionId: 'ses_1', patch: { profile: null } },
    ]);
    expect(log.warn).toHaveBeenCalled();
  });

  it('sends nothing while fleet charging is off', async () => {
    dbMock.isFleetChargingEnabled.mockResolvedValue(false);
    expect(await dispatchDepotPlanProfiles(ctx())).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('profile states after a reply', () => {
  const first = () => planProfileSends(input())[0]!.profile;

  it('sends a profile that got no answer again at the next slot, not in the same one', () => {
    const notSent = { ...first(), state: 'not_sent' as const };
    expect(planProfileSends(input({ entries: [entry({ profile: notSent })] }))).toEqual([]);
    const next = planProfileSends(
      input({
        entries: [entry({ profile: notSent })],
        slots: storedSlots(slotStarts, 1),
        slotIndex: 1,
        nowMs: NOW + 15 * MIN,
      }),
    );
    expect(next).toHaveLength(1);
  });

  it('sends a cleared profile again when the session is planned again', () => {
    const cleared = { ...first(), state: 'cleared' as const };
    expect(planProfileSends(input({ entries: [entry({ profile: cleared })] }))).toHaveLength(1);
  });

  it('retries a profile refused in W in A, and keeps the refused unit', () => {
    const rejected = {
      ...first(),
      state: 'rejected' as const,
      rejectedAt: new Date(NOW).toISOString(),
      rejectedUnits: ['W' as const],
    };
    const [send] = planProfileSends(
      input({
        entries: [entry({ profile: rejected })],
        nowMs: NOW + PLAN_PROFILE_RETRY_MS,
        slots: storedSlots(slotStarts, 0),
      }),
    );
    expect(send?.payload.chargingProfile.chargingSchedule[0]?.chargingRateUnit).toBe('A');
    expect(send?.profile.rejectedUnits).toEqual(['W']);
  });
});

describe('planProfileRate', () => {
  const rate = { rateUnit: 'A' as const, voltageV: 230, phases: 3 };

  it('uses the EV phases for an A limit and names them on the schedule', () => {
    expect(planProfileRate(rate, undefined, 1)).toEqual({
      rate: { ...rate, phases: 1 },
      numberPhases: 1,
    });
    expect(planProfileRate(rate, undefined, 3).numberPhases).toBeUndefined();
    expect(planProfileRate({ ...rate, rateUnit: 'W' }, undefined, 1).numberPhases).toBeUndefined();
  });

  it('falls back to the other unit only while that one was not refused too', () => {
    const w = { ...rate, rateUnit: 'W' as const };
    expect(planProfileRate(w, ['W'], undefined).rate?.rateUnit).toBe('A');
    expect(planProfileRate(w, ['W', 'A'], undefined).rate?.rateUnit).toBe('W');
    expect(planProfileRate(undefined, ['W'], undefined).rate).toBeUndefined();
  });

  it('sends a single-phase EV a phase current three times the three-phase one', () => {
    const one = planProfileSends(
      input({
        rates: new Map([['sta_a', rate]]),
        sessionPhases: new Map([['ses_1', 1]]),
      }),
    )[0]?.payload.chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod[0];
    const three = planProfileSends(input({ rates: new Map([['sta_a', rate]]) }))[0]?.payload
      .chargingProfile.chargingSchedule[0]?.chargingSchedulePeriod[0];
    expect(one).toEqual({ startPeriod: 0, limit: 86.9, numberPhases: 1 });
    expect(three).toEqual({ startPeriod: 0, limit: 28.9 });
  });
});

describe('phases of a session', () => {
  it('reads the phases an EV asks for', () => {
    expect(phasesOfEnergyTransfer('AC_single_phase')).toBe(1);
    expect(phasesOfEnergyTransfer('AC_two_phase')).toBe(2);
    expect(phasesOfEnergyTransfer('AC_three_phase')).toBe(3);
    expect(phasesOfEnergyTransfer('DC')).toBeUndefined();
    expect(phasesOfEnergyTransfer(null)).toBeUndefined();
  });

  it('counts the phases a station draws on', () => {
    expect(measuredPhases({ ...station, phasePowerKw: { L1: 7.2, L2: 0.05, L3: 0 } })).toBe(1);
    expect(measuredPhases({ ...station, phasePowerKw: { L1: 3.6, L2: 3.6, L3: 3.5 } })).toBe(3);
    expect(measuredPhases({ ...station, phasePowerKw: { L1: 0.3, L2: 0, L3: 0 } })).toBeUndefined();
    expect(measuredPhases(station)).toBeUndefined();
  });
});

describe('readPlanProfileInputs', () => {
  const started = new Date(NOW - 30 * MIN);

  it('uses only charging needs stored since the session started', async () => {
    dbMock.selectResults = [
      [{ stationId: 'sta_a', value: '12' }],
      [
        {
          stationId: 'sta_a',
          evseId: 1,
          maxScheduleTuples: 5,
          requestedEnergyTransfer: 'AC_single_phase',
          updatedAt: new Date(NOW - 60 * MIN),
        },
      ],
    ];
    const old = await readPlanProfileInputs([station], [{ ...session, startedAt: started }]);
    expect(old.stations.get('sta_a')).toBe(12);
    expect(old.evses.size).toBe(0);
    expect(old.phases.size).toBe(0);

    dbMock.selectResults = [
      [],
      [
        {
          stationId: 'sta_a',
          evseId: 1,
          maxScheduleTuples: 5,
          requestedEnergyTransfer: 'AC_single_phase',
          updatedAt: new Date(NOW - 10 * MIN),
        },
      ],
    ];
    const fresh = await readPlanProfileInputs([station], [{ ...session, startedAt: started }]);
    expect(fresh.evses.get('sta_a:1')).toBe(5);
    expect(fresh.phases.get('ses_1')).toBe(1);
  });

  it('falls back to the measured phases of a session alone on its station', async () => {
    dbMock.selectResults = [[], []];
    const inputs = await readPlanProfileInputs(
      [{ ...station, phasePowerKw: { L1: 7, L2: 0, L3: 0 } }],
      [session],
    );
    expect(inputs.phases.get('ses_1')).toBe(1);
  });
});

describe('dispatchDepotPlanProfiles: due checks and clears', () => {
  let publish: ReturnType<typeof vi.fn>;
  let pubsub: PubSubClient;
  const sentProfile = {
    id: 42,
    hash: 'h',
    slotStartMs: NOW,
    state: 'accepted' as const,
    sentAt: new Date(NOW).toISOString(),
  };

  beforeEach(() => {
    dbMock.calls.length = 0;
    dbMock.selectResults = [];
    dbMock.isFleetChargingEnabled.mockResolvedValue(true);
    dbMock.listPlanSessions.mockResolvedValue([session]);
    publish = vi.fn(async () => {
      dbMock.calls.push('publish');
    });
    pubsub = { publish, subscribe: vi.fn(), close: vi.fn() } as unknown as PubSubClient;
  });

  const ctx = () => ({
    siteId: 'sit_1',
    hierarchy: [] as HierarchyNode[],
    stations: [station],
    reservedKw: new Map<string, number>(),
    previous: null,
    log: makeLogger(),
    nowMs: NOW + MIN,
    pubsub,
  });
  const plan = (entries: unknown[]) => ({
    computedAt: new Date(NOW),
    staleAt: null,
    trigger: 'slot_boundary',
    slotStarts,
    plan: entries,
  });

  it('reads no period bounds when nothing is due this slot', async () => {
    dbMock.getSitePlan.mockResolvedValue(plan([entry({ profile: sentProfile })]));
    expect(await dispatchDepotPlanProfiles(ctx())).toBe(0);
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('clears the profile of a session that left the plan once, state first', async () => {
    dbMock.getSitePlan.mockResolvedValue(
      plan([entry({ profile: sentProfile, left: true }), entry({ sessionId: 'ses_2' })]),
    );
    await dispatchDepotPlanProfiles(ctx());
    expect(dbMock.calls.slice(0, 2)).toEqual(['patch', 'publish']);
    expect(dbMock.patchSitePlanEntries).toHaveBeenNthCalledWith(1, 'sit_1', [
      {
        sessionId: 'ses_1',
        patch: { profile: expect.objectContaining({ id: 42, state: 'cleared' }) },
      },
    ]);
    const [, message] = publish.mock.calls[0] as [string, string];
    expect(JSON.parse(message)).toMatchObject({
      stationId: 'DEPOT-01',
      action: 'ClearChargingProfile',
      payload: { chargingProfileId: 42 },
    });
  });

  it('marks the profile of an ended session cleared without a clear', async () => {
    dbMock.listPlanSessions.mockResolvedValue([]);
    dbMock.getSitePlan.mockResolvedValue(plan([entry({ profile: sentProfile, left: true })]));
    await dispatchDepotPlanProfiles(ctx());
    expect(dbMock.patchSitePlanEntries).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('puts the state back when the clear cannot be published', async () => {
    publish.mockRejectedValueOnce(new Error('redis down'));
    dbMock.getSitePlan.mockResolvedValue(plan([entry({ profile: sentProfile, left: true })]));
    await dispatchDepotPlanProfiles(ctx());
    expect(dbMock.patchSitePlanEntries).toHaveBeenLastCalledWith('sit_1', [
      { sessionId: 'ses_1', patch: { profile: sentProfile } },
    ]);
  });

  it('clears every live plan profile of a site whose load management was turned off', async () => {
    dbMock.getSitePlan.mockResolvedValue(plan([entry({ profile: sentProfile })]));
    dbMock.selectResults.push([{ id: 'sta_a', stationId: 'DEPOT-01' }]);
    expect(await clearSitePlanProfiles('sit_1', makeLogger(), { pubsub, nowMs: NOW })).toBe(1);
    expect(dbMock.calls).toEqual(['patch', 'publish']);
    const [, message] = publish.mock.calls[0] as [string, string];
    expect(JSON.parse(message)).toMatchObject({
      stationId: 'DEPOT-01',
      action: 'ClearChargingProfile',
      payload: { chargingProfileId: 42 },
    });
    // Nothing live, nothing read or sent.
    dbMock.getSitePlan.mockResolvedValue(plan([entry()]));
    expect(await clearSitePlanProfiles('sit_1', makeLogger(), { pubsub, nowMs: NOW })).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('clears every live plan profile while fleet charging is off', async () => {
    dbMock.isFleetChargingEnabled.mockResolvedValue(false);
    dbMock.getSitePlan.mockResolvedValue(plan([entry({ profile: sentProfile })]));
    expect(await dispatchDepotPlanProfiles(ctx())).toBe(0);
    const [, message] = publish.mock.calls[0] as [string, string];
    expect(JSON.parse(message)).toMatchObject({ action: 'ClearChargingProfile' });
  });
});
