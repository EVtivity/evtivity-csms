// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The one writer of charging_stations.data_plan and sites.data_plan, and the
// SQL twin of resolveDataPlan (@evtivity/lib). The station data plan service
// (@evtivity/services) drives the writers: audit, invalidation and push.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { isDataPlan, resolveDataPlan, stationChargingKind } from '@evtivity/lib';
import type { ChargingKind, DataPlan, DataPlanSource } from '@evtivity/lib';
import { db } from '../config.js';
import { chargingStations, connectors, evses, sites } from '../schema/assets.js';
import { isOperatorStation } from './conformance-stations.js';

export type DataPlanDb = Pick<typeof db, 'select' | 'update' | 'execute'>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function checkAlias(alias: string): string {
  if (!IDENTIFIER.test(alias)) throw new Error(`Invalid SQL alias: ${alias}`);
  return alias;
}

/** Whether the station (row alias) has an open confirmed SIM attachment. */
export function hasConfirmedSimSqlText(stationAlias = 'charging_stations'): string {
  const s = checkAlias(stationAlias);
  return `EXISTS (SELECT 1 FROM sim_attachments dp_sa WHERE dp_sa.station_id = ${s}.id AND dp_sa.detached_at IS NULL AND dp_sa.confirmed_at IS NOT NULL)`;
}

/**
 * The effective data plan of a station row as SQL text (`wifi_or_wired` or
 * `cellular`), the twin of resolveDataPlan: the station's own choice, a
 * confirmed SIM (Cellular), the site's plan, the default. Use it with
 * postgres.js `sql.unsafe` or drizzle `sql.raw`; the alias is checked.
 */
export function effectiveDataPlanSqlText(stationAlias = 'charging_stations'): string {
  const s = checkAlias(stationAlias);
  return `COALESCE(${s}.data_plan::text, CASE WHEN ${hasConfirmedSimSqlText(s)} THEN 'cellular' END, (SELECT dp_site.data_plan::text FROM sites dp_site WHERE dp_site.id = ${s}.site_id), 'wifi_or_wired')`;
}

/** Where the effective plan of a station row comes from, as SQL text. */
export function dataPlanSourceSqlText(stationAlias = 'charging_stations'): string {
  const s = checkAlias(stationAlias);
  return `CASE WHEN ${s}.data_plan IS NOT NULL THEN 'station' WHEN ${hasConfirmedSimSqlText(s)} THEN 'sim' WHEN (SELECT dp_site.data_plan FROM sites dp_site WHERE dp_site.id = ${s}.site_id) IS NOT NULL THEN 'site' ELSE 'default' END`;
}

/** The effective plan of `charging_stations` rows in a drizzle query. */
export const effectiveDataPlanSql: SQL<DataPlan> = sql.raw(
  effectiveDataPlanSqlText(),
) as SQL<DataPlan>;
/** The source of the effective plan of `charging_stations` rows in a drizzle query. */
export const dataPlanSourceSql: SQL<DataPlanSource> = sql.raw(
  dataPlanSourceSqlText(),
) as SQL<DataPlanSource>;

export interface StationDataPlanState {
  stationId: string;
  stationOcppId: string;
  siteId: string | null;
  isOnline: boolean;
  ocppProtocol: string | null;
  /** The operator's choice on the station (null: none). */
  stationPlan: DataPlan | null;
  sitePlan: DataPlan | null;
  hasConfirmedSim: boolean;
  plan: DataPlan;
  source: DataPlanSource;
  chargingKind: ChargingKind;
}

/**
 * The data plan inputs, effective plan and charging kind of stations, keyed
 * by station id. The kind comes from the connectors of in-service EVSEs.
 */
export async function readStationDataPlans(
  stationIds: readonly string[],
  executor: DataPlanDb = db,
): Promise<Map<string, StationDataPlanState>> {
  const out = new Map<string, StationDataPlanState>();
  if (stationIds.length === 0) return out;
  const ids = [...new Set(stationIds)];
  const rows = await executor
    .select({
      id: chargingStations.id,
      stationOcppId: chargingStations.stationId,
      siteId: chargingStations.siteId,
      isOnline: chargingStations.isOnline,
      ocppProtocol: chargingStations.ocppProtocol,
      stationPlan: chargingStations.dataPlan,
      sitePlan: sites.dataPlan,
      hasConfirmedSim: sql<boolean>`${sql.raw(hasConfirmedSimSqlText())}`,
    })
    .from(chargingStations)
    .leftJoin(sites, eq(sites.id, chargingStations.siteId))
    .where(inArray(chargingStations.id, ids));
  const connectorRows = await executor
    .select({
      stationId: evses.stationId,
      connectorType: connectors.connectorType,
      maxPowerKw: connectors.maxPowerKw,
    })
    .from(connectors)
    .innerJoin(evses, eq(evses.id, connectors.evseId))
    .where(
      and(inArray(evses.stationId, ids), isNull(evses.retiredAt), isNull(connectors.retiredAt)),
    );
  const byStation = new Map<
    string,
    { connectorType: string | null; maxPowerKw: string | null }[]
  >();
  for (const c of connectorRows) {
    const list = byStation.get(c.stationId) ?? [];
    list.push({ connectorType: c.connectorType, maxPowerKw: c.maxPowerKw });
    byStation.set(c.stationId, list);
  }
  for (const r of rows) {
    const stationPlan = isDataPlan(r.stationPlan) ? r.stationPlan : null;
    const sitePlan = isDataPlan(r.sitePlan) ? r.sitePlan : null;
    const hasConfirmedSim = r.hasConfirmedSim;
    const { plan, source } = resolveDataPlan({ stationPlan, hasConfirmedSim, sitePlan });
    out.set(r.id, {
      stationId: r.id,
      stationOcppId: r.stationOcppId,
      siteId: r.siteId,
      isOnline: r.isOnline,
      ocppProtocol: r.ocppProtocol,
      stationPlan,
      sitePlan,
      hasConfirmedSim,
      plan,
      source,
      chargingKind: stationChargingKind(byStation.get(r.id) ?? []),
    });
  }
  return out;
}

/**
 * The ids of a site's operator stations. Conformance test stations are left
 * out like everywhere operators look, so a site plan change neither counts nor
 * pushes them; such a station still resolves its plan at its next boot.
 */
export async function listSiteStationIds(
  siteId: string,
  executor: DataPlanDb = db,
): Promise<string[]> {
  const rows = await executor
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(and(eq(chargingStations.siteId, siteId), isOperatorStation()));
  return rows.map((r) => r.id);
}

export interface DataPlanChange {
  before: DataPlan | null;
  after: DataPlan | null;
}

/**
 * Sets the station's own data plan choice (null clears it). Returns the
 * before and after values, or null when the station does not exist or the
 * value is unchanged (nothing written).
 */
export async function setStationDataPlan(
  stationId: string,
  plan: DataPlan | null,
  executor: DataPlanDb = db,
): Promise<DataPlanChange | null> {
  const [current] = await executor
    .select({ dataPlan: chargingStations.dataPlan })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));
  if (current == null) return null;
  const before = isDataPlan(current.dataPlan) ? current.dataPlan : null;
  if (before === plan) return null;
  await executor
    .update(chargingStations)
    .set({ dataPlan: plan, updatedAt: new Date() })
    .where(eq(chargingStations.id, stationId));
  return { before, after: plan };
}

/** Sets the site's data plan (null: not set). Same contract as setStationDataPlan. */
export async function setSiteDataPlan(
  siteId: string,
  plan: DataPlan | null,
  executor: DataPlanDb = db,
): Promise<DataPlanChange | null> {
  const [current] = await executor
    .select({ dataPlan: sites.dataPlan })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (current == null) return null;
  const before = isDataPlan(current.dataPlan) ? current.dataPlan : null;
  if (before === plan) return null;
  await executor
    .update(sites)
    .set({ dataPlan: plan, updatedAt: new Date() })
    .where(eq(sites.id, siteId));
  return { before, after: plan };
}
