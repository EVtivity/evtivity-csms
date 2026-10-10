// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { and, eq, sql, asc, desc, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import {
  db,
  sites,
  chargingStations,
  chargingSessions,
  drivers,
  fleets,
  users,
  driverTokens,
  reservations,
  invoices,
  supportCases,
  pricingGroups,
  ocpiPartners,
  configTemplates,
  chargingProfileTemplates,
  firmwareCampaigns,
  octtRuns,
} from '@evtivity/database';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds, requireAllSiteAccess } from '../lib/site-access.js';
import { supportCaseSiteCondition } from '../lib/support-case-scope.js';
import type { ErrorCode } from '../lib/error-codes.generated.js';
import { manageableUsersCondition } from '../lib/user-management-scope.js';
import {
  chargingProfileTemplateInScopeSql,
  configTemplateInScopeSql,
  firmwareCampaignInScopeSql,
} from '../lib/fleet-operation-scope.js';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, errorResponse } from '../lib/response-schemas.js';

const neighborParams = z.object({ id: z.string().describe('Entity ID') });

const neighborsItem = z
  .object({
    prevId: z
      .string()
      .nullable()
      .describe('ID of the newer sibling in default list order, null at the top'),
    nextId: z
      .string()
      .nullable()
      .describe('ID of the older sibling in default list order, null at the end'),
  })
  .passthrough();

interface NeighborTarget {
  path: string;
  tag: string;
  operationId: string;
  permission: string;
  notFoundCode: ErrorCode;
  idColumn: PgColumn;
  createdAtColumn: PgColumn;
  parseId?: (raw: string) => string | number;
  // Returns the site-access condition for the user's allowed sites, or
  // undefined when the resource is not site-scoped. `siteIds` is non-null
  // only for restricted users.
  scopeWhere?: (siteIds: string[], userId: string) => SQL | undefined;
  // True when scopeWhere does not depend on the sites: a restricted user with
  // no site is then scoped like any restricted user instead of answered 404.
  scopeServesNoSites?: boolean;
  // True for a company-wide resource: only a user with access to every site
  // may page through it; a site-restricted user gets 404.
  allSitesOnly?: boolean;
}

const stationSiteSubquery = (siteIds: string[]): SQL =>
  inArray(
    chargingSessions.stationId,
    db
      .select({ id: chargingStations.id })
      .from(chargingStations)
      .where(inArray(chargingStations.siteId, siteIds)),
  );

const TARGETS: NeighborTarget[] = [
  {
    path: '/sites/:id/neighbors',
    tag: 'Sites',
    operationId: 'getSiteNeighbors',
    permission: 'sites:read',
    notFoundCode: 'SITE_NOT_FOUND',
    idColumn: sites.id,
    createdAtColumn: sites.createdAt,
    scopeWhere: (siteIds) => inArray(sites.id, siteIds),
  },
  {
    path: '/stations/:id/neighbors',
    tag: 'Stations',
    operationId: 'getStationNeighbors',
    permission: 'stations:read',
    notFoundCode: 'STATION_NOT_FOUND',
    idColumn: chargingStations.id,
    createdAtColumn: chargingStations.createdAt,
    // Stations with no site are visible to all-site users only, matching the list.
    scopeWhere: (siteIds) => inArray(chargingStations.siteId, siteIds),
  },
  {
    path: '/sessions/:id/neighbors',
    tag: 'Sessions',
    operationId: 'getSessionNeighbors',
    permission: 'sessions:read',
    notFoundCode: 'SESSION_NOT_FOUND',
    idColumn: chargingSessions.id,
    createdAtColumn: chargingSessions.createdAt,
    scopeWhere: (siteIds) => stationSiteSubquery(siteIds),
  },
  {
    path: '/drivers/:id/neighbors',
    tag: 'Drivers',
    operationId: 'getDriverNeighbors',
    permission: 'drivers:read',
    notFoundCode: 'DRIVER_NOT_FOUND',
    idColumn: drivers.id,
    createdAtColumn: drivers.createdAt,
  },
  {
    path: '/fleets/:id/neighbors',
    tag: 'Fleets',
    operationId: 'getFleetNeighbors',
    permission: 'fleets:read',
    notFoundCode: 'FLEET_NOT_FOUND',
    idColumn: fleets.id,
    createdAtColumn: fleets.createdAt,
  },
  {
    path: '/users/:id/neighbors',
    tag: 'Users',
    operationId: 'getUserNeighbors',
    permission: 'users:read',
    notFoundCode: 'USER_NOT_FOUND',
    idColumn: users.id,
    createdAtColumn: users.createdAt,
    // A site-restricted operator pages only through the users it manages
    // (user-management-scope.ts): never all-site users or users of other sites.
    scopeWhere: (siteIds) => manageableUsersCondition(siteIds),
    scopeServesNoSites: true,
  },
  {
    path: '/tokens/:id/neighbors',
    tag: 'Tokens',
    operationId: 'getTokenNeighbors',
    permission: 'drivers:read',
    notFoundCode: 'TOKEN_NOT_FOUND',
    idColumn: driverTokens.id,
    createdAtColumn: driverTokens.createdAt,
  },
  {
    path: '/reservations/:id/neighbors',
    tag: 'Reservations',
    operationId: 'getReservationNeighbors',
    permission: 'reservations:read',
    notFoundCode: 'RESERVATION_NOT_FOUND',
    idColumn: reservations.id,
    createdAtColumn: reservations.createdAt,
    scopeWhere: (siteIds) =>
      inArray(
        reservations.stationId,
        db
          .select({ id: chargingStations.id })
          .from(chargingStations)
          .where(inArray(chargingStations.siteId, siteIds)),
      ),
  },
  {
    path: '/invoices/:id/neighbors',
    tag: 'Invoices',
    operationId: 'getInvoiceNeighbors',
    permission: 'payments:read',
    notFoundCode: 'INVOICE_NOT_FOUND',
    idColumn: invoices.id,
    createdAtColumn: invoices.createdAt,
    // Invoices are company-wide money: a site-restricted user sees none,
    // matching the list and the per-invoice routes (404 INVOICE_NOT_FOUND).
    allSitesOnly: true,
  },
  {
    path: '/support-cases/:id/neighbors',
    tag: 'Support Cases',
    operationId: 'getSupportCaseNeighbors',
    permission: 'support:read',
    notFoundCode: 'SUPPORT_CASE_NOT_FOUND',
    idColumn: supportCases.id,
    createdAtColumn: supportCases.createdAt,
    // The same visibility as the case list and detail.
    scopeWhere: (siteIds) => supportCaseSiteCondition(siteIds),
  },
  {
    path: '/pricing-groups/:id/neighbors',
    tag: 'Pricing',
    operationId: 'getPricingGroupNeighbors',
    permission: 'pricing:read',
    notFoundCode: 'PRICING_GROUP_NOT_FOUND',
    idColumn: pricingGroups.id,
    createdAtColumn: pricingGroups.createdAt,
  },
  {
    path: '/ocpi/partners/:id/neighbors',
    tag: 'OCPI',
    operationId: 'getOcpiPartnerNeighbors',
    permission: 'roaming:read',
    notFoundCode: 'PARTNER_NOT_FOUND',
    idColumn: ocpiPartners.id,
    createdAtColumn: ocpiPartners.createdAt,
    // Roaming partners are company-wide (site-access-control.md).
    allSitesOnly: true,
  },
  {
    path: '/config-templates/:id/neighbors',
    tag: 'Stations',
    operationId: 'getConfigTemplateNeighbors',
    permission: 'settings.stationConfig:read',
    notFoundCode: 'TEMPLATE_NOT_FOUND',
    idColumn: configTemplates.id,
    createdAtColumn: configTemplates.createdAt,
    // The same visibility as the template routes (fleet-operation-scope.ts).
    scopeWhere: (siteIds) => configTemplateInScopeSql(siteIds),
  },
  {
    path: '/smart-charging/templates/:id/neighbors',
    tag: 'Stations',
    operationId: 'getSmartChargingTemplateNeighbors',
    permission: 'smartCharging:read',
    notFoundCode: 'TEMPLATE_NOT_FOUND',
    idColumn: chargingProfileTemplates.id,
    createdAtColumn: chargingProfileTemplates.createdAt,
    scopeWhere: (siteIds) => chargingProfileTemplateInScopeSql(siteIds),
  },
  {
    path: '/firmware-campaigns/:id/neighbors',
    tag: 'Stations',
    operationId: 'getFirmwareCampaignNeighbors',
    permission: 'settings.firmware:read',
    notFoundCode: 'CAMPAIGN_NOT_FOUND',
    idColumn: firmwareCampaigns.id,
    createdAtColumn: firmwareCampaigns.createdAt,
    scopeWhere: (siteIds, userId) => firmwareCampaignInScopeSql(siteIds, userId),
  },
  {
    path: '/octt/runs/:id/neighbors',
    tag: 'Conformance',
    operationId: 'getConformanceRunNeighbors',
    permission: 'conformance:read',
    notFoundCode: 'OCTT_RUN_NOT_FOUND',
    idColumn: octtRuns.id,
    createdAtColumn: octtRuns.createdAt,
    parseId: (raw) => Number(raw),
  },
];

// Neighbors follow the uniform (created_at DESC, id DESC) ordering: prev is
// the newer sibling, next the older one. Keyset comparisons keep this O(1)
// regardless of table size.
async function findNeighbors(
  target: NeighborTarget,
  id: string | number,
  scope: SQL | undefined,
): Promise<{ prevId: string | number | null; nextId: string | number | null } | null> {
  const { idColumn, createdAtColumn } = target;
  const table = idColumn.table;

  const current = await db
    .select({ id: idColumn })
    .from(table)
    .where(scope == null ? eq(idColumn, id) : and(eq(idColumn, id), scope))
    .limit(1);
  if (current[0] == null) return null;

  // The current row's (created_at, id) tuple must stay inside SQL: created_at
  // has microsecond precision and a JS Date round-trip truncates it to
  // milliseconds, which made every same-millisecond sibling compare as
  // "newer" and broke prev/next for bulk-created rows. The inner subquery's
  // unqualified id resolves to the subquery's own table scope.
  const curTuple = sql`(SELECT ${createdAtColumn}, ${idColumn} FROM ${table} WHERE ${idColumn} = ${id})`;
  const newer = sql`(${createdAtColumn}, ${idColumn}) > ${curTuple}`;
  const older = sql`(${createdAtColumn}, ${idColumn}) < ${curTuple}`;

  const [prev, next] = await Promise.all([
    db
      .select({ id: idColumn })
      .from(table)
      .where(scope == null ? newer : and(newer, scope))
      .orderBy(asc(createdAtColumn), asc(idColumn))
      .limit(1),
    db
      .select({ id: idColumn })
      .from(table)
      .where(scope == null ? older : and(older, scope))
      .orderBy(desc(createdAtColumn), desc(idColumn))
      .limit(1),
  ]);

  return {
    prevId: (prev[0]?.id ?? null) as string | number | null,
    nextId: (next[0]?.id ?? null) as string | number | null,
  };
}

export function entityNeighborRoutes(app: FastifyInstance): void {
  for (const target of TARGETS) {
    app.get(
      target.path,
      {
        onRequest: [authorize(target.permission)],
        schema: {
          tags: [target.tag],
          summary: 'Get previous and next entity IDs in default list order',
          operationId: target.operationId,
          security: [{ bearerAuth: [] }],
          params: zodSchema(neighborParams),
          response: { 200: itemResponse(neighborsItem), 404: errorResponse },
        },
      },
      async (request, reply) => {
        const { id: rawId } = request.params as z.infer<typeof neighborParams>;
        const id = target.parseId ? target.parseId(rawId) : rawId;

        let scope: SQL | undefined;
        if (
          target.allSitesOnly === true &&
          !(await requireAllSiteAccess(request, reply, {
            error: 'Not found',
            code: target.notFoundCode,
          }))
        ) {
          return;
        }
        if (target.scopeWhere != null) {
          const { userId } = request.user as JwtPayload;
          const siteIds = await getUserSiteIds(userId);
          if (siteIds != null && siteIds.length === 0 && target.scopeServesNoSites !== true) {
            await reply.status(404).send({ error: 'Not found', code: target.notFoundCode });
            return;
          }
          if (siteIds != null) scope = target.scopeWhere(siteIds, userId);
        }

        const neighbors = await findNeighbors(target, id, scope);
        if (neighbors == null) {
          await reply.status(404).send({ error: 'Not found', code: target.notFoundCode });
          return;
        }
        // IDs serialize as strings regardless of column type (octt runs use
        // integer PKs); the client only ever puts them back into URLs.
        return {
          prevId: neighbors.prevId == null ? null : String(neighbors.prevId),
          nextId: neighbors.nextId == null ? null : String(neighbors.nextId),
        };
      },
    );
  }
}
