// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db, fleets } from '@evtivity/database';
import { isAllSiteUser, requireAllSiteAccess } from './site-access.js';

const FLEET_NOT_FOUND = { error: 'Fleet not found', code: 'FLEET_NOT_FOUND' } as const;

/**
 * A fleet invoice spans the sites the fleet's members charged at, so only a
 * user with access to every site (getUserSiteIds is null) may preview,
 * generate or list fleet invoices. A site-restricted user gets 404
 * FLEET_NOT_FOUND, not 403, so the fleet's existence does not leak (design
 * principle P11, multi-tenant isolation). Returns true when the reply was
 * sent.
 */
export async function refuseSiteRestrictedFleetBilling(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  return !(await requireAllSiteAccess(request, reply, FLEET_NOT_FOUND));
}

/**
 * Fleet membership decides what a driver pays at every site when the fleet
 * has a pricing group (fleet tariffs) or bills on account. A site-restricted
 * user may add or remove members only of a fleet with neither (owner
 * decision 2026-10-09); otherwise, and for a missing fleet, it gets 404
 * FLEET_NOT_FOUND. All-site users pass; the route answers its own 404 for a
 * missing fleet. Returns true when the reply was sent.
 */
export async function refuseSiteRestrictedFleetMembership(
  request: FastifyRequest,
  reply: FastifyReply,
  fleetId: string,
): Promise<boolean> {
  const { userId } = request.user as { userId: string };
  if (await isAllSiteUser(userId)) return false;
  const [fleet] = await db
    .select({
      accountBillingEnabled: fleets.accountBillingEnabled,
      // Written out: a single-table select renders columns unqualified, and
      // the correlated fleet id must name the outer fleets row.
      hasPricingGroup: sql<boolean>`exists (select 1 from pricing_group_fleets pgf where pgf.fleet_id = "fleets"."id")`,
    })
    .from(fleets)
    .where(eq(fleets.id, fleetId));
  if (fleet != null && !fleet.accountBillingEnabled && !fleet.hasPricingGroup) return false;
  await reply.status(404).send(FLEET_NOT_FOUND);
  return true;
}
