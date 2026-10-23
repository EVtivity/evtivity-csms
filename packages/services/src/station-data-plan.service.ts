// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The station data plan service (features/station-data-plans.md): drives the
// one writer of charging_stations.data_plan and sites.data_plan
// (@evtivity/database station-data-plan.ts), audits each change and pushes
// the new plan values to the online stations whose effective plan or charging
// kind changed. Offline stations get the values at their next boot.

import { inArray } from 'drizzle-orm';
import {
  chargingStations,
  db,
  getDataPlanValues,
  listSiteStationIds,
  readStationDataPlans,
  setSiteDataPlan,
  setStationDataPlan,
  siteAuditLog,
  stationAuditLog,
  writeAudit,
} from '@evtivity/database';
import type { AuditActor, StationDataPlanState } from '@evtivity/database';
import {
  CACHE_INVALIDATE_CHANNEL,
  buildDataPlanCommands,
  publishOcppCommand,
  resolveDataPlan,
  stationDataPlanInvalidationPayload,
} from '@evtivity/lib';
import type { DataPlan, PubSubClient, ServiceLogger } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

/** The audit fields of whoever changes a plan. */
export interface DataPlanActor {
  actor: AuditActor;
  actorUserId: string | null;
  actorDriverId: string | null;
  actorApiKeyId: string | null;
  actorLabel: string | null;
}

export interface DataPlanDeps {
  pubsub?: PubSubClient;
  log?: ServiceLogger;
}

export interface PushStationDataPlanOptions extends DataPlanDeps {
  /** `charging` sends only the readings while charging (a charging kind change). */
  scope?: 'all' | 'charging';
}

/** The effective plan and charging kind of stations, before a change. */
export type StationDataPlanSnapshot = Map<string, StationDataPlanState>;

function pubsubOf(deps?: DataPlanDeps): PubSubClient {
  return deps?.pubsub ?? getPubSub();
}

/**
 * Sends each online station its effective plan values (heartbeat included)
 * and tells the OCPP pod holding it to re-read its plan. Offline stations are
 * skipped: the boot push sends the values at the next boot. Fail-open: a lost
 * publish heals at the next boot. Returns the ids of the stations pushed to.
 */
export async function pushStationDataPlan(
  stationIds: readonly string[],
  options: PushStationDataPlanOptions = {},
): Promise<string[]> {
  const pushed: string[] = [];
  if (stationIds.length === 0) return pushed;
  const pubsub = pubsubOf(options);
  let states: StationDataPlanSnapshot;
  try {
    states = await readStationDataPlans(stationIds);
  } catch (err) {
    options.log?.warn({ err, stationIds }, 'Data plan push skipped: station read failed');
    return pushed;
  }
  for (const state of states.values()) {
    if (!state.isOnline) continue;
    try {
      if (options.scope !== 'charging') {
        await pubsub.publish(
          CACHE_INVALIDATE_CHANNEL,
          stationDataPlanInvalidationPayload(state.stationOcppId),
        );
      }
      const values = await getDataPlanValues(state.plan);
      const commands = buildDataPlanCommands(state.ocppProtocol, values, state.chargingKind, {
        includeHeartbeat: true,
        scope: options.scope ?? 'all',
      });
      for (const command of commands) {
        await publishOcppCommand(pubsub, {
          stationId: state.stationOcppId,
          action: command.action,
          payload: command.payload,
          version: state.ocppProtocol,
        });
      }
      pushed.push(state.stationId);
      options.log?.info(
        {
          stationId: state.stationOcppId,
          plan: state.plan,
          chargingKind: state.chargingKind,
          scope: options.scope ?? 'all',
          commands: commands.length,
        },
        'Pushed the station data plan values',
      );
    } catch (err) {
      options.log?.warn(
        { err, stationId: state.stationOcppId },
        'Data plan push failed; the station gets the values at its next boot',
      );
    }
  }
  return pushed;
}

/** Reads the effective plans of stations before a change (fail-open: empty on error). */
export async function snapshotStationDataPlans(
  stationIds: readonly (string | null | undefined)[],
  deps: DataPlanDeps = {},
): Promise<StationDataPlanSnapshot> {
  const ids = stationIds.filter((id): id is string => id != null && id !== '');
  if (ids.length === 0) return new Map();
  try {
    return await readStationDataPlans(ids);
  } catch (err) {
    deps.log?.warn({ err, stationIds: ids }, 'Data plan snapshot failed; no push follows');
    return new Map();
  }
}

/**
 * The snapshot of the existing stations among OCPP identities (a CSV import
 * names stations by identity). Unknown identities are left out: a new
 * station gets its plan at its first boot. Fail-open like the snapshot.
 */
export async function snapshotStationDataPlansByOcppIds(
  stationOcppIds: readonly string[],
  deps: DataPlanDeps = {},
): Promise<StationDataPlanSnapshot> {
  if (stationOcppIds.length === 0) return new Map();
  try {
    const rows = await db
      .select({ id: chargingStations.id })
      .from(chargingStations)
      .where(inArray(chargingStations.stationId, [...stationOcppIds]));
    return await snapshotStationDataPlans(
      rows.map((r) => r.id),
      deps,
    );
  } catch (err) {
    deps.log?.warn({ err }, 'Data plan snapshot failed; no push follows');
    return new Map();
  }
}

/**
 * After a committed change: pushes the full plan to the stations whose
 * effective plan changed, and the charging values to those whose charging
 * kind alone changed. Returns the ids pushed to.
 */
export async function pushStationDataPlanChanges(
  before: StationDataPlanSnapshot,
  deps: DataPlanDeps = {},
): Promise<string[]> {
  if (before.size === 0) return [];
  let after: StationDataPlanSnapshot;
  try {
    after = await readStationDataPlans([...before.keys()]);
  } catch (err) {
    deps.log?.warn({ err }, 'Data plan compare failed; the stations get it at their next boot');
    return [];
  }
  const planChanged: string[] = [];
  const kindChanged: string[] = [];
  for (const [id, prev] of before) {
    const next = after.get(id);
    if (next == null) continue;
    if (next.plan !== prev.plan) planChanged.push(id);
    else if (next.chargingKind !== prev.chargingKind) kindChanged.push(id);
  }
  const pushed = await pushStationDataPlan(planChanged, deps);
  pushed.push(...(await pushStationDataPlan(kindChanged, { ...deps, scope: 'charging' })));
  return pushed;
}

/**
 * Runs a change that may move stations to another plan or charging kind (a
 * SIM confirm or close, a connector type change) and pushes the new values
 * after it returns. Only for a change that commits on its own: inside a
 * caller's transaction the caller snapshots before and pushes after commit.
 */
export async function withStationDataPlanPush<T>(
  stationIds: readonly (string | null | undefined)[],
  run: () => Promise<T>,
  deps: DataPlanDeps = {},
): Promise<T> {
  const before = await snapshotStationDataPlans(stationIds, deps);
  const result = await run();
  await pushStationDataPlanChanges(before, deps);
  return result;
}

export interface StationDataPlanChangeResult {
  changed: boolean;
  before: DataPlan | null;
  after: DataPlan | null;
  /** Whether the station's effective plan changed (then it was pushed, when online). */
  effectiveChanged: boolean;
}

/**
 * Sets the station's own plan choice (null: use the SIM or site rule). Audits
 * `station.updated` (notes `data_plan_changed`, before and after the station's
 * own value) and pushes when the effective plan changed.
 */
export async function changeStationDataPlan(
  stationId: string,
  plan: DataPlan | null,
  actor: DataPlanActor,
  deps: DataPlanDeps & { push?: boolean } = {},
): Promise<StationDataPlanChangeResult> {
  const before = await readStationDataPlans([stationId]);
  const change = await setStationDataPlan(stationId, plan);
  if (change == null) {
    return { changed: false, before: plan, after: plan, effectiveChanged: false };
  }
  await writeAudit(
    { table: stationAuditLog, idColumn: 'station_id' },
    {
      entityId: stationId,
      entityIdSnapshot: stationId,
      action: 'updated',
      ...actor,
      before: { dataPlan: change.before },
      after: { dataPlan: change.after },
      notes: 'data_plan_changed',
    },
    db,
    deps.log,
  );
  if (deps.push !== false) await pushStationDataPlanChanges(before, deps);
  return {
    changed: true,
    before: change.before,
    after: change.after,
    effectiveChanged: planChangedIn(before, stationId, plan),
  };
}

function planChangedIn(
  before: StationDataPlanSnapshot,
  stationId: string,
  stationPlan: DataPlan | null,
): boolean {
  const prev = before.get(stationId);
  if (prev == null) return false;
  const next = resolveDataPlan({
    stationPlan,
    hasConfirmedSim: prev.hasConfirmedSim,
    sitePlan: prev.sitePlan,
  });
  return next.plan !== prev.plan;
}

/**
 * The number of the site's stations whose effective plan would change if the
 * site's plan became `plan` (stations without their own choice and without a
 * confirmed SIM whose resolved plan differs).
 */
export async function siteDataPlanImpact(siteId: string, plan: DataPlan | null): Promise<number> {
  const states = await readStationDataPlans(await listSiteStationIds(siteId));
  let count = 0;
  for (const s of states.values()) {
    const next = resolveDataPlan({
      stationPlan: s.stationPlan,
      hasConfirmedSim: s.hasConfirmedSim,
      sitePlan: plan,
    });
    if (next.plan !== s.plan) count++;
  }
  return count;
}

export interface SiteDataPlanChangeResult {
  changed: boolean;
  before: DataPlan | null;
  after: DataPlan | null;
  stationsChanged: number;
}

/**
 * Sets the site's plan (null: not set). Audits the site (`data_plan_changed`,
 * with the number of stations that change plan in the notes) and pushes to
 * the online stations whose effective plan changed. No station row is written.
 */
export async function changeSiteDataPlan(
  siteId: string,
  plan: DataPlan | null,
  actor: DataPlanActor,
  deps: DataPlanDeps = {},
): Promise<SiteDataPlanChangeResult> {
  const before = await readStationDataPlans(await listSiteStationIds(siteId));
  const change = await setSiteDataPlan(siteId, plan);
  if (change == null) return { changed: false, before: plan, after: plan, stationsChanged: 0 };
  let stationsChanged = 0;
  for (const s of before.values()) {
    const next = resolveDataPlan({
      stationPlan: s.stationPlan,
      hasConfirmedSim: s.hasConfirmedSim,
      sitePlan: plan,
    });
    if (next.plan !== s.plan) stationsChanged++;
  }
  await writeAudit(
    { table: siteAuditLog, idColumn: 'site_id' },
    {
      entityId: siteId,
      entityIdSnapshot: siteId,
      action: 'data_plan_changed',
      ...actor,
      before: { dataPlan: change.before },
      after: { dataPlan: change.after },
      notes: `stationsChanged: ${String(stationsChanged)}`,
    },
    db,
    deps.log,
  );
  await pushStationDataPlanChanges(before, deps);
  return { changed: true, before: change.before, after: change.after, stationsChanged };
}
