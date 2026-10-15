// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, isNotNull } from 'drizzle-orm';
import {
  db,
  panels,
  circuits,
  unmanagedLoads,
  chargingStations,
  operatorStationSql,
} from '@evtivity/database';
import { parseZodRequest, zodSchema } from '../lib/zod-schema.js';
import { itemResponse, arrayResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';
import { siteInScope } from '../lib/site-scope.js';
import { changedFields } from '../lib/audit-diff.js';
import { writeSiteLoadManagementAudit } from '../lib/load-management-audit.js';
import {
  PANEL_VOLTAGES,
  SUB_PANEL_PHASE_CONNECTIONS,
  circuitConductorPhases,
  computeMaxContinuousKw,
  effectiveCircuitVoltageV,
  isCircuitVoltageAllowed,
  isPanelVoltageAllowed,
  isSubPanelPhaseConnectionAllowed,
} from '@evtivity/lib';

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
  breakerRatingAmps: z.number().int().min(1).max(10000).describe('Breaker rating in amps'),
  voltageV: z
    .number()
    .int()
    .refine((v) => (PANEL_VOLTAGES as readonly number[]).includes(v), {
      message: `Voltage must be one of: ${PANEL_VOLTAGES.join(', ')}`,
    }),
  phases: z
    .number()
    .int()
    .refine((v) => [1, 3].includes(v), { message: 'Phases must be 1 or 3' }),
  safetyMarginKw: z.number().min(0).max(10000).optional().default(0),
  oversubscriptionRatio: z.number().min(1.0).max(3.0).optional().default(1.0),
  phaseConnections: z
    .enum(SUB_PANEL_PHASE_CONNECTIONS)
    .optional()
    .describe(
      'Phases of the three-phase parent panel that feed this single-phase sub-panel (one phase line to neutral, two line to line). Omit when unknown: the sub-panel load then counts on every parent phase. Refused unless the panel is single-phase below a three-phase parent',
    ),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

const updatePanelBody = z.object({
  name: z.string().min(1).max(255).optional(),
  breakerRatingAmps: z.number().int().min(1).max(10000).optional(),
  voltageV: z
    .number()
    .int()
    .refine((v) => (PANEL_VOLTAGES as readonly number[]).includes(v), {
      message: `Voltage must be one of: ${PANEL_VOLTAGES.join(', ')}`,
    })
    .optional(),
  phases: z
    .number()
    .int()
    .refine((v) => [1, 3].includes(v), { message: 'Phases must be 1 or 3' })
    .optional(),
  safetyMarginKw: z.number().min(0).max(10000).optional(),
  oversubscriptionRatio: z.number().min(1.0).max(3.0).optional(),
  phaseConnections: z
    .enum(SUB_PANEL_PHASE_CONNECTIONS)
    .nullable()
    .optional()
    .describe(
      'Phases of the three-phase parent panel that feed this single-phase sub-panel; null when unknown (its load counts on every parent phase). Refused unless the panel is single-phase below a three-phase parent',
    ),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

const panelItem = z
  .object({
    id: z.string().describe('Identifier'),
    siteId: z.string().describe('Site identifier the panel belongs to'),
    parentPanelId: z
      .string()
      .nullable()
      .describe('Parent panel identifier when nested under a sub-panel'),
    name: z.string().max(255).describe('Display name'),
    breakerRatingAmps: z.number().int().min(1).max(10000).describe('Main breaker rating in amps'),
    voltageV: z.number().int().min(0).max(1000).describe('Service voltage in volts'),
    phases: z.number().int().min(1).max(3).describe('Number of phases (1 or 3)'),
    maxContinuousKw: z
      .number()
      .min(0)
      .describe('Maximum continuous load in kW (NEC 80% derating applied)'),
    safetyMarginKw: z.number().min(0).describe('Safety margin reserved from capacity in kW'),
    oversubscriptionRatio: z
      .number()
      .min(1.0)
      .max(3.0)
      .describe('Ratio of connected capacity to physical capacity allowed'),
    phaseConnections: z
      .enum(SUB_PANEL_PHASE_CONNECTIONS)
      .nullable()
      .describe(
        'Phases of the three-phase parent panel that feed this single-phase sub-panel; null when unknown',
      ),
    sortOrder: z.number().int().min(0).describe('Display ordering within the site'),
    circuitCount: z.number().int().min(0).describe('Number of circuits attached to this panel'),
    createdAt: z.coerce.date().describe('Timestamp when created'),
    updatedAt: z.coerce.date().describe('Timestamp when last modified'),
  })
  .passthrough();

const panelCircuitItem = z
  .object({
    id: z.string().describe('Circuit ID'),
    panelId: z.string().describe('Parent panel ID'),
    name: z.string().max(255).describe('Circuit name'),
    breakerRatingAmps: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .describe('Circuit breaker rating in amps'),
    maxContinuousKw: z.number().min(0).describe('Computed max continuous power in kW'),
    phaseConnections: z.string().max(20).nullable().describe('Phase connection assignment'),
    voltageV: z
      .number()
      .int()
      .nullable()
      .describe('Circuit voltage in volts; null uses the panel voltage'),
    sortOrder: z.number().int().min(0).describe('Display sort order'),
    createdAt: z.coerce.date().describe('Row creation timestamp'),
    updatedAt: z.coerce.date().describe('Row last update timestamp'),
    stationCount: z.number().int().min(0).describe('Number of stations attached to this circuit'),
  })
  .passthrough();

const panelUnmanagedLoadItem = z
  .object({
    id: z.number().int().min(1).describe('Unmanaged load ID'),
    panelId: z.string().nullable().describe('Parent panel ID, if attached to a panel'),
    circuitId: z.string().nullable().describe('Parent circuit ID, if attached to a circuit'),
    name: z.string().max(255).describe('Unmanaged load name'),
    estimatedDrawKw: z.number().min(0).describe('Estimated load draw in kW'),
    meterDeviceId: z.string().max(255).nullable().describe('Optional meter device identifier'),
    createdAt: z.coerce.date().describe('Row creation timestamp'),
    updatedAt: z.coerce.date().describe('Row last update timestamp'),
  })
  .passthrough();

const panelDetailItem = z
  .object({
    id: z.string().describe('Identifier'),
    siteId: z.string().describe('Site identifier the panel belongs to'),
    parentPanelId: z
      .string()
      .nullable()
      .describe('Parent panel identifier when nested under a sub-panel'),
    name: z.string().max(255).describe('Display name'),
    breakerRatingAmps: z.number().int().min(1).max(10000).describe('Main breaker rating in amps'),
    voltageV: z.number().int().min(0).max(1000).describe('Service voltage in volts'),
    phases: z.number().int().min(1).max(3).describe('Number of phases (1 or 3)'),
    maxContinuousKw: z
      .number()
      .min(0)
      .describe('Maximum continuous load in kW (NEC 80% derating applied)'),
    safetyMarginKw: z.number().min(0).describe('Safety margin reserved from capacity in kW'),
    oversubscriptionRatio: z
      .number()
      .min(1.0)
      .max(3.0)
      .describe('Ratio of connected capacity to physical capacity allowed'),
    phaseConnections: z
      .enum(SUB_PANEL_PHASE_CONNECTIONS)
      .nullable()
      .describe(
        'Phases of the three-phase parent panel that feed this single-phase sub-panel; null when unknown',
      ),
    sortOrder: z.number().int().min(0).describe('Display ordering within the site'),
    createdAt: z.coerce.date().describe('Timestamp when created'),
    updatedAt: z.coerce.date().describe('Timestamp when last modified'),
    circuits: z.array(panelCircuitItem).describe('Circuits attached to this panel'),
    unmanagedLoads: z
      .array(panelUnmanagedLoadItem)
      .describe('Unmanaged loads attached to this panel'),
  })
  .passthrough();

// --- Helpers ---

const SUB_PANEL_PHASE_ERROR = {
  error: 'Phase connections apply only to a single-phase sub-panel of a three-phase panel',
  code: 'VALIDATION_ERROR',
} as const;

const THREE_PHASE_VOLTAGE_ERROR = {
  error:
    'A three-phase panel takes its phase to neutral voltage (120 for 208Y/120, 277 for 480Y/277)',
  code: 'VALIDATION_ERROR',
} as const;

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
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          500: errorWith('Create failed', [ERROR_CODES.CREATE_FAILED]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParam>;
      const body = parseZodRequest(createPanelBody, request.body);

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, siteId)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      // Verify parentPanelId belongs to same site
      let parentPhases: number | null = null;
      if (body.parentPanelId != null) {
        const [parent] = await db
          .select({ id: panels.id, siteId: panels.siteId, phases: panels.phases })
          .from(panels)
          .where(eq(panels.id, body.parentPanelId));
        if (parent == null || parent.siteId !== siteId) {
          await reply
            .status(400)
            .send({ error: 'Parent panel not found in this site', code: 'INVALID_PARENT_PANEL' });
          return;
        }
        parentPhases = parent.phases;
      }

      if (!isPanelVoltageAllowed(body.voltageV, body.phases)) {
        await reply.status(400).send(THREE_PHASE_VOLTAGE_ERROR);
        return;
      }

      if (
        body.phaseConnections != null &&
        !isSubPanelPhaseConnectionAllowed(body.phases, parentPhases)
      ) {
        await reply.status(400).send(SUB_PANEL_PHASE_ERROR);
        return;
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
          phaseConnections: body.phaseConnections ?? null,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      const created = rows[0];
      if (created == null) {
        await reply.status(500).send({ error: 'Failed to create panel', code: 'CREATE_FAILED' });
        return;
      }

      await writeSiteLoadManagementAudit(request, siteId, {
        before: null,
        after: { panel: created },
        notes: `panel created: ${created.name}`,
      });

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
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId } = request.params as z.infer<typeof siteIdParam>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, siteId)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
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
          phaseConnections: panels.phaseConnections,
          sortOrder: panels.sortOrder,
          createdAt: panels.createdAt,
          updatedAt: panels.updatedAt,
          // "panels"."id" written out: a single-table select renders the
          // column unqualified, which inside the subquery names circuits.id.
          circuitCount: sql<number>`(SELECT count(*)::int FROM circuits WHERE circuits.panel_id = "panels"."id")`,
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
          404: errorWith('Panel not found', [ERROR_CODES.PANEL_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, panelId } = request.params as z.infer<typeof panelIdParam>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, siteId)) {
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
          voltageV: circuits.voltageV,
          sortOrder: circuits.sortOrder,
          createdAt: circuits.createdAt,
          updatedAt: circuits.updatedAt,
          // "circuits"."id" written out: a single-table select renders
          // the circuits.id column unqualified, which inside the subquery would
          // name charging_stations.id.
          stationCount: sql<number>`(SELECT count(*)::int FROM charging_stations WHERE charging_stations.circuit_id = "circuits"."id" AND charging_stations.site_id = ${siteId} AND ${sql.raw(operatorStationSql('charging_stations'))})`,
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
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Panel not found', [ERROR_CODES.PANEL_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, panelId } = request.params as z.infer<typeof panelIdParam>;
      const body = parseZodRequest(updatePanelBody, request.body);

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, siteId)) {
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

      if (!isPanelVoltageAllowed(newVoltage, newPhases)) {
        await reply.status(400).send(THREE_PHASE_VOLTAGE_ERROR);
        return;
      }

      // Phase connections only fit a single-phase sub-panel of a three-phase
      // panel. A panel turned three-phase drops the ones it had.
      if (body.phaseConnections != null) {
        let parentPhases: number | null = null;
        if (existing.parentPanelId != null) {
          const [parent] = await db
            .select({ phases: panels.phases })
            .from(panels)
            .where(and(eq(panels.id, existing.parentPanelId), eq(panels.siteId, siteId)));
          parentPhases = parent?.phases ?? null;
        }
        if (!isSubPanelPhaseConnectionAllowed(newPhases, parentPhases)) {
          await reply.status(400).send(SUB_PANEL_PHASE_ERROR);
          return;
        }
      }

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
      if (body.phaseConnections !== undefined) {
        updateData['phaseConnections'] = body.phaseConnections;
      } else if (newPhases === 3 && existing.phaseConnections != null) {
        updateData['phaseConnections'] = null;
      }
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

      // If voltage or phases changed, recompute maxContinuousKw for all circuits
      // on this panel. A circuit voltage the panel no longer allows (above the
      // new voltage, or on a three-phase panel) is cleared: the circuit then
      // runs at the panel voltage.
      if (body.voltageV != null || body.phases != null) {
        const panelCircuits = await db.select().from(circuits).where(eq(circuits.panelId, panelId));

        for (const circuit of panelCircuits) {
          const keepVoltage =
            circuit.voltageV != null &&
            isCircuitVoltageAllowed(circuit.voltageV, newVoltage, newPhases);
          const circuitMaxKw = computeMaxContinuousKw(
            circuit.breakerRatingAmps,
            effectiveCircuitVoltageV(keepVoltage ? circuit.voltageV : null, newVoltage, newPhases),
            circuitConductorPhases(circuit.phaseConnections, newPhases),
          );
          await db
            .update(circuits)
            .set({
              maxContinuousKw: String(circuitMaxKw),
              ...(circuit.voltageV != null && !keepVoltage ? { voltageV: null } : {}),
              updatedAt: new Date(),
            })
            .where(eq(circuits.id, circuit.id));
        }
      }

      // A panel that is no longer three-phase leaves its sub-panels' phase
      // connections without meaning: clear them (their load then counts on
      // every phase again if the panel turns three-phase later).
      if (body.phases != null && newPhases !== 3) {
        await db
          .update(panels)
          .set({ phaseConnections: null, updatedAt: new Date() })
          .where(
            and(
              eq(panels.parentPanelId, panelId),
              eq(panels.siteId, siteId),
              isNotNull(panels.phaseConnections),
            ),
          );
      }

      const change = changedFields(existing, updated);
      await writeSiteLoadManagementAudit(request, siteId, {
        before: { panelId, ...change.before },
        after: { panelId, ...change.after },
        notes: `panel updated: ${updated.name}`,
      });

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
          404: errorWith('Panel not found', [ERROR_CODES.PANEL_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { siteId, panelId } = request.params as z.infer<typeof panelIdParam>;

      const { userId } = request.user as { userId: string };
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, siteId)) {
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

      // Set circuitId = null on stations assigned to circuits on this panel
      const panelCircuits = await db
        .select({ id: circuits.id })
        .from(circuits)
        .where(eq(circuits.panelId, panelId));

      for (const circuit of panelCircuits) {
        await db
          .update(chargingStations)
          .set({ circuitId: null, updatedAt: new Date() })
          .where(
            and(eq(chargingStations.circuitId, circuit.id), eq(chargingStations.siteId, siteId)),
          );
      }

      // Delete the panel (cascades to circuits and unmanaged loads)
      await db.delete(panels).where(eq(panels.id, panelId));

      await writeSiteLoadManagementAudit(request, siteId, {
        before: { panel: existing, circuitIds: panelCircuits.map((c) => c.id) },
        after: null,
        notes: `panel deleted: ${existing.name}`,
      });

      return { success: true as const };
    },
  );
}
