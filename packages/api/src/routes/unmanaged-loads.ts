// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db, panels, circuits, unmanagedLoads } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, itemResponse, arrayResponse } from '../lib/response-schemas.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

// --- Schemas ---

const siteIdParam = z.object({
  siteId: z.string().describe('Site ID'),
});

const loadIdParam = z.object({
  siteId: z.string().describe('Site ID'),
  id: z.string().describe('Unmanaged load ID'),
});

const createLoadBody = z
  .object({
    panelId: z
      .string()
      .optional()
      .describe('Panel ID (exactly one of panelId or circuitId required)'),
    circuitId: z
      .string()
      .optional()
      .describe('Circuit ID (exactly one of panelId or circuitId required)'),
    name: z.string().min(1).max(255),
    estimatedDrawKw: z.number().min(0).describe('Estimated power draw in kW'),
  })
  .refine((d) => (d.panelId != null) !== (d.circuitId != null), {
    message: 'Exactly one of panelId or circuitId must be provided',
  });

const updateLoadBody = z.object({
  name: z.string().min(1).max(255).optional(),
  estimatedDrawKw: z.number().min(0).optional(),
  panelId: z.string().nullable().optional(),
  circuitId: z.string().nullable().optional(),
});

const loadItem = z
  .object({
    id: z.number(),
    panelId: z.string().nullable(),
    circuitId: z.string().nullable(),
    name: z.string(),
    estimatedDrawKw: z.number(),
    meterDeviceId: z.string().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

// --- Helpers ---

function formatLoad(row: typeof unmanagedLoads.$inferSelect) {
  return {
    ...row,
    estimatedDrawKw: Number(row.estimatedDrawKw),
  };
}

async function verifyPanelInSite(panelId: string, siteId: string): Promise<boolean> {
  const [panel] = await db
    .select({ id: panels.id })
    .from(panels)
    .where(and(eq(panels.id, panelId), eq(panels.siteId, siteId)));
  return panel != null;
}

async function verifyCircuitInSite(circuitId: string, siteId: string): Promise<boolean> {
  const [circuit] = await db
    .select({ id: circuits.id })
    .from(circuits)
    .innerJoin(panels, eq(circuits.panelId, panels.id))
    .where(and(eq(circuits.id, circuitId), eq(panels.siteId, siteId)));
  return circuit != null;
}

// --- Routes ---

export function unmanagedLoadRoutes(app: FastifyInstance): void {
  // POST /sites/:siteId/unmanaged-loads
  app.post(
    '/sites/:siteId/unmanaged-loads',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Create an unmanaged load',
        operationId: 'createUnmanagedLoad',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParam),
        body: zodSchema(createLoadBody),
        response: {
          201: itemResponse(loadItem),
          400: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParam>;
      const body = request.body as z.infer<typeof createLoadBody>;

      // Exactly one of panelId or circuitId must be provided
      const hasPanelId = body.panelId != null;
      const hasCircuitId = body.circuitId != null;
      if (hasPanelId && hasCircuitId) {
        await reply.status(400).send({
          error: 'Provide either panelId or circuitId, not both',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      if (!hasPanelId && !hasCircuitId) {
        await reply.status(400).send({
          error: 'One of panelId or circuitId is required',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      // Validate panel/circuit belongs to the same site
      if (body.panelId != null) {
        const valid = await verifyPanelInSite(body.panelId, siteId);
        if (!valid) {
          await reply.status(400).send({
            error: 'Panel not found in this site',
            code: 'INVALID_PANEL',
          });
          return;
        }
      }

      if (body.circuitId != null) {
        const valid = await verifyCircuitInSite(body.circuitId, siteId);
        if (!valid) {
          await reply.status(400).send({
            error: 'Circuit not found in this site',
            code: 'INVALID_CIRCUIT',
          });
          return;
        }
      }

      const insertRows = await db
        .insert(unmanagedLoads)
        .values({
          panelId: body.panelId ?? null,
          circuitId: body.circuitId ?? null,
          name: body.name,
          estimatedDrawKw: String(body.estimatedDrawKw),
        })
        .returning();
      const created = insertRows[0];
      if (created == null) {
        await reply.status(500).send({ error: 'Failed to create load', code: 'CREATE_FAILED' });
        return;
      }

      return reply.status(201).send(formatLoad(created));
    },
  );

  // GET /sites/:siteId/unmanaged-loads
  app.get(
    '/sites/:siteId/unmanaged-loads',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'List unmanaged loads for a site',
        operationId: 'listUnmanagedLoads',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParam),
        response: {
          200: arrayResponse(loadItem),
        },
      },
    },
    async (request) => {
      const { siteId } = request.params as z.infer<typeof siteIdParam>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        return [];
      }

      // Get all unmanaged loads where panelId or circuitId belongs to panels in this site
      const rows = await db
        .select({
          id: unmanagedLoads.id,
          panelId: unmanagedLoads.panelId,
          circuitId: unmanagedLoads.circuitId,
          name: unmanagedLoads.name,
          estimatedDrawKw: unmanagedLoads.estimatedDrawKw,
          meterDeviceId: unmanagedLoads.meterDeviceId,
          createdAt: unmanagedLoads.createdAt,
          updatedAt: unmanagedLoads.updatedAt,
        })
        .from(unmanagedLoads)
        .leftJoin(panels, eq(unmanagedLoads.panelId, panels.id))
        .leftJoin(circuits, eq(unmanagedLoads.circuitId, circuits.id))
        .where(
          // Panel loads: panel belongs to this site
          // Circuit loads: circuit's panel belongs to this site
          // Use raw SQL for the OR across two join paths
          eq(panels.siteId, siteId),
        );

      // Also get circuit-based loads
      const circuitRows = await db
        .select({
          id: unmanagedLoads.id,
          panelId: unmanagedLoads.panelId,
          circuitId: unmanagedLoads.circuitId,
          name: unmanagedLoads.name,
          estimatedDrawKw: unmanagedLoads.estimatedDrawKw,
          meterDeviceId: unmanagedLoads.meterDeviceId,
          createdAt: unmanagedLoads.createdAt,
          updatedAt: unmanagedLoads.updatedAt,
        })
        .from(unmanagedLoads)
        .innerJoin(circuits, eq(unmanagedLoads.circuitId, circuits.id))
        .innerJoin(panels, eq(circuits.panelId, panels.id))
        .where(eq(panels.siteId, siteId));

      // Merge and deduplicate by id
      const allLoads = new Map<number, (typeof rows)[0]>();
      for (const row of rows) {
        allLoads.set(row.id, row);
      }
      for (const row of circuitRows) {
        allLoads.set(row.id, row);
      }

      return Array.from(allLoads.values()).map((row) => ({
        ...row,
        estimatedDrawKw: Number(row.estimatedDrawKw),
      }));
    },
  );

  // PATCH /sites/:siteId/unmanaged-loads/:id
  app.patch(
    '/sites/:siteId/unmanaged-loads/:id',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Update an unmanaged load',
        operationId: 'updateUnmanagedLoad',
        security: [{ bearerAuth: [] }],
        params: zodSchema(loadIdParam),
        body: zodSchema(updateLoadBody),
        response: {
          200: itemResponse(loadItem),
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId, id } = request.params as z.infer<typeof loadIdParam>;
      const body = request.body as z.infer<typeof updateLoadBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Load not found', code: 'LOAD_NOT_FOUND' });
        return;
      }

      const loadId = Number(id);
      const [existing] = await db
        .select()
        .from(unmanagedLoads)
        .where(eq(unmanagedLoads.id, loadId));

      if (existing == null) {
        await reply.status(404).send({ error: 'Load not found', code: 'LOAD_NOT_FOUND' });
        return;
      }

      // Validate new panelId/circuitId if provided
      if (body.panelId != null) {
        const valid = await verifyPanelInSite(body.panelId, siteId);
        if (!valid) {
          await reply.status(400).send({
            error: 'Panel not found in this site',
            code: 'INVALID_PANEL',
          });
          return;
        }
      }
      if (body.circuitId != null) {
        const valid = await verifyCircuitInSite(body.circuitId, siteId);
        if (!valid) {
          await reply.status(400).send({
            error: 'Circuit not found in this site',
            code: 'INVALID_CIRCUIT',
          });
          return;
        }
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name != null) updateData['name'] = body.name;
      if (body.estimatedDrawKw != null)
        updateData['estimatedDrawKw'] = String(body.estimatedDrawKw);
      if (body.panelId !== undefined) updateData['panelId'] = body.panelId;
      if (body.circuitId !== undefined) updateData['circuitId'] = body.circuitId;

      const updateRows = await db
        .update(unmanagedLoads)
        .set(updateData)
        .where(eq(unmanagedLoads.id, loadId))
        .returning();
      const updated = updateRows[0];
      if (updated == null) {
        await reply.status(404).send({ error: 'Load not found', code: 'LOAD_NOT_FOUND' });
        return;
      }

      return formatLoad(updated);
    },
  );

  // DELETE /sites/:siteId/unmanaged-loads/:id
  app.delete(
    '/sites/:siteId/unmanaged-loads/:id',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Delete an unmanaged load',
        operationId: 'deleteUnmanagedLoad',
        security: [{ bearerAuth: [] }],
        params: zodSchema(loadIdParam),
        response: {
          200: itemResponse(z.object({ success: z.literal(true) }).passthrough()),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId, id } = request.params as z.infer<typeof loadIdParam>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Load not found', code: 'LOAD_NOT_FOUND' });
        return;
      }

      const loadId = Number(id);
      const [existing] = await db
        .select({ id: unmanagedLoads.id })
        .from(unmanagedLoads)
        .where(eq(unmanagedLoads.id, loadId));

      if (existing == null) {
        await reply.status(404).send({ error: 'Load not found', code: 'LOAD_NOT_FOUND' });
        return;
      }

      await db.delete(unmanagedLoads).where(eq(unmanagedLoads.id, loadId));

      return { success: true as const };
    },
  );
}
