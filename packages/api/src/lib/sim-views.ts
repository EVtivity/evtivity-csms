// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  aliasedTable,
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
} from 'drizzle-orm';
import { sql, type SQL } from 'drizzle-orm';
import {
  chargingStations,
  db,
  simAlerts,
  simAttachments,
  simSessions,
  sims,
  sites,
  users,
  type Sim,
  type SimAttachment,
} from '@evtivity/database';
import { escapeLikePattern } from '@evtivity/lib';
import {
  atInWindows,
  mergeIntervals,
  OPEN_WINDOW_END,
  spanInWindows,
  type SimInterval,
} from '@evtivity/services/station-sim.service';
import { fetchedInSiteWindowsSql, simVisibleWhere } from './sim-site-scope.js';
import { visibleUserIds } from './user-management-scope.js';

// Database reads of the SIM inventory routes (`routes/sims.ts`). Reads only:
// no provider call and no write. `siteIds` is null for a user with
// access to every site, else the user's sites (`simVisibleWhere`).
// A site-restricted viewer never sees an all-site user or a user of another
// site named, by id or name (`visibleUserIds`), and sees the SIM's history only
// inside the periods it was confirmed-attached to stations of their sites
// (`simSiteWindows`).

/** Who reads a SIM reply: the person and their sites (null: every site). */
export interface SimViewer {
  userId: string;
  siteIds: string[] | null;
}

/**
 * Keeps a user id the viewer may see and nulls the others: for a
 * site-restricted viewer only themselves and the users they may manage
 * (`visibleUserIds`), never an all-site user or a user of another site. One
 * lookup for every id of a reply.
 */
async function userIdFilter(
  ids: ReadonlyArray<string | null>,
  viewer: SimViewer,
): Promise<(id: string | null) => string | null> {
  const referenced = ids.filter((id): id is string => id != null);
  const visible = await visibleUserIds(referenced, viewer.userId, viewer.siteIds);
  return (id) => (id == null || visible == null || visible.has(id) ? id : null);
}

/**
 * The periods a site-restricted viewer sees of a SIM's history: each
 * confirmed attachment of the SIM to a station of their sites, from its start
 * to its close (open: no end), merged. Null for an all-site viewer (all of it).
 */
export async function simSiteWindows(
  simId: string,
  siteIds: string[] | null,
): Promise<SimInterval[] | null> {
  if (siteIds == null) return null;
  if (siteIds.length === 0) return [];
  // A station attachment counts by the station's site, a payment terminal
  // attachment by the site stored on it at attach time (security case 276).
  const spans = await db
    .select({ from: simAttachments.attachedAt, to: simAttachments.detachedAt })
    .from(simAttachments)
    .leftJoin(chargingStations, eq(chargingStations.id, simAttachments.stationId))
    .where(
      and(
        eq(simAttachments.simId, simId),
        isNotNull(simAttachments.confirmedAt),
        inArray(sql`COALESCE(${chargingStations.siteId}, ${simAttachments.siteId})`, siteIds),
      ),
    );
  return mergeIntervals(spans.map((s) => ({ from: s.from, to: s.to ?? OPEN_WINDOW_END })));
}

/** A person as the SIM replies name them. */
export interface UserRef {
  id: string;
  name: string | null;
}

/** The open attachment of a SIM as the list and the detail show it. */
export interface AttachmentSummary {
  id: number;
  stationId: string | null;
  stationOcppId: string | null;
  siteId: string | null;
  siteName: string | null;
  paymentTerminalId: string | null;
  source: string;
  attachedAt: string;
  confirmed: boolean;
  confirmedAt: string | null;
}

/** A SIM as every SIM reply shows it. Never a credential. */
export interface SimView {
  id: string;
  iccid: string;
  imsi: string | null;
  label: string | null;
  notes: string | null;
  provider: string | null;
  providerRef: string | null;
  status: string;
  deactivatedAt: string | null;
  deactivatedBy: string | null;
  lastStatus: unknown;
  statusFetchedAt: string | null;
  lastFetchedAt: string | null;
  lookupMissedAt: string | null;
  lookupMissReason: string | null;
  createdAt: string;
  updatedAt: string;
  attachment: AttachmentSummary | null;
}

export type SimAttachmentFilter = 'attached' | 'unattached' | 'unconfirmed';

export interface SimListFilters {
  search?: string;
  provider?: string;
  attachment?: SimAttachmentFilter;
  status?: string;
  state?: string;
  stationId?: string;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

function personName(firstName: string | null, lastName: string | null): string | null {
  const name = [firstName, lastName]
    .filter((part): part is string => part != null && part.trim() !== '')
    .join(' ');
  return name === '' ? null : name;
}

const openAttachments = aliasedTable(simAttachments, 'open_attachment');

const listColumns = {
  sim: sims,
  attachmentId: openAttachments.id,
  stationId: openAttachments.stationId,
  paymentTerminalId: openAttachments.paymentTerminalId,
  source: openAttachments.source,
  attachedAt: openAttachments.attachedAt,
  confirmedAt: openAttachments.confirmedAt,
  stationOcppId: chargingStations.stationId,
  siteId: chargingStations.siteId,
  siteName: sites.name,
};

/**
 * The list columns plus whether the reader may see the SIM's fetch state: for
 * a site-restricted reader only the status and the sync time fetched inside
 * the SIM's periods at stations of their sites (`fetchedInSiteWindowsSql`).
 */
function listColumnsFor(siteIds: string[] | null) {
  return {
    ...listColumns,
    statusShown:
      siteIds == null
        ? sql<boolean>`true`
        : sql<boolean>`${fetchedInSiteWindowsSql(sql`${sims.statusFetchedAt}`, siteIds)}`,
    syncedShown:
      siteIds == null
        ? sql<boolean>`true`
        : sql<boolean>`${fetchedInSiteWindowsSql(sql`${sims.sessionsSyncedAt}`, siteIds)}`,
  };
}

interface ListRow {
  sim: Sim;
  attachmentId: number | null;
  stationId: string | null;
  paymentTerminalId: string | null;
  source: string | null;
  attachedAt: Date | null;
  confirmedAt: Date | null;
  stationOcppId: string | null;
  siteId: string | null;
  siteName: string | null;
  statusShown: boolean;
  syncedShown: boolean;
}

function viewOf(row: ListRow): SimView {
  const { sim } = row;
  const statusShown = row.statusShown;
  return {
    id: sim.id,
    iccid: sim.iccid,
    imsi: sim.imsi,
    label: sim.label,
    notes: sim.notes,
    provider: sim.provider,
    providerRef: sim.providerRef,
    status: sim.status,
    deactivatedAt: iso(sim.deactivatedAt),
    deactivatedBy: sim.deactivatedBy,
    lastStatus: statusShown ? (sim.lastStatus ?? null) : null,
    statusFetchedAt: statusShown ? iso(sim.statusFetchedAt) : null,
    lastFetchedAt: row.syncedShown ? iso(sim.sessionsSyncedAt) : null,
    lookupMissedAt: iso(sim.lookupMissedAt),
    lookupMissReason: sim.lookupMissReason,
    createdAt: sim.createdAt.toISOString(),
    updatedAt: sim.updatedAt.toISOString(),
    attachment:
      row.attachmentId == null || row.source == null || row.attachedAt == null
        ? null
        : {
            id: row.attachmentId,
            stationId: row.stationId,
            stationOcppId: row.stationOcppId,
            siteId: row.siteId,
            siteName: row.siteName,
            paymentTerminalId: row.paymentTerminalId,
            source: row.source,
            attachedAt: row.attachedAt.toISOString(),
            confirmed: row.confirmedAt != null,
            confirmedAt: iso(row.confirmedAt),
          },
  };
}

/** The SIM's open attachment (at most one, `uq_sim_attachments_open_sim`). */
const openAttachmentOn = and(
  eq(openAttachments.simId, sims.id),
  isNull(openAttachments.detachedAt),
);
const stationOn = eq(chargingStations.id, openAttachments.stationId);
const siteOn = eq(sites.id, chargingStations.siteId);

function listConditions(filters: SimListFilters, siteIds: string[] | null): SQL | undefined {
  const conditions: Array<SQL | undefined> = [];
  if (siteIds != null) conditions.push(simVisibleWhere(siteIds));
  if (filters.search != null && filters.search !== '') {
    const pattern = `%${escapeLikePattern(filters.search)}%`;
    conditions.push(
      or(ilike(sims.iccid, pattern), ilike(sims.imsi, pattern), ilike(sims.label, pattern)),
    );
  }
  if (filters.provider != null) conditions.push(eq(sims.provider, filters.provider));
  if (filters.status != null) conditions.push(eq(sims.status, filters.status as Sim['status']));
  // The state filter matches only a status the reader may see.
  if (filters.state != null) {
    conditions.push(
      and(
        sql`${sims.lastStatus}->>'state' = ${filters.state}`,
        siteIds == null
          ? undefined
          : fetchedInSiteWindowsSql(sql`${sims.statusFetchedAt}`, siteIds),
      ),
    );
  }
  if (filters.stationId != null) conditions.push(eq(openAttachments.stationId, filters.stationId));
  if (filters.attachment === 'attached') conditions.push(isNotNull(openAttachments.id));
  if (filters.attachment === 'unattached') conditions.push(isNull(openAttachments.id));
  if (filters.attachment === 'unconfirmed') {
    conditions.push(and(isNotNull(openAttachments.id), isNull(openAttachments.confirmedAt)));
  }
  return conditions.length === 0 ? undefined : and(...conditions);
}

/** The views with every user id the viewer may not see nulled. */
async function viewsFor(rows: readonly ListRow[], viewer: SimViewer): Promise<SimView[]> {
  const shown = await userIdFilter(
    rows.map((row) => row.sim.deactivatedBy),
    viewer,
  );
  return rows.map((row) => {
    const view = viewOf(row);
    return { ...view, deactivatedBy: shown(view.deactivatedBy) };
  });
}

/** One page of the SIMs the user sees, newest first. */
export async function listSimViews(
  filters: SimListFilters,
  viewer: SimViewer,
  page: number,
  limit: number,
): Promise<{ data: SimView[]; total: number }> {
  const where = listConditions(filters, viewer.siteIds);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select(listColumnsFor(viewer.siteIds))
      .from(sims)
      .leftJoin(openAttachments, openAttachmentOn)
      .leftJoin(chargingStations, stationOn)
      .leftJoin(sites, siteOn)
      .where(where)
      .orderBy(desc(sims.createdAt), desc(sims.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ total: count() })
      .from(sims)
      .leftJoin(openAttachments, openAttachmentOn)
      .leftJoin(chargingStations, stationOn)
      .leftJoin(sites, siteOn)
      .where(where),
  ]);
  return { data: await viewsFor(rows, viewer), total: totalRow?.total ?? 0 };
}

/**
 * Every SIM the user sees with the list filters, newest first, for the CSV
 * export: the same filters and scope as `listSimViews`, no page.
 */
export async function exportSimViews(
  filters: SimListFilters,
  siteIds: string[] | null,
): Promise<SimView[]> {
  const rows = await db
    .select(listColumnsFor(siteIds))
    .from(sims)
    .leftJoin(openAttachments, openAttachmentOn)
    .leftJoin(chargingStations, stationOn)
    .leftJoin(sites, siteOn)
    .where(listConditions(filters, siteIds))
    .orderBy(desc(sims.createdAt), desc(sims.id));
  return rows.map(viewOf);
}

/** The SIM if the user sees it, else null. */
export async function visibleSim(simId: string, siteIds: string[] | null): Promise<Sim | null> {
  const [row] = await db
    .select()
    .from(sims)
    .where(
      siteIds == null ? eq(sims.id, simId) : and(eq(sims.id, simId), simVisibleWhere(siteIds)),
    );
  return row ?? null;
}

export interface SimDetailView extends SimView {
  deactivatedByUser: UserRef | null;
  attachedBy: UserRef | null;
  /** The time zone of the attached station's site, else null. */
  siteTimezone: string | null;
  network: {
    name: string | null;
    radioAccessTechnology: string | null;
    cellId: string | null;
    observedAt: string;
  } | null;
  recentAlerts: Array<{ kind: string; receivedAt: string }>;
}

/** The person with this id and their name; null for no id. Callers pass only ids the viewer may see. */
async function userRef(id: string | null): Promise<UserRef | null> {
  if (id == null) return null;
  const [user] = await db
    .select({ firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, id));
  return { id, name: user == null ? null : personName(user.firstName, user.lastName) };
}

/**
 * The SIM page's view of a SIM the user sees, else null. Database only. A
 * site-restricted viewer gets the network and alerts of the SIM's periods at
 * stations of their sites only (`simSiteWindows`).
 */
export async function simDetailView(
  simId: string,
  viewer: SimViewer,
  recentAlertCount: number,
): Promise<SimDetailView | null> {
  const { siteIds } = viewer;
  const scope = siteIds == null ? undefined : simVisibleWhere(siteIds);
  const [row] = await db
    .select({
      ...listColumnsFor(siteIds),
      attachedBy: openAttachments.attachedBy,
      siteTimezone: sites.timezone,
    })
    .from(sims)
    .leftJoin(openAttachments, openAttachmentOn)
    .leftJoin(chargingStations, stationOn)
    .leftJoin(sites, siteOn)
    .where(and(eq(sims.id, simId), scope));
  if (row == null) return null;
  const windows = await simSiteWindows(simId, siteIds);
  const shown = await userIdFilter([row.attachedBy, row.sim.deactivatedBy], viewer);
  const [[newest], alerts, attachedBy, deactivatedByUser] = await Promise.all([
    db
      .select({
        networkName: simSessions.networkName,
        radioAccessTechnology: simSessions.radioAccessTechnology,
        cellId: simSessions.cellId,
        endedAt: simSessions.endedAt,
      })
      .from(simSessions)
      .where(
        and(
          eq(simSessions.simId, simId),
          windows == null
            ? undefined
            : spanInWindows(simSessions.startedAt, simSessions.endedAt, windows),
        ),
      )
      .orderBy(desc(simSessions.endedAt), desc(simSessions.id))
      .limit(1),
    db
      .select({ kind: simAlerts.kind, receivedAt: simAlerts.receivedAt })
      .from(simAlerts)
      .where(
        and(
          eq(simAlerts.simId, simId),
          windows == null ? undefined : atInWindows(simAlerts.receivedAt, windows),
        ),
      )
      .orderBy(desc(simAlerts.receivedAt), desc(simAlerts.id))
      .limit(recentAlertCount),
    userRef(shown(row.attachedBy)),
    userRef(shown(row.sim.deactivatedBy)),
  ]);
  // viewOf nulls fetch state from outside the viewer's periods (`listColumnsFor`).
  const view = viewOf(row);
  return {
    ...view,
    deactivatedBy: shown(view.deactivatedBy),
    deactivatedByUser,
    attachedBy: row.attachmentId == null ? null : attachedBy,
    siteTimezone: row.siteTimezone,
    network:
      newest == null
        ? null
        : {
            name: newest.networkName,
            radioAccessTechnology: newest.radioAccessTechnology,
            cellId: newest.cellId,
            observedAt: newest.endedAt.toISOString(),
          },
    recentAlerts: alerts.map((a) => ({ kind: a.kind, receivedAt: a.receivedAt.toISOString() })),
  };
}

export interface AttachmentHistoryItem {
  id: number;
  stationId: string | null;
  stationOcppId: string | null;
  siteId: string | null;
  siteName: string | null;
  paymentTerminalId: string | null;
  source: string;
  attachedAt: string;
  attachedBy: UserRef | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  detachedAt: string | null;
  detachedBy: string | null;
  detachReason: string | null;
}

/**
 * The attachment history of a SIM, newest first. A site-restricted user sees
 * only the attachments to stations of their sites: where the SIM sat before
 * belongs to another site's history.
 */
export async function simAttachmentHistory(
  simId: string,
  viewer: SimViewer,
  page: number,
  limit: number,
): Promise<{ data: AttachmentHistoryItem[]; total: number }> {
  const { siteIds } = viewer;
  const where = and(
    eq(simAttachments.simId, simId),
    siteIds == null ? undefined : inArray(chargingStations.siteId, siteIds),
  );
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        attachment: simAttachments,
        stationOcppId: chargingStations.stationId,
        siteId: chargingStations.siteId,
        siteName: sites.name,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(simAttachments)
      .leftJoin(chargingStations, eq(chargingStations.id, simAttachments.stationId))
      .leftJoin(sites, eq(sites.id, chargingStations.siteId))
      .leftJoin(users, eq(users.id, simAttachments.attachedBy))
      .where(where)
      .orderBy(desc(simAttachments.attachedAt), desc(simAttachments.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ total: count() })
      .from(simAttachments)
      .leftJoin(chargingStations, eq(chargingStations.id, simAttachments.stationId))
      .where(where),
  ]);
  const shown = await userIdFilter(
    rows.flatMap((row) => attachmentUserIds(row.attachment)),
    viewer,
  );
  return {
    data: rows.map((row) => attachmentItem(row.attachment, row, shown)),
    total: totalRow?.total ?? 0,
  };
}

function attachmentUserIds(a: SimAttachment): Array<string | null> {
  return [a.attachedBy, a.confirmedBy, a.detachedBy];
}

/** One attachment as the replies show it; `shown` nulls the users the viewer may not see. */
function attachmentItem(
  a: SimAttachment,
  row: {
    stationOcppId: string | null;
    siteId: string | null;
    siteName: string | null;
    firstName: string | null;
    lastName: string | null;
  },
  shown: (id: string | null) => string | null,
): AttachmentHistoryItem {
  const attachedBy = shown(a.attachedBy);
  return {
    id: a.id,
    stationId: a.stationId,
    stationOcppId: row.stationOcppId,
    siteId: row.siteId,
    siteName: row.siteName,
    paymentTerminalId: a.paymentTerminalId,
    source: a.source,
    attachedAt: a.attachedAt.toISOString(),
    attachedBy:
      attachedBy == null ? null : { id: attachedBy, name: personName(row.firstName, row.lastName) },
    confirmedAt: iso(a.confirmedAt),
    confirmedBy: shown(a.confirmedBy),
    detachedAt: iso(a.detachedAt),
    detachedBy: shown(a.detachedBy),
    detachReason: a.detachReason,
  };
}

/** The SIM view of one SIM (no scope), after a write. */
export async function simViewById(simId: string, viewer: SimViewer): Promise<SimView | null> {
  const [row] = await db
    .select(listColumnsFor(viewer.siteIds))
    .from(sims)
    .leftJoin(openAttachments, openAttachmentOn)
    .leftJoin(chargingStations, stationOn)
    .leftJoin(sites, siteOn)
    .where(eq(sims.id, simId));
  return row == null ? null : ((await viewsFor([row], viewer))[0] ?? null);
}

/** The view of one attachment, after a write. */
export async function attachmentViewById(
  id: number,
  viewer: SimViewer,
): Promise<AttachmentHistoryItem | null> {
  const [row] = await db
    .select({
      attachment: simAttachments,
      stationOcppId: chargingStations.stationId,
      siteId: chargingStations.siteId,
      siteName: sites.name,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(simAttachments)
    .leftJoin(chargingStations, eq(chargingStations.id, simAttachments.stationId))
    .leftJoin(sites, eq(sites.id, chargingStations.siteId))
    .leftJoin(users, eq(users.id, simAttachments.attachedBy))
    .where(eq(simAttachments.id, id));
  if (row == null) return null;
  const shown = await userIdFilter(attachmentUserIds(row.attachment), viewer);
  return attachmentItem(row.attachment, row, shown);
}

/** The station with this OCPP identity (the CSV `stationId` column), else null. */
export async function stationByOcppId(
  ocppId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<{ id: string } | null> {
  const [row] = await executor
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(eq(chargingStations.stationId, ocppId));
  return row ?? null;
}

/** The station row a SIM page attach names, else null. */
export async function stationForAttach(stationId: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: chargingStations.id })
    .from(chargingStations)
    .where(eq(chargingStations.id, stationId));
  return row ?? null;
}
