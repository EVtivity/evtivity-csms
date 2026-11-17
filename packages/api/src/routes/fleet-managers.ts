// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db, fleets, userFleetAssignments, userPermissions, users } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { errorWith, paginatedResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { requireAllSiteAccess } from '../lib/site-access.js';

const FLEET_NOT_FOUND = { error: 'Fleet not found', code: 'FLEET_NOT_FOUND' } as const;

const fleetParams = z.object({ id: ID_PARAMS.fleetId.describe('Fleet ID') });

const managerItem = z
  .object({
    id: z.string().describe('User ID'),
    firstName: z.string().nullable().describe('First name'),
    lastName: z.string().nullable().describe('Last name'),
    email: z.string().describe('Email address'),
    isActive: z.boolean().describe('Whether the account can sign in'),
    lastLoginAt: z.string().nullable().describe('Last sign-in (ISO 8601), null when never'),
    permissions: z
      .array(z.string())
      .describe('The permissions the fleet user holds, sorted by name'),
  })
  .loose();

export interface FleetManagerItem {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  permissions: string[];
}

/** The fleet users assigned to a fleet: a company-wide read for all-site admins. */
export function fleetManagerRoutes(app: FastifyInstance): void {
  app.get(
    '/fleets/:id/managers',
    {
      onRequest: [authorize('fleets:read', 'users:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List the fleet users of a fleet',
        description:
          'The fleet users (access scope fleets) assigned to the fleet, newest first, with their permissions and last sign-in. Fleet users are company-wide accounts: a site-restricted user gets 404 FLEET_NOT_FOUND, and a fleet user cannot read it.',
        operationId: 'listFleetManagers',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(managerItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      if (!(await requireAllSiteAccess(request, reply, FLEET_NOT_FOUND))) return;
      const [fleet] = await db.select({ id: fleets.id }).from(fleets).where(eq(fleets.id, id));
      if (fleet == null) {
        await reply.status(404).send(FLEET_NOT_FOUND);
        return;
      }
      const where = and(eq(userFleetAssignments.fleetId, id), eq(users.accessScope, 'fleets'));
      const [rows, totals] = await Promise.all([
        db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            isActive: users.isActive,
            lastLoginAt: users.lastLoginAt,
          })
          .from(userFleetAssignments)
          .innerJoin(users, eq(users.id, userFleetAssignments.userId))
          .where(where)
          .orderBy(desc(users.createdAt), desc(users.id))
          .limit(limit)
          .offset((page - 1) * limit),
        db
          .select({ total: count() })
          .from(userFleetAssignments)
          .innerJoin(users, eq(users.id, userFleetAssignments.userId))
          .where(where),
      ]);
      const ids = rows.map((r) => r.id);
      const grants =
        ids.length === 0
          ? []
          : await db
              .select({ userId: userPermissions.userId, permission: userPermissions.permission })
              .from(userPermissions)
              .where(inArray(userPermissions.userId, ids));
      const byUser = new Map<string, string[]>();
      for (const g of grants) {
        const list = byUser.get(g.userId) ?? [];
        list.push(g.permission);
        byUser.set(g.userId, list);
      }
      const data: FleetManagerItem[] = rows.map((r) => ({
        ...r,
        lastLoginAt: r.lastLoginAt != null ? r.lastLoginAt.toISOString() : null,
        permissions: (byUser.get(r.id) ?? []).sort(),
      }));
      return { data, total: totals[0]?.total ?? 0 } satisfies PaginatedResponse<FleetManagerItem>;
    },
  );
}
