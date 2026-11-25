// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The model site of the property test: a service transformer with a solar
// array, a three-phase panel with per-phase limits, a three-phase circuit and
// a single-phase circuit on L2. It builds what the CSMS reads each cycle (the
// tree and the station status) the way `buildSiteHierarchy` and
// `getSitePowerStatus` assemble them, from the station models.

import {
  chargingRateUnitFor,
  supportedRateUnits,
} from '@evtivity/services/load-management-rate-units';
import { circuitPhaseShare } from '@evtivity/services/load-management-phases';
import {
  alignSessionPhases,
  evseSessions,
  stationMaxPowerKw,
  unitEvsesOf,
} from '@evtivity/services/load-management-site-status';
import { loadManagementProfileId } from '@evtivity/services/load-management-profiles';
import {
  type HierarchyNode,
  type StationPowerInfo,
} from '@evtivity/services/load-management-model';
import {
  CONTINUOUS_LOAD_FACTOR,
  circuitConductorPhases,
  effectiveCircuitVoltageV,
} from '@evtivity/lib/load-allocation';
import type { PhaseRotation } from '@evtivity/lib/phase-rotation';
import { PHASE_VOLTAGE_V, actualDraws, type ModelStation, type Phase } from './station-physics.js';

export interface SiteSpec {
  transformerKw: number;
  panelKw: number;
  panelBreakerA: number;
  panelUnmanagedKw: number;
  threePhaseBreakerA: number;
  singlePhaseBreakerA: number;
  strategy: 'equal_share' | 'priority_based';
}

/** Solar on the transformer: what the CSMS reads, and what it produces. */
export interface SolarState {
  creditKw: number;
  /** The end of the last reading's freshness; null: no fresh reading. */
  freshUntilMs: number | null;
  /** The assets could not be read this cycle. */
  unknown: boolean;
}

export const SITE_ID = 'sit_prop';

export function circuitKw(breakerA: number, phases: number): number {
  return (breakerA * PHASE_VOLTAGE_V * phases * CONTINUOUS_LOAD_FACTOR) / 1000;
}

export function panelPhaseKw(spec: SiteSpec): number {
  return Math.min(
    (spec.panelBreakerA * PHASE_VOLTAGE_V * CONTINUOUS_LOAD_FACTOR) / 1000,
    spec.panelKw / 3,
  );
}

function rotationOf(wiring: readonly Phase[]): PhaseRotation {
  const letter: Record<Phase, string> = { L1: 'R', L2: 'S', L3: 'T' };
  return wiring.map((p) => letter[p]).join('') as PhaseRotation;
}

/** The station status the CSMS reads (getSitePowerStatus), before the tree sets the circuit fields. */
export function stationStatus(model: ModelStation, nowMs: number): StationPowerInfo {
  const ocpp2x = model.protocol !== 'ocpp1.6';
  const connectorRows = model.evses.map((evse) => ({
    stationId: model.id,
    evseDbId: `${model.id}_e${String(evse.number)}`,
    evseNumber: evse.number,
    unitId: evse.unitId,
    connectorType: evse.kind === 'dc' ? 'CCS2' : 'Type2',
    maxPowerKw: evse.reportedKw != null ? String(evse.reportedKw) : null,
    maxCurrentAmps: evse.kind === 'ac' ? evse.ratingA : null,
  }));
  const sessionRows = [...model.cars.entries()].map(([evseNumber, car]) => ({
    stationId: model.id,
    sessionId: car.sessionId,
    transactionId: car.transactionId,
    evseDbId: `${model.id}_e${String(evseNumber)}`,
    startedAt: new Date(car.startedAtMs),
    chargingKind: model.evses.find((e) => e.number === evseNumber)?.kind ?? 'ac',
    // What the station measures, in the EVSE's own frame.
    evPhases: car.phases === 3 ? 'L1L2L3' : `L${String(car.evsePhase)}`,
    tariffId: null,
    tariffMaxCurrentA: null,
  }));
  // What the station measures: each charging EVSE's power and current, sent
  // while the station is connected (an offline station's readings age out).
  const draws: ReturnType<typeof actualDraws> = model.online
    ? actualDraws(model, nowMs)
    : new Map();
  const evseDbId = (n: number): string => `${model.id}_e${String(n)}`;
  const rotations = new Map(model.evses.map((e) => [e.number, rotationOf(e.wiring)]));
  const known = model.wiringKnown && ocpp2x;
  const rotationFor = (s: { evseNumber: number }): PhaseRotation | null =>
    known ? (rotations.get(s.evseNumber) ?? null) : null;
  const sessions = alignSessionPhases(
    (evseSessions(connectorRows, sessionRows).get(model.id) ?? []).map((s) => ({
      ...s,
      drawKw: draws.get(s.evseNumber)?.kw ?? null,
      drawA: draws.get(s.evseNumber)?.a ?? null,
      measuredPhases: s.phases,
      rotation: rotationFor(s),
      phaseSwitching: model.protocol === 'ocpp2.1' && model.phaseSwitching,
    })),
    rotationFor,
  );
  const reported = model.reportedUnits.map((u) => (u === 'A' ? 'A' : 'W'));
  const supply = ocpp2x ? (model.singlePhaseCharger ? 1 : 3) : null;
  // The phase a single-phase charger reports: null when its EVSEs report different ones.
  const firstWires = new Set(model.evses.map((e) => e.wiring[0] ?? null));
  const firstWire = firstWires.size === 1 ? ([...firstWires][0] ?? null) : null;
  const evseDrawKw = Object.fromEntries([...draws].map(([n, d]) => [evseDbId(n), d.kw]));
  const currentDrawKw = Object.values(evseDrawKw).reduce((sum, kw) => sum + kw, 0);
  return {
    id: model.id,
    stationId: model.ocppId,
    circuitId: model.circuit === 'three' ? 'cir_three' : 'cir_single',
    currentDrawKw,
    phasePowerKw: null,
    maxPowerKw: stationMaxPowerKw(connectorRows).get(model.id) ?? 0,
    loadPriority: model.loadPriority,
    isOnline: model.online,
    hasActiveSession: model.cars.size > 0,
    departureTime: null,
    minPowerKw: model.minPowerKw,
    rateUnit: chargingRateUnitFor(reported),
    supportedRateUnits: supportedRateUnits(reported),
    profileId: loadManagementProfileId(null),
    maxStackLevel: model.maxStackLevel,
    evseDrawKw,
    drawMeasured: draws.size > 0,
    balancingMode: model.balancing,
    evseLimitsRefusedAt: null,
    sessions,
    unitEvses: unitEvsesOf(connectorRows).get(model.id) ?? [],
    supplyPhases: supply,
    supplyPanelPhase: supply === 1 && known ? firstWire : null,
    unitBudgets: model.units.map((u) => ({
      unitId: u.id,
      kind: 'ac' as const,
      maxCurrentA: u.budgetA,
      phases: u.phases,
      maxPowerKw: null,
    })),
    usesUnits: model.units.length > 0,
  };
}

function circuitNode(
  id: string,
  breakerA: number,
  phaseConnections: string,
  stations: StationPowerInfo[],
  unmanagedKw: number,
): HierarchyNode {
  const conductors = circuitConductorPhases(phaseConnections, 3);
  const voltage = effectiveCircuitVoltageV(null, PHASE_VOLTAGE_V, 3);
  const maxKw = circuitKw(breakerA, conductors);
  for (const station of stations) {
    const singleOnThree = station.supplyPhases === 1 && conductors === 3;
    const stationPhases = singleOnThree ? 1 : conductors;
    if (station.supportedRateUnits != null && station.supportedRateUnits.length > 0) {
      station.rateUnit = chargingRateUnitFor(station.supportedRateUnits);
    }
    station.circuitVoltageV = voltage;
    station.circuitPhases = stationPhases;
    station.singlePhaseOnThreePhase = singleOnThree;
    station.circuitCapacityKw = maxKw;
  }
  return {
    type: 'circuit',
    id,
    name: id,
    maxContinuousKw: maxKw,
    safetyMarginKw: 0,
    unmanagedLoadKw: unmanagedKw,
    currentDrawKw: stations.reduce((s, x) => s + x.currentDrawKw, 0) + unmanagedKw,
    stations,
    children: [],
    phases: 3,
    breakerRatingAmps: breakerA,
    voltageV: voltage,
    oversubscriptionRatio: 1,
    phaseConnections,
    phaseLoad: null,
    perPhaseCapacityKw: null,
    ownVoltageV: null,
  };
}

/** The tree the CSMS builds for a cycle (buildSiteHierarchyWithAssets). */
export function siteTree(
  spec: SiteSpec,
  stations: StationPowerInfo[],
  solar: SolarState,
  nowMs: number,
): { roots: HierarchyNode[]; energyAssets: 'read' | 'unknown' } {
  const three = circuitNode(
    'cir_three',
    spec.threePhaseBreakerA,
    'L1L2L3',
    stations.filter((s) => s.circuitId === 'cir_three'),
    0,
  );
  const single = circuitNode(
    'cir_single',
    spec.singlePhaseBreakerA,
    'L2',
    stations.filter((s) => s.circuitId === 'cir_single'),
    0,
  );
  const panel: HierarchyNode = {
    type: 'panel',
    id: 'pnl_main',
    name: 'Main',
    maxContinuousKw: spec.panelKw,
    safetyMarginKw: 0,
    unmanagedLoadKw: spec.panelUnmanagedKw,
    currentDrawKw: 0,
    stations: [],
    children: [three, single],
    phases: 3,
    breakerRatingAmps: spec.panelBreakerA,
    voltageV: PHASE_VOLTAGE_V,
    oversubscriptionRatio: 1,
    phaseConnections: null,
    phaseLoad: { L1: 0, L2: 0, L3: 0 },
    perPhaseCapacityKw: panelPhaseKw(spec),
  };
  const fresh =
    !solar.unknown &&
    solar.freshUntilMs != null &&
    solar.freshUntilMs > nowMs &&
    solar.creditKw > 0;
  const transformer: HierarchyNode = {
    type: 'transformer',
    transformerKind: 'service',
    id: 'tfm_main',
    name: 'Transformer',
    maxContinuousKw: spec.transformerKw,
    safetyMarginKw: 0,
    unmanagedLoadKw: 0,
    currentDrawKw: 0,
    stations: [],
    children: [panel],
    phases: 3,
    breakerRatingAmps: 0,
    voltageV: PHASE_VOLTAGE_V,
    oversubscriptionRatio: 1,
    phaseConnections: null,
    phaseLoad: { L1: 0, L2: 0, L3: 0 },
    perPhaseCapacityKw: spec.transformerKw / 3,
    ...(fresh
      ? {
          supplyCreditKw: solar.creditKw,
          supplyPhaseCreditKw: {
            L1: solar.creditKw / 3,
            L2: solar.creditKw / 3,
            L3: solar.creditKw / 3,
          },
          energyAssets: [
            {
              id: 'ena_solar',
              name: 'Solar',
              type: 'solar' as const,
              phases: 3,
              telemetry: 'api' as const,
              connection: 'transformer' as const,
              state: 'fresh' as const,
              creditKw: solar.creditKw,
              loadKw: 0,
              creditApplied: true,
              readingReceivedAt: new Date(nowMs),
              socPercent: null,
              freshUntil: new Date(solar.freshUntilMs ?? nowMs),
            },
          ],
        }
      : {}),
  };
  // The panel's own load and the circuits' draw per phase, as the builder adds them.
  const phaseLoad = panel.phaseLoad as Record<Phase, number>;
  for (const phase of ['L1', 'L2', 'L3'] as const) phaseLoad[phase] += spec.panelUnmanagedKw / 3;
  for (const circuit of panel.children) {
    const { phases, share } = circuitPhaseShare(circuit.phaseConnections, panel.phases);
    for (const phase of phases) phaseLoad[phase] += circuit.currentDrawKw * share;
  }
  return { roots: [transformer], energyAssets: solar.unknown ? 'unknown' : 'read' };
}
