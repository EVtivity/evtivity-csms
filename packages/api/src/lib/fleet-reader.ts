// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { requestHasPermission } from '../middleware/rbac.js';
import { getUserAccessScope } from './fleet-scope.js';
import { getUserSiteIds } from './site-access.js';

/**
 * Who reads a fleet through the fleet routes: an operator with its sites
 * (`siteIds` null for every site) or a fleet user with its assigned fleets
 * (`paymentsRead`: it may see costs). The fleet service readers take it to
 * pick the sessions and the fields.
 */
export type FleetReader =
  | { kind: 'sites'; siteIds: string[] | null }
  | { kind: 'fleets'; fleetIds: string[]; paymentsRead: boolean };

/** Every site: what the readers default to (an all-site operator). */
export const ALL_SITES_READER: FleetReader = { kind: 'sites', siteIds: null };

/** The fleet reader of the signed-in user (an API key keeps its scope). */
export async function fleetReaderOf(request: FastifyRequest): Promise<FleetReader> {
  const { userId } = request.user as { userId: string };
  const access = await getUserAccessScope(userId);
  if (access.kind === 'fleets') {
    return {
      kind: 'fleets',
      fleetIds: access.fleetIds,
      paymentsRead: await requestHasPermission(request, 'payments:read'),
    };
  }
  return { kind: 'sites', siteIds: await getUserSiteIds(userId) };
}

/**
 * Whether the sort key names a field the reader is not shown: a fleet user
 * never sorts members by email or phone, vehicles by VIN, or sessions by cost
 * without payments:read, so the order cannot tell it those values.
 */
export function sortsByHiddenField(
  reader: FleetReader,
  list: 'drivers' | 'vehicles' | 'sessions',
  sort: string | undefined,
): boolean {
  if (reader.kind !== 'fleets' || sort == null) return false;
  if (list === 'drivers') return sort === 'email' || sort === 'phone';
  if (list === 'vehicles') return sort === 'vin';
  return sort === 'cost' && !reader.paymentsRead;
}
