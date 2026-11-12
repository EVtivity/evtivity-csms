// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DISPLAY_LABEL_PATTERN } from '@evtivity/lib/display-label';
import { STATION_UNIT_NAME_MAX, STATION_UNITS_MAX } from '@evtivity/database';
import { authorize } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import {
  arrayResponse,
  errorWith,
  itemResponse,
  successResponse,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { checkStationSiteAccess } from '../lib/site-access.js';
import type { JwtPayload } from '../plugins/auth.js';
import {
  assignEvseUnit,
  createUnit,
  deleteUnit,
  listUnits,
  updateUnit,
  type UnitContext,
} from '../services/station-unit.service.js';

/**
 * Station units: the physical charger boxes (a master and its extenders)
 * under one OCPP station. A unit is a grouping of the station's EVSEs for
 * people (CSMS, portal, app, site layout, OCPI); OCPP, sessions and commands
 * stay at the station. Every write goes through `station-unit.service.ts`
 * and leaves one station history row (`unit_changed`) in the caller's name.
 */

const stationParams = z.object({ id: ID_PARAMS.stationId.describe('Station ID') });
const unitParams = z.object({
  id: ID_PARAMS.stationId.describe('Station ID'),
  unitId: ID_PARAMS.unitId.describe('Unit ID'),
});
const evseParams = z.object({
  id: ID_PARAMS.stationId.describe('Station ID'),
  evseId: z.coerce.number().int().min(1).describe('OCPP EVSE ID (integer)'),
});

const unitName = z
  .string()
  .max(1000)
  .regex(DISPLAY_LABEL_PATTERN, 'Must not contain control or invisible format characters')
  .describe(
    `Unit name, 1 to ${String(STATION_UNIT_NAME_MAX)} characters after trimming, unique per station regardless of case. Control and invisible format characters answer 400 VALIDATION_ERROR`,
  );

const createBody = z.object({
  name: unitName,
  evseIds: z
    .array(z.number().int().min(1))
    .max(1000)
    .optional()
    .describe('OCPP EVSE IDs of the station that move into the new unit'),
});
const updateBody = z.object({
  name: unitName.optional(),
  sortOrder: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe('Position in the station order'),
});
const evseUnitBody = z.object({
  unitId: ID_PARAMS.unitId
    .nullable()
    .describe('Unit of the same station, or null to take the EVSE out of every unit'),
});

const unitItem = z
  .object({
    id: z.string().describe('Unit ID'),
    stationId: z.string().describe('Station ID'),
    name: z.string().describe('Unit name'),
    sortOrder: z.number().describe('Position in the station order'),
    evseIds: z.array(z.string()).describe('EVSE record IDs of the unit, by EVSE number'),
    evseNumbers: z.array(z.number()).describe('OCPP EVSE IDs of the unit, ascending'),
  })
  .loose()
  .describe('A station unit with its EVSEs');

const stationNotFound = errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]);
const notFoundErrors = errorWith('Station, unit or EVSE not found', [
  ERROR_CODES.STATION_NOT_FOUND,
  ERROR_CODES.STATION_UNIT_NOT_FOUND,
  ERROR_CODES.EVSE_NOT_FOUND,
]);

const writeConfig = { invalidatesCacheTags: ['sites'] };

async function stationAccess(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const { id } = request.params as { id: string };
  const { userId } = request.user as JwtPayload;
  if (!(await checkStationSiteAccess(id, userId))) {
    await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
    return false;
  }
  return true;
}

function context(request: FastifyRequest): UnitContext {
  return { actor: getAuditActor(request), log: request.log };
}

export function stationUnitRoutes(app: FastifyInstance): void {
  app.get(
    '/stations/:id/units',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List the units of a station',
        description:
          'The physical charger boxes of the station in their order, each with its EVSEs. Empty for a station without units.',
        operationId: 'listStationUnits',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: { 200: arrayResponse(unitItem), 404: stationNotFound },
      },
    },
    async (request, reply) => {
      if (!(await stationAccess(request, reply))) return;
      const { id } = request.params as z.infer<typeof stationParams>;
      return listUnits(id);
    },
  );

  app.post(
    '/stations/:id/units',
    {
      onRequest: [authorize('stations:write')],
      config: writeConfig,
      schema: {
        tags: ['Stations'],
        summary: 'Create a station unit',
        description: `Adds a named unit at the end of the station order, optionally with EVSEs of the station (they leave their previous unit). At most ${String(STATION_UNITS_MAX)} units per station.`,
        operationId: 'createStationUnit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(createBody),
        response: {
          201: itemResponse(unitItem),
          400: errorWith('Invalid name or too many units', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.STATION_UNIT_LIMIT_REACHED,
          ]),
          404: errorWith('Station or EVSE not found', [
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.EVSE_NOT_FOUND,
          ]),
          409: errorWith('Name in use', [ERROR_CODES.STATION_UNIT_NAME_IN_USE]),
        },
      },
    },
    async (request, reply) => {
      if (!(await stationAccess(request, reply))) return;
      const { id } = request.params as z.infer<typeof stationParams>;
      const body = request.body as z.infer<typeof createBody>;
      const unit = await createUnit(
        id,
        { name: body.name, ...(body.evseIds != null ? { evseIds: body.evseIds } : {}) },
        context(request),
      );
      await reply.status(201).send(unit);
    },
  );

  app.patch(
    '/stations/:id/units/:unitId',
    {
      onRequest: [authorize('stations:write')],
      config: writeConfig,
      schema: {
        tags: ['Stations'],
        summary: 'Rename or reorder a station unit',
        description: 'The same name and order again change nothing and write no history.',
        operationId: 'updateStationUnit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(unitParams),
        body: zodSchema(updateBody),
        response: {
          200: itemResponse(unitItem),
          400: errorWith('Invalid name', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Station or unit not found', [
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.STATION_UNIT_NOT_FOUND,
          ]),
          409: errorWith('Name in use', [ERROR_CODES.STATION_UNIT_NAME_IN_USE]),
        },
      },
    },
    async (request, reply) => {
      if (!(await stationAccess(request, reply))) return;
      const { id, unitId } = request.params as z.infer<typeof unitParams>;
      const body = request.body as z.infer<typeof updateBody>;
      return updateUnit(
        id,
        unitId,
        {
          ...(body.name != null ? { name: body.name } : {}),
          ...(body.sortOrder != null ? { sortOrder: body.sortOrder } : {}),
        },
        context(request),
      );
    },
  );

  app.delete(
    '/stations/:id/units/:unitId',
    {
      onRequest: [authorize('stations:write')],
      config: writeConfig,
      schema: {
        tags: ['Stations'],
        summary: 'Delete a station unit',
        description:
          'Its EVSEs stay on the station without a unit; driver favorites and watches of the unit are removed.',
        operationId: 'deleteStationUnit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(unitParams),
        response: {
          200: successResponse,
          404: errorWith('Station or unit not found', [
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.STATION_UNIT_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      if (!(await stationAccess(request, reply))) return;
      const { id, unitId } = request.params as z.infer<typeof unitParams>;
      await deleteUnit(id, unitId, context(request));
      return { success: true as const };
    },
  );

  app.put(
    '/stations/:id/evses/:evseId/unit',
    {
      onRequest: [authorize('stations:write')],
      config: writeConfig,
      schema: {
        tags: ['Stations'],
        summary: 'Move an EVSE into a unit',
        description:
          'Puts the EVSE in a unit of the same station, or takes it out of every unit with null. An EVSE already in that unit changes nothing (changed false).',
        operationId: 'setStationEvseUnit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(evseParams),
        body: zodSchema(evseUnitBody),
        response: {
          200: itemResponse(
            z
              .object({ changed: z.boolean().describe('False when the EVSE already was there') })
              .describe('Result of the move'),
          ),
          400: errorWith('A unit of another station', [ERROR_CODES.VALIDATION_ERROR]),
          404: notFoundErrors,
        },
      },
    },
    async (request, reply) => {
      if (!(await stationAccess(request, reply))) return;
      const { id, evseId } = request.params as z.infer<typeof evseParams>;
      const { unitId } = request.body as z.infer<typeof evseUnitBody>;
      const result = await assignEvseUnit(id, evseId, unitId, context(request));
      if (!result.changed) request.responseCacheUnchanged = true;
      return result;
    },
  );
}
