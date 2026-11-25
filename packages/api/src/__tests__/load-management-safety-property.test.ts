// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The safety spec's property test (I1 to I7): a model site (a service
// transformer with solar, a three-phase panel with per-phase limits, a
// three-phase and a single-phase circuit) and 2 to 5 stations of OCPP 1.6,
// 2.0.1 and 2.1 (A and W, single- and three-phase chargers and cars, unit
// boxes with budgets, limits per station or per EVSE, phase switching) runs
// the real per-site cycle against an in-memory site row. Stations answer,
// refuse, answer with an error, apply without answering, reboot, drop off and
// reconnect; cars come and go and follow phase choices; other writers send
// profiles and clears through the one rule of the API; the solar reading goes
// stale; a second worker takes the site over from one whose lease was lost.
// After every change at a station and every publish the test checks the
// station models (what they hold, the calls on their way, a new car on every
// EVSE), the CSMS records against them, and after every quiet cycle the
// minimums (I3).

import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module mocks reach the harness through these hooks, set once the
// modules are loaded (a mock factory that imported the harness would wait on
// the module it mocks).
const hooks = vi.hoisted(() => ({
  managedTx: (_stationId: string, _transactionId: string): boolean => false,
  claim: (_input: never): Promise<boolean> => Promise.resolve(false),
  fenceHolds: (): Promise<boolean> => Promise.resolve(false),
  storedRows: (): unknown[] => [],
  write: (..._args: never[]): Promise<boolean> => Promise.resolve(false),
  publish: (_command: never): void => undefined,
  results: new Set<(raw: string) => void>(),
  cars: (_stationId: string): Array<[number, { transactionId: string }]> => [],
  unitBoxEvses: (_stationId: string): number[] => [],
}));

// The database: the site row with its fence (the harness row), and the stored
// accepted profiles `storedLimitsOf` selects.
vi.mock('@evtivity/database', () => ({
  client: {},
  db: {
    // The stored profiles; a join (a station's reported MaxExternalConstraintsId)
    // finds no row, as no model station reports one.
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(hooks.storedRows()),
        innerJoin: () => ({ where: () => Promise.resolve([]) }),
      }),
    }),
    // The one raw query the command routes run here: the EVSEs of the station's
    // unit boxes with a budget. Any other raw query is not modelled and fails.
    execute: (query: { queryChunks: unknown[] }) => {
      const text = query.queryChunks
        .map((c) => (c as { value?: unknown }).value)
        .filter((v): v is string[] => Array.isArray(v))
        .flat()
        .join('');
      if (!text.includes('station_unit_load_budgets')) {
        return Promise.reject(new Error(`Raw query not modelled: ${text.slice(0, 80)}`));
      }
      const stationId = query.queryChunks.find((c) => typeof c === 'string') as string;
      return Promise.resolve(hooks.unitBoxEvses(stationId).map((evse_id) => ({ evse_id })));
    },
  },
  chargingProfiles: { stationId: 'station_id', source: 'source', profileData: 'profile_data' },
  stationConfigurations: {
    value: 'value',
    stationId: 'station_id',
    component: 'component',
    variable: 'variable',
    attributeType: 'attribute_type',
  },
  chargingStations: { id: 'id', stationId: 'station_id' },
  claimAndLogAllocations: (input: never) => hooks.claim(input),
  writeLoadManagementRecords: (...args: never[]) => hooks.write(...args),
  loadManagementFenceHolds: () => hooks.fenceHolds(),
  recordAllocationEntryReply: () => Promise.resolve(),
}));

vi.mock('@evtivity/lib/pubsub-instance', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib/pubsub-instance')>(
    '@evtivity/lib/pubsub-instance',
  );
  return {
    ...actual,
    getPubSub: () => ({
      publish: (channel: string, message: string) => {
        if (channel === 'ocpp_commands') hooks.publish(JSON.parse(message) as never);
        return Promise.resolve();
      },
      subscribe: (_channel: string, handler: (raw: string) => void) => {
        hooks.results.add(handler);
        return Promise.resolve({
          unsubscribe: () => {
            hooks.results.delete(handler);
            return Promise.resolve();
          },
        });
      },
      ping: () => Promise.resolve(true),
    }),
  };
});

// The database reads of the API rule: every model station is managed, no depot
// plan runs, and a session is limited per EVSE when its station limits per EVSE.
vi.mock('../lib/charging-profile-id.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/charging-profile-id.js')>();
  const { chargingProfileClearCriteria } = await import('@evtivity/lib');
  const { chargingNeedsProfileId } = await import('@evtivity/lib/charging-profile-ids');
  const carsOf = (stationId: string) => hooks.cars(stationId);
  return {
    ...actual,
    isLoadManagedStationIdentity: () => Promise.resolve(true),
    maxExternalConstraintsIdByIdentity: () => Promise.resolve(null),
    plannedProfileIdConflict: () => Promise.resolve(null),
    isPlannedTransaction: () => Promise.resolve(false),
    isPlannedConnectorSession: () => Promise.resolve(false),
    plannedClearConflict: () => Promise.resolve(null),
    loadManagedClearConflict: (_stationId: string, payload: Record<string, unknown>) => {
      const c = chargingProfileClearCriteria(payload);
      return Promise.resolve(actual.clearRemovesLoadManagement(c, null));
    },
    isEvseManagedTransaction: (stationId: string, tx: string) =>
      Promise.resolve(hooks.managedTx(stationId, tx)),
    isEvseManagedConnectorSession: (stationId: string, connector: number) =>
      Promise.resolve(
        carsOf(stationId).some(
          ([n, car]) => n === connector && hooks.managedTx(stationId, car.transactionId),
        ),
      ),
    evseManagedProfileIdConflict: (stationId: string, profileId: number | null) =>
      Promise.resolve(
        carsOf(stationId).find(
          ([, car]) =>
            profileId === chargingNeedsProfileId(stationId, car.transactionId) &&
            hooks.managedTx(stationId, car.transactionId),
        )?.[1].transactionId ?? null,
      ),
    evseManagedClearConflict: (stationId: string, payload: Record<string, unknown>) => {
      const c = chargingProfileClearCriteria(payload);
      if (c.chargingProfilePurpose != null && c.chargingProfilePurpose !== 'TxProfile') {
        return Promise.resolve(null);
      }
      if (c.evseId === 0) return Promise.resolve(null);
      const hit = carsOf(stationId).find(([n, car]) => {
        if (c.chargingProfileId != null) {
          return c.chargingProfileId === chargingNeedsProfileId(stationId, car.transactionId);
        }
        return c.evseId == null || c.evseId === n;
      });
      return Promise.resolve(
        hit != null && hooks.managedTx(stationId, hit[1].transactionId)
          ? hit[1].transactionId
          : null,
      );
    },
  };
});

import { parseAppliedAllocations } from '@evtivity/services/load-limit-entries';
import { chargingNeedsProfileId } from '@evtivity/lib/charging-profile-ids';
import { loadManagementProfileConflict } from '../lib/load-management-profile-conflict.js';
import {
  applyEvent,
  checkCounted,
  checkCountedNodes,
  checkMinimums,
  checkNodes,
  checkPublishFence,
  checkUnits,
  createStations,
  fakeClaim,
  fakeFenceHolds,
  fakeWrite,
  runCycle,
  shared,
  storedRowsOf,
  type Answer,
  type Command,
  type Harness,
  type StationScript,
  type StoredProfileRow,
} from './helpers/lm-property/harness.js';
import {
  type ModelProfile,
  type ModelStation,
  type Phase,
} from './helpers/lm-property/station-physics.js';
import type { SiteSpec, SolarState } from './helpers/lm-property/site-model.js';

const CYCLES = 5;
// The committed run; LM_PROPERTY_RUNS and LM_PROPERTY_SEED explore more cases or another seed.
const PROPERTY_RUNS = Number(process.env['LM_PROPERTY_RUNS'] ?? 3000);
const PROPERTY_SEED = Number(process.env['LM_PROPERTY_SEED'] ?? 20261125);
// LM_PROPERTY_REPLAY names a JSON file holding one printed counterexample: only it runs.
const REPLAY_FILE = process.env['LM_PROPERTY_REPLAY'];
const REPLAY: unknown = REPLAY_FILE == null ? null : JSON.parse(readFileSync(REPLAY_FILE, 'utf8'));
const CYCLE_MS = 10_000;
const START = Date.parse('2026-11-24T12:00:00Z');
const LM_ID = 1_000_000_000;

type EventSpec =
  | {
      kind: 'arrive';
      at: number;
      station: number;
      evse: number;
      phases: 1 | 3;
      maxA: number;
      evsePhase: 1 | 2 | 3;
      refuses: boolean;
    }
  | { kind: 'leave'; at: number; station: number; evse: number }
  | { kind: 'reboot'; at: number; station: number; downMs: number }
  | { kind: 'drop'; at: number; station: number; downMs: number }
  | { kind: 'writer'; at: number; station: number; action: number; level: number; limit: number };

interface StationSpec {
  protocol: ModelStation['protocol'];
  units: Array<'A' | 'W'>;
  maxStackLevel: number | null;
  single: boolean;
  singlePhaseCharger: boolean;
  wiringKnown: boolean;
  phaseSwitching: boolean;
  balancing: 'station' | 'evse';
  loadPriority: number;
  minPowerKw: number;
  evses: Array<{ dc: boolean; ratingA: number; ratingKw: number; rated: boolean; wiring: Phase[] }>;
  unit: { budgetA: number; phases: 1 | 3 } | null;
  startLimitKw: number | null;
  /** A credit profile (stack level 2) the station holds at the start, above its limit until `validInMs`. */
  startCredit: { extraKw: number; validInMs: number } | null;
  startEntry: 'accepted' | 'stored' | 'none';
  script: StationScript;
}

/** A worker whose lease is lost during a cycle, and the worker that takes the site over. */
interface OverlapSpec {
  cycle: number;
  atMs: number;
}

const PERMUTATIONS: Phase[][] = [
  ['L1', 'L2', 'L3'],
  ['L2', 'L3', 'L1'],
  ['L3', 'L1', 'L2'],
  ['L1', 'L3', 'L2'],
  ['L3', 'L2', 'L1'],
  ['L2', 'L1', 'L3'],
];

const answerArb = fc.constantFrom<Answer>(
  'accept',
  'accept',
  'accept',
  'accept',
  'reject',
  'callError',
  'silentApplied',
  'silentDropped',
);

const stationArb: fc.Arbitrary<StationSpec> = fc
  .record({
    protocol: fc.constantFrom<ModelStation['protocol']>('ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'),
    units: fc.constantFrom<Array<'A' | 'W'>>([], ['W'], ['A'], ['A', 'W']),
    maxStackLevel: fc.constantFrom<number | null>(null, 1, 2, 3),
    single: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
    singlePhaseCharger: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
    wiringKnown: fc.boolean(),
    phaseSwitching: fc.boolean(),
    balancing: fc.constantFrom<'station' | 'evse'>('station', 'evse'),
    loadPriority: fc.integer({ min: 1, max: 9 }),
    minPowerKw: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 12 })),
    evses: fc.array(
      fc.record({
        dc: fc.integer({ min: 0, max: 6 }).map((n) => n === 0),
        ratingA: fc.constantFrom(16, 32),
        ratingKw: fc.integer({ min: 20, max: 50 }),
        rated: fc.integer({ min: 0, max: 6 }).map((n) => n !== 0),
        wiring: fc.constantFrom(...PERMUTATIONS),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    unit: fc.option(
      fc.record({
        budgetA: fc.integer({ min: 16, max: 40 }),
        phases: fc.constantFrom<1 | 3>(1, 3),
      }),
      { nil: null },
    ),
    startLimitKw: fc.option(fc.integer({ min: 2, max: 20 }), { nil: null }),
    startCredit: fc.option(
      fc.record({
        extraKw: fc.integer({ min: 1, max: 10 }),
        validInMs: fc.integer({ min: 1_000, max: 60_000 }),
      }),
      { nil: null },
    ),
    startEntry: fc.constantFrom<StationSpec['startEntry']>('accepted', 'stored', 'none'),
    script: fc.record({
      answers: fc.array(answerArb, { minLength: 1, maxLength: 6 }),
      delaysMs: fc.array(fc.integer({ min: 0, max: 8_000 }), { minLength: 1, maxLength: 4 }),
    }),
  })
  .map((s) => ({
    ...s,
    singlePhaseCharger: s.singlePhaseCharger && s.protocol !== 'ocpp1.6' && !s.single,
    // DC on the three-phase circuit only, never on a single-phase charger.
    evses: s.evses.map((e) => ({ ...e, dc: e.dc && !s.single && !s.singlePhaseCharger })),
    // A station whose stack level stops at 1 cannot hold a stack level 2 credit profile.
    startCredit: s.maxStackLevel === 1 ? null : s.startCredit,
  }));

const eventArb = (stations: number): fc.Arbitrary<EventSpec> =>
  fc.oneof(
    {
      weight: 5,
      arbitrary: fc.record({
        kind: fc.constant('arrive' as const),
        at: fc.integer({ min: 0, max: CYCLES * CYCLE_MS }),
        station: fc.integer({ min: 0, max: stations - 1 }),
        evse: fc.integer({ min: 1, max: 3 }),
        phases: fc.constantFrom<1 | 3>(1, 3),
        maxA: fc.constantFrom(10, 16, 32),
        evsePhase: fc.constantFrom<1 | 2 | 3>(1, 2, 3),
        refuses: fc.boolean(),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant('leave' as const),
        at: fc.integer({ min: 0, max: CYCLES * CYCLE_MS }),
        station: fc.integer({ min: 0, max: stations - 1 }),
        evse: fc.integer({ min: 1, max: 3 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('reboot' as const),
        at: fc.integer({ min: 0, max: CYCLES * CYCLE_MS }),
        station: fc.integer({ min: 0, max: stations - 1 }),
        downMs: fc.integer({ min: 1_000, max: 20_000 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('drop' as const),
        at: fc.integer({ min: 0, max: CYCLES * CYCLE_MS }),
        station: fc.integer({ min: 0, max: stations - 1 }),
        downMs: fc.integer({ min: 1_000, max: 25_000 }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant('writer' as const),
        at: fc.integer({ min: 0, max: CYCLES * CYCLE_MS }),
        station: fc.integer({ min: 0, max: stations - 1 }),
        action: fc.integer({ min: 0, max: 9 }),
        level: fc.integer({ min: 0, max: 3 }),
        limit: fc.integer({ min: 6, max: 100 }),
      }),
    },
  );

const siteArb: fc.Arbitrary<SiteSpec> = fc.record({
  transformerKw: fc.integer({ min: 30, max: 120 }),
  panelKw: fc.integer({ min: 30, max: 120 }),
  panelBreakerA: fc.integer({ min: 63, max: 160 }),
  panelUnmanagedKw: fc.integer({ min: 0, max: 6 }),
  threePhaseBreakerA: fc.integer({ min: 32, max: 100 }),
  singlePhaseBreakerA: fc.integer({ min: 16, max: 50 }),
  strategy: fc.constantFrom<SiteSpec['strategy']>('equal_share', 'priority_based'),
});

const overlapArb: fc.Arbitrary<OverlapSpec | null> = fc.option(
  fc.record({
    cycle: fc.integer({ min: 0, max: CYCLES - 1 }),
    atMs: fc.integer({ min: 0, max: CYCLE_MS - 500 }),
  }),
  { nil: null },
);

const solarArb = fc.record({
  creditKw: fc.integer({ min: 0, max: 25 }),
  readings: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: CYCLES, maxLength: CYCLES }),
  // From under one cycle to past the credit replacement, so credits are sent, refused and lapse.
  ttlMs: fc.integer({ min: 15_000, max: 600_000 }),
});

/** The limit unit and value of `kw` for a station that takes `units` (K01.FR.26: an A-only station holds no W limit). */
function startLimit(spec: StationSpec, kw: number): { unit: 'A' | 'W'; limit: number } {
  return spec.units.length > 0 && !spec.units.includes('W')
    ? { unit: 'A', limit: (kw * 1000) / (230 * (spec.single || spec.singlePhaseCharger ? 1 : 3)) }
    : { unit: 'W', limit: kw * 1000 };
}

/** The profiles a station holds at the start: its limit and a credit profile above it. */
function startProfiles(spec: StationSpec): ModelProfile[] {
  if (spec.startLimitKw == null) return [];
  const profiles: ModelProfile[] = [
    {
      id: LM_ID,
      purpose: 'ChargingStationMaxProfile',
      stackLevel: 1,
      evseId: 0,
      ...startLimit(spec, spec.startLimitKw),
    },
  ];
  if (spec.startCredit != null) {
    profiles.push({
      id: LM_ID + 1,
      purpose: 'ChargingStationMaxProfile',
      stackLevel: 2,
      evseId: 0,
      ...startLimit(spec, spec.startLimitKw + spec.startCredit.extraKw),
      validToMs: START + spec.startCredit.validInMs,
    });
  }
  return profiles;
}

/** The stored copy of a profile a station holds (`charging_profiles`, csms_set). */
function storedRow(stationId: string, p: ModelProfile): StoredProfileRow {
  return {
    stationId,
    profileData: {
      id: p.id,
      stackLevel: p.stackLevel,
      chargingProfilePurpose: p.purpose,
      chargingProfileKind: 'Absolute',
      evseId: p.evseId,
      ...(p.validToMs != null ? { validTo: new Date(p.validToMs).toISOString() } : {}),
      chargingSchedule: [
        {
          id: 1,
          chargingRateUnit: p.unit,
          chargingSchedulePeriod: [{ startPeriod: 0, limit: p.limit }],
        },
      ],
    },
  };
}

function modelOf(spec: StationSpec, index: number): ModelStation {
  const id = `sta_${String(index)}`;
  const units =
    spec.unit != null && spec.evses.length >= 2 && !spec.evses.some((e) => e.dc)
      ? [
          {
            id: `unt_${String(index)}`,
            budgetA: spec.unit.budgetA,
            phases: spec.single ? (1 as const) : spec.unit.phases,
          },
        ]
      : [];
  return {
    id,
    ocppId: `CS-${String(index)}`,
    protocol: spec.protocol,
    reportedUnits: spec.units,
    maxStackLevel: spec.maxStackLevel,
    circuit: spec.single ? 'single' : 'three',
    singlePhaseCharger: spec.singlePhaseCharger,
    wiringKnown: spec.wiringKnown,
    phaseSwitching: spec.phaseSwitching,
    balancing: spec.balancing,
    loadPriority: spec.loadPriority,
    evses: spec.evses.map((e, i) => {
      const phases = spec.single || spec.singlePhaseCharger ? 1 : 3;
      const kw = e.dc ? e.ratingKw : (e.ratingA * 230 * phases) / 1000;
      return {
        number: i + 1,
        kind: e.dc ? 'dc' : 'ac',
        ratingA: e.ratingA,
        ratingKw: kw,
        reportedKw: e.rated ? kw : null,
        unitId: units.length > 0 && i < 2 ? (units[0]?.id ?? null) : null,
        wiring: e.wiring,
      };
    }),
    units,
    profiles: startProfiles(spec),
    cars: new Map(),
    online: true,
    connection: 0,
    minPowerKw: spec.minPowerKw,
  };
}

/** The payload of an other writer's command; `action` picks the writer, `level` its stack level. */
function writerCommand(
  model: ModelStation,
  e: Extract<EventSpec, { kind: 'writer' }>,
): {
  action: 'SetChargingProfile' | 'ClearChargingProfile' | 'UsePriorityCharging';
  payload: Record<string, unknown>;
} {
  const tx = [...model.cars.values()][0]?.transactionId;
  const schedule = (unit: 'A' | 'W', limit: number) => [
    { id: 1, chargingRateUnit: unit, chargingSchedulePeriod: [{ startPeriod: 0, limit }] },
  ];
  const set = (profile: Record<string, unknown>, evseId = 0) => ({
    action: 'SetChargingProfile' as const,
    payload: { evseId, chargingProfile: { chargingProfileKind: 'Absolute', ...profile } },
  });
  switch (e.action) {
    case 0:
      return set({
        id: 5,
        stackLevel: e.level,
        chargingProfilePurpose: 'ChargingStationMaxProfile',
        chargingSchedule: schedule('W', e.limit * 1000),
      });
    case 1:
      return set({
        id: LM_ID + (e.level % 2),
        stackLevel: e.level,
        chargingProfilePurpose: 'ChargingStationMaxProfile',
        chargingSchedule: schedule('W', e.limit * 1000),
      });
    case 2:
      return set(
        {
          id: 7,
          stackLevel: e.level,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingSchedule: schedule('A', e.limit),
        },
        e.level % 2,
      );
    case 3:
      return set(
        {
          id: 8,
          stackLevel: e.level,
          chargingProfilePurpose: 'TxProfile',
          transactionId: tx ?? 'tx-none',
          chargingSchedule: schedule('A', e.limit),
        },
        1,
      );
    case 4:
      return set(
        {
          id: tx != null ? chargingNeedsProfileId(model.ocppId, tx) : 9,
          stackLevel: 1,
          chargingProfilePurpose: 'TxProfile',
          transactionId: tx ?? 'tx-none',
          chargingSchedule: schedule('A', e.limit),
        },
        1,
      );
    case 5:
      return set(
        {
          id: 10,
          stackLevel: e.level,
          chargingProfilePurpose: 'PriorityCharging',
          transactionId: tx ?? 'tx-none',
          chargingSchedule: schedule('A', e.limit),
        },
        1,
      );
    case 6:
      return set({
        id: 11,
        stackLevel: e.level,
        chargingProfilePurpose: 'LocalGeneration',
        chargingSchedule: schedule('W', e.limit * 1000),
      });
    case 7:
      return {
        action: 'ClearChargingProfile',
        payload: { chargingProfileId: [LM_ID, LM_ID + 1, 5, 7][e.level] },
      };
    case 8:
      return {
        action: 'ClearChargingProfile',
        payload: {
          chargingProfileCriteria: {
            chargingProfilePurpose: 'ChargingStationMaxProfile',
            stackLevel: [0, 1, 2, null][e.level],
            evseId: 0,
          },
        },
      };
    default:
      return {
        action: 'UsePriorityCharging',
        payload: { transactionId: tx ?? 'tx-none', activate: true },
      };
  }
}

interface CaseResult {
  h: Harness;
  overlaps: number;
  quietCycles: number;
}

async function runCase(
  site: SiteSpec,
  specs: StationSpec[],
  events: EventSpec[],
  solarSpec: { creditKw: number; readings: number[]; ttlMs: number },
  overlap: OverlapSpec | null,
): Promise<CaseResult> {
  const models = specs.map(modelOf);
  const solar: SolarState = { creditKw: solarSpec.creditKw, freshUntilMs: null, unknown: false };
  const h: Harness = {
    row: { enabled: true, appliedAllocations: null, appliedAt: null, fence: 0 },
    models,
    violations: [],
    // The CSMS stored the copy of every profile a station accepted from it.
    storedRows: specs.flatMap((s, i) =>
      s.startEntry === 'none' ? [] : startProfiles(s).map((p) => storedRow(`sta_${String(i)}`, p)),
    ),
    pending: new Map(),
    acceptedIds: new Set(),
    refusedLimit: new Set(),
    lateIds: new Set(),
    trace: [],
    cycleIds: new Set(),
    foreignEvents: 0,
    staleAttempts: 0,
    creditSends: 0,
    publish: () => undefined,
    resultHandlers: hooks.results,
  };
  shared.harness = h;
  hooks.managedTx = (stationId, tx) => {
    const m = models.find((x) => x.ocppId === stationId);
    return m?.balancing === 'evse' && [...m.cars.values()].some((c) => c.transactionId === tx);
  };
  const counted: Array<Promise<void>> = [];
  const check = (moment: string): void => {
    checkNodes(h, site, solar, moment);
    checkCountedNodes(h, site, solar, moment);
    checkUnits(h, moment);
    counted.push(
      checkCounted(h, site, solar, moment).catch((err: unknown) => {
        h.violations.push(`checkCounted failed at ${moment}: ${String(err)}`);
      }),
    );
  };
  const scripts = new Map(specs.map((s, i) => [`sta_${String(i)}`, s.script]));
  const stations = createStations(h, scripts, check);
  const quiet = { changes: 0 };
  const publishes: Command[] = [];
  h.publish = (command) => {
    checkPublishFence(h, command);
    publishes.push(command);
    if (command.commandId != null) h.cycleIds.add(command.commandId);
    stations(command);
    check(`${command.stationId} sent ${command.action}`);
  };
  // The CSMS knows what each station holds at the start: an accepted entry, a
  // stored profile only, or nothing.
  h.row.appliedAllocations = specs
    .map((s, i) => ({ s, m: models[i] }))
    .filter(({ s, m }) => s.startEntry === 'accepted' && m != null)
    .map(({ s, m }) => ({
      stationId: m?.ocppId,
      stationDbId: m?.id,
      allocatedKw: s.startLimitKw ?? 0,
      // The unit the station accepted its limit in, as the reply writer stores it.
      ...(s.startLimitKw != null ? { acceptedUnits: [startLimit(s, s.startLimitKw).unit] } : {}),
      limit:
        s.startLimitKw != null
          ? {
              state: 'accepted',
              commandId: `start-${String(m?.id)}`,
              sentKw: s.startLimitKw,
              mightKw: s.startLimitKw,
              ...(startLimit(s, s.startLimitKw).unit === 'W'
                ? { sentInW: true, mightInW: true }
                : {}),
            }
          : { state: 'unknown', mightKw: null },
      ...(s.startLimitKw != null && s.startCredit != null
        ? {
            credit: {
              limit: {
                state: 'accepted',
                commandId: `start-credit-${String(m?.id)}`,
                sentKw: s.startLimitKw + s.startCredit.extraKw,
                mightKw: s.startLimitKw + s.startCredit.extraKw,
                ...(startLimit(s, s.startLimitKw).unit === 'W'
                  ? { sentInW: true, mightInW: true }
                  : {}),
              },
              until: new Date(START + s.startCredit.validInMs).toISOString(),
            },
          }
        : {}),
    }));

  const stamp = (n: number): string => `tx-${String(n)}-${String(Date.now())}`;
  let sessions = 0;
  for (const e of events) {
    setTimeout(() => {
      const model = models[e.station];
      if (model == null) return;
      quiet.changes += 1;
      const nowMs = Date.now();
      if (e.kind === 'arrive') {
        const evse = model.evses.find((x) => x.number === e.evse);
        if (evse == null || model.cars.has(evse.number) || !model.online) return;
        sessions += 1;
        model.cars.set(evse.number, {
          sessionId: `ses-${String(sessions)}`,
          transactionId: stamp(sessions),
          startedAtMs: nowMs,
          phases: evse.kind === 'dc' ? 3 : e.phases,
          maxA: e.maxA,
          evsePhase: e.evsePhase,
          switchTo: null,
          refusesSwitch: e.refuses,
        });
        check(`${model.ocppId} car plugged in on EVSE ${String(evse.number)}`);
      } else if (e.kind === 'leave') {
        const car = model.cars.get(e.evse);
        if (car == null) return;
        model.cars.delete(e.evse);
        // A TxProfile ends with its transaction.
        model.profiles = model.profiles.filter((p) => p.transactionId !== car.transactionId);
        check(`${model.ocppId} car left EVSE ${String(e.evse)}`);
      } else if (e.kind === 'reboot' || e.kind === 'drop') {
        if (!model.online) return;
        model.online = false;
        model.connection += 1;
        if (e.kind === 'reboot') {
          // A reboot ends the transactions; the profiles persist (OCPP keeps them).
          for (const car of model.cars.values()) {
            model.profiles = model.profiles.filter((p) => p.transactionId !== car.transactionId);
          }
          model.cars.clear();
        }
        check(`${model.ocppId} went offline`);
        setTimeout(() => {
          quiet.changes += 1;
          model.online = true;
          if (e.kind === 'reboot') applyEvent(h, model, { type: 'boot' });
          check(`${model.ocppId} back online`);
        }, e.downMs);
      } else {
        const command = writerCommand(model, e);
        void loadManagementProfileConflict(model.ocppId, command.action, command.payload, {
          maxExternalId: null,
        }).then((conflict) => {
          if (conflict != null) return;
          h.publish({ stationId: model.ocppId, action: command.action, payload: command.payload });
        });
      }
    }, e.at);
  }
  // Cars follow a phase choice after a while.
  const follow = setInterval(() => {
    const nowMs = Date.now();
    for (const m of models) {
      for (const car of m.cars.values()) {
        if (car.switchTo != null && car.switchTo.atMs <= nowMs) {
          quiet.changes += 1;
          car.evsePhase = car.switchTo.phase;
          car.switchTo = null;
          check(`${m.ocppId} car moved to phase ${String(car.evsePhase)}`);
        }
      }
    }
  }, 1_000);

  // Each worker takes the site lock: it raises the fence and holds a lease.
  const takeSite = (): { fence: number; signal: AbortSignal; lose: () => void } => {
    h.row.fence += 1;
    const lease = new AbortController();
    return { fence: h.row.fence, signal: lease.signal, lose: () => lease.abort() };
  };

  let overlaps = 0;
  let quietCycles = 0;
  let quietBefore = false;
  check('start');
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const reading = solarSpec.readings[cycle] ?? 0;
    // A reading this cycle (most of them), none (the old one goes stale), or unknown assets.
    if (reading >= 2) {
      solar.freshUntilMs = Date.now() + solarSpec.ttlMs;
      solar.unknown = false;
    } else {
      solar.unknown = reading === 0;
    }
    quiet.changes = 0;
    h.foreignEvents = 0;
    h.cycleIds.clear();
    const from = publishes.length;
    // I5: every online station whose limit is not confirmed (awaiting or lost)
    // at the start of the cycle is sent its station limit again in it.
    const owed = (parseAppliedAllocations(h.row.appliedAllocations) ?? [])
      .filter((e) => e.limit.state === 'awaiting' || e.limit.state === 'lost')
      .map((e) => ({ entry: e, model: models.find((m) => m.id === e.stationDbId) }))
      .filter(({ model }) => model?.online === true);
    const runs: Array<Promise<void>> = [];
    const done = { count: 0 };
    const run = (worker: { fence: number; signal: AbortSignal }): void => {
      runs.push(
        runCycle(h, site, solar, worker).finally(() => {
          done.count += 1;
        }),
      );
    };
    const first = takeSite();
    run(first);
    const takeover = overlap?.cycle === cycle;
    if (takeover) {
      // The first worker loses its lease; a second one takes the site over
      // while the first may still wait on its replies.
      overlaps += 1;
      setTimeout(() => {
        first.lose();
        run(takeSite());
      }, overlap.atMs);
    }
    const expected = takeover ? 2 : 1;
    for (let waited = 0; waited < 2 * CYCLE_MS && done.count < expected; waited += 250) {
      await vi.advanceTimersByTimeAsync(250);
    }
    await Promise.all(runs);
    // Let the cycle's commands be answered before the next one.
    await vi.advanceTimersByTimeAsync(Math.max(0, CYCLE_MS - 250));
    const sent = publishes.slice(from);
    for (const { entry, model } of owed) {
      if (model == null) continue;
      const resent = sent.some((c) => {
        if (c.stationId !== model.ocppId || c.action !== 'SetChargingProfile') return false;
        const profile = c.payload['chargingProfile'] as Record<string, unknown> | undefined;
        return (
          profile?.['chargingProfilePurpose'] === 'ChargingStationMaxProfile' &&
          profile['stackLevel'] === 1
        );
      });
      if (!resent) {
        h.violations.push(
          `I5 ${model.ocppId} (${entry.limit.state}) online and not sent its limit in cycle ${String(cycle)} rows ${JSON.stringify(h.row.appliedAllocations)} TRACE ${h.trace.slice(-30).join(' | ')}`,
        );
      }
    }
    // I3 for a cycle that allocated on a state every station had answered
    // (the cycle before was quiet) and that was quiet itself: every limit
    // answered within the confirmation wait (a later answer is lost for the
    // cycle, so its raises wait), nothing changed at a station, no call still
    // on its way. With
    // the energy assets unknown the cycle raises no limit (the failure model),
    // so the minimums are owed only by a cycle that read them.
    const quietNow =
      quiet.changes === 0 &&
      h.foreignEvents === 0 &&
      models.every((m) => m.online) &&
      [...h.pending.values()].every((list) => list.length === 0) &&
      sent.every(
        (c) => c.commandId != null && h.acceptedIds.has(c.commandId) && !h.lateIds.has(c.commandId),
      );
    if (quietNow && quietBefore && !solar.unknown) {
      quietCycles += 1;
      checkMinimums(h, site, solar, `end of cycle ${String(cycle)}`);
    }
    quietBefore = quietNow;
  }
  clearInterval(follow);
  await Promise.all(counted);
  return { h, overlaps, quietCycles };
}

hooks.claim = (input) => fakeClaim(input);
hooks.write = (...args) => fakeWrite(...(args as unknown as Parameters<typeof fakeWrite>));
hooks.fenceHolds = () => fakeFenceHolds();
hooks.storedRows = () => storedRowsOf();
hooks.cars = (stationId) => [
  ...(shared.harness?.models.find((m) => m.ocppId === stationId)?.cars.entries() ?? []),
];
hooks.publish = (command) => shared.harness?.publish(command);
hooks.unitBoxEvses = (stationId) => {
  const model = shared.harness?.models.find((m) => m.ocppId === stationId);
  if (model == null) return [];
  const boxed = new Set(model.units.map((u) => u.id));
  return model.evses.filter((e) => e.unitId != null && boxed.has(e.unitId)).map((e) => e.number);
};

/**
 * True when the site starts safe: whatever cars plug in under what the
 * stations hold at the start fits every node, phase and unit box.
 */
function startsSafe(site: SiteSpec, specs: StationSpec[]): boolean {
  const solar: SolarState = { creditKw: 0, freshUntilMs: null, unknown: false };
  const probe = {
    models: specs.map(modelOf),
    violations: [] as string[],
    pending: new Map(),
    row: { enabled: true, appliedAllocations: null, appliedAt: null, fence: 0 },
    trace: [],
  } as unknown as Harness;
  checkCountedNodes(probe, site, solar, 'start');
  checkUnits(probe, 'start');
  return probe.violations.length === 0;
}

describe('load management safety property (I1 to I7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    shared.harness = null;
  });

  it(
    'keeps every node, phase and unit box within its limit, never counts a station below what it may enforce, gives every session its minimum and lets no stale worker send',
    { timeout: 120_000 },
    async () => {
      let overlaps = 0;
      let quietCycles = 0;
      let staleAttempts = 0;
      let creditSends = 0;
      await fc.assert(
        fc.asyncProperty(
          siteArb,
          fc
            .integer({ min: 2, max: 5 })
            .chain((n) =>
              fc.tuple(
                fc.tuple(...Array.from({ length: n }, () => stationArb)),
                fc.array(eventArb(n), { minLength: 0, maxLength: 24 }),
                fc.boolean(),
              ),
            )
            // A calm case (half of them): every station answers at once and only
            // cars arrive and leave, so cycles go quiet and the minimums (I3)
            // are checked; the other cases run the full failure model.
            .map(([specs, events, calm]): readonly [StationSpec[], EventSpec[]] =>
              calm
                ? ([
                    specs.map((spec) => ({
                      ...spec,
                      script: { answers: ['accept'], delaysMs: [0] },
                    })),
                    events.filter((e) => e.kind === 'arrive' || e.kind === 'leave'),
                  ] as const)
                : ([specs, events] as const),
            ),
          solarArb,
          overlapArb,
          async (site, [specs, events], solarSpec, overlap) => {
            // The site must start safe: whatever cars plug in under the limits the
            // stations hold at the start fits every node, phase and unit box.
            vi.clearAllTimers();
            vi.setSystemTime(START);
            fc.pre(startsSafe(site, specs));
            const result = await runCase(site, specs, events, solarSpec, overlap);
            overlaps += result.overlaps;
            quietCycles += result.quietCycles;
            staleAttempts += result.h.staleAttempts;
            creditSends += result.h.creditSends;
            expect(result.h.violations).toEqual([]);
          },
        ),
        REPLAY == null
          ? { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED }
          : { numRuns: 1, seed: PROPERTY_SEED, examples: [REPLAY as never], endOnFailure: true },
      );
      if (REPLAY != null) return;
      // A run that never sends a credit profile does not test the credit path (review H1).
      expect(creditSends).toBeGreaterThan(0);
      // Nor one whose cycles almost never go quiet: I3 is checked only then (review M3).
      expect(quietCycles).toBeGreaterThan(PROPERTY_RUNS / 10);
      console.info(
        `load management property: ${String(PROPERTY_RUNS)} cases, ${String(overlaps)} worker takeovers (${String(staleAttempts)} stale writes refused), ${String(creditSends)} credit profiles sent, ${String(quietCycles)} quiet cycles checked for minimums`,
      );
    },
  );
});
