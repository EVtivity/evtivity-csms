// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The safety spec's property test (I1, I4, I7): a model site of one circuit
// and 2 to 5 stations runs several load management cycles through the real
// allocation, reservations, send order and limit records. Each station is a
// model of its own that holds the limit it enforces and applies the limits it
// is sent in order, after a random delay; it answers, refuses, or applies
// without an answer that arrives, and it may reboot without a limit. After
// every change at a station the test checks, from the station models alone
// (never from the service records), that the stations together cannot draw
// more than the circuit: a station without a known limit counts at its
// maximum, so the check holds only while those maxima fit, which the
// generator keeps true.

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { limitTransition, type LimitEvent } from '@evtivity/lib/load-limit-state';

const bus = vi.hoisted(() => ({
  handlers: new Map<string, Set<(raw: string) => void>>(),
  onCommand: (_command: { stationId: string; commandId?: string; payload: unknown }): void =>
    undefined,
}));

vi.mock('@evtivity/database', () => ({
  client: {},
  loadManagementFenceHolds: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@evtivity/lib/pubsub-instance', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib/pubsub-instance')>(
    '@evtivity/lib/pubsub-instance',
  );
  return {
    ...actual,
    getPubSub: () => ({
      publish: (channel: string, message: string) => {
        if (channel === 'ocpp_commands') {
          bus.onCommand(
            JSON.parse(message) as { stationId: string; commandId?: string; payload: unknown },
          );
        }
        return Promise.resolve();
      },
      subscribe: (channel: string, handler: (raw: string) => void) => {
        const set = bus.handlers.get(channel) ?? new Set<(raw: string) => void>();
        set.add(handler);
        bus.handlers.set(channel, set);
        return Promise.resolve({
          unsubscribe: () => {
            set.delete(handler);
            return Promise.resolve();
          },
        });
      },
      ping: () => Promise.resolve(true),
    }),
  };
});

import { computeHierarchicalAllocation } from '../load-management-allocation.js';
import {
  dispatchAllocationSend,
  LOAD_MANAGEMENT_CUT_CONFIRM_MS,
  limitSendCommand,
  prepareAllocationSend,
} from '../load-management-send.js';
import { reservedStationLimitsKw } from '../load-management-site-allocation.js';
import { startAllowances } from '../load-management-allowances.js';
import {
  type AllocationResult,
  type HierarchyNode,
  type StationPowerInfo,
} from '../load-management-model.js';
import {
  entriesAfterFailures,
  entriesForCuts,
  entriesForRaises,
  limitReservations,
  mightEnforceKw,
  retryStationIds,
  type AppliedAllocation,
} from '../load-limit-entries.js';

const CIRCUIT_KW = 60;
const NOW = Date.parse('2026-11-24T12:00:00Z');

type Answer = 'accept' | 'reject' | 'silentApplied' | 'silentDropped';

interface StationModel {
  id: string;
  ocppId: string;
  maxKw: number;
  /** The limit the station enforces now; null: none (it may draw its maximum). */
  enforced: number | null;
  /** Limits sent and not applied yet (the station applies them in order). */
  queued: number[];
  answers: Answer[];
  delays: number[];
  reboots: boolean[];
  /** Whether the station has a session in each cycle: sessions start and stop. */
  sessions: boolean[];
}

/** What a station model may draw: its limit, else its maximum. */
function drawKw(s: StationModel): number {
  return Math.min(s.enforced ?? s.maxKw, s.maxKw);
}

/** A panel over one circuit of `CIRCUIT_KW` (the circuit is the binding limit). */
function circuit(stations: StationPowerInfo[]): HierarchyNode[] {
  const node = (
    type: 'panel' | 'circuit',
    kw: number,
    children: HierarchyNode[],
  ): HierarchyNode => ({
    type,
    id: type === 'panel' ? 'p1' : 'c1',
    name: type,
    maxContinuousKw: kw,
    safetyMarginKw: 0,
    unmanagedLoadKw: 0,
    currentDrawKw: 0,
    stations: type === 'circuit' ? stations : [],
    children,
    phases: 1,
    breakerRatingAmps: 100,
    voltageV: 240,
    oversubscriptionRatio: 1,
    phaseConnections: null,
    phaseLoad: null,
    perPhaseCapacityKw: null,
  });
  return [node('panel', 1000, [node('circuit', CIRCUIT_KW, [])])];
}

function powerInfo(s: StationModel, cycle: number): StationPowerInfo {
  return {
    hasActiveSession: s.sessions[cycle % s.sessions.length] ?? true,
    circuitPhases: 1,
    circuitVoltageV: 240,
    id: s.id,
    stationId: s.ocppId,
    circuitId: 'c1',
    currentDrawKw: 0,
    maxPowerKw: s.maxKw,
    loadPriority: 5,
    isOnline: true,
    departureTime: null,
    phasePowerKw: { L1: 0, L2: 0, L3: 0 },
    minPowerKw: 0,
    rateUnit: 'W',
    profileId: 1_000_000_000,
  };
}

function limitOf(payload: unknown): number {
  const profile = (payload as { chargingProfile: Record<string, unknown> }).chargingProfile;
  const schedule = (profile['chargingSchedule'] as Array<Record<string, unknown>>)[0];
  const period = (schedule?.['chargingSchedulePeriod'] as Array<{ limit: number }>)[0];
  return (period?.limit ?? 0) / 1000;
}

/** Runs one site through `cycles` load management cycles; fails on the first unsafe moment. */
async function runSite(models: StationModel[], cycles: number): Promise<void> {
  const byOcpp = new Map(models.map((m) => [m.ocppId, m]));
  const check = (moment: string): void => {
    const total = models.reduce((sum, m) => sum + drawKw(m), 0);
    expect(total, moment).toBeLessThanOrEqual(CIRCUIT_KW + 1e-6);
  };
  // Every station starts within the circuit, its record what the CSMS knows.
  let stored: AppliedAllocation[] = models.map((m) => ({
    stationId: m.ocppId,
    stationDbId: m.id,
    allocatedKw: m.enforced ?? m.maxKw,
    limit:
      m.enforced == null
        ? { state: 'unknown', mightKw: null }
        : {
            state: 'accepted',
            commandId: `start-${m.id}`,
            sentKw: m.enforced,
            mightKw: m.enforced,
          },
  }));
  const reply = (stationDbId: string, event: LimitEvent): void => {
    stored = stored.map((e) =>
      e.stationDbId === stationDbId ? { ...e, limit: limitTransition(e.limit, event) } : e,
    );
  };
  let step = 0;
  const busyUntil = new Map<string, number>();
  bus.onCommand = (command) => {
    const model = byOcpp.get(command.stationId);
    if (model == null || command.commandId == null) return;
    const commandId = command.commandId;
    const answer = model.answers[step % model.answers.length] ?? 'accept';
    const delay = model.delays[step % model.delays.length] ?? 0;
    step += 1;
    // A station takes its CALLs one at a time, in the order they were sent.
    const at = Math.max(Date.now() + delay, busyUntil.get(model.id) ?? 0);
    busyUntil.set(model.id, at);
    const queuedKw = limitOf(command.payload);
    model.queued.push(queuedKw);
    setTimeout(() => {
      model.queued.splice(model.queued.indexOf(queuedKw), 1);
      if (answer !== 'reject' && answer !== 'silentDropped') {
        model.enforced = limitOf(command.payload);
        check(`${model.ocppId} applied ${String(model.enforced)} kW`);
      }
      if (answer === 'silentApplied' || answer === 'silentDropped') return;
      const event: LimitEvent =
        answer === 'accept' ? { type: 'accepted', commandId } : { type: 'rejected', commandId };
      reply(model.id, event);
      const raw = JSON.stringify({
        commandId,
        response: { status: answer === 'accept' ? 'Accepted' : 'Rejected' },
      });
      for (const handler of bus.handlers.get('ocpp_command_results') ?? []) handler(raw);
    }, at - Date.now());
  };

  check('start');
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    // A reboot drops the station limit; the boot event makes its record unknown.
    for (const m of models) {
      if (m.reboots[cycle % m.reboots.length] === true) {
        m.enforced = null;
        stored = stored.map((e) =>
          e.stationDbId === m.id ? { ...e, limit: { state: 'unknown', mightKw: null } } : e,
        );
      }
    }
    // A reboot that alone puts the site over its circuit is outside the CSMS's
    // control: the case ends there.
    // Limits still on their way count as applied: they were sent before the reboot.
    const worst = models.reduce(
      (sum, m) => sum + Math.max(drawKw(m), ...m.queued.map((kw) => Math.min(kw, m.maxKw))),
      0,
    );
    if (worst > CIRCUIT_KW) return;
    check(`cycle ${String(cycle)} start`);
    const stations = models.map((m) => powerInfo(m, cycle));
    const hierarchy = circuit(stations);
    const reservedKw = limitReservations(stations, stored, { nowMs: NOW });
    // What the CSMS counts each station at (its records) already exceeds the
    // circuit: a refusal or a reboot raised it, which no allocation can undo,
    // so the case ends there (I1 assumes the counted stations fit).
    const counted = models.reduce((sum, m) => {
      const might = mightEnforceKw(
        stored.find((e) => e.stationDbId === m.id),
        { nowMs: NOW },
      );
      return sum + Math.min(might ?? m.maxKw, m.maxKw);
    }, 0);
    if (counted > CIRCUIT_KW) return;
    // Idle stations hold their start allowance as a fixed load, as the cycle does.
    const allowances = startAllowances(hierarchy, 'equal_share', stations, reservedKw, new Map());
    const fixedKw = new Map(reservedKw);
    for (const a of allowances) fixedKw.set(a.stationDbId, a.allocatedKw);
    const allocations = [
      ...computeHierarchicalAllocation(hierarchy, 'equal_share', fixedKw),
      ...allowances,
    ];
    const retryIds = retryStationIds(stations, stored, NOW);
    const retryLimits = reservedStationLimitsKw(
      hierarchy,
      'equal_share',
      reservedKw,
      allocations,
      retryIds,
    );
    const retries: AllocationResult[] = retryIds.map((id) => ({
      stationId: byId(models, id).ocppId,
      stationDbId: id,
      allocatedKw: retryLimits.get(id) ?? 0,
      currentDrawKw: 0,
    }));
    const previousKw = new Map<string, number>();
    for (const e of stored) {
      const kw = mightEnforceKw(e, { nowMs: NOW });
      if (kw != null) previousKw.set(e.stationDbId, kw);
    }
    const send = prepareAllocationSend(
      [...allocations, ...retries],
      new Date(NOW),
      new Map(),
      previousKw,
      {
        reserved: new Set(retryIds),
      },
    );
    const cuts = [...send.stationCuts, ...send.evseCuts].map(limitSendCommand);
    const raises = [...send.evseRaises, ...send.stationRaises].map(limitSendCommand);
    const applied = stored.map((e) => ({
      ...e,
      allocatedKw:
        [...allocations, ...retries].find((a) => a.stationDbId === e.stationDbId)?.allocatedKw ??
        e.allocatedKw,
    }));
    stored = entriesForCuts(applied, stored, cuts, new Set(), NOW);
    const outcome = dispatchAllocationSend('site', send, silentLog, {
      beforeRaises: () => {
        stored = entriesForRaises(stored, raises, new Set(), NOW);
        return Promise.resolve(true);
      },
    });
    await vi.advanceTimersByTimeAsync(LOAD_MANAGEMENT_CUT_CONFIRM_MS + 1000);
    const result = await outcome;
    if (!result.sent) stored = entriesAfterFailures(stored, result.failures);
    await vi.advanceTimersByTimeAsync(1000);
    // I4 corollary: what the records count never lies below what a station enforces.
    for (const m of models) {
      const entry = stored.find((e) => e.stationDbId === m.id);
      const might = mightEnforceKw(entry, { nowMs: NOW });
      if (might != null) {
        expect(drawKw(m), `${m.ocppId} counted at ${String(might)}`).toBeLessThanOrEqual(
          might + 1e-6,
        );
      }
    }
  }
}

function byId(models: StationModel[], id: string): StationModel {
  const found = models.find((m) => m.id === id);
  if (found == null) throw new Error(`no model ${id}`);
  return found;
}

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const answer = fc.constantFrom<Answer>(
  'accept',
  'accept',
  'accept',
  'reject',
  'silentApplied',
  'silentDropped',
);

const station = (index: number) =>
  fc
    .record({
      maxKw: fc.integer({ min: 7, max: 40 }),
      start: fc.option(fc.integer({ min: 0, max: 30 }), { nil: null }),
      answers: fc.array(answer, { minLength: 1, maxLength: 6 }),
      delays: fc.array(fc.integer({ min: 0, max: 7_000 }), { minLength: 1, maxLength: 4 }),
      sessions: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
      reboots: fc.array(
        fc.integer({ min: 0, max: 9 }).map((n) => n < 2),
        { minLength: 1, maxLength: 3 },
      ),
    })
    .map((r) => ({ ...r, index }));

describe('load management safety property (I1, I4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bus.handlers.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    'never lets the stations together draw more than the circuit',
    { timeout: 120_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .integer({ min: 2, max: 5 })
            .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => station(i)))),
          async (specs) => {
            const models: StationModel[] = specs.map((s) => ({
              id: `sta_${String(s.index)}`,
              ocppId: `CS-${String(s.index)}`,
              maxKw: s.maxKw,
              enforced: s.start == null ? null : Math.min(s.start, s.maxKw),
              answers: s.answers,
              delays: s.delays,
              reboots: s.reboots,
              sessions: s.sessions,
              queued: [],
            }));
            // The start must be safe: a site that is already over its circuit is no case.
            fc.pre(models.reduce((sum, m) => sum + drawKw(m), 0) <= CIRCUIT_KW);
            // Commands of an earlier case never reach this one.
            vi.clearAllTimers();
            bus.handlers.clear();
            await runSite(models, 4);
          },
        ),
        { numRuns: 2000, seed: 20261124 },
      );
    },
  );
});
