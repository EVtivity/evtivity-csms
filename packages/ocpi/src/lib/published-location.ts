// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, ocpiLocationPublish } from '@evtivity/database';
import { and, eq, or, sql } from 'drizzle-orm';

/**
 * Resolve a partner-supplied OCPI `location_id` to the published site id.
 * Partners may send the custom OCPI location id or the site id. The custom
 * id wins: a row whose `ocpi_location_id` equals the value is chosen before
 * a row whose `site_id` does. `ocpi_location_id` is unique (partial index,
 * migration 0360) and the API refuses one equal to another site's id, so at
 * most one row matches each form and the result is deterministic.
 * Null when no published site matches.
 */
export async function findPublishedSiteId(locationId: string): Promise<string | null> {
  const [row] = await db
    .select({ siteId: ocpiLocationPublish.siteId })
    .from(ocpiLocationPublish)
    .where(
      and(
        eq(ocpiLocationPublish.isPublished, true),
        or(
          eq(ocpiLocationPublish.ocpiLocationId, locationId),
          eq(ocpiLocationPublish.siteId, locationId),
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${ocpiLocationPublish.ocpiLocationId} = ${locationId} THEN 0 ELSE 1 END`,
      ocpiLocationPublish.id,
    )
    .limit(1);
  return row?.siteId ?? null;
}
