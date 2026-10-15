// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  db,
  evses,
  isRoamingEnabled,
  ocpiLocationAudience,
  recordRemovedOcpiEvses,
  removedOcpiEvses,
} from '@evtivity/database';
import type { OcpiLocationAudience, RemovedOcpiEvse, sites } from '@evtivity/database';
import { getPubSub } from '@evtivity/lib/pubsub-instance';

/**
 * The partners that lose a location between two publish states, under the
 * OCPI location id they know: those no longer in the audience, or all of
 * them when the location id changed. Null when nobody loses it.
 */
export function lostLocationAudience(
  before: OcpiLocationAudience | null,
  after: OcpiLocationAudience | null,
): { ocpiLocationId: string; partnerIds: string[] } | null {
  if (before == null) return null;
  const kept =
    after != null && after.ocpiLocationId === before.ocpiLocationId
      ? new Set(after.partnerIds)
      : new Set<string>();
  const partnerIds = before.partnerIds.filter((id) => !kept.has(id));
  return partnerIds.length > 0 ? { ocpiLocationId: before.ocpiLocationId, partnerIds } : null;
}

async function publishOcpiPush(
  payload: Record<string, unknown>,
  logger?: FastifyBaseLogger,
): Promise<void> {
  try {
    if (!(await isRoamingEnabled())) return;
    await getPubSub().publish('ocpi_push', JSON.stringify(payload));
  } catch (err) {
    logger?.warn({ err, type: payload['type'] }, 'OCPI push publish failed');
  }
}

/**
 * Asks the OCPI server to push a site's location to its partners, and the
 * location with every EVSE REMOVED to the partners in `removed` (OCPI 8.1).
 * Fail-open: the change is stored, and pull partners see it on their next GET.
 */
export async function publishOcpiLocationPush(
  siteId: string,
  removed: { ocpiLocationId: string; partnerIds: string[] } | null,
  logger?: FastifyBaseLogger,
): Promise<void> {
  await publishOcpiPush(
    { type: 'location', siteId, ...(removed != null ? { removed } : {}) },
    logger,
  );
}

/**
 * A station moved from one site to another. Its EVSEs are recorded as
 * removed from the site it left (served there as REMOVED, OCPI 8.1), and
 * both locations are pushed: the old one with the EVSEs REMOVED, the new one
 * with them live. Fail-open: the move is stored, and pull partners see both
 * locations on their next GET.
 */
export async function publishOcpiStationSiteMove(
  stationId: string,
  fromSiteId: string | null,
  toSiteId: string | null,
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (fromSiteId === toSiteId) return;
  if (fromSiteId != null) {
    try {
      const rows = await db
        .select({ id: evses.id })
        .from(evses)
        .where(eq(evses.stationId, stationId));
      await recordRemovedOcpiEvses(
        fromSiteId,
        rows.map((r) => r.id),
      );
    } catch (err) {
      logger?.warn({ err, stationId }, 'Recording EVSEs removed from the old site failed');
    }
    await publishOcpiLocationPush(fromSiteId, null, logger);
  }
  if (toSiteId != null) await publishOcpiLocationPush(toSiteId, null, logger);
}

/** What the OCPI server needs to render a deleted site's location as REMOVED. */
export interface DeletedSiteLocation {
  siteId: string;
  ocpiLocationId: string;
  partnerIds: string[];
  site: Pick<
    typeof sites.$inferSelect,
    | 'id'
    | 'name'
    | 'address'
    | 'city'
    | 'state'
    | 'postalCode'
    | 'country'
    | 'latitude'
    | 'longitude'
    | 'timezone'
    | 'contactName'
    | 'contactIsPublic'
    | 'hoursOfOperation'
    | 'updatedAt'
  >;
  removedEvses: RemovedOcpiEvse[];
}

/**
 * Captures a site's published location before the site is deleted: the
 * delete cascades its publish row and its removed EVSEs, so the OCPI server
 * could not render it afterwards. Null when no partner has the location (not
 * published, or no EVSE was published there within the retention period).
 * Fail-open: a failed read only skips the push.
 */
export async function captureDeletedSiteLocation(
  site: typeof sites.$inferSelect,
  logger?: FastifyBaseLogger,
): Promise<DeletedSiteLocation | null> {
  try {
    if (!(await isRoamingEnabled())) return null;
    const audience = await ocpiLocationAudience(site.id);
    if (audience == null || audience.partnerIds.length === 0) return null;
    const removed = await removedOcpiEvses([site.id]);
    if (removed.length === 0) return null;
    return {
      siteId: site.id,
      ocpiLocationId: audience.ocpiLocationId,
      partnerIds: audience.partnerIds,
      site: {
        id: site.id,
        name: site.name,
        address: site.address,
        city: site.city,
        state: site.state,
        postalCode: site.postalCode,
        country: site.country,
        latitude: site.latitude,
        longitude: site.longitude,
        timezone: site.timezone,
        contactName: site.contactName,
        contactIsPublic: site.contactIsPublic,
        hoursOfOperation: site.hoursOfOperation,
        updatedAt: site.updatedAt,
      },
      removedEvses: removed,
    };
  } catch (err) {
    logger?.warn({ err, siteId: site.id }, 'Capturing the OCPI location of a deleted site failed');
    return null;
  }
}

/**
 * Asks the OCPI server to push a deleted site's location, every EVSE
 * REMOVED, to the partners that had it (OCPI 8.1: a Location is removed by
 * setting its EVSEs to REMOVED). Fail-open.
 */
export async function publishOcpiDeletedSiteLocation(
  deleted: DeletedSiteLocation,
  logger?: FastifyBaseLogger,
): Promise<void> {
  await publishOcpiPush(
    {
      type: 'location',
      siteId: deleted.siteId,
      removed: { ocpiLocationId: deleted.ocpiLocationId, partnerIds: deleted.partnerIds },
      deletedSite: { site: deleted.site, removedEvses: deleted.removedEvses },
    },
    logger,
  );
}
