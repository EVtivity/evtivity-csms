// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db, siteLoadManagement, chargingStations, loadAllocationLog } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, itemResponse, arrayResponse } from '../lib/response-schemas.js';
import {
  getSitePowerStatus,
  buildSiteHierarchy,
  computeHierarchicalAllocation,
  type HierarchyNode,
} from '../services/load-management.service.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

const putBody = z.object({
  strategy: z.enum(['equal_share', 'priority_based']).describe('Load distribution strategy'),
  isEnabled: z.boolean().describe('Whether load management is active for this site'),
});

const patchPriorityBody = z.object({
  loadPriority: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe('Load priority rank from 1 (highest) to 10 (lowest)'),
});

const historyQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe('Number of history entries to return, max 200'),
});

const hierarchyNodeSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      type: z.enum(['panel', 'circuit']),
      id: z.string(),
      name: z.string(),
      maxContinuousKw: z.number(),
      safetyMarginKw: z.number(),
      unmanagedLoadKw: z.number(),
      currentDrawKw: z.number(),
      availableKw: z.number(),
      utilization: z.number(),
      stations: z.array(z.object({}).passthrough()),
      children: z.array(hierarchyNodeSchema),
    })
    .passthrough(),
);

const loadStationItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    currentDrawKw: z.number(),
    allocatedLimitKw: z.number().nullable(),
    loadPriority: z.number(),
    isOnline: z.boolean(),
    hasActiveSession: z.boolean(),
  })
  .passthrough();

const loadManagementItem = z
  .object({
    config: z
      .object({
        strategy: z.string(),
        isEnabled: z.boolean(),
      })
      .nullable(),
    hierarchy: z.array(z.object({}).passthrough()),
    stations: z.array(loadStationItem),
  })
  .passthrough();

const siteLoadManagementRecord = z.object({}).passthrough();

const loadPriorityItem = z
  .object({ id: z.string(), stationId: z.string(), loadPriority: z.number() })
  .passthrough();

const historyItem = z
  .object({
    id: z.string(),
    siteLimitKw: z.number(),
    totalDrawKw: z.number(),
    availableKw: z.number(),
    strategy: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

/**
 * Annotate hierarchy nodes with computed availableKw and utilization.
 */
function annotateHierarchy(nodes: HierarchyNode[]): unknown[] {
  return nodes.map((node) => {
    const effectiveCapacity = node.maxContinuousKw - node.safetyMarginKw - node.unmanagedLoadKw;
    const availableKw = Math.max(0, effectiveCapacity - node.currentDrawKw);
    const utilization =
      effectiveCapacity > 0 ? Math.min(1, node.currentDrawKw / effectiveCapacity) : 0;

    // Separate children into circuits and child panels for the frontend
    const circuitChildren = node.children.filter((c) => c.type === 'circuit');
    const panelChildren = node.children.filter((c) => c.type === 'panel');

    // Compute totalConnectedKw: sum of maxPowerKw for all stations on this panel's circuits
    let totalConnectedKw = 0;
    for (const child of node.children) {
      if (child.type === 'circuit') {
        for (const s of child.stations) {
          totalConnectedKw += s.maxPowerKw;
        }
      }
    }

    return {
      type: node.type,
      id: node.id,
      name: node.name,
      maxContinuousKw: node.maxContinuousKw,
      safetyMarginKw: node.safetyMarginKw,
      unmanagedLoadKw: node.unmanagedLoadKw,
      currentDrawKw: node.currentDrawKw,
      availableKw,
      utilization,
      totalConnectedKw,
      phases: node.phases,
      breakerRatingAmps: node.breakerRatingAmps,
      voltageV: node.voltageV,
      oversubscriptionRatio: node.oversubscriptionRatio,
      phaseConnections: node.phaseConnections,
      phaseLoad: node.phaseLoad,
      perPhaseCapacityKw: node.perPhaseCapacityKw,
      circuits: circuitChildren.map((circuit) => {
        const circuitAvailable = Math.max(0, circuit.maxContinuousKw - circuit.unmanagedLoadKw);
        return {
          id: circuit.id,
          name: circuit.name,
          breakerRatingAmps: circuit.breakerRatingAmps,
          maxContinuousKw: circuit.maxContinuousKw,
          currentDrawKw: circuit.currentDrawKw,
          availableKw: Math.max(0, circuitAvailable - circuit.currentDrawKw),
          phaseConnections: circuit.phaseConnections,
          stations: circuit.stations.map((s) => ({
            id: s.id,
            stationId: s.stationId,
            currentDrawKw: s.currentDrawKw,
            allocatedLimitKw: null,
            maxPowerKw: s.maxPowerKw,
            isOnline: s.isOnline,
            hasActiveSession: s.hasActiveSession,
          })),
          unmanagedLoads: [],
        };
      }),
      childPanels: annotateHierarchy(panelChildren),
      unmanagedLoads: [],
    };
  });
}

export function loadManagementRoutes(app: FastifyInstance): void {
  // GET /sites/:id/load-management
  app.get(
    '/sites/:id/load-management',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'Get load management config, hierarchy, and station status for a site',
        operationId: 'getSiteLoadManagement',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(loadManagementItem) },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        return { config: null, hierarchy: [], stations: [] };
      }

      const [config] = await db
        .select()
        .from(siteLoadManagement)
        .where(eq(siteLoadManagement.siteId, id));

      const status = await getSitePowerStatus(id);
      const hierarchy = await buildSiteHierarchy(id, status.stations);
      const strategy = config?.strategy ?? 'equal_share';

      // Compute current allocations for the UI
      let allocationMap = new Map<string, number>();
      if (config != null && config.isEnabled && hierarchy.length > 0) {
        const allocations = computeHierarchicalAllocation(hierarchy, strategy);
        allocationMap = new Map(allocations.map((a) => [a.stationDbId, a.allocatedKw]));
      }

      return {
        config:
          config != null
            ? {
                strategy,
                isEnabled: config.isEnabled,
              }
            : null,
        hierarchy: annotateHierarchy(hierarchy),
        stations: status.stations.map((s) => ({
          id: s.id,
          stationId: s.stationId,
          currentDrawKw: s.currentDrawKw,
          maxPowerKw: s.maxPowerKw,
          allocatedLimitKw: allocationMap.get(s.id) ?? null,
          loadPriority: s.loadPriority,
          isOnline: s.isOnline,
          hasActiveSession: s.hasActiveSession,
        })),
      };
    },
  );

  // PUT /sites/:id/load-management
  app.put(
    '/sites/:id/load-management',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Create or update load management config for a site',
        operationId: 'upsertSiteLoadManagement',
        security: [{ bearerAuth: [] }],
        body: zodSchema(putBody),
        response: {
          200: itemResponse(siteLoadManagementRecord),
          201: itemResponse(siteLoadManagementRecord),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as z.infer<typeof putBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [existing] = await db
        .select()
        .from(siteLoadManagement)
        .where(eq(siteLoadManagement.siteId, id));

      if (existing != null) {
        const [updated] = await db
          .update(siteLoadManagement)
          .set({
            strategy: body.strategy,
            isEnabled: body.isEnabled,
            updatedAt: new Date(),
          })
          .where(eq(siteLoadManagement.siteId, id))
          .returning();
        return updated;
      }

      const [created] = await db
        .insert(siteLoadManagement)
        .values({
          siteId: id,
          strategy: body.strategy,
          isEnabled: body.isEnabled,
        })
        .returning();

      return reply.status(201).send(created);
    },
  );

  // PATCH /sites/:id/stations/:stationId/load-priority
  app.patch(
    '/sites/:id/stations/:stationId/load-priority',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Update load priority for a station',
        operationId: 'updateStationLoadPriority',
        security: [{ bearerAuth: [] }],
        body: zodSchema(patchPriorityBody),
        response: { 200: itemResponse(loadPriorityItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id, stationId } = request.params as { id: string; stationId: string };
      const body = request.body as z.infer<typeof patchPriorityBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        return reply.status(404).send({ error: 'Station not found', code: 'NOT_FOUND' });
      }

      const [updated] = await db
        .update(chargingStations)
        .set({
          loadPriority: body.loadPriority,
          updatedAt: new Date(),
        })
        .where(eq(chargingStations.id, stationId))
        .returning();

      if (updated == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'NOT_FOUND' });
      }

      return { id: updated.id, stationId: updated.stationId, loadPriority: updated.loadPriority };
    },
  );

  // GET /sites/:id/load-management/history
  app.get(
    '/sites/:id/load-management/history',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'Get load allocation history for a site',
        operationId: 'getSiteLoadManagementHistory',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(historyQuery),
        response: { 200: arrayResponse(historyItem) },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as z.infer<typeof historyQuery>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        return [];
      }

      const rows = await db
        .select()
        .from(loadAllocationLog)
        .where(eq(loadAllocationLog.siteId, id))
        .orderBy(desc(loadAllocationLog.createdAt))
        .limit(limit);

      return rows.map((row) => ({
        id: row.id,
        siteLimitKw: Number(row.siteLimitKw),
        totalDrawKw: Number(row.totalDrawKw),
        availableKw: Number(row.availableKw),
        strategy: row.strategy,
        allocations: row.allocations,
        createdAt: row.createdAt.toISOString(),
      }));
    },
  );
}
