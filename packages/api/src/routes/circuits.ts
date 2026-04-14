// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { db, panels, circuits, chargingStations, connectors, evses } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, itemResponse, arrayResponse } from '../lib/response-schemas.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

// --- Schemas ---

const panelParams = z.object({
  siteId: z.string().describe('Site ID'),
  panelId: z.string().describe('Panel ID'),
});

const circuitParams = z.object({
  siteId: z.string().describe('Site ID'),
  panelId: z.string().describe('Panel ID'),
  circuitId: z.string().describe('Circuit ID'),
});

const stationCircuitParams = z.object({
  siteId: z.string().describe('Site ID'),
  stationId: z.string().describe('Station ID'),
});

const phaseConnectionValues = ['L1', 'L2', 'L3', 'L1L2', 'L1L3', 'L2L3', 'L1L2L3'] as const;

const phaseConnectionsSchema = z
  .enum(phaseConnectionValues)
  .optional()
  .describe('Phase connections (omit to inherit all panel phases)');

const createCircuitBody = z.object({
  name: z.string().min(1).max(255),
  breakerRatingAmps: z.number().int().min(1).describe('Breaker rating in amps'),
  phaseConnections: phaseConnectionsSchema,
  sortOrder: z.number().int().min(0).optional(),
});

const updateCircuitBody = z.object({
  name: z.string().min(1).max(255).optional(),
  breakerRatingAmps: z.number().int().min(1).optional(),
  phaseConnections: phaseConnectionsSchema,
  sortOrder: z.number().int().min(0).optional(),
});

const assignCircuitBody = z.object({
  circuitId: z.string().nullable().describe('Circuit ID to assign, or null to unassign'),
});

const circuitItem = z
  .object({
    id: z.string(),
    panelId: z.string(),
    name: z.string(),
    breakerRatingAmps: z.number(),
    maxContinuousKw: z.number(),
    phaseConnections: z.string().nullable(),
    sortOrder: z.number(),
    stationCount: z.number(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const stationCircuitItem = z
  .object({
    id: z.string(),
    stationId: z.string(),
    circuitId: z.string().nullable(),
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

export function circuitRoutes(app: FastifyInstance): void {
  // POST /sites/:siteId/panels/:panelId/circuits
  app.post(
    '/sites/:siteId/panels/:panelId/circuits',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Create a circuit on a panel',
        operationId: 'createCircuit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(panelParams),
        body: zodSchema(createCircuitBody),
        response: {
          201: itemResponse(circuitItem),
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId, panelId } = request.params as z.infer<typeof panelParams>;
      const body = request.body as z.infer<typeof createCircuitBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Panel not found', code: 'PANEL_NOT_FOUND' });
        return;
      }

      // Verify panel belongs to site
      const [panel] = await db
        .select()
        .from(panels)
        .where(and(eq(panels.id, panelId), eq(panels.siteId, siteId)));

      if (panel == null) {
        await reply.status(404).send({ error: 'Panel not found', code: 'PANEL_NOT_FOUND' });
        return;
      }

      const maxContinuousKw = computeMaxContinuousKw(
        body.breakerRatingAmps,
        panel.voltageV,
        panel.phases,
      );

      const rows = await db
        .insert(circuits)
        .values({
          panelId,
          name: body.name,
          breakerRatingAmps: body.breakerRatingAmps,
          maxContinuousKw: String(maxContinuousKw),
          phaseConnections: body.phaseConnections ?? null,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      const created = rows[0];
      if (created == null) {
        await reply.status(500).send({ error: 'Failed to create circuit', code: 'CREATE_FAILED' });
        return;
      }

      return reply.status(201).send({
        ...created,
        maxContinuousKw: Number(created.maxContinuousKw),
        stationCount: 0,
      });
    },
  );

  // GET /sites/:siteId/panels/:panelId/circuits
  app.get(
    '/sites/:siteId/panels/:panelId/circuits',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'List circuits for a panel',
        operationId: 'listCircuits',
        security: [{ bearerAuth: [] }],
        params: zodSchema(panelParams),
        response: {
          200: arrayResponse(circuitItem),
        },
      },
    },
    async (request) => {
      const { siteId, panelId } = request.params as z.infer<typeof panelParams>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        return [];
      }

      const rows = await db
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

      return rows.map((row) => ({
        ...row,
        maxContinuousKw: Number(row.maxContinuousKw),
      }));
    },
  );

  // PATCH /sites/:siteId/panels/:panelId/circuits/:circuitId
  app.patch(
    '/sites/:siteId/panels/:panelId/circuits/:circuitId',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Update a circuit',
        operationId: 'updateCircuit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(circuitParams),
        body: zodSchema(updateCircuitBody),
        response: {
          200: itemResponse(circuitItem),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId, panelId, circuitId } = request.params as z.infer<typeof circuitParams>;
      const body = request.body as z.infer<typeof updateCircuitBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Circuit not found', code: 'CIRCUIT_NOT_FOUND' });
        return;
      }

      // Verify panel belongs to site
      const [panel] = await db
        .select()
        .from(panels)
        .where(and(eq(panels.id, panelId), eq(panels.siteId, siteId)));

      if (panel == null) {
        await reply.status(404).send({ error: 'Circuit not found', code: 'CIRCUIT_NOT_FOUND' });
        return;
      }

      const [existing] = await db
        .select()
        .from(circuits)
        .where(and(eq(circuits.id, circuitId), eq(circuits.panelId, panelId)));

      if (existing == null) {
        await reply.status(404).send({ error: 'Circuit not found', code: 'CIRCUIT_NOT_FOUND' });
        return;
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name != null) updateData['name'] = body.name;
      if (body.breakerRatingAmps != null) updateData['breakerRatingAmps'] = body.breakerRatingAmps;
      if (body.phaseConnections !== undefined)
        updateData['phaseConnections'] = body.phaseConnections;
      if (body.sortOrder != null) updateData['sortOrder'] = body.sortOrder;

      // Recompute maxContinuousKw if breakerRatingAmps changed
      if (body.breakerRatingAmps != null) {
        const maxContinuousKw = computeMaxContinuousKw(
          body.breakerRatingAmps,
          panel.voltageV,
          panel.phases,
        );
        updateData['maxContinuousKw'] = String(maxContinuousKw);
      }

      const updateRows = await db
        .update(circuits)
        .set(updateData)
        .where(eq(circuits.id, circuitId))
        .returning();
      const updated = updateRows[0];
      if (updated == null) {
        await reply.status(404).send({ error: 'Circuit not found', code: 'CIRCUIT_NOT_FOUND' });
        return;
      }

      const stationCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(chargingStations)
        .where(eq(chargingStations.circuitId, circuitId));

      return {
        ...updated,
        maxContinuousKw: Number(updated.maxContinuousKw),
        stationCount: stationCount[0]?.count ?? 0,
      };
    },
  );

  // DELETE /sites/:siteId/panels/:panelId/circuits/:circuitId
  app.delete(
    '/sites/:siteId/panels/:panelId/circuits/:circuitId',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Delete a circuit',
        operationId: 'deleteCircuit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(circuitParams),
        response: {
          200: itemResponse(z.object({ success: z.literal(true) }).passthrough()),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId, panelId, circuitId } = request.params as z.infer<typeof circuitParams>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Circuit not found', code: 'CIRCUIT_NOT_FOUND' });
        return;
      }

      const [existing] = await db
        .select({ id: circuits.id })
        .from(circuits)
        .where(and(eq(circuits.id, circuitId), eq(circuits.panelId, panelId)));

      if (existing == null) {
        await reply.status(404).send({ error: 'Circuit not found', code: 'CIRCUIT_NOT_FOUND' });
        return;
      }

      // Set circuitId = null on assigned stations
      await db
        .update(chargingStations)
        .set({ circuitId: null, updatedAt: new Date() })
        .where(eq(chargingStations.circuitId, circuitId));

      // Delete the circuit (cascades unmanaged loads)
      await db.delete(circuits).where(eq(circuits.id, circuitId));

      return { success: true as const };
    },
  );

  // PATCH /sites/:siteId/stations/:stationId/circuit
  app.patch(
    '/sites/:siteId/stations/:stationId/circuit',
    {
      onRequest: [authorize('loadManagement:write')],
      schema: {
        tags: ['Load Management'],
        summary: 'Assign or unassign a station to a circuit',
        operationId: 'assignStationCircuit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationCircuitParams),
        body: zodSchema(assignCircuitBody),
        response: {
          200: itemResponse(stationCircuitItem),
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { siteId, stationId } = request.params as z.infer<typeof stationCircuitParams>;
      const body = request.body as z.infer<typeof assignCircuitBody>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && !siteIds.includes(siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Verify station belongs to this site
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, stationId));

      if (station == null || station.siteId !== siteId) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // If assigning, verify circuit belongs to a panel in the same site
      if (body.circuitId != null) {
        const [circuit] = await db
          .select({
            id: circuits.id,
            panelId: circuits.panelId,
            panelMaxKw: panels.maxContinuousKw,
            panelOversubRatio: panels.oversubscriptionRatio,
            panelSiteId: panels.siteId,
          })
          .from(circuits)
          .innerJoin(panels, eq(circuits.panelId, panels.id))
          .where(and(eq(circuits.id, body.circuitId), eq(panels.siteId, siteId)));

        if (circuit == null) {
          await reply.status(400).send({
            error: 'Circuit not found in this site',
            code: 'INVALID_CIRCUIT',
          });
          return;
        }

        // Check oversubscription: compute total connected kW on the panel
        const panelMaxKw = Number(circuit.panelMaxKw);
        const oversubRatio = Number(circuit.panelOversubRatio);
        const effectiveCapacityKw = panelMaxKw * oversubRatio;

        // Get all circuits on this panel
        const panelCircuits = await db
          .select({ id: circuits.id })
          .from(circuits)
          .where(eq(circuits.panelId, circuit.panelId));
        const panelCircuitIds = panelCircuits.map((c) => c.id);

        // Get all stations on those circuits (including the one being assigned)
        const stationsOnPanel = await db
          .select({ id: chargingStations.id })
          .from(chargingStations)
          .where(
            panelCircuitIds.length > 0
              ? inArray(chargingStations.circuitId, panelCircuitIds)
              : sql`false`,
          );
        const stationDbIds = stationsOnPanel.map((s) => s.id);
        // Include the station being assigned if not already on the panel
        if (!stationDbIds.includes(stationId)) {
          stationDbIds.push(stationId);
        }

        if (stationDbIds.length > 0) {
          // Sum max power for all stations on this panel
          const connectorRows = await db
            .select({
              stationId: evses.stationId,
              maxPowerKw: connectors.maxPowerKw,
            })
            .from(connectors)
            .innerJoin(evses, eq(connectors.evseId, evses.id))
            .where(inArray(evses.stationId, stationDbIds));

          let totalConnectedKw = 0;
          for (const row of connectorRows) {
            totalConnectedKw += row.maxPowerKw != null ? Number(row.maxPowerKw) : 0;
          }

          if (totalConnectedKw > effectiveCapacityKw) {
            await reply.status(400).send({
              error: `Total connected capacity (${totalConnectedKw.toFixed(1)} kW) exceeds panel effective capacity (${effectiveCapacityKw.toFixed(1)} kW)`,
              code: 'OVERSUBSCRIPTION_EXCEEDED',
            });
            return;
          }

          if (totalConnectedKw > panelMaxKw) {
            void reply.header('X-Oversubscription-Warning', 'true');
          }
        }
      }

      const assignRows = await db
        .update(chargingStations)
        .set({ circuitId: body.circuitId, updatedAt: new Date() })
        .where(eq(chargingStations.id, stationId))
        .returning();
      const assignedStation = assignRows[0];
      if (assignedStation == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      return {
        id: assignedStation.id,
        stationId: assignedStation.stationId,
        circuitId: assignedStation.circuitId,
      };
    },
  );
}
