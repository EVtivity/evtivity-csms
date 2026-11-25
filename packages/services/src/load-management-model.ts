// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type {
  EnergyAssetSupply,
  EnergyAssetTelemetry,
  EnergyAssetType,
  ServiceLogger,
  TransformerKind,
} from '@evtivity/lib';
import type { PhaseRotation } from '@evtivity/lib/phase-rotation';
import type { LoadAllocationReason } from '@evtivity/lib/load-allocation-reasons';

export interface PhaseLoad {
  L1: number;
  L2: number;
  L3: number;
}

export type LoadBalancingMode = 'station' | 'evse';

/** An active session of a station, as the per-EVSE split reads it. */
export interface EvseSessionInfo {
  sessionId: string;
  transactionId: string;
  evseDbId: string;
  evseNumber: number;
  unitId: string | null;
  kind: 'ac' | 'dc';
  /** Highest connector rating of the EVSE in kW; null: unrated. */
  ratingKw: number | null;
  /** Highest connector current rating of the EVSE in A; null: unrated. */
  ratingA: number | null;
  tariffId: string | null;
  /** The tariff current limit in force, A per phase: the open segment's, else the session's. */
  tariffMaxCurrentA: number | null;
  /**
   * The phases the session charges on, as phases of the station's circuit
   * (`alignSessionPhases`); null: not known, counted on every phase.
   */
  phases: string | null;
  startedAt: Date;
  /** The EVSE's latest measured draw in kW; null without a reading. */
  drawKw?: number | null;
  /** The EVSE limit last sent for this session in kW; null when none was sent. */
  heldLimitKw?: number | null;
  /** The highest latest `Current.Import` phase reading of the EVSE, A; null without one. */
  drawA?: number | null;
  /** The EVSE limit last sent for this session in A per phase; null when none or in W. */
  heldLimitA?: number | null;
  /** The phases the station measured, in the EVSE's own frame (before `alignSessionPhases`). */
  measuredPhases?: string | null;
  /** How the EVSE is wired to the circuit's phases; null when not known. */
  rotation?: PhaseRotation | null;
  /** The EVSE reports SmartChargingCtrlr.ACPhaseSwitchingSupported true (OCPP 2.x only). */
  phaseSwitching?: boolean;
  /** The EVSE phase (1 to 3) the session is sent to charge on (phaseToUse); null: none chosen. */
  phaseToUse?: number | null;
  /** When the station was first sent `phaseToUse` for the session, ms. */
  phaseToUseSinceMs?: number | null;
  /** The station refused or did not follow a phase choice: the session keeps its measured phase. */
  phaseToUseRefused?: boolean;
  /**
   * The circuit phase the station still measures the car on after a phase
   * choice (`phases` is the chosen one); null once the car follows it. The
   * phase accounting counts the session on both until then (`withPendingPhases`).
   */
  pendingPhases?: string | null;
}

/** One EVSE of a unit box. */
export interface UnitEvseInfo {
  evseNumber: number;
  unitId: string;
  kind: 'ac' | 'dc';
  /** Per-phase current rating, A (`unitEvsesOf`). */
  ratingA: number;
  /** Highest connector rating, kW; null when unrated. */
  ratingKw: number | null;
}

/** The budget of one Station Unit: AC in A per phase on 1 or 3 phases, DC in kW. */
export interface UnitBudgetInfo {
  unitId: string;
  kind: 'ac' | 'dc';
  maxCurrentA: number | null;
  phases: number | null;
  maxPowerKw: number | null;
}

export interface StationPowerInfo {
  id: string;
  stationId: string;
  circuitId: string | null;
  currentDrawKw: number;
  phasePowerKw: PhaseLoad | null;
  maxPowerKw: number;
  loadPriority: number;
  isOnline: boolean;
  hasActiveSession: boolean;
  departureTime: Date | null;
  /** Lowest power in kW a charging session gets before it is stopped (0: none). */
  minPowerKw: number;
  /**
   * Charging rate unit of the station's limit: A whenever it reports A or
   * accepted an A limit before (`withSendRateUnits`), else W.
   */
  rateUnit: ChargingRateUnit;
  /** The limit the station may still enforce may be a W limit (`mightEnforceInWatts`). */
  heldWattLimit?: boolean;
  /** Units the station reports it takes (empty: it reported none). */
  supportedRateUnits?: ChargingRateUnit[];
  /** Id of the station's load management profile (`loadManagementProfileId`). */
  profileId: number;
  /**
   * Highest charging profile stack level the station reports it takes (2.1
   * `SmartChargingCtrlr.ProfileStackLevel`, 1.6 `ChargeProfileMaxStackLevel`);
   * null when it reported none. Below the credit stack level it is sent no
   * credit profile (`LOAD_MANAGEMENT_CREDIT_STACK_LEVEL`).
   */
  maxStackLevel?: number | null;
  /** Latest power reading per EVSE database id in kW, for the EVSEs that sent one. */
  evseDrawKw?: Record<string, number>;
  /** True when `currentDrawKw` comes from a reading (false: no reading in the last minute). */
  drawMeasured?: boolean;
  /** Local generation the station reported (OCPP 2.1 K27), kW; set by `buildSiteHierarchy`. */
  localGenerationKw?: number;
  /** The operator's balancing mode; 'evse' splits the station limit per charging EVSE. */
  balancingMode?: LoadBalancingMode;
  /** When the station refused a per-EVSE limit; set: one station limit only. */
  evseLimitsRefusedAt?: Date | null;
  /** Voltage of the station's circuit (V, phase to neutral on a 3-phase panel); set by `buildSiteHierarchy`. */
  circuitVoltageV?: number;
  /** Conductor phases of the station's circuit (1 to 3); set by `buildSiteHierarchy`. */
  circuitPhases?: number;
  /**
   * Capacity of the station's circuit, kW; set by `buildSiteHierarchy`. The
   * most an unrated station (no maximum) is counted at.
   */
  circuitCapacityKw?: number;
  /** Active sessions of the station, one per charging EVSE. */
  sessions?: EvseSessionInfo[];
  /** The EVSEs of the station's units (`unitEvsesOf`; the unit box bound, `unitBoxPlan`). */
  unitEvses?: UnitEvseInfo[];
  /**
   * False when every EVSE of the station is DC (`stationsWithAcEvse`): its W
   * limit then loads the phases evenly. Absent counts as true.
   */
  hasAcEvse?: boolean;
  /**
   * Set by the allocation: the station's limit is split per phase onto the
   * phases its sessions charge on (`stationSplitWeights`), so the whole
   * allocation reaches its sessions.
   */
  phaseSplit?: boolean;
  /** Budgets of the station's units; a unit without one adds no constraint. */
  unitBudgets?: UnitBudgetInfo[];
  /** The station groups its EVSEs in units (physical charger boxes). */
  usesUnits?: boolean;
  /**
   * AC phases the charger is wired to (2.x SupplyPhases of the station, or of
   * every EVSE): 1 for a single-phase charger, 3 for three-phase; null when
   * not reported (every 1.6 station: its circuit's phases stand for it).
   */
  supplyPhases?: number | null;
  /**
   * The circuit phase a single-phase charger is wired to (the circuit's
   * operator rotation, else its reported PhaseRotation); null when not known.
   */
  supplyPanelPhase?: Phase | null;
  /**
   * A single-phase charger on a three-phase circuit (set by `buildSiteHierarchy`,
   * which then gives it one circuit phase): it loads its one phase in full.
   */
  singlePhaseOnThreePhase?: boolean;
}

export type ChargingRateUnit = 'A' | 'W';

export interface AllocationResult {
  stationId: string;
  stationDbId: string;
  allocatedKw: number;
  currentDrawKw: number;
  /** What set the limit, for the allocation log; absent: not known. */
  limitedBy?: LoadAllocationReason;
  /** The station's share of the limit per phase when split per phase (`stationPhaseWeights`). */
  phaseWeights?: PhaseLoad;
}

/** What the depot plan fixes for the current slot (departure-aware sites). */
export interface PlannedAllocationInput {
  kw?: ReadonlyMap<string, number>;
  sharing?: ReadonlySet<string>;
  minKw?: ReadonlyMap<string, number>;
}

/**
 * A battery or solar asset connected at a hierarchy node, with the supply it
 * gives this allocation (`energyAssetSupply`, @evtivity/lib/energy-supply).
 */
export interface EnergyAssetNodeSupply {
  id: string;
  name: string;
  type: EnergyAssetType;
  phases: number;
  telemetry: EnergyAssetTelemetry;
  /** `transformer`: supply-side (NEC 705.11); `panel`: load-side (705.12). */
  connection: 'transformer' | 'panel';
  state: EnergyAssetSupply['state'];
  /** Credit the asset gives, kW (0 unless its reading is fresh). */
  creditKw: number;
  /** Load it adds at its connection point, kW. */
  loadKw: number;
  /** False when no node takes the credit (a load-side asset on a root panel). */
  creditApplied: boolean;
  readingReceivedAt: Date | null;
  socPercent: number | null;
  /**
   * When the reading stops being fresh (`energyAssetReadingFreshUntilMs`);
   * null without a fresh reading. Limits that rest on it are sent valid until
   * then only (security case 334).
   */
  freshUntil: Date | null;
}

export interface HierarchyNode {
  /**
   * `transformer`: a service transformer (a root above the top-level panels
   * that name it) or a step-down transformer (between a panel and the
   * sub-panels that name it). The allocation treats it like a panel.
   */
  type: 'panel' | 'circuit' | 'transformer';
  /** Transformers only. */
  transformerKind?: TransformerKind;
  /**
   * Battery and solar supply this node carries on top of its capacity, kW
   * (owner decision D8): the credit of every asset connected load-side on a
   * strict descendant panel, and of a supply-side asset at this transformer.
   * Absent: 0.
   */
  supplyCreditKw?: number;
  /** The per-phase part of `supplyCreditKw` (three-phase assets only, / 3). */
  supplyPhaseCreditKw?: PhaseLoad | null;
  /**
   * Load of the assets connected at this node (a charging battery, or one
   * without a fresh reading that may charge from the grid, D9), kW: a fixed
   * load of this node and of every node above it.
   */
  supplyLoadKw?: number;
  /** The part of `supplyLoadKw` from single-phase assets (in full on every phase). */
  supplySinglePhaseLoadKw?: number;
  /**
   * `supplyLoadKw` and `supplySinglePhaseLoadKw` as they count once every
   * reading is stale (no reading: a battery that may charge from the grid at
   * its rating, D9). The station limits the cycle sends without an end date
   * are computed with these and no credit (`withoutAssetReadings`, security
   * case 334).
   */
  fallbackSupplyLoadKw?: number;
  fallbackSupplySinglePhaseLoadKw?: number;
  /** The assets connected at this node. */
  energyAssets?: EnergyAssetNodeSupply[];
  /**
   * Circuits: the local generation its stations reported (OCPP 2.1 K27), kW.
   * A station may draw it on top of its limit, so it is a fixed load of the
   * circuit and of every node above it (owner decision D11).
   */
  localGenerationKw?: number;
  id: string;
  name: string;
  maxContinuousKw: number;
  safetyMarginKw: number;
  unmanagedLoadKw: number;
  currentDrawKw: number;
  stations: StationPowerInfo[];
  children: HierarchyNode[];
  // Three-phase tracking (panels only, null for single-phase or circuits)
  phases: number;
  breakerRatingAmps: number;
  voltageV: number;
  oversubscriptionRatio: number;
  /**
   * Circuits: the phases of a three-phase panel the circuit uses. Panels: the
   * phases of a three-phase parent that feed this single-phase sub-panel.
   * Null: every phase.
   */
  phaseConnections: string | null;
  phaseLoad: PhaseLoad | null;
  perPhaseCapacityKw: number | null;
  /**
   * Circuits: the circuit's own stored voltage (null uses the panel voltage).
   * `voltageV` holds the voltage in use.
   */
  ownVoltageV?: number | null;
}

export interface PanelRow {
  id: string;
  parentPanelId: string | null;
  name: string;
  breakerRatingAmps: number;
  voltageV: number;
  phases: number;
  maxContinuousKw: string;
  safetyMarginKw: string;
  oversubscriptionRatio: string;
  phaseConnections: string | null;
  transformerId: string | null;
}

export interface TransformerRow {
  id: string;
  kind: TransformerKind;
  name: string;
  phases: number;
  secondaryVoltageV: number | null;
  safetyMarginKw: string;
  fedFromPanelId: string | null;
  maxContinuousKw: string | null;
}

export interface EnergyAssetRow {
  id: string;
  type: EnergyAssetType;
  name: string;
  capacityKwh: number | null;
  peakKwp: number | null;
  inverterKw: string | null;
  maxDischargeKw: string | null;
  maxChargeKw: string | null;
  phases: number;
  connectionTransformerId: string | null;
  connectionPanelId: string | null;
  gridCharging: 'never' | 'possible';
  reservePercent: number;
  telemetry: EnergyAssetTelemetry;
  readingTtlSeconds: number;
}

export interface EnergyAssetReadingRow {
  assetId: string;
  reportedAt: Date;
  receivedAt: Date;
  powerKw: string;
  availableKw: string | null;
  socPercent: string | null;
  source: string;
}

export interface CircuitRow {
  id: string;
  panelId: string;
  name: string;
  breakerRatingAmps: number;
  maxContinuousKw: string;
  phaseConnections: string | null;
  voltageV: number | null;
}

export interface UnmanagedLoadRow {
  panelId: string | null;
  circuitId: string | null;
  name: string;
  estimatedDrawKw: string;
}

export type Phase = 'L1' | 'L2' | 'L3';

export interface SiteHierarchyOptions {
  /** The time the supply readings are judged at (freshness). Default: now. */
  nowMs?: number;
  log?: ServiceLogger;
  /**
   * Whether this process computes readings for `simulated` telemetry
   * (ENERGY_ASSETS_ALLOW_SIMULATED, owner decision D13). Default: false, so a
   * simulated asset has no reading.
   */
  allowSimulatedEnergyAssets?: boolean;
}

// Floating point slack for kW comparisons.
export const EPSILON_KW = 1e-9;
