// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The AI insights scope (owner decision v0.1.48). The only writer of the
 * `aiInsights.scope` setting, `sites.ai_insights_enabled` (site create sets
 * the initial value) and `charging_stations.ai_insights_enabled` (P3).
 *
 * `all` analyzes every site and station, new ones included; switching to it
 * selects every site and turns every station back on, so the stored flags
 * always agree with the mode. `selected` analyzes the selected sites and,
 * inside them, the stations not turned off; a site created while the scope is
 * `selected` starts unselected, a station follows its site. Taking a site or
 * station out of the scope expires its waiting actions and dismisses its open
 * insights (cause `ai_insights_scope`) through the action and insight
 * services, as a suppression does. Every changed flag is audited in the site
 * or station history, a mode change in the setting history.
 */

import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  chargingStations,
  client,
  db,
  isAiInsightsEnabled,
  operatorStationSql,
  settingAuditLog,
  settings,
  siteAuditLog,
  siteInsightScopeReasonSql,
  siteInsightsInScopeSql,
  stationAuditLog,
  stationInsightScopeReasonSql,
  stationInsightsInScopeSql,
  sites,
  writeAudit,
} from '@evtivity/database';
import {
  AI_INSIGHT_SCOPE_SETTING_KEY,
  DEFAULT_AI_INSIGHT_SCOPE_MODE,
  isAiInsightScopeMode,
} from '@evtivity/lib/ai-insights';
import type { AiInsightScopeMode, AiInsightScopeReason } from '@evtivity/lib/ai-insights';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { dismissSiteInsights, dismissStationInsights } from '@evtivity/services/ai-insight.service';
import {
  expireSiteAiProposals,
  expireStationAiProposals,
} from '@evtivity/services/ai-proposal.service';
import type { AuditActorInfo } from '../lib/audit-actor.js';

/** The audit note and the reason given to closed insights and actions. */
const SCOPE_CHANGE_NOTE = 'Removed from the AI insights scope';

export interface AiInsightScopeSite {
  id: string;
  name: string;
  selected: boolean;
  /** Operator stations of the site. */
  stationCount: number;
  /** Stations of the site turned off on their own. */
  stationsTurnedOff: number;
}

export interface AiInsightScope {
  mode: AiInsightScopeMode;
  sites: AiInsightScopeSite[];
  /** Operator stations without a site (out of a `selected` scope). */
  stationsWithoutSite: number;
}

export interface AiInsightScopeStation {
  id: string;
  stationId: string;
  enabled: boolean;
}

export interface AiInsightScopeUpdate {
  mode: AiInsightScopeMode;
  /** Sites to select or unselect (`selected` only); others keep their state. */
  sites?: { siteId: string; selected: boolean }[] | undefined;
  /** Stations to turn on or off (`selected` only); others keep their state. */
  stations?: { stationId: string; enabled: boolean }[] | undefined;
}

export interface AiInsightScopeUpdateResult {
  scope: AiInsightScope;
  /** Sites and stations that left the scope with this change. */
  sitesRemoved: number;
  stationsRemoved: number;
  insightsDismissed: number;
  actionsExpired: number;
}

/** Why an update was refused, with the ids at fault. */
export class AiInsightScopeError extends Error {
  constructor(
    message: string,
    readonly ids: string[] = [],
  ) {
    super(message);
    this.name = 'AiInsightScopeError';
  }
}

export interface AiInsightScopeStatus {
  /** Insights are produced for it now (AI Insights on and in the scope). */
  enabled: boolean;
  reason: AiInsightScopeReason;
}

/** The stored mode; a missing or unknown value reads as the default (`all`). */
export async function readAiInsightScopeMode(): Promise<AiInsightScopeMode> {
  const [row] = await client<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = ${AI_INSIGHT_SCOPE_SETTING_KEY}
  `;
  return isAiInsightScopeMode(row?.value) ? row.value : DEFAULT_AI_INSIGHT_SCOPE_MODE;
}

/** Whether a site created now starts selected: always, unless the scope is `selected`. */
export async function initialSiteAiInsightsSelected(): Promise<boolean> {
  return (await readAiInsightScopeMode()) !== 'selected';
}

/** The scope: the mode and every site with its station counts, by name. */
export async function readAiInsightScope(): Promise<AiInsightScope> {
  const mode = await readAiInsightScopeMode();
  const rows = await client<
    { id: string; name: string; selected: boolean; station_count: number; turned_off: number }[]
  >`
    SELECT s.id, s.name, s.ai_insights_enabled AS selected,
      count(cs.id)::int AS station_count,
      count(cs.id) FILTER (WHERE NOT cs.ai_insights_enabled)::int AS turned_off
    FROM sites s
    LEFT JOIN charging_stations cs ON cs.site_id = s.id AND ${client.unsafe(operatorStationSql('cs'))}
    GROUP BY s.id, s.name, s.ai_insights_enabled
    ORDER BY lower(s.name), s.id
  `;
  const [lone] = await client<{ n: number }[]>`
    SELECT count(*)::int AS n FROM charging_stations cs
    WHERE cs.site_id IS NULL AND ${client.unsafe(operatorStationSql('cs'))}
  `;
  return {
    mode,
    sites: rows.map((r) => ({
      id: r.id,
      name: r.name,
      selected: r.selected,
      stationCount: r.station_count,
      stationsTurnedOff: r.turned_off,
    })),
    stationsWithoutSite: lone?.n ?? 0,
  };
}

/** The operator stations of a site with their switch. Null for an unknown site. */
export async function readAiInsightScopeStations(
  siteId: string,
): Promise<AiInsightScopeStation[] | null> {
  const [site] = await client<{ id: string }[]>`SELECT id FROM sites WHERE id = ${siteId}`;
  if (site == null) return null;
  const rows = await client<{ id: string; station_id: string; enabled: boolean }[]>`
    SELECT cs.id, cs.station_id, cs.ai_insights_enabled AS enabled
    FROM charging_stations cs
    WHERE cs.site_id = ${siteId} AND ${client.unsafe(operatorStationSql('cs'))}
    ORDER BY cs.station_id
  `;
  return rows.map((r) => ({ id: r.id, stationId: r.station_id, enabled: r.enabled }));
}

/** Whether AI insights run for a station now, and why. Null for an unknown station. */
export async function stationAiInsightsScopeStatus(
  stationId: string,
): Promise<AiInsightScopeStatus | null> {
  const [row] = await client<{ reason: AiInsightScopeReason }[]>`
    SELECT ${client.unsafe(stationInsightScopeReasonSql('cs'))} AS reason
    FROM charging_stations cs WHERE cs.id = ${stationId}
  `;
  if (row == null) return null;
  return aiInsightsScopeStatusOf(row.reason);
}

/** Whether AI insights run for a site now, and why. Null for an unknown site. */
export async function siteAiInsightsScopeStatus(
  siteId: string,
): Promise<AiInsightScopeStatus | null> {
  const [row] = await client<{ reason: AiInsightScopeReason }[]>`
    SELECT ${client.unsafe(siteInsightScopeReasonSql('s'))} AS reason FROM sites s WHERE s.id = ${siteId}
  `;
  if (row == null) return null;
  return aiInsightsScopeStatusOf(row.reason);
}

/**
 * Outside the scope by its selection (no site, site not selected, station
 * turned off). AI Insights being off is not: a suppression set then holds
 * once they are on again.
 */
export function isOutsideAiInsightScope(status: AiInsightScopeStatus): boolean {
  return !status.enabled && status.reason !== 'feature_off';
}

/** The status of a scope reason: `feature_off` while AI Insights are off. */
export async function aiInsightsScopeStatusOf(
  reason: AiInsightScopeReason,
): Promise<AiInsightScopeStatus> {
  const inScope = reason === 'all_sites' || reason === 'selected';
  if (inScope && !(await isAiInsightsEnabled())) return { enabled: false, reason: 'feature_off' };
  return { enabled: inScope, reason };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface InScope {
  sites: Set<string>;
  stations: Map<string, string | null>;
}

async function inScopeNow(tx: Tx): Promise<InScope> {
  const siteRows = await tx.execute<{ id: string }>(
    sql`SELECT s.id FROM sites s WHERE ${sql.raw(siteInsightsInScopeSql('s'))}`,
  );
  const stationRows = await tx.execute<{ id: string; site_id: string | null }>(
    sql`SELECT cs.id, cs.site_id FROM charging_stations cs
      WHERE ${sql.raw(operatorStationSql('cs'))} AND ${sql.raw(stationInsightsInScopeSql('cs'))}`,
  );
  return {
    sites: new Set(siteRows.map((r) => r.id)),
    stations: new Map(stationRows.map((r) => [r.id, r.site_id])),
  };
}

interface FlagChange {
  id: string;
  before: boolean;
  after: boolean;
}

function unique(items: readonly { id: string }[], label: string): void {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  if (repeated.size > 0) {
    throw new AiInsightScopeError(`${label} listed more than once`, [...repeated]);
  }
}

/**
 * Changes the scope. In one transaction (one at a time, an advisory lock):
 * the mode, then the listed site and station switches (`selected` only; `all`
 * selects every site and turns every station on). After the commit, closes
 * the insights and actions of what left the scope. Throws
 * `AiInsightScopeError` for lists sent with `all`, an id listed twice, or an
 * unknown site or station (nothing changes).
 */
export async function updateAiInsightScope(
  input: AiInsightScopeUpdate,
  actor: AuditActorInfo,
  log: FastifyBaseLogger,
): Promise<AiInsightScopeUpdateResult> {
  const siteChanges = (input.sites ?? []).map((s) => ({ id: s.siteId, on: s.selected }));
  const stationChanges = (input.stations ?? []).map((s) => ({ id: s.stationId, on: s.enabled }));
  if (input.mode === 'all' && (siteChanges.length > 0 || stationChanges.length > 0)) {
    throw new AiInsightScopeError('Sites and stations are chosen only for the selected scope');
  }
  unique(siteChanges, 'A site');
  unique(stationChanges, 'A station');

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${AI_INSIGHT_SCOPE_SETTING_KEY}))`);
    const siteIds = siteChanges.map((c) => c.id);
    const stationIds = stationChanges.map((c) => c.id);
    const knownSites =
      siteIds.length === 0
        ? []
        : await tx
            .select({ id: sites.id, on: sites.aiInsightsEnabled })
            .from(sites)
            .where(inArray(sites.id, siteIds));
    const knownStations =
      stationIds.length === 0
        ? []
        : await tx
            .select({ id: chargingStations.id, on: chargingStations.aiInsightsEnabled })
            .from(chargingStations)
            .where(
              and(
                inArray(chargingStations.id, stationIds),
                sql.raw(operatorStationSql('charging_stations')),
              ),
            );
    const siteNow = new Map(knownSites.map((r) => [r.id, r.on]));
    const stationNow = new Map(knownStations.map((r) => [r.id, r.on]));
    const unknownSites = siteIds.filter((id) => !siteNow.has(id));
    if (unknownSites.length > 0) throw new AiInsightScopeError('Unknown site', unknownSites);
    const unknownStations = stationIds.filter((id) => !stationNow.has(id));
    if (unknownStations.length > 0) {
      throw new AiInsightScopeError('Unknown station', unknownStations);
    }

    const before = await inScopeNow(tx);
    const [modeRow] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, AI_INSIGHT_SCOPE_SETTING_KEY));
    const modeBefore = isAiInsightScopeMode(modeRow?.value)
      ? modeRow.value
      : DEFAULT_AI_INSIGHT_SCOPE_MODE;
    if (modeBefore !== input.mode) {
      await tx
        .insert(settings)
        .values({ key: AI_INSIGHT_SCOPE_SETTING_KEY, value: input.mode })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: input.mode, updatedAt: new Date() },
        });
    }

    let siteFlips: FlagChange[];
    let stationFlips: FlagChange[];
    if (input.mode === 'all') {
      // Every site selected and every station on: the flags agree with `all`.
      const sitesOn = await tx
        .update(sites)
        .set({ aiInsightsEnabled: true, updatedAt: new Date() })
        .where(eq(sites.aiInsightsEnabled, false))
        .returning({ id: sites.id });
      const stationsOn = await tx
        .update(chargingStations)
        .set({ aiInsightsEnabled: true, updatedAt: new Date() })
        .where(eq(chargingStations.aiInsightsEnabled, false))
        .returning({ id: chargingStations.id });
      siteFlips = sitesOn.map((r) => ({ id: r.id, before: false, after: true }));
      stationFlips = stationsOn.map((r) => ({ id: r.id, before: false, after: true }));
    } else {
      siteFlips = siteChanges
        .filter((c) => siteNow.get(c.id) !== c.on)
        .map((c) => ({ id: c.id, before: !c.on, after: c.on }));
      stationFlips = stationChanges
        .filter((c) => stationNow.get(c.id) !== c.on)
        .map((c) => ({ id: c.id, before: !c.on, after: c.on }));
      for (const on of [true, false]) {
        const sitesTo = siteFlips.filter((f) => f.after === on).map((f) => f.id);
        if (sitesTo.length > 0) {
          await tx
            .update(sites)
            .set({ aiInsightsEnabled: on, updatedAt: new Date() })
            .where(inArray(sites.id, sitesTo));
        }
        const stationsTo = stationFlips.filter((f) => f.after === on).map((f) => f.id);
        if (stationsTo.length > 0) {
          await tx
            .update(chargingStations)
            .set({ aiInsightsEnabled: on, updatedAt: new Date() })
            .where(inArray(chargingStations.id, stationsTo));
        }
      }
    }
    const after = await inScopeNow(tx);
    return { modeBefore, before, after, siteFlips, stationFlips };
  });

  await auditScopeChange(input.mode, outcome.modeBefore, outcome, actor, log);

  // What left the scope: sites, then stations whose site stays in scope (a
  // site's closing covers its stations).
  const sitesRemoved = [...outcome.before.sites].filter((id) => !outcome.after.sites.has(id));
  const removedSites = new Set(sitesRemoved);
  const stationsRemoved = [...outcome.before.stations.entries()]
    .filter(([id]) => !outcome.after.stations.has(id))
    .filter(([, siteId]) => siteId == null || !removedSites.has(siteId))
    .map(([id]) => id);
  const closed = await closeOutOfScope(sitesRemoved, stationsRemoved, actor, log);

  return {
    scope: await readAiInsightScope(),
    sitesRemoved: sitesRemoved.length,
    stationsRemoved: [...outcome.before.stations.keys()].filter(
      (id) => !outcome.after.stations.has(id),
    ).length,
    ...closed,
  };
}

async function closeOutOfScope(
  siteIds: readonly string[],
  stationIds: readonly string[],
  actor: AuditActorInfo,
  log: FastifyBaseLogger,
): Promise<{ insightsDismissed: number; actionsExpired: number }> {
  let insightsDismissed = 0;
  let actionsExpired = 0;
  const proposalActor = {
    actor: actor.actor,
    actorUserId: actor.actorUserId,
    actorLabel: actor.actorLabel,
  };
  const insightActor = {
    actor: actor.actor,
    actorUserId: actor.actorUserId,
    actorApiKeyId: actor.actorApiKeyId,
  };
  // The scan and the workers stop at once (the predicates read the new
  // flags); a failed close leaves an insight open, so it is logged and the
  // others still close.
  for (const siteId of siteIds) {
    try {
      actionsExpired += await expireSiteAiProposals(siteId, SCOPE_CHANGE_NOTE, proposalActor, log);
      insightsDismissed += (
        await dismissSiteInsights(
          siteId,
          SCOPE_CHANGE_NOTE,
          insightActor,
          getPubSub(),
          'ai_insights_scope',
        )
      ).length;
    } catch (err) {
      log.warn({ err, siteId }, 'Closing the AI insights of a site that left the scope failed');
    }
  }
  for (const stationId of stationIds) {
    try {
      actionsExpired += await expireStationAiProposals(
        stationId,
        SCOPE_CHANGE_NOTE,
        proposalActor,
        log,
      );
      insightsDismissed += (
        await dismissStationInsights(
          stationId,
          SCOPE_CHANGE_NOTE,
          insightActor,
          getPubSub(),
          'ai_insights_scope',
        )
      ).length;
    } catch (err) {
      log.warn(
        { err, stationId },
        'Closing the AI insights of a station that left the scope failed',
      );
    }
  }
  return { insightsDismissed, actionsExpired };
}

async function auditScopeChange(
  mode: AiInsightScopeMode,
  modeBefore: AiInsightScopeMode,
  outcome: { siteFlips: FlagChange[]; stationFlips: FlagChange[] },
  actor: AuditActorInfo,
  log: FastifyBaseLogger,
): Promise<void> {
  if (mode !== modeBefore) {
    await writeAudit(
      { table: settingAuditLog, idColumn: 'setting_key' },
      {
        entityId: AI_INSIGHT_SCOPE_SETTING_KEY,
        entityIdSnapshot: AI_INSIGHT_SCOPE_SETTING_KEY,
        action: 'updated',
        ...actor,
        before: { key: AI_INSIGHT_SCOPE_SETTING_KEY, value: modeBefore },
        after: { key: AI_INSIGHT_SCOPE_SETTING_KEY, value: mode },
        notes: 'AI insights scope changed',
      },
      db,
      log,
    );
  }
  for (const flip of outcome.siteFlips) {
    await writeAudit(
      { table: siteAuditLog, idColumn: 'site_id' },
      {
        entityId: flip.id,
        entityIdSnapshot: flip.id,
        action: 'updated',
        ...actor,
        before: { aiInsightsEnabled: flip.before },
        after: { aiInsightsEnabled: flip.after },
        notes: flip.after ? 'Added to the AI insights scope' : SCOPE_CHANGE_NOTE,
      },
      db,
      log,
    );
  }
  for (const flip of outcome.stationFlips) {
    await writeAudit(
      { table: stationAuditLog, idColumn: 'station_id' },
      {
        entityId: flip.id,
        entityIdSnapshot: flip.id,
        action: 'updated',
        ...actor,
        before: { aiInsightsEnabled: flip.before },
        after: { aiInsightsEnabled: flip.after },
        notes: flip.after
          ? 'Turned on in the AI insights scope'
          : 'Turned off in the AI insights scope',
      },
      db,
      log,
    );
  }
}
