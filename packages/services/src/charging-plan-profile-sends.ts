// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Departure-aware allocation of a depot site: builds the planner input from the
// site's panel and circuit tree, binds departures to the sessions charging for
// them, plans when the stored plan is stale, writes the plan and the readiness
// of every departure (writeSitePlan), and turns the current slot of the plan
// into fixed allocations for the load management cycle.

import {
  db,
  chargingStations,
  evChargingNeeds,
  stationConfigurations,
  type PlanSessionRow,
} from '@evtivity/database';
import { and, eq, inArray } from 'drizzle-orm';
import { isOcpp21 } from '@evtivity/lib/ocpp-version';
import { type PlanSlot } from '@evtivity/lib/charging-plan';
import { type ChargingRateUnit, type StationPowerInfo } from './load-management-model.js';
import { type StationRate } from './load-management-profiles.js';
import {
  DEFAULT_PLAN_MAX_PERIODS,
  buildChargingPlanProfile,
  planProfileHash,
  type PlanProfilePayload,
} from './charging-plan-profile.js';
import {
  currentSlotStartMs,
  type PlanProfileState,
  type StoredPlanEntry,
  plannedEntries,
  snapToMinimum,
} from './charging-plan-stored.js';
import { SLOT_MS } from './charging-plan-nodes.js';

/** A rejected plan profile is sent again after this long, not every cycle. */
export const PLAN_PROFILE_RETRY_MS = 3_600_000;

/** The plan slots from `index` on, rebuilt from the stored slot starts. */
export function storedSlots(slotStarts: unknown, index: number): PlanSlot[] {
  if (!Array.isArray(slotStarts) || index < 0) return [];
  const starts = (slotStarts as unknown[])
    .map((v) => (typeof v === 'string' ? Date.parse(v) : Number.NaN))
    .filter((v) => Number.isFinite(v));
  const slots: PlanSlot[] = [];
  for (let i = index; i < starts.length; i += 1) {
    const startMs = starts[i] ?? 0;
    const endMs = starts[i + 1] ?? currentSlotStartMs(startMs) + SLOT_MS;
    slots.push({ startMs, endMs, hours: (endMs - startMs) / 3_600_000 });
  }
  return slots;
}

/** One plan profile to send. */
export interface PlanProfileSend {
  sessionId: string;
  stationOcppId: string;
  payload: PlanProfilePayload;
  profile: PlanProfileState;
  previous: PlanProfileState | null;
}

export interface PlanProfileSendInput {
  entries: readonly StoredPlanEntry[];
  sessions: readonly PlanSessionRow[];
  stations: readonly StationPowerInfo[];
  reservedKw: ReadonlyMap<string, number>;
  rates: ReadonlyMap<string, StationRate>;
  /** Period bound per station, and per `stationDbId:evseNumber` the EV's maxScheduleTuples. */
  stationMaxPeriods: ReadonlyMap<string, number>;
  evseMaxTuples: ReadonlyMap<string, number>;
  /** The plan slots from the current one on. */
  slots: readonly PlanSlot[];
  /** Index of the current slot in the stored plan. */
  slotIndex: number;
  nowMs: number;
  /** Phases the EV of each session charges on, when known (charging needs or measured). */
  sessionPhases?: ReadonlyMap<string, number>;
  /** Stations on OCPP 2.1, which take the preconditioningRequest of a period. */
  ocpp21Stations?: ReadonlySet<string>;
  /** The most each session may draw (its tariff limit, its own EVSE limit), kW by session id. */
  sessionCapKw?: ReadonlyMap<string, number>;
}

/**
 * Whether a session's profile may be sent this slot, before its content is
 * known: never sent, a new slot, a cleared profile wanted again, or a refusal
 * more than an hour old. The hash check comes after.
 */
export function profileMaySend(
  previous: PlanProfileState | null,
  slotStartMs: number,
  nowMs: number,
): boolean {
  if (previous == null || previous.state === 'cleared') return true;
  if (previous.state === 'rejected') {
    const rejectedAt = previous.rejectedAt != null ? Date.parse(previous.rejectedAt) : 0;
    return nowMs - rejectedAt >= PLAN_PROFILE_RETRY_MS;
  }
  return previous.slotStartMs !== slotStartMs;
}

/** The planned sessions a cycle could send a profile to (station online, not reserved, may send). */
export function sendCandidates(
  input: Pick<PlanProfileSendInput, 'entries' | 'sessions' | 'stations' | 'reservedKw' | 'nowMs'>,
  slotStartMs: number,
): Array<{ entry: StoredPlanEntry; session: PlanSessionRow; station: StationPowerInfo }> {
  const active = new Map(input.sessions.map((s) => [s.id, s]));
  const stationById = new Map(input.stations.map((s) => [s.id, s]));
  const out: Array<{ entry: StoredPlanEntry; session: PlanSessionRow; station: StationPowerInfo }> =
    [];
  for (const entry of plannedEntries(input.entries)) {
    const session = active.get(entry.sessionId);
    const station = stationById.get(entry.stationDbId);
    if (session == null || session.stationDbId !== entry.stationDbId) continue;
    if (station == null || !station.isOnline || input.reservedKw.has(station.id)) continue;
    if (session.evseNumber == null) continue;
    if (!profileMaySend(entry.profile ?? null, slotStartMs, input.nowMs)) continue;
    out.push({ entry, session, station });
  }
  return out;
}

/**
 * The rate of a session's profile: the station's, in the other unit when the
 * station refused this unit for the session (W falls back to A, which needs
 * the circuit), with the EV's phases when it charges on fewer than the circuit.
 */
export function planProfileRate(
  rate: StationRate | undefined,
  rejectedUnits: readonly ChargingRateUnit[] | undefined,
  evPhases: number | undefined,
): { rate: StationRate | undefined; numberPhases: number | undefined } {
  if (rate == null) return { rate: undefined, numberPhases: undefined };
  let unit = rate.rateUnit;
  const refused = rejectedUnits ?? [];
  if (refused.includes(unit)) {
    const other: ChargingRateUnit = unit === 'W' ? 'A' : 'W';
    if (!refused.includes(other)) unit = other;
  }
  let phases = rate.phases;
  let numberPhases: number | undefined;
  if (unit === 'A' && evPhases != null && evPhases >= 1 && evPhases < rate.phases) {
    phases = evPhases;
    numberPhases = evPhases;
  }
  return { rate: { ...rate, rateUnit: unit, phases }, numberPhases };
}

/**
 * The plan profiles a cycle sends: for each planned session still active on
 * an online station without a reservation, its profile from the current slot
 * on, unless it was already sent in this slot, the station holds the same
 * profile, or the station refused one less than an hour ago.
 */
export function planProfileSends(input: PlanProfileSendInput): PlanProfileSend[] {
  const slotStartMs = input.slots[0]?.startMs;
  if (slotStartMs == null) return [];
  const sends: PlanProfileSend[] = [];
  for (const { entry, session, station } of sendCandidates(input, slotStartMs)) {
    if (session.evseNumber == null) continue;
    const previous = entry.profile ?? null;
    const tuples = input.evseMaxTuples.get(`${station.id}:${String(session.evseNumber)}`);
    const maxPeriods = Math.min(
      input.stationMaxPeriods.get(station.id) ?? DEFAULT_PLAN_MAX_PERIODS,
      tuples != null && tuples > 0 ? tuples : Number.POSITIVE_INFINITY,
    );
    // The limit holds the planned charging power plus the preconditioning load.
    const aux = entry.auxKw?.slice(input.slotIndex) ?? [];
    const capKw = input.sessionCapKw?.get(session.id);
    const powerKw = entry.powerKw.slice(input.slotIndex).map((kw, i) => {
      const slotKw = snapToMinimum(kw, entry.minKw) + (aux[i] ?? 0);
      return capKw != null ? Math.min(slotKw, capKw) : slotKw;
    });
    const preconditioning =
      input.ocpp21Stations?.has(station.id) === true
        ? entry.preconditioning?.slice(input.slotIndex)
        : undefined;
    const { rate, numberPhases } = planProfileRate(
      input.rates.get(station.id),
      previous?.rejectedUnits,
      input.sessionPhases?.get(session.id),
    );
    const payload = buildChargingPlanProfile({
      stationOcppId: station.stationId,
      evseId: session.evseNumber,
      transactionId: session.transactionId,
      slots: input.slots,
      powerKw,
      rate,
      maxPeriods,
      now: new Date(input.nowMs),
      ...(numberPhases != null ? { numberPhases } : {}),
      ...(preconditioning != null ? { preconditioning } : {}),
    });
    const hash = planProfileHash(payload);
    if (
      previous != null &&
      (previous.state === 'sent' || previous.state === 'accepted') &&
      previous.hash === hash
    ) {
      continue;
    }
    sends.push({
      sessionId: session.id,
      stationOcppId: station.stationId,
      payload,
      previous,
      profile: {
        id: payload.chargingProfile.id,
        hash,
        slotStartMs,
        state: 'sent',
        sentAt: new Date(input.nowMs).toISOString(),
        ...(previous?.rejectedUnits != null ? { rejectedUnits: previous.rejectedUnits } : {}),
      },
    });
  }
  return sends;
}

const PERIOD_BOUND_VARIABLES = ['PeriodsPerSchedule', 'ChargingScheduleMaxPeriods'];

/** Phases an EV asks for in its charging needs (`requestedEnergyTransfer`). */
export function phasesOfEnergyTransfer(transfer: string | null | undefined): number | undefined {
  if (transfer == null) return undefined;
  if (transfer.includes('single_phase')) return 1;
  if (transfer.includes('two_phase')) return 2;
  if (transfer.includes('three_phase')) return 3;
  return undefined;
}

/** A phase counts as drawing above this share of the busiest one (and at least 0.2 kW). */
const MEASURED_PHASE_SHARE = 0.25;

/** Phases a station draws on, from its latest per-phase readings, when it charges one session. */
export function measuredPhases(station: StationPowerInfo): number | undefined {
  const load = station.phasePowerKw;
  if (load == null) return undefined;
  const values = [load.L1, load.L2, load.L3];
  const busiest = Math.max(...values);
  if (!(busiest >= 1)) return undefined;
  return values.filter((kw) => kw >= Math.max(0.2, busiest * MEASURED_PHASE_SHARE)).length;
}

export interface PlanProfileInputs {
  stations: Map<string, number>;
  /** Per `stationDbId:evseNumber`, the EV's maxScheduleTuples of the current session. */
  evses: Map<string, number>;
  /** Phases per session id. */
  phases: Map<string, number>;
  /** Stations that speak OCPP 2.1. */
  ocpp21: Set<string>;
}

/**
 * What each profile depends on beyond the plan: the period bound each station
 * reported (2.x SmartChargingCtrlr.PeriodsPerSchedule, 1.6
 * ChargingScheduleMaxPeriods), and the charging needs of the EV of each
 * session (its maxScheduleTuples and phases), only needs stored since that
 * session started, so an earlier EV's needs never shape the profile. Phases
 * fall back to the station's per-phase readings when the session is alone on
 * the station.
 */
export async function readPlanProfileInputs(
  stations: readonly StationPowerInfo[],
  sessions: readonly PlanSessionRow[],
): Promise<PlanProfileInputs> {
  const inputs: PlanProfileInputs = {
    stations: new Map(),
    evses: new Map(),
    phases: new Map(),
    ocpp21: new Set(),
  };
  const stationDbIds = [...new Set(sessions.map((se) => se.stationDbId))];
  if (stationDbIds.length === 0) return inputs;
  const [configRows, needsRows, protocolRows] = await Promise.all([
    db
      .select({
        stationId: stationConfigurations.stationId,
        value: stationConfigurations.value,
      })
      .from(stationConfigurations)
      .where(
        and(
          inArray(stationConfigurations.stationId, stationDbIds),
          inArray(stationConfigurations.variable, PERIOD_BOUND_VARIABLES),
          eq(stationConfigurations.attributeType, 'Actual'),
        ),
      ),
    db
      .select({
        stationId: evChargingNeeds.stationId,
        evseId: evChargingNeeds.evseId,
        maxScheduleTuples: evChargingNeeds.maxScheduleTuples,
        requestedEnergyTransfer: evChargingNeeds.requestedEnergyTransfer,
        updatedAt: evChargingNeeds.updatedAt,
      })
      .from(evChargingNeeds)
      .where(inArray(evChargingNeeds.stationId, stationDbIds)),
    db
      .select({ id: chargingStations.id, protocol: chargingStations.ocppProtocol })
      .from(chargingStations)
      .where(inArray(chargingStations.id, stationDbIds)),
  ]);
  for (const row of protocolRows) {
    if (isOcpp21(row.protocol)) inputs.ocpp21.add(row.id);
  }
  for (const row of configRows) {
    const bound = Number(row.value);
    if (Number.isInteger(bound) && bound > 0) {
      inputs.stations.set(
        row.stationId,
        Math.min(inputs.stations.get(row.stationId) ?? bound, bound),
      );
    }
  }
  const sessionByEvse = new Map<string, PlanSessionRow>();
  for (const se of sessions) {
    if (se.evseNumber != null) sessionByEvse.set(`${se.stationDbId}:${String(se.evseNumber)}`, se);
  }
  for (const row of needsRows) {
    const key = `${row.stationId}:${String(row.evseId)}`;
    const session = sessionByEvse.get(key);
    if (session == null) continue;
    const startedAt = session.startedAt;
    if (startedAt != null && row.updatedAt.getTime() < startedAt.getTime()) continue;
    if (row.maxScheduleTuples != null && row.maxScheduleTuples > 0) {
      inputs.evses.set(key, row.maxScheduleTuples);
    }
    const phases = phasesOfEnergyTransfer(row.requestedEnergyTransfer);
    if (phases != null) inputs.phases.set(session.id, phases);
  }
  const activeOnStation = new Map<string, number>();
  for (const se of sessions) {
    activeOnStation.set(se.stationDbId, (activeOnStation.get(se.stationDbId) ?? 0) + 1);
  }
  const stationById = new Map(stations.map((st) => [st.id, st]));
  for (const se of sessions) {
    if (inputs.phases.has(se.id) || activeOnStation.get(se.stationDbId) !== 1) continue;
    const station = stationById.get(se.stationDbId);
    const phases = station != null ? measuredPhases(station) : undefined;
    if (phases != null) inputs.phases.set(se.id, phases);
  }
  return inputs;
}
