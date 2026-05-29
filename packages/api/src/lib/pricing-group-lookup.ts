// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { db, pricingGroups } from '@evtivity/database';

// Pre-check used by every pricing-group assignment endpoint (site, station,
// driver, fleet) so a typo'd pricingGroupId returns a clean 404 instead of
// tripping the junction-table FK and surfacing a 500. The race between this
// SELECT and the subsequent INSERT is still possible and each call site
// wraps the upsert in a try/catch that maps Postgres 23503 back to 404.
export async function pricingGroupExists(pricingGroupId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: pricingGroups.id })
    .from(pricingGroups)
    .where(eq(pricingGroups.id, pricingGroupId));
  return row != null;
}
