// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, sites } from '@evtivity/database';

/**
 * True when the site exists. A create route names its site in the path, so an
 * all-site caller (whose scope check passes for any id) gets 404
 * SITE_NOT_FOUND for an unknown site instead of a foreign key error (500).
 */
export async function siteExists(siteId: string): Promise<boolean> {
  const [row] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId)).limit(1);
  return row != null;
}
