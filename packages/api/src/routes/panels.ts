// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db, panels, circuits, unmanagedLoads, chargingStations } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, itemResponse, arrayResponse } from '../lib/response-schemas.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

// --- Schemas ---

const siteIdParam = z.object({
  siteId: z.string().describe('Site ID'),
});

const panelIdParam = z.object({
  siteId: z.string().describe('Site ID'),
  panelId: z.string().describe('Panel ID'),
});

const createPanelBody = z.object({
  name: z.string().min(1).max(255),
  parentPanelId: z.string().nullable().optional(),
  breakerRatingAmps: z.number().int().min(1).describe('Breaker rating in amps'),
  voltageV: z.number().int(),
  phases: z.number().int(),
  safetyMarginKw: z.number().min(0).optional().default(0),
  oversubscriptionRatio: z.number().min(1.0).max(3.0).optional().default(1.0),
  sortOrder: z.number().int().min(0).optional(),
});

const updatePanelBody = z.object({
  name: z.string().min(1).max(255).optional(),
  breakerRatingAmps: z.number().int().min(1).optional(),
  voltageV: z
    .number()
    .int()
    .refine((v) => [120, 208, 240, 277, 480].includes(v), {
      message: 'Voltage must be one of: 120, 208, 240, 277, 480',
    })
    .optional(),
  phases: z
    .number()
    .int()
    .refine((v) => [1, 3].includes(v), { message: 'Phases must be 1 or 3' })
    .optional(),
  safetyMarginKw: z.number().min(0).optional(),
  oversubscriptionRatio: z.number().min(1.0).max(3.0).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const panelItem = z
  .object({
    id: z.string(),
    siteId: z.string(),
    parentPanelId: z.string().nullable(),
    name: z.string(),
    breakerRatingAmps: z.number(),
    voltageV: z.number(),
    phases: z.number(),
    maxContinuousKw: z.number(),
    safetyMarginKw: z.number(),
    oversubscriptionRatio: z.number(),
    sortOrder: z.number(),
    circuitCount: z.number(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const panelDetailItem = z
  .object({
    id: z.string(),
    siteId: z.string(),
    parentPanelId: z.string().nullable(),
    name: z.string(),
    breakerRatingAmps: z.number(),
    voltageV: z.number(),
    phases: z.number(),
    maxContinuousKw: z.number(),
    safetyMarginKw: z.number(),
    oversubscriptionRatio: z.number(),
    sortOrder: z.number(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    circuits: z.array(z.object({}).passthrough()),
    unmanagedLoads: z.array(z.object({}).passthrough()),
  })
  .passthrough();

// --- Helpers ---

function computeMaxContinuousKw(
  breakerRatingAmps: number,
  voltageV: number,
  phases: number,
): number {
  return (breakerRatingAmps * voltageV * phases * 0.8) / 1000;
}

// --- Routes ---

export function panelRoutes(app: FastifyInstance): void {
  // POST /sites/:siteId/panels
  app.post(
    '/sites/:siteId/panels',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Create a panel',
        operationId: 'createPanel',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParam),
        body: zodSchema(createPanelBody),
        response: {
          201: itemResponse(panelItem),
          400: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParam>;
      const body = request.body as z.infer<typeof createPanelBody>;

      const validVoltages = [120, 208, 240, 277, 480];
      if (!validVoltages.includes(body.voltageV)) {
        await reply.status(400).send({
          error: 'Voltage must be one of: 120, 208, 240, 277, 480',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      if (body.phases !== 1 && body.phases !== 3) {
        await reply.status(400).send({ error: 'Phases must be 1 or 3', code: 'VALIDATION_ERROR' });
        return;
      }

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      // Verify parentPanelId belongs to same site
      if (body.parentPanelId != null) {
        const [parent] = await db
          .select({ id: panels.id, siteId: panels.siteId })
          .from(panels)
          .where(eq(panels.id, body.parentPanelId));
        if (parent == null || parent.siteId !== siteId) {
          await reply
            .status(400)
            .send({ error: 'Parent panel not found in this site', code: 'INVALID_PARENT_PANEL' });
          return;
        }
      }

      const maxContinuousKw = computeMaxContinuousKw(
        body.breakerRatingAmps,
        body.voltageV,
        body.phases,
      );

      const rows = await db
        .insert(panels)
        .values({
          siteId,
          parentPanelId: body.parentPanelId ?? null,
          name: body.name,
          breakerRatingAmps: body.breakerRatingAmps,
          voltageV: body.voltageV,
          phases: body.phases,
          maxContinuousKw: String(maxContinuousKw),
          safetyMarginKw: String(body.safetyMarginKw),
          oversubscriptionRatio: String(body.oversubscriptionRatio),
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      const created = rows[0];
      if (created == null) {
        await reply.status(500).send({ error: 'Failed to create panel', code: 'CREATE_FAILED' });
        return;
      }

      return reply.status(201).send({
        ...created,
        breakerRatingAmps: created.breakerRatingAmps,
        voltageV: created.voltageV,
        phases: created.phases,
        maxContinuousKw: Number(created.maxContinuousKw),
        safetyMarginKw: Number(created.safetyMarginKw),
        oversubscriptionRatio: Number(created.oversubscriptionRatio),
        circuitCount: 0,
      });
    },
  );

  // GET /sites/:siteId/panels
  app.get(
    '/sites/:siteId/panels',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'List panels for a site',
        operationId: 'listPanels',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteIdParam),
        response: {
          200: arrayResponse(panelItem),
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

      const rows = await db
        .select({
          id: panels.id,
          siteId: panels.siteId,
          parentPanelId: panels.parentPanelId,
          name: panels.name,
          breakerRatingAmps: panels.breakerRatingAmps,
          voltageV: panels.voltageV,
          phases: panels.phases,
          maxContinuousKw: panels.maxContinuousKw,
          safetyMarginKw: panels.safetyMarginKw,
          oversubscriptionRatio: panels.oversubscriptionRatio,
          sortOrder: panels.sortOrder,
          createdAt: panels.createdAt,
          updatedAt: panels.updatedAt,
          circuitCount: sql<number>`(SELECT count(*)::int FROM circuits WHERE circuits.panel_id = ${panels.id})`,
        })
        .from(panels)
        .where(eq(panels.siteId, siteId))
        .orderBy(panels.sortOrder);

      return rows.map((row) => ({
        ...row,
        maxContinuousKw: Number(row.maxContinuousKw),
        safetyMarginKw: Number(row.safetyMarginKw),
        oversubscriptionRatio: Number(row.oversubscriptionRatio),
      }));
    },
  );

  // GET /sites/:siteId/panels/:panelId
  app.get(
    '/sites/:siteId/panels/:panelId',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'Get panel detail',
        operationId: 'getPanel',
        security: [{ bearerAuth: [] }],
        params: zodSchema(panelIdParam),
        response: {
          200: itemResponse(panelDetailItem),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId, panelId } = request.params as z.infer<typeof panelIdParam>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Panel not found', code: 'PANEL_NOT_FOUND' });
        return;
      }

      const [panel] = await db
        .select()
        .from(panels)
        .where(and(eq(panels.id, panelId), eq(panels.siteId, siteId)));

      if (panel == null) {
        await reply.status(404).send({ error: 'Panel not found', code: 'PANEL_NOT_FOUND' });
        return;
      }

      const panelCircuits = await db
        .select({
          id: circuits.id,
          panelId: circuits.panelId,
          name: circuits.name,
          breakerRatingAmps: circuits.breakerRatingAmps,
          maxContinuousKw: circuits.maxContinuousKw,
          phaseConnections: circuits.phaseConnections,
          sortOrder: circuits.sortOrder,
          createdAt: circuits.createdAt,
          updatedAt: circuits.updatedAt,
          stationCount: sql<number>`(SELECT count(*)::int FROM charging_stations WHERE charging_stations.circuit_id = ${circuits.id})`,
        })
        .from(circuits)
        .where(eq(circuits.panelId, panelId))
        .orderBy(circuits.sortOrder);

      const panelLoads = await db
        .select()
        .from(unmanagedLoads)
        .where(eq(unmanagedLoads.panelId, panelId));

      return {
        ...panel,
        maxContinuousKw: Number(panel.maxContinuousKw),
        safetyMarginKw: Number(panel.safetyMarginKw),
        oversubscriptionRatio: Number(panel.oversubscriptionRatio),
        circuits: panelCircuits.map((c) => ({
          ...c,
          maxContinuousKw: Number(c.maxContinuousKw),
        })),
        unmanagedLoads: panelLoads.map((l) => ({
          ...l,
          estimatedDrawKw: Number(l.estimatedDrawKw),
        })),
      };
    },
  );

  // PATCH /sites/:siteId/panels/:panelId
  app.patch(
    '/sites/:siteId/panels/:panelId',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Update a panel',
        operationId: 'updatePanel',
        security: [{ bearerAuth: [] }],
        params: zodSchema(panelIdParam),
        body: zodSchema(updatePanelBody),
        response: {
          200: itemResponse(panelItem),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId, panelId } = request.params as z.infer<typeof panelIdParam>;
      const body = request.body as z.infer<typeof updatePanelBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Panel not found', code: 'PANEL_NOT_FOUND' });
        return;
      }

      const [existing] = await db
        .select()
        .from(panels)
        .where(and(eq(panels.id, panelId), eq(panels.siteId, siteId)));

      if (existing == null) {
        await reply.status(404).send({ error: 'Panel not found', code: 'PANEL_NOT_FOUND' });
        return;
      }

      const newBreaker = body.breakerRatingAmps ?? existing.breakerRatingAmps;
      const newVoltage = body.voltageV ?? existing.voltageV;
      const newPhases = body.phases ?? existing.phases;

      const voltageOrPhasesChanged =
        body.voltageV != null || body.phases != null || body.breakerRatingAmps != null;
      const maxContinuousKw = computeMaxContinuousKw(newBreaker, newVoltage, newPhases);

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name != null) updateData['name'] = body.name;
      if (body.breakerRatingAmps != null) updateData['breakerRatingAmps'] = body.breakerRatingAmps;
      if (body.voltageV != null) updateData['voltageV'] = body.voltageV;
      if (body.phases != null) updateData['phases'] = body.phases;
      if (body.safetyMarginKw != null) updateData['safetyMarginKw'] = String(body.safetyMarginKw);
      if (body.oversubscriptionRatio != null)
        updateData['oversubscriptionRatio'] = String(body.oversubscriptionRatio);
      if (body.sortOrder != null) updateData['sortOrder'] = body.sortOrder;
      if (voltageOrPhasesChanged) updateData['maxContinuousKw'] = String(maxContinuousKw);

      const updateRows = await db
        .update(panels)
        .set(updateData)
        .where(eq(panels.id, panelId))
        .returning();
      const updated = updateRows[0];
      if (updated == null) {
        await reply.status(404).send({ error: 'Panel not found', code: 'PANEL_NOT_FOUND' });
        return;
      }

      // If voltage or phases changed, recompute maxContinuousKw for all circuits on this panel
      if (body.voltageV != null || body.phases != null) {
        const panelCircuits = await db.select().from(circuits).where(eq(circuits.panelId, panelId));

        for (const circuit of panelCircuits) {
          const circuitMaxKw = computeMaxContinuousKw(
            circuit.breakerRatingAmps,
            newVoltage,
            newPhases,
          );
          await db
            .update(circuits)
            .set({ maxContinuousKw: String(circuitMaxKw), updatedAt: new Date() })
            .where(eq(circuits.id, circuit.id));
        }
      }

      const circuitCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(circuits)
        .where(eq(circuits.panelId, panelId));

      return {
        ...updated,
        maxContinuousKw: Number(updated.maxContinuousKw),
        safetyMarginKw: Number(updated.safetyMarginKw),
        oversubscriptionRatio: Number(updated.oversubscriptionRatio),
        circuitCount: circuitCount[0]?.count ?? 0,
      };
    },
  );

  // DELETE /sites/:siteId/panels/:panelId
  app.delete(
    '/sites/:siteId/panels/:panelId',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Delete a panel',
        operationId: 'deletePanel',
        security: [{ bearerAuth: [] }],
        params: zodSchema(panelIdParam),
        response: {
          200: itemResponse(z.object({ success: z.literal(true) }).passthrough()),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId, panelId } = request.params as z.infer<typeof panelIdParam>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Panel not found', code: 'PANEL_NOT_FOUND' });
        return;
      }

      const [existing] = await db
        .select({ id: panels.id })
        .from(panels)
        .where(and(eq(panels.id, panelId), eq(panels.siteId, siteId)));

      if (existing == null) {
        await reply.status(404).send({ error: 'Panel not found', code: 'PANEL_NOT_FOUND' });
        return;
      }

      // Set circuitId = null on stations assigned to circuits on this panel
      const panelCircuits = await db
        .select({ id: circuits.id })
        .from(circuits)
        .where(eq(circuits.panelId, panelId));

      for (const circuit of panelCircuits) {
        await db
          .update(chargingStations)
          .set({ circuitId: null, updatedAt: new Date() })
          .where(eq(chargingStations.circuitId, circuit.id));
      }

      // Delete the panel (cascades to circuits and unmanaged loads)
      await db.delete(panels).where(eq(panels.id, panelId));

      return { success: true as const };
    },
  );
}
