// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { aliasedTable, desc, sql, type SQL } from 'drizzle-orm';
import { chargingStations, simAttachments, sims, sites } from '@evtivity/database';
import { defineListSort, type ListSortDefinition } from '../list-sort.js';
import { fetchedInSiteWindowsSql } from '../sim-site-scope.js';

/** The SIM's open attachment in the list query (at most one, `uq_sim_attachments_open_sim`). */
export const openSimAttachments = aliasedTable(simAttachments, 'open_attachment');

/**
 * A fetch value only where the reader may see it: a site-restricted reader sees the
 * provider status and the fetch times only when fetched inside the SIM's periods at
 * stations of their sites (`fetchedInSiteWindowsSql`, security cases 42 to 50), so the
 * sort reads them under the same rule and a hidden value sorts as null.
 */
function shownWhen(value: SQL, fetchedAt: SQL, siteIds: readonly string[] | null): SQL {
  if (siteIds == null) return value;
  return sql`case when ${fetchedInSiteWindowsSql(fetchedAt, siteIds)} then ${value} end`;
}

function simListColumns(siteIds: readonly string[] | null) {
  const statusAt = sql`${sims.statusFetchedAt}`;
  const syncedAt = sql`${sims.sessionsSyncedAt}`;
  return {
    iccid: sims.iccid,
    label: sims.label,
    provider: sims.provider,
    status: sims.status,
    providerStatus: shownWhen(sql`${sims.lastStatus}->>'state'`, statusAt, siteIds),
    station: chargingStations.stationId,
    // Unattached sorts last (null); an attached SIM by whether it is confirmed.
    confirmed: sql`case when ${openSimAttachments.id} is not null then ${openSimAttachments.confirmedAt} is not null end`,
    // The later of the two fetch times the reader may see, as the list shows it.
    lastFetched: sql`greatest(${shownWhen(statusAt, statusAt, siteIds)}, ${shownWhen(syncedAt, syncedAt, siteIds)})`,
    createdAt: sims.createdAt,
  };
}

type SimSortKey = keyof ReturnType<typeof simListColumns>;

const options = {
  tieBreaker: sims.id,
  defaultOrder: [desc(sims.createdAt), desc(sims.id)],
};

/** The sortable columns of `GET /v1/sims` (`api/routes.md`, "List sorting"), all-site reader. */
export const simListSort = defineListSort(simListColumns(null), options);

/** The SIM list sort for one reader: the same keys, the fetch values under the site rule. */
export function simListSortFor(siteIds: readonly string[] | null): ListSortDefinition<SimSortKey> {
  return siteIds == null ? simListSort : defineListSort(simListColumns(siteIds), options);
}

/** The sortable columns of `GET /v1/sims/:id/attachments`. */
export const simAttachmentListSort = defineListSort(
  {
    station: chargingStations.stationId,
    site: sites.name,
    source: simAttachments.source,
    attachedAt: simAttachments.attachedAt,
    detachedAt: simAttachments.detachedAt,
    reason: simAttachments.detachReason,
  },
  {
    tieBreaker: simAttachments.id,
    defaultOrder: [desc(simAttachments.attachedAt), desc(simAttachments.id)],
  },
);
