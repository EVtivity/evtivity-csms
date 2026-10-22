// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, isNotNull } from 'drizzle-orm';
import {
  db,
  siteLoadManagement,
  chargingStations,
  loadAllocationLog,
  isOperatorStation,
} from '@evtivity/database';
import { LOAD_ALLOCATION_STRATEGIES } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, arrayResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import {
  computeSiteAllocation,
  clearLoadManagementProfiles,
  parseAppliedAllocations,
  type HierarchyNode,
} from '@evtivity/services/load-management.service';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';
import { siteInScope } from '../lib/site-scope.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { changedFields } from '../lib/audit-diff.js';
import {
  writeSiteLoadManagementAudit,
  writeStationLoadAudit,
} from '../lib/load-management-audit.js';

const putBody = z.object({
  strategy: z.enum(LOAD_ALLOCATION_STRATEGIES).describe('Load distribution strategy'),
  isEnabled: z.boolean().describe('Whether load management is active for this site'),
});

// The station is the CSMS station ID (sta_...), not the OCPP identifier: the pattern tells API
// clients and the AI assistant which one to send.
const siteStationParams = z.object({
  id: ID_PARAMS.siteId.describe('Site ID'),
  stationId: ID_PARAMS.stationId.describe('Station ID (not the OCPP station identifier)'),
});

const patchPriorityBody = z.object({
  loadPriority: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe('Load priority from 1 (lowest) to 10 (highest)'),
});

const patchMinPowerBody = z.object({
  loadMinPowerKw: z
    .number()
    .min(0)
    .max(1000)
    .nullable()
    .describe(
      'Lowest power in kW a charging session at this station gets before load management stops it; null for no minimum',
    ),
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
    voltageV: z
      .number()
      .int()
      .nullable()
      .describe('Circuit voltage in volts; null uses the panel voltage'),
    stations: z.array(hierarchyStationSchema).describe('Stations attached to this circuit'),
    unmanagedLoads: z.array(z.record(z.unknown())).describe('Unmanaged loads on this circuit'),
  })
  .passthrough();

// Mirrors the shape annotateHierarchy() emits: panels carry `circuits` and
// `childPanels`, never `stations`/`children`. A mismatch here makes
// fast-json-stringify reject the response (500) for any site with panels.
// Route schemas are inlined JSON Schema without $ref, which cannot express
// recursion, so a sub-panel is an open object with the same fields.
const hierarchyNodeSchema = z
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
    phaseConnections: z
      .string()
      .nullable()
      .describe(
        'Phases of the three-phase parent panel that feed this single-phase sub-panel; null when unknown',
      ),
    circuits: z.array(hierarchyCircuitSchema).describe('Circuits on this panel'),
    childPanels: z
      .array(z.record(z.unknown()))
      .describe(
        'Nested sub-panels, each with the fields of this node, its own childPanels included',
      ),
    unmanagedLoads: z.array(z.record(z.unknown())).describe('Unmanaged loads on this panel'),
  })
  .passthrough();

const loadStationItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().describe('OCPP station ID'),
    currentDrawKw: z.number().describe('Current power draw in kW'),
    allocatedLimitKw: z
      .number()
      .nullable()
      .describe('Allocated power limit in kW (null when unmanaged)'),
    loadPriority: z.number().describe('Load priority from 1 (lowest) to 10 (highest)'),
    loadMinPowerKw: z
      .number()
      .nullable()
      .describe('Minimum power in kW of a charging session, or null for none'),
    rateUnit: z
      .enum(['A', 'W'])
      .describe(
        'Unit of the limit sent to the station: A when it supports only A, or supports A on a circuit of two or three phases, else W',
      ),
    isOnline: z.boolean().describe('Whether the station is online'),
    hasActiveSession: z.boolean().describe('Whether a charging session is active'),
  })
  .passthrough();

const loadManagementItem = z
  .object({
    config: z
      .object({
        strategy: z.enum(LOAD_ALLOCATION_STRATEGIES).describe('Load distribution strategy'),
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
    strategy: z.enum(LOAD_ALLOCATION_STRATEGIES).describe('Load distribution strategy'),
    isEnabled: z.boolean().describe('Whether load management is active for this site'),
    createdAt: z.string().describe('Created timestamp (ISO 8601)'),
    updatedAt: z.string().describe('Updated timestamp (ISO 8601)'),
  })
  .passthrough();

const loadPriorityItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().describe('OCPP station ID'),
    loadPriority: z.number().describe('Load priority from 1 (lowest) to 10 (highest)'),
  })
  .passthrough();

const loadMinPowerItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().describe('OCPP station ID'),
    loadMinPowerKw: z
      .number()
      .nullable()
      .describe('Minimum power in kW of a charging session, or null for none'),
  })
  .passthrough();

const historyItem = z
  .object({
    id: z.string().describe('Allocation log entry identifier'),
    siteLimitKw: z.number().describe('Site power limit at the time of allocation, in kW'),
    totalDrawKw: z.number().describe('Total measured power draw in kW'),
    availableKw: z.number().describe('Power capacity available for distribution in kW'),
    strategy: z
      .enum(LOAD_ALLOCATION_STRATEGIES)
      .describe('Strategy used for this allocation cycle'),
    createdAt: z.string().describe('Timestamp of the allocation cycle'),
  })
  .passthrough();

function toConfigRecord(
  row: typeof siteLoadManagement.$inferSelect | undefined,
): Record<string, unknown> | undefined {
  if (row == null) return undefined;
  return {
    id: row.id,
    siteId: row.siteId,
    strategy: row.strategy,
    isEnabled: row.isEnabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Annotate hierarchy nodes with computed availableKw and utilization.
 */
function annotateHierarchy(nodes: HierarchyNode[]): unknown[] {
  return nodes.map((node) => {
    // currentDrawKw already holds the unmanaged loads of the node and of every
    // node below it, so they are not subtracted from the capacity again.
    const effectiveCapacity = node.maxContinuousKw - node.safetyMarginKw;
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
        return {
          id: circuit.id,
          name: circuit.name,
          breakerRatingAmps: circuit.breakerRatingAmps,
          maxContinuousKw: circuit.maxContinuousKw,
          currentDrawKw: circuit.currentDrawKw,
          availableKw: Math.max(0, circuit.maxContinuousKw - circuit.currentDrawKw),
          phaseConnections: circuit.phaseConnections,
          voltageV: circuit.ownVoltageV ?? null,
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
        response: {
          200: itemResponse(loadManagementItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [config] = await db
        .select()
        .from(siteLoadManagement)
        .where(eq(siteLoadManagement.siteId, id));

      const strategy = config?.strategy ?? 'equal_share';
      // The same computation as the control loop, with the power it keeps
      // for offline stations, so the UI shows the limits the stations get.
      const { status, hierarchy, reservedKw, allocations } = await computeSiteAllocation(
        id,
        strategy,
        parseAppliedAllocations(config?.appliedAllocations),
      );

      // Compute current allocations for the UI
      let allocationMap = new Map<string, number>();
      if (config != null && config.isEnabled && hierarchy.length > 0) {
        allocationMap = new Map([
          ...reservedKw,
          ...allocations.map((a): [string, number] => [a.stationDbId, a.allocatedKw]),
        ]);
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
          loadMinPowerKw: s.minPowerKw > 0 ? s.minPowerKw : null,
          rateUnit: s.rateUnit,
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
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [existing] = await db
        .select()
        .from(siteLoadManagement)
        .where(eq(siteLoadManagement.siteId, id));

      if (existing != null) {
        // A config change makes the next cycle send every limit again. Turned
        // off, the limits are removed from the site's stations: the profile
        // stays on a station until cleared and would cap it forever.
        const [updated] = await db
          .update(siteLoadManagement)
          .set({
            strategy: body.strategy,
            isEnabled: body.isEnabled,
            appliedAllocations: null,
            appliedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(siteLoadManagement.siteId, id))
          .returning();
        if (existing.isEnabled && !body.isEnabled) {
          const assigned = await db
            .select({ stationId: chargingStations.stationId })
            .from(chargingStations)
            .where(
              and(
                eq(chargingStations.siteId, id),
                isNotNull(chargingStations.circuitId),
                // Load management never manages a conformance test station.
                isOperatorStation(),
              ),
            );
          const previous = parseAppliedAllocations(existing.appliedAllocations) ?? [];
          await clearLoadManagementProfiles(
            [...assigned.map((s) => s.stationId), ...previous.map((a) => a.stationId)],
            request.log,
          );
        }
        const change = changedFields(
          { strategy: existing.strategy, isEnabled: existing.isEnabled },
          { strategy: body.strategy, isEnabled: body.isEnabled },
        );
        if (Object.keys(change.after).length > 0) {
          await writeSiteLoadManagementAudit(request, id, {
            ...change,
            notes: 'load management configuration updated',
          });
        }
        return toConfigRecord(updated);
      }

      const [created] = await db
        .insert(siteLoadManagement)
        .values({
          siteId: id,
          strategy: body.strategy,
          isEnabled: body.isEnabled,
        })
        .returning();

      await writeSiteLoadManagementAudit(request, id, {
        before: null,
        after: { strategy: body.strategy, isEnabled: body.isEnabled },
        notes: 'load management configuration created',
      });

      return reply.status(201).send(toConfigRecord(created));
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
        params: zodSchema(siteStationParams),
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
      if (!siteInScope(siteIds, id)) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      // Bind the station to the URL site so an operator with access to
      // siteA can't bump load-priority on a station that lives at siteB
      // by passing PATCH /sites/<siteA>/stations/<stationB>/load-priority.
      const [previous] = await db
        .select({ loadPriority: chargingStations.loadPriority })
        .from(chargingStations)
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)));
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

      if (previous?.loadPriority !== updated.loadPriority) {
        await writeStationLoadAudit(request, updated.id, {
          before: { loadPriority: previous?.loadPriority ?? null },
          after: { loadPriority: updated.loadPriority },
          notes: 'load priority changed',
        });
      }

      return { id: updated.id, stationId: updated.stationId, loadPriority: updated.loadPriority };
    },
  );

  // PATCH /sites/:id/stations/:stationId/load-min-power
  app.patch(
    '/sites/:id/stations/:stationId/load-min-power',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Update the minimum power of a station under load management',
        description:
          'Load management never gives a charging session at this station less than this power. When the minimums do not fit, the lowest priority sessions stop (limit 0) first.',
        operationId: 'updateStationLoadMinPower',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteStationParams),
        body: zodSchema(patchMinPowerBody),
        response: {
          200: itemResponse(loadMinPowerItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, stationId } = request.params as { id: string; stationId: string };
      const body = request.body as z.infer<typeof patchMinPowerBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      // Bound to the URL site, like the load priority.
      const [previous] = await db
        .select({ loadMinPowerKw: chargingStations.loadMinPowerKw })
        .from(chargingStations)
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)));
      const [updated] = await db
        .update(chargingStations)
        .set({
          loadMinPowerKw: body.loadMinPowerKw != null ? String(body.loadMinPowerKw) : null,
          updatedAt: new Date(),
        })
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)))
        .returning();

      if (updated == null) {
        return reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      }

      const beforeKw = previous?.loadMinPowerKw != null ? Number(previous.loadMinPowerKw) : null;
      const afterKw = updated.loadMinPowerKw != null ? Number(updated.loadMinPowerKw) : null;
      if (beforeKw !== afterKw) {
        await writeStationLoadAudit(request, updated.id, {
          before: { loadMinPowerKw: beforeKw },
          after: { loadMinPowerKw: afterKw },
          notes: 'load minimum power changed',
        });
      }

      return {
        id: updated.id,
        stationId: updated.stationId,
        loadMinPowerKw: afterKw,
      };
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
        response: {
          200: arrayResponse(historyItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as z.infer<typeof historyQuery>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
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
