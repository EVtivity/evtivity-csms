// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, gte, desc, inArray, isNull } from 'drizzle-orm';
import {
  db,
  circuits,
  chargingStations,
  chargingSessions,
  meterValues,
  connectors,
  evses,
  evChargingNeeds,
  stationConfigurations,
  isOperatorStation,
  sessionTariffSegments,
  stationUnitLoadBudgets,
} from '@evtivity/database';
import { evseChargingKind } from '@evtivity/lib';
import { UNRATED_AC_EVSE_A, unitBudgetKw } from './evse-limits.js';
import { EV_PHASES } from '@evtivity/lib/ev-phases';
import { EVSE_LIMITS_REFUSAL_RETRY_MS } from '@evtivity/lib/load-allocation';
import type { EvPhases } from '@evtivity/lib/ev-phases';
import {
  parseConnectorPhaseRotations,
  parsePhaseRotation,
  phasesThroughRotation,
  singlePhaseOfRotation,
} from '@evtivity/lib/phase-rotation';
import { isOcpp2x } from '@evtivity/lib/ocpp-version';
import type { PhaseRotation } from '@evtivity/lib/phase-rotation';
import type {
  UnitBudgetInfo,
  EvseSessionInfo,
  UnitEvseInfo,
  Phase,
  StationPowerInfo,
  PhaseLoad,
} from './load-management-model.js';
import {
  RATE_UNIT_VARIABLES,
  MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE,
  PROFILE_STACK_LEVEL_VARIABLES,
  chargingRateUnitFor,
  supportedRateUnits,
} from './load-management-rate-units.js';
import { loadManagementProfileId } from './load-management-profiles.js';

/**
 * Maximum power of each station: the sum over its EVSEs of the highest
 * connector rating of the EVSE (the connectors of one EVSE cannot charge at
 * the same time). A station with an EVSE whose connectors have no rating gets
 * 0, which the allocation reads as unknown (capped at its equal share).
 */
export function stationMaxPowerKw(
  connectorRows: Array<{ stationId: string; evseDbId: string; maxPowerKw: string | null }>,
): Map<string, number> {
  const evseMax = new Map<string, Map<string, number | null>>();
  for (const row of connectorRows) {
    const perEvse = evseMax.get(row.stationId) ?? new Map<string, number | null>();
    const rating = row.maxPowerKw != null ? Number(row.maxPowerKw) : null;
    const known = rating != null && rating > 0 ? rating : null;
    const current = perEvse.get(row.evseDbId);
    if (current === undefined) {
      perEvse.set(row.evseDbId, known);
    } else if (known != null && (current == null || known > current)) {
      perEvse.set(row.evseDbId, known);
    }
    evseMax.set(row.stationId, perEvse);
  }
  const result = new Map<string, number>();
  for (const [stationId, perEvse] of evseMax) {
    const values = [...perEvse.values()];
    result.set(
      stationId,
      values.some((v) => v == null) ? 0 : values.reduce<number>((sum, v) => sum + (v ?? 0), 0),
    );
  }
  return result;
}

/**
 * Connected power of one station from its connector rows: per unit with a
 * budget the lower of its EVSEs' summed ratings and the budget
 * (`unitBudgetKw`), every other EVSE at its highest connector rating. 0 when
 * an EVSE has no rating, as `stationMaxPowerKw`.
 */
export function stationConnectedKw(
  connectorRows: ReadonlyArray<{
    evseDbId: string;
    unitId?: string | null;
    maxPowerKw: string | null;
  }>,
  unitBudgets: readonly UnitBudgetInfo[],
  circuitVoltageV: number | undefined,
  conductorPhases: number,
): number {
  const evses = new Map<string, { unitId: string | null; kw: number | null }>();
  for (const row of connectorRows) {
    const rating = row.maxPowerKw != null ? Number(row.maxPowerKw) : null;
    const known = rating != null && rating > 0 ? rating : null;
    const current = evses.get(row.evseDbId);
    if (current === undefined) {
      evses.set(row.evseDbId, { unitId: row.unitId ?? null, kw: known });
    } else if (known != null && (current.kw == null || known > current.kw)) {
      current.kw = known;
    }
  }
  const budgets = new Map(unitBudgets.map((b) => [b.unitId, b]));
  const unitTotals = new Map<string, number>();
  let total = 0;
  for (const evse of evses.values()) {
    if (evse.kw == null) return 0;
    if (evse.unitId != null && budgets.has(evse.unitId)) {
      unitTotals.set(evse.unitId, (unitTotals.get(evse.unitId) ?? 0) + evse.kw);
    } else {
      total += evse.kw;
    }
  }
  for (const [unitId, unitKw] of unitTotals) {
    const budget = budgets.get(unitId);
    const capKw = budget == null ? null : unitBudgetKw(budget, circuitVoltageV, conductorPhases);
    total += capKw == null ? unitKw : Math.min(unitKw, capKw);
  }
  return total;
}

const positiveOrNull = (value: number | string | null | undefined): number | null => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The active sessions of each station with what the per-EVSE split needs: the
 * EVSE's number, unit, kind and ratings, the tariff limit in force (the open
 * tariff segment's, else the session snapshot) and the phases. A session
 * without an EVSE is left out: it cannot get an EVSE limit.
 */
export function evseSessions(
  connectorRows: ReadonlyArray<{
    stationId: string;
    evseDbId: string;
    evseNumber?: number | null;
    unitId?: string | null;
    connectorType?: string | null;
    maxPowerKw: string | null;
    maxCurrentAmps?: number | string | null;
  }>,
  sessionRows: ReadonlyArray<{
    stationId: string;
    sessionId?: string;
    transactionId?: string;
    evseDbId?: string | null;
    startedAt?: Date | null;
    chargingKind?: string | null;
    evPhases?: string | null;
    tariffId?: string | null;
    tariffMaxCurrentA?: number | string | null;
    segmentId?: number | null;
    segmentTariffId?: string | null;
    segmentMaxCurrentA?: number | string | null;
  }>,
): Map<string, EvseSessionInfo[]> {
  const evseInfo = new Map<
    string,
    {
      number: number;
      unitId: string | null;
      connectors: Array<{ connectorType: string | null; maxPowerKw: string | null }>;
      ratingKw: number | null;
      ratingA: number | null;
    }
  >();
  for (const row of connectorRows) {
    const info = evseInfo.get(row.evseDbId) ?? {
      number: row.evseNumber ?? 0,
      unitId: row.unitId ?? null,
      connectors: [],
      ratingKw: null,
      ratingA: null,
    };
    info.connectors.push({ connectorType: row.connectorType ?? null, maxPowerKw: row.maxPowerKw });
    const kw = positiveOrNull(row.maxPowerKw);
    if (kw != null && (info.ratingKw == null || kw > info.ratingKw)) info.ratingKw = kw;
    const amps = positiveOrNull(row.maxCurrentAmps);
    if (amps != null && (info.ratingA == null || amps > info.ratingA)) info.ratingA = amps;
    evseInfo.set(row.evseDbId, info);
  }
  const result = new Map<string, EvseSessionInfo[]>();
  for (const row of sessionRows) {
    if (row.sessionId == null || row.evseDbId == null || row.transactionId == null) continue;
    const evse = evseInfo.get(row.evseDbId);
    const evseKind = evse != null ? evseChargingKind(evse.connectors) : null;
    const kind: 'ac' | 'dc' =
      row.chargingKind === 'ac' || row.chargingKind === 'dc'
        ? row.chargingKind
        : evseKind === 'dc'
          ? 'dc'
          : 'ac';
    const fromSegment = row.segmentId != null;
    const list = result.get(row.stationId) ?? [];
    list.push({
      sessionId: row.sessionId,
      transactionId: row.transactionId,
      evseDbId: row.evseDbId,
      evseNumber: evse?.number ?? 0,
      unitId: evse?.unitId ?? null,
      kind,
      ratingKw: evse?.ratingKw ?? null,
      ratingA: evse?.ratingA ?? null,
      tariffId: (fromSegment ? row.segmentTariffId : row.tariffId) ?? null,
      tariffMaxCurrentA: positiveOrNull(
        fromSegment ? row.segmentMaxCurrentA : row.tariffMaxCurrentA,
      ),
      phases: row.evPhases ?? null,
      startedAt: row.startedAt ?? new Date(0),
    });
    result.set(row.stationId, list);
  }
  for (const list of result.values()) {
    list.sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.evseNumber - b.evseNumber,
    );
  }
  return result;
}

/**
 * The stations with an EVSE that is not DC (an EVSE with no typed connector
 * counts as AC), where a car may draw a W limit on one phase.
 */
export function stationsWithAcEvse(
  connectorRows: ReadonlyArray<{
    stationId: string;
    evseDbId: string;
    connectorType?: string | null;
    maxPowerKw: string | null;
  }>,
): Set<string> {
  const byEvse = new Map<
    string,
    {
      stationId: string;
      connectors: Array<{ connectorType: string | null; maxPowerKw: string | null }>;
    }
  >();
  for (const row of connectorRows) {
    const evse = byEvse.get(row.evseDbId) ?? { stationId: row.stationId, connectors: [] };
    evse.connectors.push({ connectorType: row.connectorType ?? null, maxPowerKw: row.maxPowerKw });
    byEvse.set(row.evseDbId, evse);
  }
  const result = new Set<string>();
  for (const evse of byEvse.values()) {
    if (evseChargingKind(evse.connectors) !== 'dc') result.add(evse.stationId);
  }
  return result;
}

/**
 * Per station, the EVSEs of its units (`StationPowerInfo.unitEvses`): number,
 * unit, kind and rating. An EVSE with no typed connector counts as AC; the
 * per-phase current rating of an unrated EVSE is `UNRATED_AC_EVSE_A`, of one
 * rated in kW only its single-phase current.
 */
export function unitEvsesOf(
  connectorRows: ReadonlyArray<{
    stationId: string;
    evseDbId: string;
    evseNumber?: number | null;
    unitId?: string | null;
    connectorType?: string | null;
    maxPowerKw: string | null;
    maxCurrentAmps?: number | string | null;
  }>,
  voltageV = 230,
): Map<string, UnitEvseInfo[]> {
  const evses = new Map<
    string,
    {
      stationId: string;
      evseNumber: number;
      unitId: string;
      connectors: Array<{ connectorType: string | null; maxPowerKw: string | null }>;
      ratingKw: number | null;
      ratingA: number | null;
    }
  >();
  for (const row of connectorRows) {
    if (row.unitId == null || row.evseNumber == null) continue;
    const evse = evses.get(row.evseDbId) ?? {
      stationId: row.stationId,
      evseNumber: row.evseNumber,
      unitId: row.unitId,
      connectors: [],
      ratingKw: null,
      ratingA: null,
    };
    evse.connectors.push({ connectorType: row.connectorType ?? null, maxPowerKw: row.maxPowerKw });
    const kw = positiveOrNull(row.maxPowerKw);
    if (kw != null && (evse.ratingKw == null || kw > evse.ratingKw)) evse.ratingKw = kw;
    const amps = positiveOrNull(row.maxCurrentAmps);
    if (amps != null && (evse.ratingA == null || amps > evse.ratingA)) evse.ratingA = amps;
    evses.set(row.evseDbId, evse);
  }
  const result = new Map<string, UnitEvseInfo[]>();
  for (const evse of evses.values()) {
    const list = result.get(evse.stationId) ?? [];
    list.push({
      evseNumber: evse.evseNumber,
      unitId: evse.unitId,
      kind: evseChargingKind(evse.connectors) === 'dc' ? 'dc' : 'ac',
      ratingA:
        evse.ratingA ??
        (evse.ratingKw != null ? (evse.ratingKw * 1000) / voltageV : UNRATED_AC_EVSE_A),
      ratingKw: evse.ratingKw,
    });
    result.set(evse.stationId, list);
  }
  for (const list of result.values()) list.sort((a, b) => a.evseNumber - b.evseNumber);
  return result;
}

/** The variables a station reports its phase wiring in (2.x per EVSE or connector, 1.6 per connector). */
export const PHASE_ROTATION_VARIABLES = ['PhaseRotation', 'ConnectorPhaseRotation'] as const;

/**
 * The EVSE rotations one stored configuration row reports: a 2.x EVSE or
 * Connector PhaseRotation for its EVSE, or the 1.6 ConnectorPhaseRotation
 * list (connector n is EVSE n; connector 0, the grid to the meter, is left
 * out). A station level 2.x value applies to every EVSE alike, so it tells
 * nothing about how two EVSEs share a phase and is not read.
 */
export function reportedEvseRotations(row: {
  component: string;
  evseId: number | null;
  variable: string;
  value: string | null;
}): Array<[number, PhaseRotation]> {
  if (row.variable === 'ConnectorPhaseRotation') {
    return [...parseConnectorPhaseRotations(row.value)].filter(([connector]) => connector > 0);
  }
  if ((row.component === 'EVSE' || row.component === 'Connector') && row.evseId != null) {
    const rotation = parsePhaseRotation(row.value);
    return rotation != null ? [[row.evseId, rotation]] : [];
  }
  return [];
}

/**
 * The phases of a station's AC sessions as phases of its circuit, so sessions
 * of different EVSEs compare on one frame: each session's measured phases go
 * through its EVSE's rotation (the circuit's operator value, else what the
 * station reports). A station with one AC session keeps its phases (one
 * session shares no phase with another). With two or more, a session whose
 * rotation is not known is counted on every phase of its circuit (phases
 * null), so two sessions are never taken to be on different phases when
 * they may share one.
 */
export function alignSessionPhases(
  sessions: readonly EvseSessionInfo[],
  rotationOf: (session: EvseSessionInfo) => PhaseRotation | null,
): EvseSessionInfo[] {
  const ac = sessions.filter((s) => s.kind === 'ac');
  if (ac.length < 2) return [...sessions];
  return sessions.map((s) => {
    if (s.kind !== 'ac' || s.phases == null) return s;
    if (!(EV_PHASES as readonly string[]).includes(s.phases)) return { ...s, phases: null };
    const rotation = rotationOf(s);
    if (rotation == null) return { ...s, phases: null };
    return { ...s, phases: phasesThroughRotation(s.phases as EvPhases, rotation) };
  });
}

/**
 * OCPP 2.x device model variables the phase accounting reads: the phases a
 * charger or EVSE is wired to (SupplyPhases: 1 or 3 for AC, 0 for DC) and
 * whether an EVSE can pick the phase of a single-phase car
 * (SmartChargingCtrlr.ACPhaseSwitchingSupported, K01.FR.20).
 */
export const PHASE_CAPABILITY_VARIABLES = ['SupplyPhases', 'ACPhaseSwitchingSupported'] as const;

/** What one station reported about its phases, by EVSE number (0: the whole station). */
export interface StationPhaseCapabilities {
  supplyPhases: Map<number, number>;
  /** SupplyPhases of the connectors of each EVSE; null when they differ. */
  connectorSupplyPhases: Map<number, number | null>;
  phaseSwitching: Map<number, boolean>;
  singlePhase: Map<number, Phase>;
}

export function emptyPhaseCapabilities(): StationPhaseCapabilities {
  return {
    supplyPhases: new Map(),
    connectorSupplyPhases: new Map(),
    phaseSwitching: new Map(),
    singlePhase: new Map(),
  };
}

/** Adds one stored configuration row to a station's phase capabilities. */
export function readPhaseCapability(
  caps: StationPhaseCapabilities,
  row: { component: string; evseId: number | null; variable: string; value: string | null },
): void {
  const value = row.value?.trim() ?? '';
  if (row.variable === 'ACPhaseSwitchingSupported') {
    if (row.component !== 'SmartChargingCtrlr') return;
    caps.phaseSwitching.set(row.evseId ?? 0, value.toLowerCase() === 'true');
    return;
  }
  if (row.component === 'Connector' && row.variable === 'SupplyPhases') {
    const n = Number(value);
    if (row.evseId == null || !(n === 0 || n === 1 || n === 3)) return;
    const seen = caps.connectorSupplyPhases.get(row.evseId);
    caps.connectorSupplyPhases.set(row.evseId, seen === undefined || seen === n ? n : null);
    return;
  }
  const evse =
    row.component === 'ChargingStation' ? 0 : row.component === 'EVSE' ? row.evseId : null;
  if (evse == null) return;
  if (row.variable === 'SupplyPhases') {
    const n = Number(value);
    if (n === 0 || n === 1 || n === 3) caps.supplyPhases.set(evse, n);
    return;
  }
  if (row.variable === 'PhaseRotation') {
    const phase = singlePhaseOfRotation(value);
    if (phase != null) caps.singlePhase.set(evse, phase);
  }
}

/**
 * True when the EVSE may be sent a phaseToUse: ACPhaseSwitchingSupported is
 * defined and true for it, or for the station as a whole and not false for it.
 */
export function phaseSwitchingSupported(
  caps: StationPhaseCapabilities,
  evseNumber: number,
): boolean {
  return caps.phaseSwitching.get(evseNumber) ?? caps.phaseSwitching.get(0) ?? false;
}

/**
 * The AC phases a charger is wired to: its station SupplyPhases, else the one
 * value every EVSE of it reports (an EVSE's own value, else the one value its
 * connectors report). Null when not reported or the EVSEs differ.
 */
export function stationSupplyPhases(
  caps: StationPhaseCapabilities,
  evseNumbers: readonly number[],
): number | null {
  const station = caps.supplyPhases.get(0);
  if (station === 1 || station === 3) return station;
  const values = new Set(
    evseNumbers.map((n) => caps.supplyPhases.get(n) ?? caps.connectorSupplyPhases.get(n) ?? null),
  );
  if (values.size !== 1) return null;
  const [only] = [...values];
  return only === 1 || only === 3 ? only : null;
}

/** The circuit phase a single-phase charger reports it is wired to; null when not known. */
export function stationSinglePhase(
  caps: StationPhaseCapabilities,
  evseNumbers: readonly number[],
): Phase | null {
  const station = caps.singlePhase.get(0);
  if (station != null) return station;
  const values = new Set(evseNumbers.map((n) => caps.singlePhase.get(n) ?? null));
  if (values.size !== 1) return null;
  return [...values][0] ?? null;
}

export async function getSitePowerStatus(siteId: string): Promise<{
  totalDrawKw: number;
  stations: StationPowerInfo[];
}> {
  const since = new Date(Date.now() - 60_000);

  // Get all stations at the site with their priority and online status.
  // Conformance test stations are never load managed.
  const stationRows = await db
    .select({
      id: chargingStations.id,
      stationId: chargingStations.stationId,
      isOnline: chargingStations.isOnline,
      loadPriority: chargingStations.loadPriority,
      loadMinPowerKw: chargingStations.loadMinPowerKw,
      circuitId: chargingStations.circuitId,
      loadBalancingMode: chargingStations.loadBalancingMode,
      evseLimitsRefusedAt: chargingStations.evseLimitsRefusedAt,
      usesUnits: chargingStations.usesUnits,
      circuitPhaseRotation: circuits.phaseRotation,
      ocppProtocol: chargingStations.ocppProtocol,
    })
    .from(chargingStations)
    .leftJoin(circuits, eq(circuits.id, chargingStations.circuitId))
    .where(and(eq(chargingStations.siteId, siteId), isOperatorStation()));

  if (stationRows.length === 0) {
    return { totalDrawKw: 0, stations: [] };
  }

  const stationDbIds = stationRows.map((s) => s.id);

  // The remaining queries depend only on the station ids and run in parallel.
  // Power readings are read once and split into overall and per-phase below.
  const [
    connectorRows,
    activeSessions,
    allPowerValues,
    chargingNeedsRows,
    rateUnitRows,
    unitBudgetRows,
  ] = await Promise.all([
    db
      .select({
        stationId: evses.stationId,
        evseDbId: evses.id,
        evseNumber: evses.evseId,
        unitId: evses.unitId,
        connectorType: connectors.connectorType,
        maxPowerKw: connectors.maxPowerKw,
        maxCurrentAmps: connectors.maxCurrentAmps,
      })
      .from(connectors)
      .innerJoin(evses, eq(connectors.evseId, evses.id))
      .where(inArray(evses.stationId, stationDbIds)),
    db
      .select({
        stationId: chargingSessions.stationId,
        sessionId: chargingSessions.id,
        transactionId: chargingSessions.transactionId,
        evseDbId: chargingSessions.evseId,
        startedAt: chargingSessions.startedAt,
        chargingKind: chargingSessions.chargingKind,
        evPhases: chargingSessions.evPhases,
        tariffId: chargingSessions.tariffId,
        tariffMaxCurrentA: chargingSessions.tariffMaxCurrentA,
        segmentId: sessionTariffSegments.id,
        segmentTariffId: sessionTariffSegments.tariffId,
        segmentMaxCurrentA: sessionTariffSegments.maxCurrentA,
      })
      .from(chargingSessions)
      .leftJoin(
        sessionTariffSegments,
        and(
          eq(sessionTariffSegments.sessionId, chargingSessions.id),
          isNull(sessionTariffSegments.endedAt),
        ),
      )
      .where(
        and(
          eq(chargingSessions.status, 'active'),
          inArray(chargingSessions.stationId, stationDbIds),
        ),
      ),
    db
      .select({
        stationId: meterValues.stationId,
        evseDbId: meterValues.evseId,
        value: meterValues.value,
        unit: meterValues.unit,
        phase: meterValues.phase,
        measurand: meterValues.measurand,
      })
      .from(meterValues)
      .where(
        and(
          inArray(meterValues.measurand, ['Power.Active.Import', 'Current.Import']),
          gte(meterValues.timestamp, since),
          inArray(meterValues.stationId, stationDbIds),
        ),
      )
      .orderBy(desc(meterValues.timestamp)),
    db
      .select({
        stationId: evChargingNeeds.stationId,
        departureTime: evChargingNeeds.departureTime,
      })
      .from(evChargingNeeds)
      .where(inArray(evChargingNeeds.stationId, stationDbIds)),
    db
      .select({
        stationId: stationConfigurations.stationId,
        component: stationConfigurations.component,
        evseId: stationConfigurations.evseId,
        variable: stationConfigurations.variable,
        value: stationConfigurations.value,
      })
      .from(stationConfigurations)
      .where(
        and(
          inArray(stationConfigurations.stationId, stationDbIds),
          inArray(stationConfigurations.variable, [
            ...RATE_UNIT_VARIABLES,
            MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE,
            ...PROFILE_STACK_LEVEL_VARIABLES,
            ...PHASE_ROTATION_VARIABLES,
            ...PHASE_CAPABILITY_VARIABLES,
          ]),
          eq(stationConfigurations.attributeType, 'Actual'),
        ),
      ),
    db
      .select({
        stationId: stationUnitLoadBudgets.stationId,
        unitId: stationUnitLoadBudgets.unitId,
        kind: stationUnitLoadBudgets.kind,
        maxCurrentA: stationUnitLoadBudgets.maxCurrentA,
        phases: stationUnitLoadBudgets.phases,
        maxPowerKw: stationUnitLoadBudgets.maxPowerKw,
      })
      .from(stationUnitLoadBudgets)
      .where(inArray(stationUnitLoadBudgets.stationId, stationDbIds)),
  ]);
  const unitBudgetsByStation = new Map<string, UnitBudgetInfo[]>();
  for (const row of unitBudgetRows) {
    const list = unitBudgetsByStation.get(row.stationId) ?? [];
    list.push({
      unitId: row.unitId,
      kind: row.kind === 'dc' ? 'dc' : 'ac',
      maxCurrentA: positiveOrNull(row.maxCurrentA),
      phases: row.phases,
      maxPowerKw: positiveOrNull(row.maxPowerKw),
    });
    unitBudgetsByStation.set(row.stationId, list);
  }
  const reportedUnits = new Map<string, string[]>();
  const maxExternalIds = new Map<string, string>();
  const maxStackLevels = new Map<string, number>();
  const reportedRotations = new Map<string, Map<number, PhaseRotation>>();
  const phaseCapabilities = new Map<string, StationPhaseCapabilities>();
  for (const row of rateUnitRows) {
    if (row.value == null) continue;
    if (
      (PHASE_CAPABILITY_VARIABLES as readonly string[]).includes(row.variable) ||
      row.variable === 'PhaseRotation'
    ) {
      const caps = phaseCapabilities.get(row.stationId) ?? emptyPhaseCapabilities();
      readPhaseCapability(caps, row);
      phaseCapabilities.set(row.stationId, caps);
    }
    if ((PHASE_ROTATION_VARIABLES as readonly string[]).includes(row.variable)) {
      const byEvse = reportedRotations.get(row.stationId) ?? new Map<number, PhaseRotation>();
      for (const [evse, rotation] of reportedEvseRotations(row)) {
        // An EVSE's own value wins over one of its connectors.
        if (row.component === 'EVSE' || !byEvse.has(evse)) byEvse.set(evse, rotation);
      }
      reportedRotations.set(row.stationId, byEvse);
      continue;
    }
    if (row.variable === MAX_EXTERNAL_CONSTRAINTS_ID_VARIABLE) {
      maxExternalIds.set(row.stationId, row.value);
      continue;
    }
    if ((PROFILE_STACK_LEVEL_VARIABLES as readonly string[]).includes(row.variable)) {
      const level = Number(row.value);
      if (Number.isInteger(level) && level >= 0) maxStackLevels.set(row.stationId, level);
      continue;
    }
    const list = reportedUnits.get(row.stationId) ?? [];
    list.push(row.value);
    reportedUnits.set(row.stationId, list);
  }
  // Partition the single power query in JS: rows without a phase populate
  // the overall most-recent map, rows with a phase populate the per-phase
  // map. desc(timestamp) ordering above guarantees first-row-wins per
  // (station, [phase]) bucket.
  const powerRows = allPowerValues.filter((r) => r.measurand !== 'Current.Import');
  const powerValues = powerRows.filter((r) => r.phase == null);
  const phasePowerValues = powerRows.filter((r) => r.phase != null);
  const evseCurrentA = latestEvsePhaseCurrentA(
    allPowerValues.filter((r) => r.measurand === 'Current.Import'),
  );

  const stationMaxPower = stationMaxPowerKw(connectorRows);

  const activeStationIds = new Set(activeSessions.map((s) => s.stationId));
  const evseNumbersByStation = new Map<string, number[]>();
  for (const row of connectorRows) {
    const list = evseNumbersByStation.get(row.stationId) ?? [];
    if (!list.includes(row.evseNumber)) list.push(row.evseNumber);
    evseNumbersByStation.set(row.stationId, list);
  }
  const sessionsByStation = evseSessions(connectorRows, activeSessions);
  const unitEvsesByStation = unitEvsesOf(connectorRows);
  const acStations = stationsWithAcEvse(connectorRows);

  // Most recent power reading per EVSE, summed per station. A reading without
  // an EVSE is the station total and counts only when the station sent no
  // EVSE reading: a station with several EVSEs charging reports each one.
  const evsePower = new Map<string, Map<string, number>>();
  const stationLevelPower = new Map<string, number>();
  for (const row of powerValues) {
    let kw = Number(row.value);
    // Convert W to kW if unit is W or not specified
    if (row.unit == null || row.unit === 'W') {
      kw = kw / 1000;
    }
    if (row.evseDbId == null) {
      if (!stationLevelPower.has(row.stationId)) stationLevelPower.set(row.stationId, kw);
      continue;
    }
    const perEvse = evsePower.get(row.stationId) ?? new Map<string, number>();
    if (!perEvse.has(row.evseDbId)) perEvse.set(row.evseDbId, kw);
    evsePower.set(row.stationId, perEvse);
  }
  const stationPower = new Map<string, number>(stationLevelPower);
  for (const [stationId, perEvse] of evsePower) {
    stationPower.set(
      stationId,
      [...perEvse.values()].reduce((sum, kw) => sum + kw, 0),
    );
  }

  // Take the most recent per-phase reading per station
  const stationPhasePower = new Map<string, PhaseLoad>();
  const seenPhases = new Map<string, Set<string>>();
  for (const row of phasePowerValues) {
    const phase = row.phase;
    if (phase == null || !['L1', 'L2', 'L3'].includes(phase)) continue;
    const seen = seenPhases.get(row.stationId) ?? new Set<string>();
    if (seen.has(phase)) continue;
    seen.add(phase);
    seenPhases.set(row.stationId, seen);

    let kw = Number(row.value);
    if (row.unit == null || row.unit === 'W') {
      kw = kw / 1000;
    }

    const existing = stationPhasePower.get(row.stationId) ?? { L1: 0, L2: 0, L3: 0 };
    existing[phase as 'L1' | 'L2' | 'L3'] = kw;
    stationPhasePower.set(row.stationId, existing);
  }

  // Map earliest departure time per station
  const stationDeparture = new Map<string, Date>();
  for (const row of chargingNeedsRows) {
    if (row.departureTime == null) continue;
    const existing = stationDeparture.get(row.stationId);
    if (existing == null || row.departureTime < existing) {
      stationDeparture.set(row.stationId, row.departureTime);
    }
  }

  const refusalCutoffMs = Date.now() - EVSE_LIMITS_REFUSAL_RETRY_MS;
  let totalDrawKw = 0;
  const stationInfos: StationPowerInfo[] = stationRows.map((station) => {
    const currentDrawKw = stationPower.get(station.id) ?? 0;
    totalDrawKw += currentDrawKw;
    const draws = evsePower.get(station.id);
    const override = parsePhaseRotation(station.circuitPhaseRotation);
    const reported = reportedRotations.get(station.id);
    // Phase selection and SupplyPhases are OCPP 2.x device model variables.
    const caps = isOcpp2x(station.ocppProtocol)
      ? (phaseCapabilities.get(station.id) ?? emptyPhaseCapabilities())
      : emptyPhaseCapabilities();
    const rotationOf = (s: EvseSessionInfo): PhaseRotation | null =>
      override ?? reported?.get(s.evseNumber) ?? null;
    const sessions = alignSessionPhases(
      (sessionsByStation.get(station.id) ?? []).map((s) => ({
        ...s,
        drawKw: draws?.get(s.evseDbId) ?? null,
        drawA: evseCurrentA.get(s.evseDbId) ?? null,
        measuredPhases: s.phases,
        rotation: rotationOf(s),
        phaseSwitching: phaseSwitchingSupported(caps, s.evseNumber),
      })),
      rotationOf,
    );
    const supply = stationSupplyPhases(caps, evseNumbersByStation.get(station.id) ?? []);
    const supplyPanelPhase =
      supply === 1
        ? override != null
          ? singlePhaseOfRotation(override)
          : stationSinglePhase(caps, evseNumbersByStation.get(station.id) ?? [])
        : null;
    const refusedAt = station.evseLimitsRefusedAt ?? null;
    return {
      id: station.id,
      stationId: station.stationId,
      circuitId: station.circuitId,
      currentDrawKw,
      phasePowerKw: stationPhasePower.get(station.id) ?? null,
      maxPowerKw: stationMaxPower.get(station.id) ?? 0,
      loadPriority: station.loadPriority,
      isOnline: station.isOnline,
      hasActiveSession: activeStationIds.has(station.id),
      departureTime: stationDeparture.get(station.id) ?? null,
      minPowerKw: station.loadMinPowerKw != null ? Number(station.loadMinPowerKw) : 0,
      rateUnit: chargingRateUnitFor(reportedUnits.get(station.id) ?? []),
      supportedRateUnits: supportedRateUnits(reportedUnits.get(station.id) ?? []),
      profileId: loadManagementProfileId(maxExternalIds.get(station.id)),
      maxStackLevel: maxStackLevels.get(station.id) ?? null,
      evseDrawKw: Object.fromEntries(evsePower.get(station.id) ?? []),
      drawMeasured: stationPower.has(station.id),
      balancingMode: station.loadBalancingMode === 'evse' ? 'evse' : 'station',
      // A refusal is read for an hour, then per-EVSE limits are tried again.
      evseLimitsRefusedAt:
        refusedAt != null && refusedAt.getTime() > refusalCutoffMs ? refusedAt : null,
      sessions,
      unitEvses: unitEvsesByStation.get(station.id) ?? [],
      hasAcEvse: acStations.has(station.id) || !evseNumbersByStation.has(station.id),
      supplyPhases: supply,
      supplyPanelPhase,
      unitBudgets: unitBudgetsByStation.get(station.id) ?? [],
      usesUnits: station.usesUnits,
      ocpp2x: isOcpp2x(station.ocppProtocol),
    };
  });

  return { totalDrawKw, stations: stationInfos };
}

/**
 * The highest of the latest `Current.Import` readings of each line phase of
 * each EVSE, A, by EVSE database id: the L1 to L3 readings (also as L1-N) when
 * the EVSE reports any, else its latest reading without a phase. The neutral
 * (N) and any other phase value never count. Rows newest first; a reading
 * without an EVSE belongs to no session and is left out.
 */
export function latestEvsePhaseCurrentA(
  rows: ReadonlyArray<{ evseDbId: string | null; value: string | number; phase: string | null }>,
): Map<string, number> {
  const seen = new Set<string>();
  const perPhase = new Map<string, number>();
  const phaseless = new Map<string, number>();
  for (const row of rows) {
    if (row.evseDbId == null) continue;
    const line = row.phase == null ? null : /^(L[123])(-N)?$/.exec(row.phase)?.[1];
    if (row.phase != null && line == null) continue;
    const key = `${row.evseDbId}:${line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const amps = Number(row.value);
    if (!Number.isFinite(amps) || amps < 0) continue;
    if (line == null) phaseless.set(row.evseDbId, amps);
    else perPhase.set(row.evseDbId, Math.max(perPhase.get(row.evseDbId) ?? 0, amps));
  }
  const result = new Map(phaseless);
  for (const [evse, amps] of perPhase) result.set(evse, amps);
  return result;
}
