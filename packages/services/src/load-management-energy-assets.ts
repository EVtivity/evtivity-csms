// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  db,
  chargingProfiles,
  siteEnergyAssets,
  energyAssetReadings,
  sites,
} from '@evtivity/database';
import type { SimulatedBatteryDispatch } from '@evtivity/lib';
import {
  circuitConductorPhases,
  conductorFactor,
  createLogger,
  energyAssetReadingFreshUntilMs,
  energyAssetSupply,
  simulatedBatteryDispatch,
  simulatedBatteryReading,
  simulatedSolarReading,
} from '@evtivity/lib';
import type {
  EnergyAssetRow,
  EnergyAssetReadingRow,
  HierarchyNode,
  StationPowerInfo,
  SiteHierarchyOptions,
  EnergyAssetNodeSupply,
} from './load-management-model.js';

const logger = createLogger('load-management');

interface AssetReading {
  receivedAtMs: number;
  reportedAtMs: number;
  powerKw: number;
  availableKw: number | null;
  socPercent: number | null;
}

/** What a simulated reading needs: the site position and the demand above the grid. */
interface SimulationContext {
  latitudeDeg: number | null;
  longitudeDeg: number | null;
  /** The site's IANA time zone (the battery's time-of-use windows). */
  timeZone: string | null;
  /** The battery dispatch of the site type: a depot discharges overnight. */
  dispatch: SimulatedBatteryDispatch;
  deficitKw: number;
}

const numberOrNull = (value: string | null): number | null =>
  value != null ? Number(value) : null;

/**
 * The reading an asset's supply is judged on: the stored `api` reading of an
 * asset with `api` telemetry; a reading computed now for `simulated` telemetry
 * while the process allows it (`simulation` set; @evtivity/lib
 * energy-asset-simulation, nothing stored); none for `none` (informational)
 * and for `simulated` otherwise.
 */
function assetReading(
  asset: EnergyAssetRow,
  stored: EnergyAssetReadingRow | undefined,
  nowMs: number,
  simulation: SimulationContext | null,
): AssetReading | null {
  if (asset.telemetry === 'simulated') {
    if (simulation == null) return null;
    const at = new Date(nowMs);
    const simulated =
      asset.type === 'solar'
        ? simulatedSolarReading(
            asset.peakKwp,
            numberOrNull(asset.inverterKw),
            simulation.latitudeDeg,
            simulation.longitudeDeg,
            at,
          )
        : simulatedBatteryReading(
            {
              capacityKwh: asset.capacityKwh,
              maxDischargeKw: numberOrNull(asset.maxDischargeKw),
              maxChargeKw: numberOrNull(asset.maxChargeKw),
              inverterKw: numberOrNull(asset.inverterKw),
              reservePercent: asset.reservePercent,
              gridCharging: asset.gridCharging,
              dispatch: simulation.dispatch,
              deficitKw: simulation.deficitKw,
            },
            simulation.timeZone,
            at,
          );
    return simulated == null ? null : { receivedAtMs: nowMs, reportedAtMs: nowMs, ...simulated };
  }
  if (asset.telemetry !== 'api' || stored == null || stored.source !== 'api') return null;
  return {
    receivedAtMs: stored.receivedAt.getTime(),
    reportedAtMs: stored.reportedAt.getTime(),
    powerKw: Number(stored.powerKw),
    availableKw: numberOrNull(stored.availableKw),
    socPercent: numberOrNull(stored.socPercent),
  };
}

/** A coordinate stored as text, or null when it is missing or out of range. */
function coordinate(value: string | null | undefined, limit: number): number | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
}

/**
 * Demand of the active sessions above the capacity of the roots, kW: what a
 * simulated battery discharges to cover. A station counts with its maximum
 * power, or its draw when the maximum is unknown.
 */
function demandAboveGridKw(roots: readonly HierarchyNode[]): number {
  let demand = 0;
  const walk = (nodes: readonly HierarchyNode[]): void => {
    for (const node of nodes) {
      for (const station of node.stations) {
        if (!station.isOnline || !station.hasActiveSession) continue;
        demand += station.maxPowerKw > 0 ? station.maxPowerKw : station.currentDrawKw;
      }
      walk(node.children);
    }
  };
  walk(roots);
  const grid = roots.reduce((sum, r) => sum + Math.max(0, r.maxContinuousKw - r.safetyMarginKw), 0);
  return Math.max(0, demand - grid);
}

function addPhaseCredit(node: HierarchyNode, perPhaseKw: number): void {
  if (node.phases !== 3) return;
  const current = node.supplyPhaseCreditKw ?? { L1: 0, L2: 0, L3: 0 };
  node.supplyPhaseCreditKw = {
    L1: current.L1 + perPhaseKw,
    L2: current.L2 + perPhaseKw,
    L3: current.L3 + perPhaseKw,
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** An ISO time as ms since the epoch, NaN when absent or not a date. */
const timeMs = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : NaN);

/**
 * Local generation of one stored station_reported row at `nowMs`, kW (OCPP
 * 2.1 K27): the active period of every LocalGeneration entry (a profile of a
 * GetChargingProfiles report, or a NotifyChargingLimit with isLocalGeneration
 * stored by the OCPP projection), its largest one. 0 when the row holds no
 * LocalGeneration entry or none is active; null when one is there but its
 * power cannot be read (no schedule, a unit that cannot be converted).
 *
 * A schedule starts at its `startSchedule`, else at the notification time
 * (`notifiedAt`, a schedule "from that moment onwards"), else when the row
 * was stored; it ends after `duration` and outside `validFrom`/`validTo`. A
 * W limit with `limit_L2`/`limit_L3` is per phase (summed), an A limit is the
 * phase current on the station's circuit (`rate`).
 */
export function localGenerationKw(
  profileData: unknown,
  reportedAtMs: number | null,
  nowMs: number,
  rate: { voltageV: number; phases: number },
): number | null {
  const entries = Array.isArray(profileData) ? profileData : [profileData];
  let best = 0;
  let unknown = false;
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (entry?.['chargingProfilePurpose'] !== 'LocalGeneration') continue;
    const validFrom = timeMs(entry['validFrom']);
    const validTo = timeMs(entry['validTo']);
    if (
      (Number.isFinite(validFrom) && validFrom > nowMs) ||
      (Number.isFinite(validTo) && validTo <= nowMs)
    ) {
      continue;
    }
    const schedules = entry['chargingSchedule'];
    const schedule = asRecord(Array.isArray(schedules) ? schedules[0] : schedules);
    const periods = schedule?.['chargingSchedulePeriod'];
    if (schedule == null || !Array.isArray(periods) || periods.length === 0) {
      unknown = true;
      continue;
    }
    const scheduleStart = timeMs(schedule['startSchedule']);
    const notifiedAt = timeMs(entry['notifiedAt']);
    const startMs = Number.isFinite(scheduleStart)
      ? scheduleStart
      : Number.isFinite(notifiedAt)
        ? notifiedAt
        : (reportedAtMs ?? nowMs);
    if (startMs > nowMs) continue;
    const duration = finiteNumber(schedule['duration']);
    const elapsedS = (nowMs - startMs) / 1000;
    if (duration != null && elapsedS >= duration) continue;
    let active: Record<string, unknown> | null = null;
    for (const p of periods) {
      const period = asRecord(p);
      const startPeriod = finiteNumber(period?.['startPeriod']);
      if (period != null && startPeriod != null && startPeriod <= elapsedS) active = period;
    }
    if (active == null) continue;
    const limit = finiteNumber(active['limit']);
    const l2 = finiteNumber(active['limit_L2']);
    const l3 = finiteNumber(active['limit_L3']);
    const unit = schedule['chargingRateUnit'];
    let kw: number | null = null;
    if (limit != null && unit === 'W') {
      kw = (limit + (l2 ?? 0) + (l3 ?? 0)) / 1000;
    } else if (limit != null && unit === 'A' && rate.voltageV > 0) {
      const amps = Math.max(limit, l2 ?? 0, l3 ?? 0);
      const phases = finiteNumber(active['numberPhases']) ?? rate.phases;
      kw = (amps * rate.voltageV * conductorFactor(Math.min(3, Math.max(1, phases)))) / 1000;
    }
    if (kw == null) {
      unknown = true;
      continue;
    }
    best = Math.max(best, kw);
  }
  return unknown ? null : best;
}

/**
 * Reserves the local generation each station reported (K27) on its circuit:
 * per EVSE the largest stored value, summed over the EVSEs, never above the
 * station's maximum power (else the circuit capacity), and an unreadable one
 * counts at that bound (fail closed).
 */
export async function applyLocalGeneration(
  circuitNodes: readonly HierarchyNode[],
  nowMs: number,
): Promise<void> {
  const byStation = new Map<string, { station: StationPowerInfo; circuit: HierarchyNode }>();
  for (const circuit of circuitNodes) {
    for (const station of circuit.stations) byStation.set(station.id, { station, circuit });
  }
  if (byStation.size === 0) return;
  const rows = await db
    .select({
      stationId: chargingProfiles.stationId,
      evseId: chargingProfiles.evseId,
      profileData: chargingProfiles.profileData,
      reportedAt: chargingProfiles.reportedAt,
    })
    .from(chargingProfiles)
    .where(
      and(
        inArray(chargingProfiles.stationId, [...byStation.keys()]),
        eq(chargingProfiles.source, 'station_reported'),
        sql`${chargingProfiles.profileData} @> '[{"chargingProfilePurpose": "LocalGeneration"}]'::jsonb`,
      ),
    );
  // station -> EVSE key -> largest kW (null: unreadable)
  const perEvse = new Map<string, Map<number, number | null>>();
  for (const row of rows) {
    const target = byStation.get(row.stationId);
    if (target == null) continue;
    const kw = localGenerationKw(row.profileData, row.reportedAt?.getTime() ?? null, nowMs, {
      voltageV: target.circuit.voltageV,
      phases: circuitConductorPhases(target.circuit.phaseConnections, target.circuit.phases),
    });
    const evses = perEvse.get(row.stationId) ?? new Map<number, number | null>();
    const key = row.evseId ?? 0;
    const prior = evses.get(key);
    evses.set(key, prior === null || kw === null ? null : Math.max(prior ?? 0, kw));
    perEvse.set(row.stationId, evses);
  }
  for (const [stationId, evses] of perEvse) {
    const target = byStation.get(stationId);
    if (target == null) continue;
    const bound =
      target.station.maxPowerKw > 0 ? target.station.maxPowerKw : target.circuit.maxContinuousKw;
    let total = 0;
    for (const kw of evses.values()) total += kw ?? bound;
    const reserved = Math.min(total, bound);
    if (reserved <= 0) continue;
    target.station.localGenerationKw = reserved;
    target.circuit.localGenerationKw = (target.circuit.localGenerationKw ?? 0) + reserved;
  }
}

/** The site's battery and solar rows (throws on a failed read). */
async function readEnergyAssetRows(siteId: string): Promise<EnergyAssetRow[]> {
  return db
    .select({
      id: siteEnergyAssets.id,
      type: siteEnergyAssets.type,
      name: siteEnergyAssets.name,
      capacityKwh: siteEnergyAssets.capacityKwh,
      peakKwp: siteEnergyAssets.peakKwp,
      inverterKw: siteEnergyAssets.inverterKw,
      maxDischargeKw: siteEnergyAssets.maxDischargeKw,
      maxChargeKw: siteEnergyAssets.maxChargeKw,
      phases: siteEnergyAssets.phases,
      connectionTransformerId: siteEnergyAssets.connectionTransformerId,
      connectionPanelId: siteEnergyAssets.connectionPanelId,
      gridCharging: siteEnergyAssets.gridCharging,
      reservePercent: siteEnergyAssets.reservePercent,
      telemetry: siteEnergyAssets.telemetry,
      readingTtlSeconds: siteEnergyAssets.readingTtlSeconds,
    })
    .from(siteEnergyAssets)
    .where(eq(siteEnergyAssets.siteId, siteId));
}

/**
 * How the energy assets of a tree were known: `read` this cycle, `remembered`
 * from the last successful read of this process (the read failed), or
 * `unknown` (the read failed and this process never read them).
 */
export type EnergyAssetsKnowledge = 'read' | 'remembered' | 'unknown';

/**
 * The battery and solar rows of each site from the last successful read in
 * this process, kept so a failed read never drops a battery's grid charging
 * load (D9). Process memory only (one entry per site, replaced on every read).
 */
const rememberedEnergyAssets = new Map<string, { rows: EnergyAssetRow[]; readAtMs: number }>();

// A site this process has not read for this long is one the cycle no longer
// sees (deleted, load management turned off, its jobs run elsewhere): its
// remembered rows are dropped after the next successful read of any site.
export const REMEMBERED_ENERGY_ASSETS_MAX_AGE_MS = 15 * 60_000;

/** Forgets the remembered energy asset rows (tests). */
export function clearRememberedEnergyAssets(): void {
  rememberedEnergyAssets.clear();
}

/** Forgets the remembered energy asset rows of a site (the site was deleted). */
export function forgetRememberedEnergyAssets(siteId: string): void {
  rememberedEnergyAssets.delete(siteId);
}

/** The sites whose energy asset rows this process remembers (tests). */
export function rememberedEnergyAssetSiteIds(): string[] {
  return [...rememberedEnergyAssets.keys()];
}

/**
 * Drops the remembered rows of every site not read since
 * `REMEMBERED_ENERGY_ASSETS_MAX_AGE_MS` before `nowMs`. Called after a
 * successful read only, so a database outage never drops the fallback.
 */
export function pruneRememberedEnergyAssets(nowMs: number = Date.now()): void {
  for (const [siteId, entry] of rememberedEnergyAssets) {
    if (nowMs - entry.readAtMs > REMEMBERED_ENERGY_ASSETS_MAX_AGE_MS) {
      rememberedEnergyAssets.delete(siteId);
    }
  }
}

/**
 * Reads the site's batteries and solar with their latest readings and puts
 * their supply on the tree (see `buildSiteHierarchy`). Every read fails closed
 * (P9), on both sides of the supply:
 *
 * - No credit without the rows: a failed assets read gives no battery or solar
 *   credit, so no limit rests on supply that cannot be confirmed.
 * - No dropped load: a battery that may charge from the grid is a load (D9),
 *   and dropping it would let the limits exceed what the site carries. A
 *   failed read uses the rows of the last successful read of this process
 *   with no readings, so every such battery counts at its rated charge power
 *   (`maxChargeKw`, else `inverterKw`) at its connection point and above it:
 *   at least any load it can draw, whatever it did at that read. The rows are
 *   configuration and change rarely; a battery added since that read is
 *   unknown (answer `remembered`).
 * - Nothing known (`unknown`): the process never read the rows, so no bound
 *   on a battery load exists in the data at hand (the allocation log keeps
 *   site totals only, not loads per connection point). The tree then carries
 *   no asset and the caller sends no raise this cycle: each limit is the
 *   grid-only result capped at the limit the station holds (cuts only,
 *   `computeSiteAllocation`). The held limits came from a cycle that knew the
 *   assets, so the cycle never sends more than that cycle, and the cuts still
 *   bring the site under its grid limits. Throwing instead would send no cut
 *   either.
 */
export async function applyEnergyAssets(
  siteId: string,
  nowMs: number,
  panelNodesById: ReadonlyMap<string, HierarchyNode>,
  transformerNodesById: ReadonlyMap<string, HierarchyNode>,
  parentOf: ReadonlyMap<HierarchyNode, HierarchyNode>,
  roots: readonly HierarchyNode[],
  options: SiteHierarchyOptions,
): Promise<EnergyAssetsKnowledge> {
  let assetRows: EnergyAssetRow[];
  let knowledge: EnergyAssetsKnowledge = 'read';
  try {
    assetRows = await readEnergyAssetRows(siteId);
    const readAtMs = Date.now();
    rememberedEnergyAssets.set(siteId, { rows: assetRows, readAtMs });
    pruneRememberedEnergyAssets(readAtMs);
  } catch (err: unknown) {
    const remembered = rememberedEnergyAssets.get(siteId)?.rows;
    if (remembered == null) {
      (options.log ?? logger).warn(
        { err, siteId },
        'Energy assets not read and not known, no limit is raised this cycle',
      );
      return 'unknown';
    }
    (options.log ?? logger).warn(
      { err, siteId },
      'Energy assets not read, the allocation uses the grid limits and the last known battery loads this cycle',
    );
    assetRows = remembered;
    knowledge = 'remembered';
  }
  const connected = assetRows.filter(
    (a) => a.connectionPanelId != null || a.connectionTransformerId != null,
  );
  if (connected.length === 0) return knowledge;

  let readings = new Map<string, EnergyAssetReadingRow>();
  // Remembered rows take no reading (no credit, rated battery loads).
  if (knowledge === 'read') {
    try {
      const rows: EnergyAssetReadingRow[] = await db
        .select({
          assetId: energyAssetReadings.assetId,
          reportedAt: energyAssetReadings.reportedAt,
          receivedAt: energyAssetReadings.receivedAt,
          powerKw: energyAssetReadings.powerKw,
          availableKw: energyAssetReadings.availableKw,
          socPercent: energyAssetReadings.socPercent,
          source: energyAssetReadings.source,
        })
        .from(energyAssetReadings)
        .where(
          inArray(
            energyAssetReadings.assetId,
            connected.map((a) => a.id),
          ),
        );
      readings = new Map(rows.map((r) => [r.assetId, r]));
    } catch (err: unknown) {
      (options.log ?? logger).warn(
        { err, siteId },
        'Energy asset readings not read, batteries and solar give no supply this cycle',
      );
    }
  }

  // Simulated readings (development and demos, ENERGY_ASSETS_ALLOW_SIMULATED):
  // the site position for the sun, the demand above the grid for a battery. A
  // failed position read gives no simulated reading (no credit, D9 loads).
  let simulation: SimulationContext | null = null;
  if (
    knowledge === 'read' &&
    options.allowSimulatedEnergyAssets === true &&
    connected.some((a) => a.telemetry === 'simulated')
  ) {
    let latitudeDeg: number | null = null;
    let longitudeDeg: number | null = null;
    let timeZone: string | null = null;
    let siteType: string | null = null;
    try {
      const [site] = await db
        .select({
          latitude: sites.latitude,
          longitude: sites.longitude,
          timezone: sites.timezone,
          layoutSettings: sites.layoutSettings,
        })
        .from(sites)
        .where(eq(sites.id, siteId));
      latitudeDeg = coordinate(site?.latitude, 90);
      longitudeDeg = coordinate(site?.longitude, 180);
      timeZone = site?.timezone ?? null;
      siteType = site?.layoutSettings?.siteType ?? null;
    } catch (err: unknown) {
      (options.log ?? logger).warn(
        { err, siteId },
        'Site position not read, simulated batteries and solar give no supply this cycle',
      );
    }
    simulation = {
      latitudeDeg,
      longitudeDeg,
      timeZone,
      dispatch: simulatedBatteryDispatch(siteType),
      deficitKw: demandAboveGridKw(roots),
    };
  }

  for (const asset of connected) {
    const atTransformer = asset.connectionTransformerId != null;
    const node = atTransformer
      ? transformerNodesById.get(asset.connectionTransformerId ?? '')
      : panelNodesById.get(asset.connectionPanelId ?? '');
    // A transformer outside the tree (unrated or unlinked): counts nowhere.
    if (node == null) continue;
    const reading = assetReading(asset, readings.get(asset.id), nowMs, simulation);
    const supplyInput = {
      type: asset.type,
      inverterKw: asset.inverterKw != null ? Number(asset.inverterKw) : null,
      peakKwp: asset.peakKwp,
      maxDischargeKw: asset.maxDischargeKw != null ? Number(asset.maxDischargeKw) : null,
      maxChargeKw: asset.maxChargeKw != null ? Number(asset.maxChargeKw) : null,
      gridCharging: asset.gridCharging,
      reservePercent: asset.reservePercent,
      ttlSeconds: asset.readingTtlSeconds,
    };
    const supply = energyAssetSupply({ ...supplyInput, reading }, nowMs);
    // The supply once the reading is stale: what the limits sent without an
    // end date must hold to (security case 334).
    const fallback =
      supply.state === 'fresh'
        ? energyAssetSupply({ ...supplyInput, reading: null }, nowMs)
        : supply;

    // Load at the connection point (it counts above it through the tree). An
    // unknown load (an unrated battery that may charge from the grid and has
    // no fresh reading, stored before the writer refused it) counts as the
    // connection point's whole continuous capacity: its grid charging passes
    // that point's protection, so it cannot draw more, and less would be a
    // guess that could exceed the limits while it charges (D9).
    const loadKw = supply.loadKw ?? Math.max(0, node.maxContinuousKw);
    if (supply.loadKw == null) {
      (options.log ?? logger).warn(
        { siteId, energyAssetId: asset.id, connectionId: node.id },
        'Battery without a charge or inverter rating, it counts as a load of its whole connection point',
      );
    }
    if (loadKw > 0) {
      node.supplyLoadKw = (node.supplyLoadKw ?? 0) + loadKw;
      if (asset.phases !== 3) {
        node.supplySinglePhaseLoadKw = (node.supplySinglePhaseLoadKw ?? 0) + loadKw;
      }
    }
    const fallbackLoadKw = fallback.loadKw ?? Math.max(0, node.maxContinuousKw);
    if (fallbackLoadKw > 0) {
      node.fallbackSupplyLoadKw = (node.fallbackSupplyLoadKw ?? 0) + fallbackLoadKw;
      if (asset.phases !== 3) {
        node.fallbackSupplySinglePhaseLoadKw =
          (node.fallbackSupplySinglePhaseLoadKw ?? 0) + fallbackLoadKw;
      }
    }

    // Credit: a supply-side asset on its transformer only, a load-side one on
    // every strict ancestor of its panel (D8), bottom-up. A single-phase asset
    // gives no per-phase credit. A three-phase asset at a single-phase point
    // (made single-phase after the asset connected: the writer refuses it on
    // a write) gives no credit at all: its power flows on that point's phases
    // only, which the CSMS cannot tell. A three-phase asset gives per-phase
    // credit only while every node from its connection point up to the
    // credited one is three-phase: a single-phase node on the path carries
    // the power on its own phases only, so crediting all three phases above
    // it would raise phases the asset does not feed.
    const credited: HierarchyNode[] = [];
    if (atTransformer) {
      credited.push(node);
    } else {
      for (let up = parentOf.get(node); up != null; up = parentOf.get(up)) credited.push(up);
    }
    const phaseMismatch = asset.phases === 3 && node.phases !== 3;
    if (phaseMismatch) {
      (options.log ?? logger).warn(
        { siteId, energyAssetId: asset.id, connectionId: node.id },
        'Three-phase energy asset at a single-phase connection point, it gives no credit',
      );
    }
    const creditApplied = supply.creditKw > 0 && credited.length > 0 && !phaseMismatch;
    if (creditApplied) {
      let threePhasePath = asset.phases === 3;
      for (const target of credited) {
        threePhasePath = threePhasePath && target.phases === 3;
        target.supplyCreditKw = (target.supplyCreditKw ?? 0) + supply.creditKw;
        if (threePhasePath) addPhaseCredit(target, supply.creditKw / 3);
      }
    }

    const entry: EnergyAssetNodeSupply = {
      id: asset.id,
      name: asset.name,
      type: asset.type,
      phases: asset.phases,
      telemetry: asset.telemetry,
      connection: atTransformer ? 'transformer' : 'panel',
      state: supply.state,
      creditKw: supply.creditKw,
      loadKw,
      creditApplied,
      readingReceivedAt: reading != null ? new Date(reading.receivedAtMs) : null,
      socPercent: reading?.socPercent ?? null,
      freshUntil:
        supply.state === 'fresh' && reading != null
          ? new Date(energyAssetReadingFreshUntilMs(reading, asset.readingTtlSeconds))
          : null,
    };
    node.energyAssets = [...(node.energyAssets ?? []), entry];
  }
  return knowledge;
}
