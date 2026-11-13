// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The stored plan as the profile dispatch reads it: invalid entries and
// profile states are dropped, the preconditioning load and flags reach the
// TxProfile of an OCPP 2.1 station, the station and EV period bounds apply,
// and a failed restore after a failed send or clear is logged.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PubSubClient, ServiceLogger } from '@evtivity/lib';
import type { PlanSessionRow } from '@evtivity/database';
import type { StationPowerInfo } from '../load-management.service.js';

const dbMock = vi.hoisted(() => ({
  getSitePlan: vi.fn(),
  listPlanSessions: vi.fn(),
  isFleetChargingEnabled: vi.fn(),
  patchSitePlanEntries: vi.fn(),
  /** Results of the next db.select().from().where() reads, in order. */
  selectResults: [] as unknown[][],
}));

vi.mock('@evtivity/database', () => {
  const chain = (): unknown => {
    const c: Record<string, unknown> = {};
    c['from'] = () => c;
    c['where'] = () => Promise.resolve(dbMock.selectResults.shift() ?? []);
    return c;
  };
  return {
    db: { select: () => chain() },
    chargingStations: { id: {}, stationId: {}, ocppProtocol: {} },
    evChargingNeeds: {},
    stationConfigurations: {},
    isOperatorStation: vi.fn(),
    getSitePlan: dbMock.getSitePlan,
    listPlanSessions: dbMock.listPlanSessions,
    isFleetChargingEnabled: dbMock.isFleetChargingEnabled,
    patchSitePlanEntries: dbMock.patchSitePlanEntries,
  };
});

const { clearSitePlanProfiles, dispatchDepotPlanProfiles } =
  await import('../charging-plan.service.js');

const NOW = Date.UTC(2026, 10, 2, 1, 0, 0);
const MIN = 60_000;
const slotStarts = [NOW, NOW + 15 * MIN, NOW + 30 * MIN].map((ms) => new Date(ms).toISOString());

const station: StationPowerInfo = {
  id: 'sta_a',
  stationId: 'DEPOT-01',
  circuitId: 'cir_a',
  currentDrawKw: 0,
  phasePowerKw: null,
  maxPowerKw: 100,
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
  evseMaxKw: 100,
  acCharging: false,
  evseNumber: 1,
};

const liveProfile = {
  id: 42,
  hash: 'h',
  slotStartMs: NOW,
  state: 'accepted',
  sentAt: new Date(NOW).toISOString(),
};

function plan(entries: unknown) {
  return {
    computedAt: new Date(NOW),
    staleAt: null,
    trigger: 'slot_boundary',
    slotStarts,
    plan: entries,
  };
}

function makeLogger(): ServiceLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let publish: ReturnType<typeof vi.fn>;
let pubsub: PubSubClient;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.selectResults = [];
  dbMock.isFleetChargingEnabled.mockResolvedValue(true);
  dbMock.listPlanSessions.mockResolvedValue([session]);
  dbMock.patchSitePlanEntries.mockResolvedValue(1);
  publish = vi.fn(() => Promise.resolve());
  pubsub = { publish, subscribe: vi.fn(), close: vi.fn() } as unknown as PubSubClient;
});

function published(): Array<{ action: string; payload: Record<string, unknown> }> {
  return publish.mock.calls.map(
    (c) => JSON.parse(c[1] as string) as { action: string; payload: Record<string, unknown> },
  );
}

describe('stored plan entries read by the clear', () => {
  it('drops entries that are not plan entries and profiles that are not profile states', async () => {
    dbMock.getSitePlan.mockResolvedValue(
      plan([
        null,
        'junk',
        { departureId: 'd', sessionId: 's', stationDbId: 'x' },
        {
          departureId: 'dep_bad',
          sessionId: 'ses_bad',
          stationDbId: 'sta_a',
          powerKw: [1],
          profile: { ...liveProfile, state: 'unknown' },
        },
        {
          departureId: 'dep_str',
          sessionId: 'ses_str',
          stationDbId: 'sta_a',
          powerKw: [1],
          profile: 'accepted',
        },
        {
          departureId: 'dep_1',
          sessionId: 'ses_1',
          stationDbId: 'sta_a',
          powerKw: [1],
          profile: {
            ...liveProfile,
            state: 'rejected',
            repliedAt: 'r',
            rejectedAt: 'j',
            clearedAt: 'old',
            rejectedUnits: ['A', 'X', 'W'],
          },
        },
      ]),
    );
    dbMock.selectResults.push([{ id: 'sta_a', stationId: 'DEPOT-01' }]);
    const cleared = await clearSitePlanProfiles('sit_1', makeLogger(), { pubsub, nowMs: NOW });
    expect(cleared).toBe(1);
    expect(dbMock.patchSitePlanEntries).toHaveBeenCalledWith('sit_1', [
      {
        sessionId: 'ses_1',
        patch: {
          profile: {
            id: 42,
            hash: 'h',
            slotStartMs: NOW,
            state: 'cleared',
            sentAt: liveProfile.sentAt,
            repliedAt: 'r',
            rejectedAt: 'j',
            rejectedUnits: ['A', 'W'],
            clearedAt: new Date(NOW).toISOString(),
          },
        },
      },
    ]);
  });

  it('reads a plan that is not a list as no entries', async () => {
    dbMock.getSitePlan.mockResolvedValue(plan({ not: 'a list' }));
    expect(await clearSitePlanProfiles('sit_1', makeLogger(), { pubsub, nowMs: NOW })).toBe(0);
    expect(dbMock.patchSitePlanEntries).not.toHaveBeenCalled();
  });

  it('logs when the state cannot be put back after a failed clear', async () => {
    dbMock.getSitePlan.mockResolvedValue(
      plan([
        {
          departureId: 'd',
          sessionId: 'ses_1',
          stationDbId: 'sta_a',
          powerKw: [1],
          profile: liveProfile,
        },
      ]),
    );
    dbMock.selectResults.push([{ id: 'sta_a', stationId: 'DEPOT-01' }]);
    publish.mockRejectedValueOnce(new Error('redis down'));
    dbMock.patchSitePlanEntries
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('db down'));
    const log = makeLogger();
    expect(await clearSitePlanProfiles('sit_1', log, { pubsub, nowMs: NOW })).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1' }),
      'Plan profile state not restored after a failed clear',
    );
  });
});

describe('dispatchDepotPlanProfiles with the stored plan', () => {
  const ctx = (log: ServiceLogger = makeLogger()) => ({
    siteId: 'sit_1',
    hierarchy: [],
    stations: [station],
    reservedKw: new Map<string, number>(),
    previous: null,
    log,
    nowMs: NOW + MIN,
    pubsub,
  });

  it('sends nothing without a stored plan or a current slot', async () => {
    dbMock.getSitePlan.mockResolvedValueOnce(null);
    expect(await dispatchDepotPlanProfiles(ctx())).toBe(0);
    dbMock.getSitePlan.mockResolvedValueOnce({ ...plan([]), slotStarts: [] });
    expect(await dispatchDepotPlanProfiles(ctx())).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('adds the preconditioning load and flags for a 2.1 station, within the period bounds', async () => {
    dbMock.getSitePlan.mockResolvedValue(
      plan([
        {
          departureId: 'dep_1',
          sessionId: 'ses_1',
          stationDbId: 'sta_a',
          evseDbId: 'evs_1',
          minKw: Number.NaN,
          powerKw: [20, 'x', 40],
          auxKw: [2, -1, 'y'],
          preconditioning: [true, 'yes', true],
        },
      ]),
    );
    // Period bounds, charging needs, then the station protocols.
    dbMock.selectResults.push(
      [
        { stationId: 'sta_a', value: '2' },
        { stationId: 'sta_a', value: 'none' },
        { stationId: 'sta_a', value: '5' },
      ],
      [
        {
          stationId: 'sta_a',
          evseId: 1,
          maxScheduleTuples: 0,
          requestedEnergyTransfer: null,
          updatedAt: new Date(NOW),
        },
        {
          stationId: 'sta_a',
          evseId: 9,
          maxScheduleTuples: 3,
          requestedEnergyTransfer: null,
          updatedAt: new Date(NOW),
        },
      ],
      [{ id: 'sta_a', protocol: 'ocpp2.1' }],
    );
    expect(await dispatchDepotPlanProfiles(ctx())).toBe(1);
    const [msg] = published();
    expect(msg?.action).toBe('SetChargingProfile');
    const profile = msg?.payload['chargingProfile'] as {
      chargingSchedule: Array<{ chargingSchedulePeriod: unknown[] }>;
    };
    // 20 + 2 kW with preconditioning, then 0 kW (a bad power, a negative aux), cut to 2 periods.
    expect(profile.chargingSchedule[0]?.chargingSchedulePeriod).toEqual([
      { startPeriod: 0, limit: 22000, preconditioningRequest: true },
      { startPeriod: 960, limit: 0, preconditioningRequest: false },
    ]);
  });

  it('sends an unchanged plan only once across a slot boundary', async () => {
    const stored = {
      departureId: 'dep_1',
      sessionId: 'ses_1',
      stationDbId: 'sta_a',
      powerKw: [20, 20, 20],
    };
    dbMock.getSitePlan.mockResolvedValue(plan([stored]));
    expect(await dispatchDepotPlanProfiles(ctx())).toBe(1);
    const [, patches] = dbMock.patchSitePlanEntries.mock.calls[0] as [
      string,
      Array<{ patch: { profile: Record<string, unknown> } }>,
    ];
    const sentProfile = { ...patches[0]!.patch.profile, state: 'accepted' };
    dbMock.patchSitePlanEntries.mockClear();
    publish.mockClear();
    // The next slot: the profile may be sent again, but the plan from here is the same.
    dbMock.getSitePlan.mockResolvedValue(plan([{ ...stored, profile: sentProfile }]));
    expect(await dispatchDepotPlanProfiles({ ...ctx(), nowMs: NOW + 16 * MIN })).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(dbMock.patchSitePlanEntries).not.toHaveBeenCalled();
  });

  it('sends in the other unit when the last allocation of the station was refused in W', async () => {
    const circuitTree = {
      type: 'circuit' as const,
      id: 'cir_a',
      name: 'c',
      maxContinuousKw: 100,
      safetyMarginKw: 0,
      unmanagedLoadKw: 0,
      currentDrawKw: 0,
      stations: [station],
      children: [],
      phases: 3,
      breakerRatingAmps: 100,
      voltageV: 230,
      oversubscriptionRatio: 1,
      phaseConnections: null,
      phaseLoad: null,
      perPhaseCapacityKw: null,
    };
    dbMock.getSitePlan.mockResolvedValue(
      plan([{ departureId: 'dep_1', sessionId: 'ses_1', stationDbId: 'sta_a', powerKw: [11] }]),
    );
    const sent = await dispatchDepotPlanProfiles({
      ...ctx(),
      hierarchy: [circuitTree],
      previous: [
        { stationId: 'DEPOT-01', stationDbId: 'sta_a', allocatedKw: 11, rejectedUnits: ['W'] },
        { stationId: 'OTHER', stationDbId: 'sta_x', allocatedKw: 5 },
      ],
    });
    expect(sent).toBe(1);
    const profile = published()[0]?.payload['chargingProfile'] as {
      chargingSchedule: Array<{ chargingRateUnit: string }>;
    };
    expect(profile.chargingSchedule[0]?.chargingRateUnit).toBe('A');
  });

  it('logs when the state cannot be put back after a failed send', async () => {
    dbMock.getSitePlan.mockResolvedValue(
      plan([{ departureId: 'dep_1', sessionId: 'ses_1', stationDbId: 'sta_a', powerKw: [20] }]),
    );
    publish.mockRejectedValueOnce(new Error('redis down'));
    dbMock.patchSitePlanEntries
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('db down'));
    const log = makeLogger();
    expect(await dispatchDepotPlanProfiles(ctx(log))).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1' }),
      'Plan profile state not restored after a failed send',
    );
  });
});
