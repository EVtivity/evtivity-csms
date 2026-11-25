// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The unit box TxDefaultProfiles and the station-wide box cap (second round
// decision b of the load management safety spec).

import { describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';
import type { LimitRecord } from '@evtivity/lib/load-limit-state';
import type { EvseLimitResult } from '../evse-limits.js';
import type { AppliedAllocation } from '../load-limit-entries.js';
import type { StationPowerInfo, UnitEvseInfo } from '../load-management-model.js';

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  const fake: FakeDb = createFakeDb();
  return fakeDatabaseModule(fake, { isOperatorStation: () => 'OPERATOR_STATION' });
});

const { unitBoxPlan, unitBoxLoad, unitBoxKw } = await import('../load-management-unit-boxes.js');
const { clearRemovesDefaultProfiles } = await import('../load-management-profiles.js');
const { boxCappedKw } = await import('../load-management-allocation.js');
const profiles = await import('../evse-limit-profiles.js');

const V = 230;
const RATE = { rateUnit: 'A' as const, voltageV: V, phases: 3, profileId: 1_000_000_000 };
const BOX_KW = (32 * 0.8 * V * 3) / 1000;

function accepted(kw: number, commandId: string): LimitRecord {
  return { state: 'accepted', commandId, sentKw: kw, mightKw: kw };
}

/** Parkhaus Lindenhof: one station, 8 boxes of 2 EVSEs, 32 A three-phase box budgets. */
function lindenhof(overrides: Partial<StationPowerInfo> = {}): StationPowerInfo {
  const unitEvses: UnitEvseInfo[] = [];
  for (let box = 1; box <= 8; box += 1) {
    for (const n of [box * 2 - 1, box * 2]) {
      unitEvses.push({
        evseNumber: n,
        unitId: `u${String(box)}`,
        kind: 'ac',
        ratingA: 32,
        ratingKw: 22,
      });
    }
  }
  return {
    id: 'sta',
    stationId: 'EM4-MASTER-01',
    circuitId: 'cir',
    currentDrawKw: 0,
    phasePowerKw: null,
    maxPowerKw: 352,
    loadPriority: 5,
    isOnline: true,
    hasActiveSession: true,
    departureTime: null,
    minPowerKw: 0,
    rateUnit: 'A',
    supportedRateUnits: ['A', 'W'],
    profileId: 1_000_000_000,
    circuitVoltageV: V,
    circuitPhases: 3,
    balancingMode: 'evse',
    unitEvses,
    unitBudgets: Array.from({ length: 8 }, (_, i) => ({
      unitId: `u${String(i + 1)}`,
      kind: 'ac' as const,
      maxCurrentA: 32,
      phases: 3,
      maxPowerKw: null,
    })),
    sessions: [1, 3].map((evseNumber) => ({
      sessionId: `ses_${String(evseNumber)}`,
      transactionId: `tx-${String(evseNumber)}`,
      evseDbId: `evs_${String(evseNumber)}`,
      evseNumber,
      unitId: `u${String(Math.ceil(evseNumber / 2))}`,
      kind: 'ac' as const,
      ratingKw: 22,
      ratingA: 32,
      tariffId: null,
      tariffMaxCurrentA: null,
      phases: 'L1L2L3',
      startedAt: new Date('2026-11-24T09:00:00Z'),
    })),
    ...overrides,
  };
}

function limit(evseNumber: number, amps: number): EvseLimitResult {
  return {
    sessionId: `ses_${String(evseNumber)}`,
    transactionId: `tx-${String(evseNumber)}`,
    evseNumber,
    unitId: `u${String(Math.ceil(evseNumber / 2))}`,
    kind: 'ac',
    limitA: amps,
    limitKw: (amps * V * 3) / 1000,
    phases: 3,
    reason: 'unit_budget',
    paused: false,
  };
}

const LIMITS = [limit(1, 16), limit(3, 16)];

/** The entry after every TxProfile and default of `plan` was accepted. */
function acceptedEntry(plan: ReturnType<typeof unitBoxPlan>): AppliedAllocation {
  return {
    stationId: 'EM4-MASTER-01',
    stationDbId: 'sta',
    allocatedKw: 30,
    limit: accepted(30, 'st'),
    evses: LIMITS.map((l) => ({
      ...profiles.appliedEvseLimit(l, 'A'),
      limit: accepted(l.limitKw, `tx${String(l.evseNumber)}`),
    })),
    evseDefaults: plan.defaults.map((d) => ({
      ...d,
      limit: accepted(d.limitKw, `d${String(d.evseNumber)}`),
    })),
  };
}

describe('unit box defaults', () => {
  it('gives a busy EVSE its session limit and the free EVSEs what the sessions leave', () => {
    const plan = unitBoxPlan(lindenhof(), undefined, LIMITS, RATE, { sendDefaults: true });
    const byEvse = new Map(plan.defaults.map((d) => [d.evseNumber, d]));
    expect(plan.defaults).toHaveLength(16);
    expect(byEvse.get(1)?.limitA).toBe(16);
    expect(byEvse.get(2)?.limitA).toBeCloseTo(25.6 - 16, 6);
    expect(byEvse.get(5)?.limitA).toBeCloseTo(12.8, 6);
    expect(byEvse.get(5)?.limitKw).toBeCloseTo((12.8 * V) / 1000, 6);
    expect(byEvse.get(5)?.rateUnit).toBe('A');
  });

  it('sends a W-only station its defaults in W at the single-phase worst case', () => {
    const st = lindenhof({ supportedRateUnits: ['W'] });
    const plan = unitBoxPlan(
      st,
      undefined,
      LIMITS,
      { ...RATE, rateUnit: 'W' },
      { sendDefaults: true },
    );
    const free = plan.defaults.find((d) => d.evseNumber === 5);
    expect(free?.rateUnit).toBe('W');
    const payload = profiles.buildEvseDefaultProfile(
      1_000_000_006,
      free ?? plan.defaults[0]!,
      new Date(),
    );
    const profile = payload['chargingProfile'] as Record<string, unknown>;
    expect(profile['chargingProfilePurpose']).toBe('TxDefaultProfile');
    expect(profile['stackLevel']).toBe(1);
    expect(payload['evseId']).toBe(5);
    const period = (profile['chargingSchedule'] as Array<Record<string, unknown>>)[0]?.[
      'chargingSchedulePeriod'
    ] as Array<Record<string, unknown>>;
    expect(period[0]?.['limit']).toBe(Math.floor(12.8 * V));
  });

  it('holds a DC box in kW', () => {
    const st = lindenhof({
      unitEvses: [
        { evseNumber: 1, unitId: 'd1', kind: 'dc', ratingA: 200, ratingKw: 150 },
        { evseNumber: 2, unitId: 'd1', kind: 'dc', ratingA: 200, ratingKw: 150 },
      ],
      unitBudgets: [{ unitId: 'd1', kind: 'dc', maxCurrentA: null, phases: null, maxPowerKw: 200 }],
      sessions: [],
    });
    const plan = unitBoxPlan(st, undefined, [], RATE, { sendDefaults: true });
    expect(plan.defaults.map((d) => [d.kind, d.limitKw, d.rateUnit])).toEqual([
      ['dc', 80, 'W'],
      ['dc', 80, 'W'],
    ]);
    expect(plan.capKw).toBeCloseTo(160, 6);
  });

  it('holds the station to one box until its defaults are accepted (Parkhaus Lindenhof)', () => {
    const st = lindenhof();
    const first = unitBoxPlan(st, undefined, LIMITS, RATE, { sendDefaults: true });
    expect(first.capKw).toBeCloseTo(BOX_KW, 6);
    expect(first.heldByDefaults).toBe(false);
    const entry = acceptedEntry(first);
    const later = unitBoxPlan(st, entry, LIMITS, RATE, { sendDefaults: true });
    expect(later.capKw).toBeNull();
    expect(later.heldByDefaults).toBe(true);
    // Every box stays within 80 percent of its budget with what the station may hold.
    for (const budget of st.unitBudgets ?? []) {
      expect(unitBoxLoad(st, budget, entry, LIMITS, later.defaults, V)).toBeLessThanOrEqual(
        25.6 + 1e-6,
      );
    }
  });

  it('counts a refused, unknown or lost default at the EVSE rating', () => {
    const st = lindenhof();
    const plan = unitBoxPlan(st, undefined, LIMITS, RATE, { sendDefaults: true });
    const entry = acceptedEntry(plan);
    for (const record of [
      { state: 'refused', mightKw: null },
      { state: 'unknown', mightKw: null },
    ] as LimitRecord[]) {
      const changed: AppliedAllocation = {
        ...entry,
        evseDefaults: (entry.evseDefaults ?? []).map((d) =>
          d.evseNumber === 6 ? { ...d, limit: record } : d,
        ),
      };
      expect(unitBoxPlan(st, changed, LIMITS, RATE, { sendDefaults: true }).capKw).toBeCloseTo(
        BOX_KW,
        6,
      );
    }
    // A default lost while raising counts at the higher of sent and held.
    const lost: AppliedAllocation = {
      ...entry,
      evseDefaults: (entry.evseDefaults ?? []).map((d) =>
        d.evseNumber === 6
          ? { ...d, limit: { state: 'lost', commandId: 'x', sentKw: 7, mightKw: 7 } }
          : d,
      ),
    };
    expect(unitBoxPlan(st, lost, LIMITS, RATE, { sendDefaults: true }).capKw).toBeCloseTo(
      BOX_KW,
      6,
    );
  });

  it('counts a session whose TxProfile was never sent at the EVSE rating', () => {
    const st = lindenhof();
    const plan = unitBoxPlan(st, undefined, LIMITS, RATE, { sendDefaults: true });
    const entry = { ...acceptedEntry(plan), evses: [] };
    expect(unitBoxPlan(st, entry, LIMITS, RATE, { sendDefaults: true }).capKw).toBeCloseTo(
      BOX_KW,
      6,
    );
  });

  it('sends no defaults to a station limited as a whole or one that refused per-EVSE limits', () => {
    for (const st of [
      lindenhof({ balancingMode: 'station' }),
      lindenhof({ evseLimitsRefusedAt: new Date() }),
    ]) {
      const plan = unitBoxPlan(st, undefined, [], RATE, { sendDefaults: true });
      expect(plan.defaults).toEqual([]);
      expect(plan.capKw).toBeCloseTo(BOX_KW, 6);
    }
  });

  it('clears a default the station no longer needs by its id, and skips a reserved station', () => {
    const st = lindenhof();
    const previous = new Map([
      [
        'sta',
        [
          {
            evseNumber: 4,
            unitId: 'u2',
            kind: 'ac' as const,
            limitA: 9.6,
            limitKw: 2.2,
            rateUnit: 'A' as const,
          },
        ],
      ],
    ]);
    const releases = profiles.evseDefaultReleases(previous, [], new Map([['sta', st]]));
    expect(releases).toEqual([
      {
        stationId: 'EM4-MASTER-01',
        stationDbId: 'sta',
        evseNumber: 4,
        chargingProfileId: 1_000_000_005,
      },
    ]);
    expect(profiles.evseDefaultReleases(previous, [], new Map())).toEqual([]);
  });
});

describe('clearRemovesDefaultProfiles', () => {
  const none = {
    chargingProfileId: null,
    chargingProfilePurpose: null,
    stackLevel: null,
    evseId: null,
  };
  it('matches a default by its id, by TxDefaultProfile criteria, and not EVSE 0 or another purpose', () => {
    const id = 1_000_000_000;
    expect(clearRemovesDefaultProfiles({ ...none, chargingProfileId: id + 5 }, id)).toEqual([4]);
    expect(clearRemovesDefaultProfiles({ ...none, chargingProfileId: id + 1 }, id)).toEqual([]);
    expect(clearRemovesDefaultProfiles(none, id)).toBe('all');
    expect(clearRemovesDefaultProfiles({ ...none, evseId: 3 }, id)).toEqual([3]);
    expect(clearRemovesDefaultProfiles({ ...none, evseId: 0 }, id)).toEqual([]);
    expect(
      clearRemovesDefaultProfiles({ ...none, chargingProfilePurpose: 'TxProfile' }, id),
    ).toEqual([]);
    expect(clearRemovesDefaultProfiles({ ...none, stackLevel: 0 }, id)).toEqual([]);
  });
});

describe('boxCappedKw (A4, I3)', () => {
  it('pauses a station whose box cannot carry its minimum, never leaving it under its floor', () => {
    // A 16 A single-phase box holds 2.944 kW at 80 percent.
    const st = lindenhof({ minPowerKw: 4, sessions: [] });
    expect(boxCappedKw(st, 2.944)).toBe(0);
    expect(boxCappedKw({ ...st, minPowerKw: 2 }, 2.944)).toBeCloseTo(2.944, 9);
    // Two AC sessions need 6 A each on their phases: the box cap below that pauses too.
    const busy = lindenhof({ minPowerKw: 0 });
    expect(boxCappedKw(busy, BOX_KW)).toBeCloseTo(BOX_KW, 9);
    expect(boxCappedKw(busy, 1)).toBe(0);
  });
});

describe('a single-phase box on a three-phase station (review M3)', () => {
  const single = {
    unitId: 'u1',
    kind: 'ac' as const,
    maxCurrentA: 16,
    phases: 1,
    maxPowerKw: null,
  };
  const oneCar = lindenhof({
    minPowerKw: 0,
    unitBudgets: [single],
    sessions: [{ ...lindenhof().sessions![0]!, phases: 'L1' }],
  });

  it('caps an A limit at the box current on every phase, a W limit at the box on one phase', () => {
    // 12.8 A on every phase holds the box's one phase to 12.8 A: 12.8 x 230 V x 3 in station terms.
    expect(unitBoxKw(single, oneCar, RATE)).toBeCloseTo((16 * 0.8 * V * 3) / 1000, 9);
    // A W limit bounds the total only: all of it may land on the box's phase.
    expect(unitBoxKw(single, oneCar, { ...RATE, rateUnit: 'W' })).toBeCloseTo(
      (16 * 0.8 * V) / 1000,
      9,
    );
  });

  it('pauses a station whose box cannot carry its own minimum or its sessions floor', () => {
    const carries = (st: StationPowerInfo): boolean =>
      unitBoxPlan(st, undefined, [], RATE, { sendDefaults: false }).carriesMinimum;
    // One one-phase car needs 6 A on its phase: 1.38 kW fits the 2.944 kW box.
    expect(carries(oneCar)).toBe(true);
    // A 6 kW own minimum does not, whatever the station limit allows on the other phases.
    expect(carries({ ...oneCar, minPowerKw: 6 })).toBe(false);
    // Two one-phase cars on a 10 A box need 2 x 6 A on its phase: 1.84 kW is too little
    // for a station limited as a whole; one limited per EVSE pauses one of them instead.
    const two = lindenhof({
      minPowerKw: 0,
      balancingMode: 'station',
      unitBudgets: [{ ...single, maxCurrentA: 10 }],
      sessions: [1, 2].map((n) => ({
        ...lindenhof().sessions![0]!,
        sessionId: `ses_${String(n)}`,
        transactionId: `tx-${String(n)}`,
        evseNumber: n,
        phases: 'L1',
      })),
    });
    expect(carries(two)).toBe(false);
    expect(carries({ ...two, balancingMode: 'evse' })).toBe(true);
  });

  it('holds each box to the floors of its own sessions only', () => {
    // A three-phase car in one box and a one-phase car in another: each box
    // carries its own car's 6 A, though neither carries the station's floor.
    const own = { unitId: 'u1', kind: 'ac' as const, maxCurrentA: 16, phases: 3, maxPowerKw: null };
    const st = lindenhof({
      minPowerKw: 0,
      unitBudgets: [own, { ...own, unitId: 'u2' }],
      sessions: [
        {
          ...lindenhof().sessions![0]!,
          sessionId: 'ses_1',
          transactionId: 'tx-1',
          evseNumber: 1,
          phases: 'L1L2L3',
        },
        {
          ...lindenhof().sessions![0]!,
          sessionId: 'ses_3',
          transactionId: 'tx-3',
          evseNumber: 3,
          phases: 'L1',
        },
      ],
    });
    expect(unitBoxPlan(st, undefined, [], RATE, { sendDefaults: false }).carriesMinimum).toBe(true);
  });
});

describe('what a unit box delivers to its sessions (review C3)', () => {
  const box = { unitId: 'u1', kind: 'ac' as const, maxCurrentA: 32, phases: 3, maxPowerKw: null };
  const session = lindenhof().sessions![0]!;
  const withCars = (phases: Array<{ phases: string | null; measured: string | null }>) =>
    lindenhof({
      unitBudgets: [box],
      sessions: phases.map((p, i) => ({
        ...session,
        sessionId: `ses_${String(i + 1)}`,
        transactionId: `tx-${String(i + 1)}`,
        evseNumber: i + 1,
        phases: p.phases,
        measuredPhases: p.measured,
      })),
    });
  const delivered = (st: StationPowerInfo): number | null =>
    unitBoxPlan(st, undefined, [], RATE, { sendDefaults: false }).capBoxKw;
  const phaseKw = (32 * 0.8 * V) / 1000;

  it('gives two one-phase cars on one phase that phase only', () => {
    // The wiring is unknown: the two may share a phase, 25.6 A between them.
    expect(
      delivered(
        withCars([
          { phases: null, measured: 'L1' },
          { phases: null, measured: 'L1' },
        ]),
      ),
    ).toBeCloseTo(phaseKw, 6);
    // Aligned to two phases, each car has a phase's budget.
    expect(
      delivered(
        withCars([
          { phases: 'L1', measured: 'L1' },
          { phases: 'L2', measured: 'L2' },
        ]),
      ),
    ).toBeCloseTo(2 * phaseKw, 6);
  });

  it('holds a three-phase car to its share of the phase it shares', () => {
    // 12.8 A each on the shared phase: 12.8 A on three phases for one, on one for the other.
    expect(
      delivered(
        withCars([
          { phases: null, measured: 'L1L2L3' },
          { phases: null, measured: 'L1' },
        ]),
      ),
    ).toBeCloseTo((12.8 * V * 4) / 1000, 6);
  });
});

describe('holdToBoxes (review I3 H1)', () => {
  it('holds a split station to the box by the limit it is sent, three times its busiest share', async () => {
    const { holdToBoxes } = await import('../load-management-site-allocation.js');
    const st = lindenhof();
    const split = {
      stationId: 'S',
      stationDbId: 'sta',
      allocatedKw: 11.59,
      currentDrawKw: 0,
      phaseWeights: { L1: 1, L2: 0, L3: 0 },
    };
    // Sent at 34.77 kW (3 x 11.59), above a 17.66 kW cap: held, unsplit, never above its allocation.
    const held = holdToBoxes(split, st, 17.664, true);
    expect(held.phaseWeights).toBeUndefined();
    expect(held.allocatedKw).toBeCloseTo(11.59, 6);
    expect(held.limitedBy).toBe('unit_budget');
    // An even spread under the cap passes unchanged.
    const even = { stationId: 'S', stationDbId: 'sta', allocatedKw: 11.59, currentDrawKw: 0 };
    expect(holdToBoxes(even, st, 17.664, true)).toBe(even);
  });
});
