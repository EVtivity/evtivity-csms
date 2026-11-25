// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  db,
  chargingStations,
  circuitPhaseDefault,
  clearUnitLoadBudget,
  readStationUnits,
  readUnitLoadBudgets,
  setUnitLoadBudget,
  unitChargingKind,
} from '@evtivity/database';
import type { UnitLoadBudgetInput } from '@evtivity/database';
import { hasAtMostDecimals } from '@evtivity/lib';
import { UNIT_BUDGET_MIN_AC_A } from '@evtivity/lib/load-allocation';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { siteInScope } from '../lib/site-scope.js';
import { authorize } from '../middleware/rbac.js';
import { replanSiteAfterWrite } from '../lib/site-plan-stale.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { loadTreeContext } from '../lib/load-management-audit.js';
import { sendFieldError, withTreeValidation } from '../lib/load-tree-validation.js';

// Station Unit budgets: the most one physical charger box of a station takes,
// shared by its EVSEs. Written only through the load management tree writer.

const stationParams = z.object({
  id: ID_PARAMS.siteId.describe('Site ID'),
  stationId: ID_PARAMS.stationId.describe('Station ID (not the OCPP station identifier)'),
});

const unitParams = stationParams.extend({
  unitId: ID_PARAMS.unitId.describe('Station Unit ID'),
});

const putBudgetBody = z.object({
  kind: z
    .enum(['ac', 'dc'])
    .describe(
      'ac: a fuse rating per phase (maxCurrentA, phases); dc: a power rating (maxPowerKw). Load management holds the unit to 80 percent of the rating',
    ),
  maxCurrentA: z
    .number()
    .min(UNIT_BUDGET_MIN_AC_A)
    .max(1000)
    .optional()
    .describe(
      'AC only: the fuse or breaker rating of the unit, A per phase (7.5 to 1000, 0.1 A steps); the unit draws at most 80 percent of it, which must reach the 6 A an AC session needs',
    ),
  phases: z
    .union([z.literal(1), z.literal(3)])
    .optional()
    .describe(
      'AC only: the phases the unit is wired to (1 or 3); left out takes the circuit phases',
    ),
  maxPowerKw: z
    .number()
    .min(0.01)
    .max(5000)
    .optional()
    .describe(
      'DC only: the power rating of the unit in kW (0.01 to 5000, 0.01 kW steps); the unit draws at most 80 percent of it',
    ),
});

const budgetItem = z
  .object({
    unitId: z.string().describe('Station Unit ID'),
    kind: z.enum(['ac', 'dc']).describe('ac: a fuse rating per phase; dc: a power rating'),
    maxCurrentA: z
      .number()
      .nullable()
      .describe(
        'AC: the fuse rating of the unit, A per phase; the unit draws at most 80 percent of it',
      ),
    phases: z.number().int().nullable().describe('AC: the phases the budget counts (1 or 3)'),
    maxPowerKw: z
      .number()
      .nullable()
      .describe('DC: the power rating of the unit in kW; the unit draws at most 80 percent of it'),
  })
  .loose();

const unitBudgetsItem = z
  .object({
    stationId: z.string().describe('Station ID'),
    defaultPhases: z
      .number()
      .int()
      .nullable()
      .describe('Phases an AC budget takes when none is given (the circuit); null: on no circuit'),
    units: z
      .array(
        z
          .object({
            unitId: z.string().describe('Station Unit ID'),
            name: z.string().describe('Unit name'),
            evseNumbers: z.array(z.number().int()).describe('OCPP EVSE numbers of the unit'),
            chargingKind: z
              .enum(['ac', 'dc', 'mixed'])
              .nullable()
              .describe(
                'ac or dc from the unit connectors, mixed when they differ (no budget possible), null when none is typed',
              ),
            budget: budgetItem.nullable().describe('The unit budget; null: no budget'),
          })
          .loose(),
      )
      .describe('Units of the station in their order'),
  })
  .loose();

const putBudgetItem = budgetItem
  .extend({ changed: z.boolean().describe('False when the same budget was stored already') })
  .loose();

const deleteBudgetItem = z
  .object({ removed: z.boolean().describe('False when the unit had no budget') })
  .loose();

const notFound = errorWith('Site, station or unit not found', [
  ERROR_CODES.SITE_NOT_FOUND,
  ERROR_CODES.STATION_NOT_FOUND,
  ERROR_CODES.STATION_UNIT_NOT_FOUND,
]);

const writeConfig = { invalidatesCacheTags: ['stations'] };

async function siteAllowed(request: FastifyRequest, reply: FastifyReply, siteId: string) {
  const { userId } = request.user as { userId: string };
  if (siteInScope(await getUserSiteIds(userId), siteId)) return true;
  await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
  return false;
}

async function sendRefusal(reply: FastifyReply, reason: string): Promise<void> {
  switch (reason) {
    case 'station_not_found':
      await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      return;
    case 'unit_not_found':
      await reply.status(404).send({ error: 'Unit not found', code: 'STATION_UNIT_NOT_FOUND' });
      return;
    case 'mixed_unit':
      await reply.status(400).send({
        error: 'The unit holds AC and DC EVSEs: it takes no budget',
        code: 'UNIT_LOAD_BUDGET_MIXED_UNIT',
      });
      return;
    default:
      await reply.status(400).send({
        error: 'The budget kind does not match the EVSEs of the unit',
        code: 'UNIT_LOAD_BUDGET_KIND_MISMATCH',
      });
  }
}

/** The budget the body describes, or the field that is wrong. */
function budgetFromBody(
  body: z.infer<typeof putBudgetBody>,
): { budget: UnitLoadBudgetInput } | { field: string; error: string } {
  if (body.kind === 'ac') {
    if (body.maxCurrentA == null)
      return { field: 'maxCurrentA', error: 'An AC budget needs maxCurrentA' };
    if (!hasAtMostDecimals(body.maxCurrentA, 1)) {
      return { field: 'maxCurrentA', error: 'maxCurrentA takes at most one decimal' };
    }
    if (body.maxPowerKw != null)
      return { field: 'maxPowerKw', error: 'An AC budget takes no maxPowerKw' };
    return {
      budget: {
        kind: 'ac',
        maxCurrentA: body.maxCurrentA,
        ...(body.phases != null ? { phases: body.phases } : {}),
      },
    };
  }
  if (body.maxPowerKw == null)
    return { field: 'maxPowerKw', error: 'A DC budget needs maxPowerKw' };
  if (!hasAtMostDecimals(body.maxPowerKw, 2)) {
    return { field: 'maxPowerKw', error: 'maxPowerKw takes at most two decimals' };
  }
  if (body.maxCurrentA != null)
    return { field: 'maxCurrentA', error: 'A DC budget takes no maxCurrentA' };
  if (body.phases != null) return { field: 'phases', error: 'A DC budget takes no phases' };
  return { budget: { kind: 'dc', maxPowerKw: body.maxPowerKw } };
}

export function unitLoadBudgetRoutes(app: FastifyInstance): void {
  app.get(
    '/sites/:id/stations/:stationId/unit-budgets',
    {
      onRequest: [authorize('loadManagement:read')],
      schema: {
        tags: ['Load Management'],
        summary: 'List the Station Unit budgets of a station',
        description:
          'Each unit of the station with its charging kind and budget. Load management shares a unit budget between the charging EVSEs of the unit.',
        operationId: 'listStationUnitBudgets',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: itemResponse(unitBudgetsItem), 404: notFound },
      },
    },
    async (request, reply) => {
      const { id, stationId } = request.params as z.infer<typeof stationParams>;
      if (!(await siteAllowed(request, reply, id))) return;
      const [station] = await db
        .select({ id: chargingStations.id, circuitId: chargingStations.circuitId })
        .from(chargingStations)
        .where(and(eq(chargingStations.id, stationId), eq(chargingStations.siteId, id)));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const [units, budgets, defaultPhases] = await Promise.all([
        readStationUnits(station.id),
        readUnitLoadBudgets([station.id]),
        circuitPhaseDefault(db, station.circuitId),
      ]);
      const byUnit = new Map(budgets.map((b) => [b.unitId, b]));
      const kinds = await Promise.all(units.map((u) => unitChargingKind(db, u.id)));
      return {
        stationId: station.id,
        defaultPhases,
        units: units.map((unit, index) => {
          const budget = byUnit.get(unit.id);
          return {
            unitId: unit.id,
            name: unit.name,
            evseNumbers: unit.evseNumbers,
            chargingKind: kinds[index] ?? null,
            budget:
              budget == null
                ? null
                : {
                    unitId: budget.unitId,
                    kind: budget.kind,
                    maxCurrentA: budget.maxCurrentA,
                    phases: budget.phases,
                    maxPowerKw: budget.maxPowerKw,
                  },
          };
        }),
      };
    },
  );

  app.put(
    '/sites/:id/stations/:stationId/units/:unitId/load-budget',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('unit_budget_changed', 'id')],
      config: writeConfig,
      schema: {
        tags: ['Load Management'],
        summary: 'Set the budget of a Station Unit',
        description:
          'An AC unit takes a current per phase, a DC unit a power. A unit whose EVSEs mix AC and DC takes no budget (400 UNIT_LOAD_BUDGET_MIXED_UNIT), and a budget of the other kind answers 400 UNIT_LOAD_BUDGET_KIND_MISMATCH. An AC budget without phases takes the phases of the station circuit.',
        operationId: 'setStationUnitLoadBudget',
        security: [{ bearerAuth: [] }],
        params: zodSchema(unitParams),
        body: zodSchema(putBudgetBody),
        response: {
          200: itemResponse(putBudgetItem),
          400: errorWith(
            'Invalid budget',
            [
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.UNIT_LOAD_BUDGET_KIND_MISMATCH,
              ERROR_CODES.UNIT_LOAD_BUDGET_MIXED_UNIT,
            ],
            { field: z.string().optional().describe('The input to fix') },
          ),
          404: notFound,
        },
      },
    },
    async (request, reply) => {
      const { id, stationId, unitId } = request.params as z.infer<typeof unitParams>;
      const body = request.body as z.infer<typeof putBudgetBody>;
      if (!(await siteAllowed(request, reply, id))) return;
      const parsed = budgetFromBody(body);
      if ('field' in parsed) {
        await sendFieldError(reply, parsed.field, parsed.error);
        return;
      }
      const result = await withTreeValidation(reply, () =>
        setUnitLoadBudget(
          { siteId: id, stationId, unitId, budget: parsed.budget },
          loadTreeContext(request),
        ),
      );
      if (result.refused) return;
      if (!result.value.ok) {
        await sendRefusal(reply, result.value.reason);
        return;
      }
      if (!result.value.changed) request.responseCacheUnchanged = true;
      const { budget } = result.value;
      return {
        unitId: budget.unitId,
        kind: budget.kind,
        maxCurrentA: budget.maxCurrentA,
        phases: budget.phases,
        maxPowerKw: budget.maxPowerKw,
        changed: result.value.changed,
      };
    },
  );

  app.delete(
    '/sites/:id/stations/:stationId/units/:unitId/load-budget',
    {
      onRequest: [authorize('loadManagement:write')],
      onResponse: [replanSiteAfterWrite('unit_budget_changed', 'id')],
      config: writeConfig,
      schema: {
        tags: ['Load Management'],
        summary: 'Remove the budget of a Station Unit',
        operationId: 'deleteStationUnitLoadBudget',
        security: [{ bearerAuth: [] }],
        params: zodSchema(unitParams),
        response: { 200: itemResponse(deleteBudgetItem), 404: notFound },
      },
    },
    async (request, reply) => {
      const { id, stationId, unitId } = request.params as z.infer<typeof unitParams>;
      if (!(await siteAllowed(request, reply, id))) return;
      const result = await clearUnitLoadBudget(
        { siteId: id, stationId, unitId },
        loadTreeContext(request),
      );
      if (!result.ok) {
        await sendRefusal(reply, result.reason);
        return;
      }
      if (!result.removed) request.responseCacheUnchanged = true;
      return { removed: result.removed };
    },
  );
}
