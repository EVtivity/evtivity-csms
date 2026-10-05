// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db } from '../config.js';
import { ocpiLocationPublish, ocpiLocationPublishPartners, ocpiPartners } from '../schema/ocpi.js';

/** Who sees a published site over OCPI, and under which location id. */
export interface OcpiLocationAudience {
  ocpiLocationId: string;
  partnerIds: string[];
}

/**
 * The partners a site is published to: every connected partner when
 * `publish_to_all`, else the allow-list. Null when the site is not published.
 * The OCPI location push and the API publish route (to find the partners that
 * lose a location and must get its EVSEs as REMOVED) share it.
 */
export async function ocpiLocationAudience(siteId: string): Promise<OcpiLocationAudience | null> {
  const [publish] = await db
    .select({
      id: ocpiLocationPublish.id,
      isPublished: ocpiLocationPublish.isPublished,
      publishToAll: ocpiLocationPublish.publishToAll,
      ocpiLocationId: ocpiLocationPublish.ocpiLocationId,
    })
    .from(ocpiLocationPublish)
    .where(eq(ocpiLocationPublish.siteId, siteId))
    .limit(1);
  if (publish == null || !publish.isPublished) return null;

  const rows = publish.publishToAll
    ? await db
        .select({ partnerId: ocpiPartners.id })
        .from(ocpiPartners)
        .where(eq(ocpiPartners.status, 'connected'))
    : await db
        .select({ partnerId: ocpiLocationPublishPartners.partnerId })
        .from(ocpiLocationPublishPartners)
        .where(eq(ocpiLocationPublishPartners.locationPublishId, publish.id));

  return {
    ocpiLocationId: publish.ocpiLocationId ?? siteId,
    partnerIds: rows.map((r) => r.partnerId),
  };
}
