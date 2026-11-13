// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Edge cases of the load management service: EVSE ratings, local generation
// entries that do not count, priority stops, fixed loads on a panel, planned
// stations that share, the profile clear when reads or publishes fail, stored
// allocations and the plan clear after load management is turned off.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceLogger } from '@evtivity/lib';
import type { FakeDb } from './helpers/fake-db.js';
import type { HierarchyNode, StationPowerInfo } from '../load-management.service.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  published: [] as { channel: string; message: Record<string, unknown> }[],
  publishFails: false,
  clearSitePlanProfiles: vi.fn(),
}));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, { isOperatorStation: () => 'OPERATOR_STATION' });
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({
    publish: (channel: string, message: string) => {
      if (h.publishFails) return Promise.reject(new Error('redis down'));
      h.published.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
      return Promise.resolve();
    },
    subscribe: vi.fn(),
  }),
}));

vi.mock('../charging-plan.service.js', () => ({
  clearSitePlanProfiles: h.clearSitePlanProfiles,
}));

const svc = await import('../load-management.service.js');

type LogFn = (obj: unknown, msg?: string, ...args: unknown[]) => void;

function makeLogger(): ServiceLogger & {
  warn: ReturnType<typeof vi.fn<LogFn>>;
  error: ReturnType<typeof vi.fn<LogFn>>;
} {
  return { info: vi.fn(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>(), debug: vi.fn() };
}

function station(overrides: Partial<StationPowerInfo> & { id: string }): StationPowerInfo {
  return {
    stationId: overrides.id.toUpperCase(),
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
    ...overrides,
  };
}

const nodeBase = {
  unmanagedLoadKw: 0,
  currentDrawKw: 0,
  phases: 1,
  breakerRatingAmps: 100,
  voltageV: 240,
  oversubscriptionRatio: 1,
  phaseConnections: null,
  phaseLoad: null,
  perPhaseCapacityKw: null,
  safetyMarginKw: 0,
  children: [],
};

function tree(stations: StationPowerInfo[], circuitKw: number): HierarchyNode[] {
  const circuit: HierarchyNode = {
    ...nodeBase,
    type: 'circuit',
    id: 'cir_a',
    name: 'A',
    maxContinuousKw: circuitKw,
    stations,
  };
  return [
    {
      ...nodeBase,
      type: 'panel',
      id: 'pnl_1',
      name: 'Main',
      maxContinuousKw: 1000,
      stations: [],
      children: [circuit],
    },
  ];
}

function byId(results: { stationDbId: string; allocatedKw: number }[]): Map<string, number> {
  return new Map(results.map((r) => [r.stationDbId, r.allocatedKw]));
}

beforeEach(() => {
  h.fake.reset();
  h.published.length = 0;
  h.publishFails = false;
  h.clearSitePlanProfiles.mockReset();
});

describe('stationMaxPowerKw', () => {
  it('keeps the highest known rating per EVSE and sums the EVSEs', () => {
    const out = svc.stationMaxPowerKw([
      { stationId: 's1', evseDbId: 'e1', maxPowerKw: '11' },
      { stationId: 's1', evseDbId: 'e1', maxPowerKw: '22' },
      { stationId: 's1', evseDbId: 'e1', maxPowerKw: '7' },
      { stationId: 's1', evseDbId: 'e2', maxPowerKw: null },
      { stationId: 's1', evseDbId: 'e2', maxPowerKw: '7.4' },
      { stationId: 's2', evseDbId: 'e3', maxPowerKw: '0' },
    ]);
    expect(out.get('s1')).toBeCloseTo(29.4, 9);
    // An EVSE of unknown rating makes the station maximum unknown (0).
    expect(out.get('s2')).toBe(0);
  });
});

describe('localGenerationKw entries that do not count', () => {
  const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
  const rate = { voltageV: 230, phases: 3 };
  const schedule = {
    chargingRateUnit: 'W',
    chargingSchedulePeriod: [{ startPeriod: 0, limit: 3000 }],
  };
  const entry = (extra: Record<string, unknown>) => ({
    chargingProfilePurpose: 'LocalGeneration',
    chargingSchedule: [schedule],
    ...extra,
  });

  it('skips an entry outside validFrom and validTo and other purposes', () => {
    const later = entry({ validFrom: new Date(NOW + 60_000).toISOString() });
    const ended = entry({ validTo: new Date(NOW).toISOString() });
    const other = { ...entry({}), chargingProfilePurpose: 'TxProfile' };
    expect(svc.localGenerationKw([later, ended, other], null, NOW, rate)).toBe(0);
  });

  it('reads one entry given without a list, starting at the stored time', () => {
    expect(svc.localGenerationKw(entry({}), NOW - 60_000, NOW, rate)).toBe(3);
    // Stored in the future: not active yet.
    expect(svc.localGenerationKw(entry({}), NOW + 60_000, NOW, rate)).toBe(0);
  });

  it('answers unknown for an entry without a schedule or with a unit it cannot read', () => {
    expect(svc.localGenerationKw([entry({ chargingSchedule: [] })], null, NOW, rate)).toBeNull();
    const amps = { ...schedule, chargingRateUnit: 'A' };
    expect(
      svc.localGenerationKw([entry({ chargingSchedule: [amps] })], null, NOW, {
        voltageV: 0,
        phases: 1,
      }),
    ).toBeNull();
    const unitless = { ...schedule, chargingRateUnit: 'kVA' };
    expect(
      svc.localGenerationKw([entry({ chargingSchedule: [unitless] })], null, NOW, rate),
    ).toBeNull();
  });

  it('counts nothing before its first period starts', () => {
    const late = {
      chargingRateUnit: 'W',
      chargingSchedulePeriod: [{ startPeriod: 600, limit: 3000 }],
    };
    expect(
      svc.localGenerationKw([entry({ chargingSchedule: [late] })], NOW - 60_000, NOW, rate),
    ).toBe(0);
  });
});

describe('computePriorityAllocation stops', () => {
  it('stops the lowest priority station whose minimum no longer fits', () => {
    const out = byId(
      svc.computePriorityAllocation(
        [
          station({ id: 'hi', loadPriority: 9, minPowerKw: 20 }),
          station({ id: 'lo', loadPriority: 1, minPowerKw: 20 }),
        ],
        30,
      ),
    );
    expect(out.get('hi')).toBe(30);
    expect(out.get('lo')).toBe(0);
  });
});

describe('weightedFixedKw', () => {
  it('counts the reservations of stations on the panel itself', () => {
    const panel: HierarchyNode = {
      ...nodeBase,
      type: 'panel',
      id: 'pnl_x',
      name: 'X',
      maxContinuousKw: 100,
      unmanagedLoadKw: 2,
      stations: [station({ id: 'a' }), station({ id: 'b' })],
    };
    expect(svc.weightedFixedKw(panel, new Map([['a', 5]]))).toBe(7);
  });
});

describe('computeHierarchicalAllocation with a planned station that shares', () => {
  it('lets a planned station of unknown maximum share on top of its plan', () => {
    const out = byId(
      svc.computeHierarchicalAllocation(
        tree([station({ id: 'a', maxPowerKw: 0 }), station({ id: 'b' })], 60),
        'departure_aware',
        new Map(),
        { kw: new Map([['a', 20]]), sharing: new Set(['a']) },
      ),
    );
    expect(out.get('b')).toBe(20);
    expect(out.get('a')).toBe(40);
  });

  it('leaves a planned station at its maximum out of the share', () => {
    const out = byId(
      svc.computeHierarchicalAllocation(
        tree([station({ id: 'a', maxPowerKw: 20 }), station({ id: 'b' })], 60),
        'departure_aware',
        new Map(),
        { kw: new Map([['a', 20]]), sharing: new Set(['a']) },
      ),
    );
    expect(out.get('a')).toBe(20);
    expect(out.get('b')).toBe(40);
  });
});

describe('computeHierarchicalAllocation on an overloaded phase', () => {
  it('cuts only the circuits on the overloaded phase of a three-phase panel', () => {
    const circuit = (id: string, phase: string, s: StationPowerInfo): HierarchyNode => ({
      ...nodeBase,
      type: 'circuit',
      id,
      name: id,
      maxContinuousKw: 40,
      phaseConnections: phase,
      stations: [s],
    });
    const panel: HierarchyNode = {
      ...nodeBase,
      type: 'panel',
      id: 'pnl_3p',
      name: 'Three phase',
      phases: 3,
      maxContinuousKw: 1000,
      perPhaseCapacityKw: 10,
      stations: [],
      children: [
        circuit('cir_l1', 'L1', station({ id: 'a', maxPowerKw: 30 })),
        circuit('cir_l2', 'L2', station({ id: 'b', maxPowerKw: 5 })),
      ],
    };
    const out = byId(svc.computeHierarchicalAllocation([panel], 'equal_share'));
    expect(out.get('a')).toBeCloseTo(10, 9);
    expect(out.get('b')).toBe(5);
  });
});

describe('clearLoadManagementProfiles', () => {
  it('clears both profiles by the default id when the MaxExternalConstraintsId read fails', async () => {
    h.fake.fail('select', new Error('db down'));
    const log = makeLogger();
    expect(await svc.clearLoadManagementProfiles(['CS-1', 'CS-1'], log)).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Reading MaxExternalConstraintsId failed, clearing by the default id',
    );
    const ids = h.published.map(
      (p) => (p.message['payload'] as { chargingProfileId: number }).chargingProfileId,
    );
    const defaultId = svc.loadManagementProfileId(undefined);
    expect(ids).toEqual([defaultId, svc.loadManagementCreditProfileId(defaultId)]);
    expect(h.published.every((p) => p.message['stationId'] === 'CS-1')).toBe(true);
    expect(h.published.every((p) => p.message['action'] === 'ClearChargingProfile')).toBe(true);
  });

  it('follows a stored MaxExternalConstraintsId and reports a failed publish', async () => {
    h.fake.queue('select', [
      { stationId: 'CS-1', value: '1000000500' },
      { stationId: 'CS-2', value: null },
    ]);
    h.publishFails = true;
    const log = makeLogger();
    expect(await svc.clearLoadManagementProfiles(['CS-1', 'CS-2'], log)).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(4);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        stationId: 'CS-1',
        chargingProfileId: svc.loadManagementProfileId('1000000500'),
      }),
      'Failed to dispatch ClearChargingProfile',
    );
  });

  it('reads nothing and sends nothing for no stations', async () => {
    expect(await svc.clearLoadManagementProfiles([], makeLogger())).toBe(true);
    expect(h.fake.calls).toHaveLength(0);
    expect(h.published).toHaveLength(0);
  });
});

describe('parseAppliedAllocations', () => {
  it('reads only well formed entries with their optional fields', () => {
    expect(svc.parseAppliedAllocations(null)).toBeNull();
    expect(svc.parseAppliedAllocations({})).toBeNull();
    const out = svc.parseAppliedAllocations([
      null,
      'x',
      { stationId: 'CS-1', stationDbId: 'sta_1' },
      {
        stationId: 'CS-2',
        stationDbId: 'sta_2',
        allocatedKw: 11,
        reserved: true,
        limitPending: true,
        rejectedUnits: ['A', 'kW'],
        baseKw: 7,
        creditUntil: '2026-11-12T12:00:00.000Z',
      },
      {
        stationId: 'CS-3',
        stationDbId: 'sta_3',
        allocatedKw: 5,
        reserved: 'yes',
        rejectedUnits: 'A',
        baseKw: Number.NaN,
        creditUntil: 'not a date',
      },
    ]);
    expect(out).toEqual([
      {
        stationId: 'CS-2',
        stationDbId: 'sta_2',
        allocatedKw: 11,
        reserved: true,
        limitPending: true,
        rejectedUnits: ['A'],
        baseKw: 7,
        creditUntil: '2026-11-12T12:00:00.000Z',
      },
      { stationId: 'CS-3', stationDbId: 'sta_3', allocatedKw: 5 },
    ]);
  });
});

describe('load management profile readers', () => {
  const p21 = {
    id: svc.LOAD_MANAGEMENT_PROFILE_ID + 5,
    stackLevel: svc.LOAD_MANAGEMENT_STACK_LEVEL,
    chargingProfilePurpose: 'ChargingStationMaxProfile',
    chargingSchedule: [{ chargingRateUnit: 'W', chargingSchedulePeriod: [{ limit: 22000 }] }],
  };
  const p16 = {
    chargingProfileId: svc.LOAD_MANAGEMENT_PROFILE_ID,
    stackLevel: svc.LOAD_MANAGEMENT_STACK_LEVEL,
    chargingProfilePurpose: 'ChargePointMaxProfile',
    chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ limit: 16 }] },
  };

  it('recognizes the 2.1 and 1.6 forms and nothing else', () => {
    expect(svc.isLoadManagementProfile(p21)).toBe(true);
    expect(svc.isLoadManagementProfile(p16)).toBe(true);
    expect(svc.isLoadManagementProfile(null)).toBe(false);
    expect(svc.isLoadManagementProfile('profile')).toBe(false);
    expect(svc.isLoadManagementProfile({ ...p21, id: 7 })).toBe(false);
    expect(svc.isLoadManagementProfile({ ...p21, stackLevel: 9 })).toBe(false);
    expect(svc.isLoadManagementProfile({ ...p21, chargingProfilePurpose: 'TxProfile' })).toBe(
      false,
    );
  });

  it('reads the rate unit of either schedule form', () => {
    expect(svc.profileRateUnit(p21)).toBe('W');
    expect(svc.profileRateUnit(p16)).toBe('A');
    expect(svc.profileRateUnit(null)).toBeNull();
    expect(svc.profileRateUnit({ chargingSchedule: [{ chargingRateUnit: 'kW' }] })).toBeNull();
    expect(svc.profileRateUnit({})).toBeNull();
  });

  it('reads the first limit in kW, from A only with the circuit', () => {
    expect(svc.profileLimitKw(p21, undefined)).toBe(22);
    const rate = { rateUnit: 'A' as const, voltageV: 230, phases: 3 };
    expect(svc.profileLimitKw(p16, rate)).toBeCloseTo((16 * 230 * 3) / 1000, 9);
    expect(svc.profileLimitKw(p16, undefined)).toBeNull();
    expect(svc.profileLimitKw(null, rate)).toBeNull();
    expect(
      svc.profileLimitKw(
        { chargingSchedule: { chargingRateUnit: 'W', chargingSchedulePeriod: [{ limit: -1 }] } },
        rate,
      ),
    ).toBeNull();
    expect(svc.profileLimitKw({ chargingSchedule: { chargingRateUnit: 'W' } }, rate)).toBeNull();
    expect(
      svc.profileLimitKw(
        { chargingSchedule: [{ chargingRateUnit: 'kW', chargingSchedulePeriod: [{ limit: 5 }] }] },
        rate,
      ),
    ).toBeNull();
  });

  it('expresses a limit in A per phase, rounded down to 0.1 A', () => {
    expect(svc.limitInUnit(11000, undefined)).toBe(11000);
    expect(svc.limitInUnit(11000, { rateUnit: 'W', voltageV: 230, phases: 3 })).toBe(11000);
    // 11000 / (230 * 3) = 15.94 A.
    expect(svc.limitInUnit(11000, { rateUnit: 'A', voltageV: 230, phases: 3 })).toBe(15.9);
    // Two phases: the line-to-line factor sqrt(3).
    expect(svc.limitInUnit(4000, { rateUnit: 'A', voltageV: 230, phases: 2 })).toBe(10);
  });
});

describe('clearPlanProfilesOnDisable', () => {
  it('clears the plan profiles of the site', async () => {
    h.clearSitePlanProfiles.mockResolvedValue(2);
    const log = makeLogger();
    await svc.clearPlanProfilesOnDisable('sit_1', log);
    expect(h.clearSitePlanProfiles).toHaveBeenCalledWith('sit_1', log);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs and goes on when the clear fails (fail-open)', async () => {
    h.clearSitePlanProfiles.mockRejectedValue(new Error('redis down'));
    const log = makeLogger();
    await expect(svc.clearPlanProfilesOnDisable('sit_1', log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'sit_1' }),
      'Depot plan profiles not cleared after load management was turned off',
    );
  });
});
