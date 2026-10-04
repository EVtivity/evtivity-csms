// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq } from 'drizzle-orm';
import { client, db, sites, siteMaxSessionFeeGrossCents } from '@evtivity/database';

/**
 * Whether a site's hold covers the session fee (tax included) of the tariffs
 * that apply at its stations to a driver without a pricing group. Warned, not
 * refused, on the site payment config save: the tariff that applies also
 * depends on the driver's or fleet's pricing group, the time of day and
 * holidays, and tariffs change after the config is saved, so no save-time
 * check can be complete. The guest start then holds the fee of the tariff that
 * applies plus the configured hold (`guestHoldTerms` in @evtivity/payments), the layer that
 * holds at every start (P11).
 */
export async function holdFeeCheck(
  siteId: string,
  preAuthAmountCents: number,
): Promise<{ sessionFeeCents: number; holdBelowSessionFee: boolean }> {
  const [site] = await db
    .select({ freeVendEnabled: sites.freeVendEnabled })
    .from(sites)
    .where(eq(sites.id, siteId));
  if (site?.freeVendEnabled === true) return { sessionFeeCents: 0, holdBelowSessionFee: false };
  const sessionFeeCents = await siteMaxSessionFeeGrossCents(siteId, client);
  return { sessionFeeCents, holdBelowSessionFee: sessionFeeCents > preAuthAmountCents };
}
