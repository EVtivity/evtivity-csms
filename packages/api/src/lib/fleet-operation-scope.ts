// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Site scope of fleet operations: config templates, firmware campaigns,
// charging profile templates and their pushes. These records are company
// configuration that targets stations through a jsonb target filter
// (siteId, stationId, vendorId, model) or through per-station rows. A
// site-restricted user (allowedSiteIds is an array) sees only the records
// whose targets lie within its sites, and only the per-station rows of its
// own sites. Unsited stations are outside every restricted scope.

import { and, eq, exists, inArray, isNull, notExists, notInArray, or, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import {
  db,
  chargingStations,
  configTemplates,
  firmwareCampaigns,
  firmwareCampaignStations,
  chargingProfileTemplates,
} from '@evtivity/database';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Subquery of the ids of the stations in the given sites. */
export function stationIdsInSites(allowedSiteIds: string[]) {
  return db
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(inArray(chargingStations.siteId, allowedSiteIds));
}

/** SQL: the station id column points at a station within the given sites. */
export function stationInSitesSql(stationIdColumn: AnyColumn, allowedSiteIds: string[]): SQL {
  return inArray(stationIdColumn, stationIdsInSites(allowedSiteIds));
}

/**
 * SQL: the jsonb target filter names no site and no station outside the
 * given sites. A filter without siteId and stationId passes.
 */
export function targetFilterInScopeSql(targetFilter: AnyColumn, allowedSiteIds: string[]): SQL {
  const siteKey = sql<string | null>`NULLIF(${targetFilter}->>'siteId', '')`;
  const stationKey = sql<string | null>`NULLIF(${targetFilter}->>'stationId', '')`;
  return and(
    or(sql`${siteKey} IS NULL`, inArray(siteKey, allowedSiteIds)),
    or(sql`${stationKey} IS NULL`, inArray(stationKey, stationIdsInSites(allowedSiteIds))),
  ) as SQL;
}

/**
 * Check a target filter from a request body against the user's sites.
 * Returns null when it is within scope (always for an all-site user), else
 * which part is out of scope so the route answers the matching 404.
 */
export async function targetFilterOutOfScope(
  filter: unknown,
  allowedSiteIds: string[] | null,
): Promise<'site' | 'station' | null> {
  if (allowedSiteIds == null || filter == null || typeof filter !== 'object') return null;
  const { siteId: rawSiteId, stationId: rawStationId } = filter as Record<string, unknown>;
  const siteId = nonEmptyString(rawSiteId);
  if (siteId != null && !allowedSiteIds.includes(siteId)) return 'site';
  const stationId = nonEmptyString(rawStationId);
  if (stationId != null) {
    const [station] = await db
      .select({ siteId: chargingStations.siteId })
      .from(chargingStations)
      .where(eq(chargingStations.id, stationId));
    if (station?.siteId == null || !allowedSiteIds.includes(station.siteId)) return 'station';
  }
  return null;
}

/** The 404 body for an out-of-scope target filter. */
export function targetFilterNotFound(part: 'site' | 'station'): { error: string; code: string } {
  return part === 'site'
    ? { error: 'Site not found', code: 'SITE_NOT_FOUND' }
    : { error: 'Station not found', code: 'STATION_NOT_FOUND' };
}

/**
 * True when a site-restricted user tries to write a company-wide template:
 * one not bound to a station whose target filter names no site and no
 * station. Creating, editing, duplicating, deleting, pushing and clearing
 * those needs access to every site (owner decision 2026-10-09), so the route
 * answers 404. Firmware campaigns use the same rule on create and edit. A
 * template bound to a station is not company-wide: it targets that station
 * only (`configTemplateTarget` in `@evtivity/lib`). Whether
 * a named site or station is in scope is checked separately
 * (targetFilterOutOfScope, findScoped*).
 */
export function isRestrictedCompanyWideWrite(
  allowedSiteIds: string[] | null,
  filter: unknown,
  boundStationId: string | null = null,
): boolean {
  if (allowedSiteIds == null || boundStationId != null) return false;
  if (filter == null || typeof filter !== 'object') return true;
  const { siteId, stationId } = filter as Record<string, unknown>;
  return nonEmptyString(siteId) == null && nonEmptyString(stationId) == null;
}

/** The 404 body for a company-wide template write by a restricted user. */
export const TEMPLATE_NOT_FOUND = { error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' };

// --- Config templates ---

/**
 * SQL: the config template is visible to a user with these sites. A template
 * bound to a station (the per-station template) or whose target filter names
 * a site or station is visible only when that station or site is within the
 * user's sites. Templates without a site or station target are company-wide
 * and visible; their pushes reach only the user's stations.
 */
export function configTemplateInScopeSql(allowedSiteIds: string[]): SQL {
  return and(
    or(
      isNull(configTemplates.stationId),
      stationInSitesSql(configTemplates.stationId, allowedSiteIds),
    ),
    targetFilterInScopeSql(configTemplates.targetFilter, allowedSiteIds),
  ) as SQL;
}

/** Load a config template the user may see, or undefined (answer 404). */
export async function findScopedConfigTemplate(
  id: string,
  allowedSiteIds: string[] | null,
): Promise<typeof configTemplates.$inferSelect | undefined> {
  const where =
    allowedSiteIds == null
      ? eq(configTemplates.id, id)
      : and(eq(configTemplates.id, id), configTemplateInScopeSql(allowedSiteIds));
  const [template] = await db.select().from(configTemplates).where(where);
  return template;
}

// --- Charging profile templates ---

/** SQL: the charging profile template's target filter is within the sites. */
export function chargingProfileTemplateInScopeSql(allowedSiteIds: string[]): SQL {
  return targetFilterInScopeSql(chargingProfileTemplates.targetFilter, allowedSiteIds);
}

/** Load a charging profile template the user may see, or undefined (404). */
export async function findScopedChargingProfileTemplate(
  id: string,
  allowedSiteIds: string[] | null,
): Promise<typeof chargingProfileTemplates.$inferSelect | undefined> {
  const where =
    allowedSiteIds == null
      ? eq(chargingProfileTemplates.id, id)
      : and(eq(chargingProfileTemplates.id, id), chargingProfileTemplateInScopeSql(allowedSiteIds));
  const [template] = await db.select().from(chargingProfileTemplates).where(where);
  return template;
}

// --- Firmware campaigns ---

/**
 * SQL: the firmware campaign covers only the user's sites. A campaign covers
 * the site or station its target filter names and every station it was
 * started on. A campaign that was never started and names no site or station
 * targets every site, so a restricted user sees it only when it created it
 * (its start then reaches only that user's stations).
 */
export function firmwareCampaignInScopeSql(allowedSiteIds: string[], userId: string): SQL {
  const campaignStations = (extra: SQL | undefined) =>
    db
      .select({ one: sql`1` })
      .from(firmwareCampaignStations)
      .innerJoin(chargingStations, eq(chargingStations.id, firmwareCampaignStations.stationId))
      .where(and(eq(firmwareCampaignStations.campaignId, firmwareCampaigns.id), extra));
  return and(
    targetFilterInScopeSql(firmwareCampaigns.targetFilter, allowedSiteIds),
    notExists(
      campaignStations(
        or(isNull(chargingStations.siteId), notInArray(chargingStations.siteId, allowedSiteIds)),
      ),
    ),
    or(
      sql`NULLIF(${firmwareCampaigns.targetFilter}->>'siteId', '') IS NOT NULL`,
      sql`NULLIF(${firmwareCampaigns.targetFilter}->>'stationId', '') IS NOT NULL`,
      exists(campaignStations(undefined)),
      eq(firmwareCampaigns.createdById, userId),
    ),
  ) as SQL;
}

/** Load a firmware campaign the user may see, or undefined (answer 404). */
export async function findScopedFirmwareCampaign(
  id: string,
  allowedSiteIds: string[] | null,
  userId: string,
): Promise<typeof firmwareCampaigns.$inferSelect | undefined> {
  const where =
    allowedSiteIds == null
      ? eq(firmwareCampaigns.id, id)
      : and(eq(firmwareCampaigns.id, id), firmwareCampaignInScopeSql(allowedSiteIds, userId));
  const [campaign] = await db.select().from(firmwareCampaigns).where(where);
  return campaign;
}
