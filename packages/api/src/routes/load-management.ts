// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db, siteLoadManagement, chargingStations, loadAllocationLog } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, arrayResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
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

const hierarchyStationSchema = z
  .object({
    id: z.string().describe('Station database ID'),
    stationId: z.string().describe('Human-readable OCPP station ID'),
    currentDrawKw: z.number().describe('Current power draw in kW'),
    allocatedLimitKw: z.number().nullable().describe('Allocated power limit in kW'),
    maxPowerKw: z.number().describe('Maximum power capability in kW'),
    isOnline: z.boolean().describe('Whether the station is online'),
    hasActiveSession: z.boolean().describe('Whether the station has an active charging session'),
  })
  .passthrough();

const hierarchyCircuitSchema = z
  .object({
    id: z.string().describe('Circuit ID'),
    name: z.string().describe('Circuit name'),
    maxContinuousKw: z.number().describe('Maximum continuous power capacity in kW'),
    currentDrawKw: z.number().describe('Current power draw in kW'),
    availableKw: z.number().describe('Available power capacity in kW'),
    stations: z.array(hierarchyStationSchema).describe('Stations attached to this circuit'),
    unmanagedLoads: z.array(z.record(z.unknown())).describe('Unmanaged loads on this circuit'),
  })
  .passthrough();

// Mirrors the shape annotateHierarchy() emits: panels carry `circuits` and
// `childPanels`, never `stations`/`children`. A mismatch here makes
// fast-json-stringify reject the response (500) for any site with panels.
const hierarchyNodeSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      type: z.enum(['panel', 'circuit']).describe('Hierarchy node type'),
      id: z.string().describe('Node ID'),
      name: z.string().describe('Node name'),
      maxContinuousKw: z.number().describe('Maximum continuous power capacity in kW'),
      safetyMarginKw: z.number().describe('Safety margin reserved from capacity in kW'),
      unmanagedLoadKw: z.number().describe('Unmanaged load drawing from this node in kW'),
      currentDrawKw: z.number().describe('Current power draw in kW'),
      availableKw: z.number().describe('Available power capacity in kW'),
      utilization: z.number().describe('Utilization ratio (0 to 1)'),
      totalConnectedKw: z.number().describe('Sum of connected station capacity in kW'),
      circuits: z.array(hierarchyCircuitSchema).describe('Circuits on this panel'),
      childPanels: z.array(hierarchyNodeSchema).describe('Nested sub-panels'),
      unmanagedLoads: z.array(z.record(z.unknown())).describe('Unmanaged loads on this panel'),
    })
    .passthrough(),
);

const loadStationItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().describe('OCPP station ID'),
    currentDrawKw: z.number().describe('Current power draw in kW'),
    allocatedLimitKw: z
      .number()
      .nullable()
      .describe('Allocated power limit in kW (null when unmanaged)'),
    loadPriority: z.number().describe('Load priority rank from 1 (highest) to 10 (lowest)'),
    isOnline: z.boolean().describe('Whether the station is online'),
    hasActiveSession: z.boolean().describe('Whether a charging session is active'),
  })
  .passthrough();

const loadManagementItem = z
  .object({
    config: z
      .object({
        strategy: z.enum(['equal_share', 'priority_based']).describe('Load distribution strategy'),
        isEnabled: z.boolean().describe('Whether load management is active'),
      })
      .nullable()
      .describe('Site load management configuration, or null when not configured'),
    hierarchy: z
      .array(hierarchyNodeSchema)
      .describe('Electrical hierarchy of panels and circuits at the site'),
    stations: z.array(loadStationItem).describe('Stations and their current allocation state'),
  })
  .passthrough();

const siteLoadManagementRecord = z
  .object({
    id: z.number().describe('Site load management config row ID'),
    siteId: z.string().describe('Site ID'),
    strategy: z.enum(['equal_share', 'priority_based']).describe('Load distribution strategy'),
    isEnabled: z.boolean().describe('Whether load management is active for this site'),
    createdAt: z.string().describe('Created timestamp (ISO 8601)'),
    updatedAt: z.string().describe('Updated timestamp (ISO 8601)'),
  })
  .passthrough();

const loadPriorityItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().describe('OCPP station ID'),
    loadPriority: z.number().describe('Load priority rank from 1 (highest) to 10 (lowest)'),
  })
  .passthrough();

const historyItem = z
  .object({
    id: z.string().describe('Allocation log entry identifier'),
    siteLimitKw: z.number().describe('Site power limit at the time of allocation, in kW'),
    totalDrawKw: z.number().describe('Total measured power draw in kW'),
    availableKw: z.number().describe('Power capacity available for distribution in kW'),
    strategy: z
      .enum(['equal_share', 'priority_based'])
      .describe('Strategy used for this allocation cycle'),
    createdAt: z.string().describe('Timestamp of the allocation cycle'),
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
        description:
          'Upserts the site-level load management config (strategy and isEnabled). Toggling isEnabled=true causes the 10-second control loop to start dispatching SetChargingProfile to stations on the next tick. Power limits live on panels and circuits, not on this row.',
        operationId: 'upsertSiteLoadManagement',
        security: [{ bearerAuth: [] }],
        body: zodSchema(putBody),
        response: {
          200: itemResponse(siteLoadManagementRecord),
          201: itemResponse(siteLoadManagementRecord),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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
        response: {
          200: itemResponse(loadPriorityItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, stationId } = request.params as { id: string; stationId: string };
      const body = request.body as z.infer<typeof patchPriorityBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(id)) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      // Bind the station to the URL site so an operator with access to
      // siteA can't bump load-priority on a station that lives at siteB
      // by passing PATCH /sites/<siteA>/stations/<stationB>/load-priority.
      const [updated] = await db
        .update(chargingStations)
        .set({
          loadPriority: body.loadPriority,
          updatedAt: new Date(),
        })
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)))
        .returning();

      if (updated == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
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
