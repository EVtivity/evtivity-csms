// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Bus depot systems of the VDV 463 interface (the bus depot interface,
// features/vdv-463.md): a depot management system or ITCS that sends charging
// requests for the buses of its depots and gets their charging information.
// All-site users only. Creating one, a new password, turning it on and
// changing its depots take a fresh proof from a signed-in session; an API key
// gets 403 SESSION_REQUIRED for those.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  chargingStations,
  db,
  depotSystemSiteIdMap,
  depotSystemSiteIds,
  evses,
  fleetDrivers,
  fleetStations,
  getDepotSystem,
  isOperatorStation,
  listDepotSystemRefusals,
  listDepotSystems,
  sites,
  vehicles,
  type DepotSystem,
} from '@evtivity/database';
import {
  VDV463_INFO_INTERVAL_SECONDS,
  VDV463_KEEPALIVE_TIMEOUT_SECONDS,
  VDV463_MAX_RETRIES,
  VDV463_PATH,
  VDV463_PRESYSTEM_TYPES,
  VDV463_REFUSAL_REASONS,
  VDV463_REQUEST_TIMEOUT_SECONDS,
  VDV463_SUBPROTOCOL_V1,
  chargingPointId,
} from '@evtivity/lib/vdv463';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { zodSchema } from '../lib/zod-schema.js';
import { errorWith, itemResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import { factorProof } from '../lib/mfa-factor-proof.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import {
  isApiKeyRequest,
  requireSessionProof,
  SESSION_PROOF_ERROR_CODES,
  sessionProofErrorFields,
} from '../lib/session-proof.js';
import {
  DepotSystemProofRefusedError,
  createDepotSystem,
  removeDepotSystem,
  rotateDepotSystemPassword,
  updateDepotSystem,
  type DepotSystemCtx,
} from '../services/depot-system.service.js';
import type { JwtPayload } from '../plugins/auth.js';

const NOT_FOUND = { error: 'Bus depot system not found', code: 'DEPOT_SYSTEM_NOT_FOUND' } as const;
const SESSION_REQUIRED = {
  error: 'This change of a bus depot system is made only from a signed-in session',
  code: 'SESSION_REQUIRED',
} as const;

const params = z.object({ id: ID_PARAMS.depotSystemId.describe('Bus depot system ID') });

const presystemIdField = z
  .string()
  .min(1)
  .max(255)
  // Visible ASCII without the colon: the colon ends the Basic authentication
  // user name. A pattern, not a refine, so the route schema (Ajv) enforces it.
  .regex(/^[\x21-\x39\x3b-\x7e]+$/, 'visible ASCII without spaces or colon')
  .describe(
    'The VDV PresystemId the depot system sends in every message; also its sign-in user name. Visible ASCII, no spaces or colon',
  );

const timingFields = {
  infoIntervalSeconds: z
    .number()
    .int()
    .min(VDV463_INFO_INTERVAL_SECONDS.min)
    .max(VDV463_INFO_INTERVAL_SECONDS.max)
    .describe('Seconds between two charging information messages (10 to 600, default 30)'),
  requestTimeoutSeconds: z
    .number()
    .int()
    .min(VDV463_REQUEST_TIMEOUT_SECONDS.min)
    .max(VDV463_REQUEST_TIMEOUT_SECONDS.max)
    .describe(
      'Seconds EVtivity waits for a confirmation before it sends again (5 to 120, default 30)',
    ),
  maxRetries: z
    .number()
    .int()
    .min(VDV463_MAX_RETRIES.min)
    .max(VDV463_MAX_RETRIES.max)
    .describe('Times a message is sent again before the connection closes (0 to 10, default 3)'),
  keepaliveTimeoutSeconds: z
    .number()
    .int()
    .min(VDV463_KEEPALIVE_TIMEOUT_SECONDS.min)
    .max(VDV463_KEEPALIVE_TIMEOUT_SECONDS.max)
    .describe(
      'Seconds without a message or ping after which the connection closes (30 to 900, default 180)',
    ),
};

const createBody = z.object({
  presystemId: presystemIdField,
  name: z.string().trim().min(1).max(100).describe('Name shown in the CSMS'),
  systemType: z.enum(VDV463_PRESYSTEM_TYPES).describe('BMS (depot management system) or ITCS'),
  siteIds: z
    .array(ID_PARAMS.siteId)
    .min(1)
    .max(50)
    .describe('The depot sites it sends requests for (Depot site type only)'),
  isEnabled: z.boolean().optional().describe('Accept its connections (default false)'),
  infoIntervalSeconds: timingFields.infoIntervalSeconds.optional(),
  requestTimeoutSeconds: timingFields.requestTimeoutSeconds.optional(),
  maxRetries: timingFields.maxRetries.optional(),
  keepaliveTimeoutSeconds: timingFields.keepaliveTimeoutSeconds.optional(),
  proof: factorProof.optional().describe('Fresh proof of the account (required from a session)'),
});

const updateBody = z.object({
  name: createBody.shape.name.optional(),
  systemType: createBody.shape.systemType.optional(),
  siteIds: createBody.shape.siteIds.optional(),
  isEnabled: z.boolean().optional().describe('Accept its connections'),
  infoIntervalSeconds: timingFields.infoIntervalSeconds.optional(),
  requestTimeoutSeconds: timingFields.requestTimeoutSeconds.optional(),
  maxRetries: timingFields.maxRetries.optional(),
  keepaliveTimeoutSeconds: timingFields.keepaliveTimeoutSeconds.optional(),
  proof: factorProof
    .optional()
    .describe(
      'Fresh proof of the account, required from a session to turn it on or change its sites',
    ),
});

const proofBody = z.object({
  proof: factorProof.optional().describe('Fresh proof of the account (required from a session)'),
});

const refusalItem = z
  .object({
    requestId: z.string().describe('The charging request id of the depot system'),
    vehicleRef: z.string().nullable().describe('The vehicle id the request named (normally a VIN)'),
    reason: z.enum(VDV463_REFUSAL_REASONS).describe('Why the request was not applied'),
    refusedAt: z.coerce.date().describe('When it was first refused for this reason'),
  })
  .loose();

const depotSystemItem = z
  .object({
    id: z.string().describe('Bus depot system ID (dms_)'),
    presystemId: z.string().describe('The VDV PresystemId and sign-in user name'),
    name: z.string().describe('Name shown in the CSMS'),
    systemType: z.enum(VDV463_PRESYSTEM_TYPES).describe('BMS or ITCS'),
    isEnabled: z.boolean().describe('Its connections are accepted'),
    siteIds: z.array(z.string()).describe('The depot sites it serves'),
    infoIntervalSeconds: z.number().int().describe('Seconds between charging information messages'),
    requestTimeoutSeconds: z.number().int().describe('Seconds to wait for a confirmation'),
    maxRetries: z.number().int().describe('Retries before the connection closes'),
    keepaliveTimeoutSeconds: z.number().int().describe('Silence after which the connection closes'),
    locked: z
      .boolean()
      .describe(
        'The sign-in ceiling is on after too many wrong passwords: addresses that sent one wait, others still sign in',
      ),
    lastConnectedAt: z.coerce.date().nullable().describe('Last successful sign-in'),
    lastBootAt: z.coerce.date().nullable().describe('Last accepted BootNotification'),
    lastMessageAt: z.coerce.date().nullable().describe('Last message received'),
    createdAt: z.coerce.date().describe('When it was created'),
    updatedAt: z.coerce.date().describe('When it last changed'),
    refusedRequests: z
      .array(refusalItem)
      .optional()
      .describe('Charging requests of its last list that were not applied (detail only)'),
  })
  .loose();

const withPasswordItem = depotSystemItem.extend({
  password: z
    .string()
    .describe('The sign-in password, shown only in this reply: give it to the depot system'),
});

const connectionItem = z
  .object({
    path: z.string().describe('WebSocket path on the API address (wss://<api host>/vdv463)'),
    subprotocol: z.string().describe('The WebSocket subprotocol'),
  })
  .loose();

const identifierItem = z
  .object({
    depots: z
      .array(
        z
          .object({
            depotId: z.string().describe('The VDV depotId (our site id)'),
            name: z.string().describe('Site name'),
            stations: z
              .array(
                z
                  .object({
                    chargingStationId: z
                      .string()
                      .describe('The VDV chargingStationId (OCPP station id)'),
                    chargingPointIds: z
                      .array(z.string())
                      .describe('The VDV chargingPointIds (`<OCPP id>/<EVSE id>`)'),
                  })
                  .loose(),
              )
              .describe('Stations of the depot'),
          })
          .loose(),
      )
      .describe('The depots of the depot system'),
    buses: z
      .array(
        z
          .object({
            vehicleId: z.string().describe('The VDV vehicleId (the VIN)'),
            licensePlate: z.string().nullable().describe('License plate'),
            batteryCapacityKwh: z
              .number()
              .nullable()
              .describe('Usable battery size, needed for requests'),
          })
          .loose(),
      )
      .optional()
      .describe(
        'Buses of the fleets at those depots that have a VIN: the only vehicles a request may name. Present only with fleets:read',
      ),
    connection: connectionItem,
  })
  .loose();

/** The buses with a VIN of the fleets at the depots, or null when the reader may not see them. */
async function readBuses(
  canRead: boolean,
  siteIds: string[],
): Promise<Array<{
  vin: string | null;
  licensePlate: string | null;
  batteryCapacityKwh: string | null;
}> | null> {
  if (!canRead) return null;
  return db
    .selectDistinct({
      vin: vehicles.vin,
      licensePlate: vehicles.licensePlate,
      batteryCapacityKwh: vehicles.batteryCapacityKwh,
    })
    .from(vehicles)
    .innerJoin(fleetDrivers, eq(fleetDrivers.driverId, vehicles.driverId))
    .innerJoin(fleetStations, eq(fleetStations.fleetId, fleetDrivers.fleetId))
    .innerJoin(chargingStations, eq(chargingStations.id, fleetStations.stationId))
    .where(
      and(
        inArray(chargingStations.siteId, siteIds),
        eq(vehicles.bodyType, 'bus'),
        isOperatorStation(),
        isNotNull(vehicles.vin),
      ),
    )
    .orderBy(vehicles.vin);
}

function view(system: DepotSystem, siteIds: string[], now: Date): Record<string, unknown> {
  return {
    id: system.id,
    presystemId: system.presystemId,
    name: system.name,
    systemType: system.systemType,
    isEnabled: system.isEnabled,
    siteIds,
    infoIntervalSeconds: system.infoIntervalSeconds,
    requestTimeoutSeconds: system.requestTimeoutSeconds,
    maxRetries: system.maxRetries,
    keepaliveTimeoutSeconds: system.keepaliveTimeoutSeconds,
    locked: system.authLockedUntil != null && system.authLockedUntil.getTime() > now.getTime(),
    lastConnectedAt: system.lastConnectedAt,
    lastBootAt: system.lastBootAt,
    lastMessageAt: system.lastMessageAt,
    createdAt: system.createdAt,
    updatedAt: system.updatedAt,
  };
}

function ctxOf(request: FastifyRequest): DepotSystemCtx {
  return { actor: getAuditActor(request), log: request.log };
}

async function sessionOnly(
  request: FastifyRequest,
  reply: FastifyReply,
  proof: Parameters<typeof requireSessionProof>[2],
): Promise<boolean> {
  if (isApiKeyRequest(request)) {
    await reply.status(403).send(SESSION_REQUIRED);
    return false;
  }
  return requireSessionProof(request, reply, proof);
}

const PROOF_400 = (what: string): Record<string, unknown> =>
  errorWith(
    what,
    [
      ...SESSION_PROOF_ERROR_CODES,
      ERROR_CODES.DEPOT_SYSTEM_SITE_NOT_DEPOT,
      ERROR_CODES.VALIDATION_ERROR,
    ],
    sessionProofErrorFields,
  );

export function depotSystemRoutes(app: FastifyInstance): void {
  app.get(
    '/depot-systems',
    {
      onRequest: [authorize('settings.integrations:read')],
      schema: {
        tags: ['Settings'],
        summary: 'List bus depot systems',
        description:
          'The bus depot systems (VDV 463 depot management systems and ITCS) with their depots and connection times. Never returns a password. Needs access to every site.',
        operationId: 'listDepotSystems',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(
            z.object({ data: z.array(depotSystemItem), connection: connectionItem }).loose(),
          ),
          404: errorWith('Not an all-site user', [ERROR_CODES.DEPOT_SYSTEM_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, NOT_FOUND))) return;
      const rows = await listDepotSystems();
      const siteMap = await depotSystemSiteIdMap(rows.map((r) => r.id));
      const now = new Date();
      return {
        data: rows.map((r) => view(r, siteMap.get(r.id) ?? [], now)),
        connection: { path: VDV463_PATH, subprotocol: VDV463_SUBPROTOCOL_V1 },
      };
    },
  );

  app.get(
    '/depot-systems/:id',
    {
      onRequest: [authorize('settings.integrations:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get a bus depot system',
        description:
          'One bus depot system with its depots and the charging requests of its last list that were not applied, with the reason.',
        operationId: 'getDepotSystem',
        security: [{ bearerAuth: [] }],
        params: zodSchema(params),
        response: {
          200: itemResponse(depotSystemItem),
          404: errorWith('Not found', [ERROR_CODES.DEPOT_SYSTEM_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, NOT_FOUND))) return;
      const { id } = request.params as z.infer<typeof params>;
      const system = await getDepotSystem(id);
      if (system == null) return reply.status(404).send(NOT_FOUND);
      const [siteIds, refusals] = await Promise.all([
        depotSystemSiteIds(id),
        listDepotSystemRefusals(id),
      ]);
      return {
        ...view(system, siteIds, new Date()),
        refusedRequests: refusals.map((r) => ({
          requestId: r.externalRequestId,
          vehicleRef: r.vehicleRef,
          reason: r.reason,
          refusedAt: r.refusedAt,
        })),
      };
    },
  );

  app.get(
    '/depot-systems/:id/identifiers',
    {
      onRequest: [authorize('settings.integrations:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Identifiers for a bus depot system',
        description:
          'The ids to give the depot system: its depots, their stations and charging points, and the buses of the fleets at those depots, with the WebSocket path and subprotocol.',
        operationId: 'getDepotSystemIdentifiers',
        security: [{ bearerAuth: [] }],
        params: zodSchema(params),
        response: {
          200: itemResponse(identifierItem),
          404: errorWith('Not found', [ERROR_CODES.DEPOT_SYSTEM_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, NOT_FOUND))) return;
      const { id } = request.params as z.infer<typeof params>;
      const system = await getDepotSystem(id);
      if (system == null) return reply.status(404).send(NOT_FOUND);
      const siteIds = await depotSystemSiteIds(id);
      // Bus VINs and plates need fleets:read too (security review AZ50-I2);
      // without it they are left out and the charging point ids stay.
      const canReadBuses = await requestHasPermission(request, 'fleets:read');
      if (siteIds.length === 0) {
        return {
          depots: [],
          ...(canReadBuses ? { buses: [] } : {}),
          connection: { path: VDV463_PATH, subprotocol: VDV463_SUBPROTOCOL_V1 },
        };
      }
      const [siteRows, pointRows, busRows] = await Promise.all([
        db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, siteIds)),
        db
          .select({
            siteId: chargingStations.siteId,
            ocppId: chargingStations.stationId,
            evseId: evses.evseId,
          })
          .from(chargingStations)
          .innerJoin(evses, eq(evses.stationId, chargingStations.id))
          .where(
            and(
              inArray(chargingStations.siteId, siteIds),
              isOperatorStation(),
              sql`${evses.retiredAt} IS NULL`,
            ),
          )
          .orderBy(chargingStations.stationId, evses.evseId),
        readBuses(canReadBuses, siteIds),
      ]);
      return {
        depots: siteRows
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((site) => {
            const stations = new Map<string, string[]>();
            for (const p of pointRows) {
              if (p.siteId !== site.id) continue;
              stations.set(p.ocppId, [
                ...(stations.get(p.ocppId) ?? []),
                chargingPointId(p.ocppId, p.evseId),
              ]);
            }
            return {
              depotId: site.id,
              name: site.name,
              stations: [...stations].map(([chargingStationId, chargingPointIds]) => ({
                chargingStationId,
                chargingPointIds,
              })),
            };
          }),
        ...(busRows != null
          ? {
              buses: busRows.map((b) => ({
                vehicleId: b.vin ?? '',
                licensePlate: b.licensePlate,
                batteryCapacityKwh:
                  b.batteryCapacityKwh != null ? Number(b.batteryCapacityKwh) : null,
              })),
            }
          : {}),
        connection: { path: VDV463_PATH, subprotocol: VDV463_SUBPROTOCOL_V1 },
      };
    },
  );
  app.post(
    '/depot-systems',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Create a bus depot system',
        description:
          'Creates a bus depot system and returns its sign-in password once. Needs access to every site and a fresh proof from a signed-in session (an API key gets 403 SESSION_REQUIRED). Only Depot sites (400 DEPOT_SYSTEM_SITE_NOT_DEPOT); a presystem id in use answers 409 DEPOT_SYSTEM_ID_IN_USE. The all-site users who may change integrations get a security notice.',
        operationId: 'createDepotSystem',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createBody),
        response: {
          201: itemResponse(withPasswordItem),
          400: PROOF_400('Validation error, a site that is no depot, or a missing or wrong proof'),
          403: errorWith('API key', [ERROR_CODES.SESSION_REQUIRED]),
          404: errorWith('Not an all-site user', [ERROR_CODES.DEPOT_SYSTEM_NOT_FOUND]),
          409: errorWith('Presystem id in use', [ERROR_CODES.DEPOT_SYSTEM_ID_IN_USE]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, NOT_FOUND))) return;
      const body = request.body as z.infer<typeof createBody>;
      if (!(await sessionOnly(request, reply, body.proof))) return;
      const { userId } = request.user as JwtPayload;
      const created = await createDepotSystem(
        {
          presystemId: body.presystemId,
          name: body.name,
          systemType: body.systemType,
          siteIds: body.siteIds,
          isEnabled: body.isEnabled,
          infoIntervalSeconds: body.infoIntervalSeconds,
          requestTimeoutSeconds: body.requestTimeoutSeconds,
          maxRetries: body.maxRetries,
          keepaliveTimeoutSeconds: body.keepaliveTimeoutSeconds,
        },
        userId,
        ctxOf(request),
      );
      return reply.status(201).send({
        ...view(created.system, created.siteIds, new Date()),
        password: created.password,
      });
    },
  );

  app.patch(
    '/depot-systems/:id',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Update a bus depot system',
        description:
          'Changes the given fields. Turning it on and changing its depots take a fresh proof from a signed-in session (an API key gets 403 SESSION_REQUIRED). Turning it off, changing its type or removing a depot closes its live connection; other changes apply to the live connection at once.',
        operationId: 'updateDepotSystem',
        security: [{ bearerAuth: [] }],
        params: zodSchema(params),
        body: zodSchema(updateBody),
        response: {
          200: itemResponse(depotSystemItem),
          400: PROOF_400('Validation error, a site that is no depot, or a missing or wrong proof'),
          403: errorWith('API key', [ERROR_CODES.SESSION_REQUIRED]),
          404: errorWith('Not found', [ERROR_CODES.DEPOT_SYSTEM_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, NOT_FOUND))) return;
      const { id } = request.params as z.infer<typeof params>;
      const body = request.body as z.infer<typeof updateBody>;
      if ((await getDepotSystem(id)) == null) return reply.status(404).send(NOT_FOUND);
      // Whether the proof is needed is decided on the locked row in the
      // service, never on this unlocked read (security review AUTH-L1).
      let updated: Awaited<ReturnType<typeof updateDepotSystem>>;
      try {
        updated = await updateDepotSystem(
          id,
          {
            name: body.name,
            systemType: body.systemType,
            siteIds: body.siteIds,
            isEnabled: body.isEnabled,
            infoIntervalSeconds: body.infoIntervalSeconds,
            requestTimeoutSeconds: body.requestTimeoutSeconds,
            maxRetries: body.maxRetries,
            keepaliveTimeoutSeconds: body.keepaliveTimeoutSeconds,
          },
          ctxOf(request),
          { requireProof: () => sessionOnly(request, reply, body.proof) },
        );
      } catch (err: unknown) {
        // The proof check has answered the request already.
        if (err instanceof DepotSystemProofRefusedError) return reply;
        throw err;
      }
      return view(updated.system, updated.siteIds, new Date());
    },
  );

  app.post(
    '/depot-systems/:id/password',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Set a new password for a bus depot system',
        description:
          'Replaces the sign-in password and returns the new one once; the live connection closes. Takes a fresh proof from a signed-in session (an API key gets 403 SESSION_REQUIRED).',
        operationId: 'rotateDepotSystemPassword',
        security: [{ bearerAuth: [] }],
        params: zodSchema(params),
        body: zodSchema(proofBody),
        response: {
          200: itemResponse(withPasswordItem),
          400: PROOF_400('A missing or wrong proof'),
          403: errorWith('API key', [ERROR_CODES.SESSION_REQUIRED]),
          404: errorWith('Not found', [ERROR_CODES.DEPOT_SYSTEM_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, NOT_FOUND))) return;
      const { id } = request.params as z.infer<typeof params>;
      if ((await getDepotSystem(id)) == null) return reply.status(404).send(NOT_FOUND);
      const body = (request.body ?? {}) as z.infer<typeof proofBody>;
      if (!(await sessionOnly(request, reply, body.proof))) return;
      const { system, password } = await rotateDepotSystemPassword(id, ctxOf(request));
      return { ...view(system, await depotSystemSiteIds(id), new Date()), password };
    },
  );

  app.delete(
    '/depot-systems/:id',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Delete a bus depot system',
        description:
          'Deletes the depot system and closes its connection. Its scheduled departures become manual departures the operators own; ended ones keep their history. Takes a fresh proof from a signed-in session (an API key gets 403 SESSION_REQUIRED).',
        operationId: 'deleteDepotSystem',
        security: [{ bearerAuth: [] }],
        params: zodSchema(params),
        body: zodSchema(proofBody),
        response: {
          200: itemResponse(
            z
              .object({
                id: z.string().describe('Deleted bus depot system ID'),
                departuresReleased: z
                  .number()
                  .int()
                  .describe('Scheduled departures handed to the operators'),
              })
              .loose(),
          ),
          400: PROOF_400('A missing or wrong proof'),
          403: errorWith('API key', [ERROR_CODES.SESSION_REQUIRED]),
          404: errorWith('Not found', [ERROR_CODES.DEPOT_SYSTEM_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, NOT_FOUND))) return;
      const { id } = request.params as z.infer<typeof params>;
      if ((await getDepotSystem(id)) == null) return reply.status(404).send(NOT_FOUND);
      const body = (request.body ?? {}) as z.infer<typeof proofBody>;
      if (!(await sessionOnly(request, reply, body.proof))) return;
      const result = await removeDepotSystem(id, ctxOf(request));
      return { id: result.system.id, departuresReleased: result.departuresReleased };
    },
  );
}
