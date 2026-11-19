// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { cardsMonthSpend, client, db, driverTokens, drivers, fleets } from '@evtivity/database';
import { escapeLikePattern } from '@evtivity/lib';
import { PORTAL_ID_TOKEN_TYPES } from '@evtivity/lib/id-token-types';
import {
  FLEET_CARD_DEACTIVATE_REASON,
  FLEET_CARD_MONTHLY_LIMIT_MAX_CENTS,
} from '@evtivity/lib/fleet-card';
import * as tokenService from '../services/token.service.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { errorWith, itemResponse, paginatedResponse } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { isFleetUser, requireFleetAccess } from '../lib/fleet-scope.js';
import { getUserSiteIds, isAllSiteUser } from '../lib/site-access.js';
import { readFleetCardHistory } from '../lib/fleet-card-history.js';
import { tokenLabelSchema } from '../lib/token-label.js';
import { importFleetCards } from '../services/fleet-card-import.js';

const cardTypeSchema = z.enum(PORTAL_ID_TOKEN_TYPES as unknown as [string, ...string[]]);

const fleetCardItem = z
  .object({
    id: z.string().describe('Token ID of the card'),
    idToken: z.string().describe('RFID card identifier'),
    tokenType: z.string().describe('OCPP IdToken type'),
    label: z.string().nullable().describe('Free-text label of the card, null if none'),
    isActive: z.boolean().describe('Whether the card can authorize charging'),
    status: z
      .enum(['active', 'suspended', 'deactivated'])
      .describe(
        'active; suspended (turned off, can be turned on again); deactivated (removed, never turned on again through the fleet routes)',
      ),
    blockedByOperator: z
      .boolean()
      .describe('True when an operator turned the card off: a fleet user cannot turn it on'),
    driver: z
      .object({
        id: z.string().describe('Driver ID of the member'),
        firstName: z.string().nullable().describe('Member first name'),
        lastName: z.string().nullable().describe('Member last name'),
      })
      .loose()
      .nullable()
      .describe('The member the card is given to, null when no member holds it'),
    monthlyLimitCents: z
      .number()
      .nullable()
      .describe(
        'Most the card may cost in one calendar month of the system timezone, in cents of the company currency; null for no limit',
      ),
    monthSpentCents: z
      .number()
      .nullable()
      .describe(
        'What the card cost this calendar month, in cents of the company currency: ended sessions at their final cost, running ones at their cost so far. Null without payments:read, and for an operator restricted to some sites (the sum covers every site)',
      ),
    createdAt: z.coerce.date().describe('Timestamp the card was added'),
    updatedAt: z.coerce.date().describe('Timestamp the card last changed'),
  })
  .loose();

const fleetParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
});

const cardParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
  tokenId: ID_PARAMS.driverTokenId.describe('Token ID of the card'),
});

const listQuery = paginationQuery.extend({
  search: z.string().max(255).optional().describe('Search the card value and label'),
});

const historyMember = z
  .object({
    id: z.string().describe('Driver ID of the member'),
    name: z.string().nullable().describe('Member name, null for an erased driver'),
    erased: z.boolean().describe('True when the driver was erased'),
  })
  .loose()
  .nullable();

const fleetCardHistoryItem = z
  .object({
    id: z.number().int().describe('History entry ID'),
    createdAt: z.coerce.date().describe('When the change was made'),
    changes: z
      .array(
        z.enum([
          'added',
          'moved_into_fleet',
          'moved_out_of_fleet',
          'given',
          'taken_back',
          'renamed',
          'limit_changed',
          'turned_off',
          'turned_on',
          'deactivated',
          'changed',
          'deleted',
        ]),
      )
      .describe(
        'What changed: added, moved into or out of the fleet, given to or taken back from a member, renamed, its monthly limit changed (limit_changed, no amounts), turned off or on, deactivated for good, changed (another field), deleted',
      ),
    reason: z
      .enum(['member_left'])
      .nullable()
      .describe('member_left when the card was taken back because the member left the fleet'),
    memberBefore: historyMember.describe('The member who held the card before, null if none'),
    memberAfter: historyMember.describe('The member who holds the card after, null if none'),
    labelBefore: z.string().nullable().describe('Label before the change'),
    labelAfter: z.string().nullable().describe('Label after the change'),
    actor: z
      .object({
        kind: z
          .enum(['fleet_user', 'operator', 'driver', 'system'])
          .describe('Who made the change: a fleet user, an operator, a driver or the system'),
        name: z
          .string()
          .nullable()
          .describe('Name of the person, null when the reader may not see it'),
        viaApiKey: z.boolean().describe('True when the change came through an API key'),
      })
      .loose()
      .describe('Who made the change'),
  })
  .loose();

const historyQuery = paginationQuery.omit({ search: true });

const labelSchema = tokenLabelSchema('Free-text label of the card, e.g. "Van 12"');

const monthlyLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(FLEET_CARD_MONTHLY_LIMIT_MAX_CENTS)
  .nullable()
  .optional()
  .describe(
    'Most the card may cost in one calendar month of the system timezone, in cents of the company currency (1 to 100000000); null for no limit. Every session of the card counts, whoever holds it; a start past it is refused and a session stops at it',
  );

const createBody = z.object({
  idToken: z.string().min(1).max(255).describe('RFID card identifier'),
  tokenType: cardTypeSchema.default('ISO14443').describe('OCPP IdToken type (ISO14443 default)'),
  label: labelSchema.nullable().optional(),
  monthlyLimitCents: monthlyLimitSchema,
  driverId: ID_PARAMS.driverId
    .nullable()
    .optional()
    .describe(
      'The member to give the card to, an active member of the fleet (else 400 FLEET_CARD_DRIVER_NOT_MEMBER); null or absent keeps it with the fleet',
    ),
});

// At least one key: the handler answers 400 for none.
const updateBody = z.object({
  label: labelSchema.nullable().optional(),
  monthlyLimitCents: monthlyLimitSchema,
  isActive: z.boolean().optional().describe('Turn the card on or off'),
  driverId: ID_PARAMS.driverId
    .nullable()
    .optional()
    .describe('Give the card to an active member of the fleet, or null to take it back'),
});

const cardColumns = {
  id: driverTokens.id,
  idToken: driverTokens.idToken,
  tokenType: driverTokens.tokenType,
  label: driverTokens.label,
  isActive: driverTokens.isActive,
  revokedAt: driverTokens.revokedAt,
  deactivatedBy: driverTokens.deactivatedBy,
  driverId: driverTokens.driverId,
  driverFirstName: drivers.firstName,
  driverLastName: drivers.lastName,
  monthlyLimitCents: driverTokens.monthlyLimitCents,
  createdAt: driverTokens.createdAt,
  updatedAt: driverTokens.updatedAt,
};

interface CardRow {
  id: string;
  idToken: string;
  tokenType: string;
  label: string | null;
  isActive: boolean;
  revokedAt: Date | null;
  deactivatedBy: string | null;
  driverId: string | null;
  driverFirstName: string | null;
  driverLastName: string | null;
  monthlyLimitCents: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What each card cost this month, or null for a reader who may not see it:
 * the sum covers sessions at every site, so it needs payments:read, and an
 * operator restricted to some sites sees no company-wide spend.
 */
async function cardSpend(
  request: FastifyRequest,
  tokenIds: readonly string[],
): Promise<Map<string, number> | null> {
  if (!(await requestHasPermission(request, 'payments:read'))) return null;
  const { userId } = request.user as { userId: string };
  if (!(await isFleetUser(userId)) && !(await isAllSiteUser(userId))) return null;
  return cardsMonthSpend(client, [...tokenIds]);
}

function cardView(row: CardRow, spent: Map<string, number> | null) {
  return {
    id: row.id,
    idToken: row.idToken,
    tokenType: row.tokenType,
    label: row.label,
    isActive: row.isActive,
    status: row.isActive ? 'active' : row.revokedAt != null ? 'deactivated' : 'suspended',
    blockedByOperator: !row.isActive && row.deactivatedBy === 'operator',
    driver:
      row.driverId == null
        ? null
        : { id: row.driverId, firstName: row.driverFirstName, lastName: row.driverLastName },
    monthlyLimitCents: row.monthlyLimitCents,
    monthSpentCents: spent == null ? null : (spent.get(row.id) ?? 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findCard(fleetId: string, tokenId: string): Promise<CardRow | null> {
  const [row] = await db
    .select(cardColumns)
    .from(driverTokens)
    .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
    .where(and(eq(driverTokens.id, tokenId), eq(driverTokens.fleetId, fleetId)));
  return row ?? null;
}

const FLEET_NOT_FOUND = { error: 'Fleet not found', code: 'FLEET_NOT_FOUND' } as const;
const TOKEN_NOT_FOUND = { error: 'Card not found', code: 'TOKEN_NOT_FOUND' } as const;
const NOT_MEMBER = {
  error: 'The driver is not an active member of the fleet',
  code: 'FLEET_CARD_DRIVER_NOT_MEMBER',
} as const;

const REVOKE_REFUSED = {
  error: 'Only an operator deactivates an RFID card for good. Turn the card off instead.',
  code: 'FORBIDDEN',
} as const;

/**
 * The fleet the route names, for a fleet user only one of its fleets, else
 * 404 FLEET_NOT_FOUND like an unknown fleet. Returns the write scope. A write
 * (`write`) is for the fleet's own fleet users and operators with access to
 * every site: a fleet card spans every site, so a site-restricted operator gets
 * 404 FLEET_NOT_FOUND too (reads stay open, fleets are company-wide).
 */
async function fleetScopeOf(
  request: FastifyRequest,
  reply: FastifyReply,
  fleetId: string,
  write = false,
): Promise<tokenService.FleetCardScope | null> {
  if (!(await requireFleetAccess(request, reply, fleetId))) return null;
  const { userId } = request.user as { userId: string };
  const byFleetUser = await isFleetUser(userId);
  if (write && !byFleetUser && !(await isAllSiteUser(userId))) {
    await reply.status(404).send(FLEET_NOT_FOUND);
    return null;
  }
  const [fleet] = await db.select({ id: fleets.id }).from(fleets).where(eq(fleets.id, fleetId));
  if (fleet == null) {
    await reply.status(404).send(FLEET_NOT_FOUND);
    return null;
  }
  return { fleetId, byFleetUser };
}

const FLEET_CARD_NOT_BILLABLE = {
  error: 'The fleet does not bill on account, so its RFID cards cannot charge',
  code: 'FLEET_CARD_NOT_BILLABLE',
};

/** Maps a refused card write to its answer; false when the error is not one. */
/**
 * What a fleet user gets for a card value it may not add: registered outside
 * its fleet, a vehicle id in use, or a vehicle id shape. One answer for all,
 * so an add never tells a fleet user that a value exists (security case 466).
 */
const FLEET_USER_CARD_VALUE_REFUSED = {
  error: 'This RFID card value cannot be added',
  code: 'VALIDATION_ERROR',
  details: { field: 'idToken' },
} as const;

async function sendCardWriteError(
  reply: FastifyReply,
  err: unknown,
  byFleetUser: boolean,
): Promise<boolean> {
  if (
    byFleetUser &&
    (err instanceof tokenService.DuplicateTokenError ||
      err instanceof tokenService.VehicleIdTokenInUseError ||
      err instanceof tokenService.VehicleShapedCardError)
  ) {
    await reply.status(400).send(FLEET_USER_CARD_VALUE_REFUSED);
    return true;
  }
  if (
    err instanceof tokenService.FleetCardDriverNotMemberError ||
    // A fleet user learns nothing about drivers outside its fleet.
    err instanceof tokenService.TokenDriverNotFoundError ||
    err instanceof tokenService.TokenDriverInactiveError
  ) {
    await reply.status(400).send(NOT_MEMBER);
    return true;
  }
  if (
    err instanceof tokenService.TokenFleetNotFoundError ||
    err instanceof tokenService.FleetCardSiteScopeError
  ) {
    await reply.status(404).send(FLEET_NOT_FOUND);
    return true;
  }
  if (err instanceof tokenService.FleetCardNotBillableError) {
    await reply.status(409).send(FLEET_CARD_NOT_BILLABLE);
    return true;
  }
  if (err instanceof tokenService.FleetCardDeactivatedError) {
    await reply.status(409).send({
      error: 'This RFID card was deactivated and cannot be turned on again',
      code: 'FLEET_CARD_DEACTIVATED',
    });
    return true;
  }
  if (
    err instanceof tokenService.TokenReactivationBlockedError ||
    err instanceof tokenService.PncContractTokenError
  ) {
    await reply.status(403).send({
      error: 'This card cannot be turned on here',
      code: 'TOKEN_BLOCKED_BY_OPERATOR',
    });
    return true;
  }
  if (err instanceof tokenService.FleetCardTypeNotAllowedError) {
    await reply.status(400).send({
      error: 'Fleet users add ISO14443 or ISO15693 RFID cards only',
      code: 'VALIDATION_ERROR',
      details: { field: 'tokenType' },
    });
    return true;
  }
  if (err instanceof tokenService.VehicleShapedCardError) {
    await reply
      .status(400)
      .send({ error: 'A vehicle id is not an RFID card', code: 'VALIDATION_ERROR' });
    return true;
  }
  if (err instanceof tokenService.VehicleIdTokenInUseError) {
    await reply
      .status(409)
      .send({ error: "Another driver's vehicle uses this id", code: 'VEHICLE_ID_IN_USE' });
    return true;
  }
  if (err instanceof tokenService.DuplicateTokenError) {
    await reply.status(409).send({ error: 'Card already registered', code: 'TOKEN_DUPLICATE' });
    return true;
  }
  return false;
}

export function fleetCardRoutes(app: FastifyInstance): void {
  app.get(
    '/fleets/:id/cards',
    {
      onRequest: [authorize('fleets:read', 'fleetCards:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'List the RFID cards of a fleet',
        description:
          'The RFID cards the fleet owns, newest first, with the member each is given to. A fleet user sees only its own fleets (404 FLEET_NOT_FOUND otherwise).',
        operationId: 'listFleetCards',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(listQuery),
        response: {
          200: paginatedResponse(fleetCardItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { page, limit, search } = request.query as z.infer<typeof listQuery>;
      if ((await fleetScopeOf(request, reply, id)) == null) return;
      const pattern = search != null && search !== '' ? `%${escapeLikePattern(search)}%` : null;
      const where = and(
        eq(driverTokens.fleetId, id),
        pattern != null
          ? or(ilike(driverTokens.idToken, pattern), ilike(driverTokens.label, pattern))
          : undefined,
      );
      const [rows, countRows] = await Promise.all([
        db
          .select(cardColumns)
          .from(driverTokens)
          .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
          .where(where)
          .orderBy(desc(driverTokens.createdAt), desc(driverTokens.id))
          .limit(limit)
          .offset((page - 1) * limit),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(driverTokens)
          .where(where),
      ]);
      const spent = await cardSpend(
        request,
        rows.map((row) => row.id),
      );
      const data = rows.map((row) => cardView(row, spent));
      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  app.get(
    '/fleets/:id/cards/:tokenId/history',
    {
      onRequest: [authorize('fleets:read', 'fleetCards:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'List the history of an RFID card of a fleet',
        description:
          "The changes to the card while it belonged to the fleet, newest first: added, given to a member and taken back, renamed, turned off and on, deactivated. Each entry names who made it: a fleet user reads the names of the fleet's own fleet users only, every other person shows as an operator without a name; a name is never an email. The RFID value and type never appear. A card the fleet does not own answers 404 TOKEN_NOT_FOUND.",
        operationId: 'listFleetCardHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(cardParams),
        querystring: zodSchema(historyQuery),
        response: {
          200: paginatedResponse(fleetCardHistoryItem),
          404: errorWith('Fleet or card not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.TOKEN_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, tokenId } = request.params as z.infer<typeof cardParams>;
      const { page, limit } = request.query as z.infer<typeof historyQuery>;
      const scope = await fleetScopeOf(request, reply, id);
      if (scope == null) return;
      if ((await findCard(id, tokenId)) == null) {
        await reply.status(404).send(TOKEN_NOT_FOUND);
        return;
      }
      const { userId } = request.user as { userId: string };
      const siteIds = scope.byFleetUser ? [] : await getUserSiteIds(userId);
      return readFleetCardHistory(
        tokenId,
        id,
        { userId, fleetUser: scope.byFleetUser, siteIds },
        page,
        limit,
      );
    },
  );

  app.post(
    '/fleets/:id/cards',
    {
      onRequest: [authorize('fleets:read', 'fleetCards:write')],
      config: { fleetScope: true, rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Fleets'],
        summary: 'Add an RFID card to a fleet',
        description:
          'Adds a card the fleet owns, kept with the fleet or given to an active member (400 FLEET_CARD_DRIVER_NOT_MEMBER otherwise). Every session of the card is billed to the fleet account, whoever holds it, so the fleet must bill on account (409 FLEET_CARD_NOT_BILLABLE otherwise). A value already registered answers an operator 409 TOKEN_DUPLICATE, a vehicle id shape 400; a fleet user gets one 400 VALIDATION_ERROR (details.field idToken) for a value registered anywhere, a vehicle id in use or a vehicle id shape alike, so it never learns that a value exists. A fleet user adds ISO14443 (an RFID card or key fob, the default) or ISO15693 cards only; another type answers 400 VALIDATION_ERROR with details.field tokenType.',
        operationId: 'createFleetCard',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(createBody),
        response: {
          201: itemResponse(fleetCardItem),
          400: errorWith('Not a member, or a vehicle id', [
            ERROR_CODES.FLEET_CARD_DRIVER_NOT_MEMBER,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          403: errorWith('The card cannot be turned on here', [
            ERROR_CODES.TOKEN_BLOCKED_BY_OPERATOR,
          ]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
          409: errorWith(
            'Card already registered, a vehicle id in use, deactivated, or a fleet that does not bill on account',
            [
              ERROR_CODES.TOKEN_DUPLICATE,
              ERROR_CODES.VEHICLE_ID_IN_USE,
              ERROR_CODES.FLEET_CARD_DEACTIVATED,
              ERROR_CODES.FLEET_CARD_NOT_BILLABLE,
            ],
          ),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof createBody>;
      const scope = await fleetScopeOf(request, reply, id, true);
      if (scope == null) return;
      let token;
      try {
        token = await tokenService.createToken(
          {
            idToken: body.idToken,
            tokenType: body.tokenType,
            label: body.label,
            driverId: body.driverId ?? null,
            ...(body.monthlyLimitCents !== undefined
              ? { monthlyLimitCents: body.monthlyLimitCents }
              : {}),
          },
          tokenService.tokenActorOf(getAuditActor(request)),
          { fleet: scope },
        );
      } catch (err) {
        if (await sendCardWriteError(reply, err, scope.byFleetUser)) return;
        throw err;
      }
      const card = token == null ? null : await findCard(id, token.id);
      if (card == null) throw new Error('Fleet card insert returned no row');
      await reply.status(201).send(cardView(card, await cardSpend(request, [card.id])));
    },
  );

  app.post(
    '/fleets/:id/cards/import',
    {
      onRequest: [authorize('fleets:read', 'fleetCards:write')],
      config: { fleetScope: true, rateLimit: { max: 5, timeWindow: '1 minute' } },
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        tags: ['Fleets'],
        summary: 'Import RFID cards to a fleet from a CSV file',
        description:
          'Adds the cards of a CSV file (columns idToken, tokenType, label, memberEmail; idToken required, tokenType ISO14443 when empty) to the fleet, each row like a single add: the same card types (a fleet user ISO14443 or ISO15693 only), vehicle id and duplicate refusals, and, for an operator, a member email of an active member of the fleet (a fleet user file with a member email answers 400 VALIDATION_ERROR and writes nothing: it gives cards to members on the RFID Cards tab). A fleet that does not bill on account answers 409 FLEET_CARD_NOT_BILLABLE and writes nothing. At most 512 KB and 2000 data rows (400 VALIDATION_ERROR, nothing written). Each row is written on its own, so a refused row changes nothing; refused rows come back as row (the line in the file, the header is line 1), field and reason, never the value. Fleet users of the fleet and operators with access to every site; a site-restricted operator gets 404 FLEET_NOT_FOUND. 5 imports a minute per user.',
        operationId: 'importFleetCards',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(
          z.object({
            csv: z
              .string()
              .max(1024 * 1024)
              .describe('The CSV file as text (UTF-8, comma separated, first line the header)'),
          }),
        ),
        response: {
          200: itemResponse(
            z
              .object({
                created: z.number().int().describe('Cards added'),
                refused: z
                  .array(
                    z
                      .object({
                        row: z.number().int().describe('Line in the file (the header is line 1)'),
                        field: z
                          .enum(['idToken', 'tokenType', 'label', 'memberEmail'])
                          .describe('The column that refused the row'),
                        reason: z
                          .enum(['missing', 'invalid', 'duplicate', 'not_found'])
                          .describe('Why the row was refused'),
                      })
                      .loose(),
                  )
                  .describe('The refused rows, in file order'),
              })
              .loose(),
          ),
          400: errorWith('The file is too large, has too many rows or no idToken column', [
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
          409: errorWith('The fleet does not bill on account, nothing written', [
            ERROR_CODES.FLEET_CARD_NOT_BILLABLE,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { csv } = request.body as { csv: string };
      const scope = await fleetScopeOf(request, reply, id, true);
      if (scope == null) return;
      try {
        return await importFleetCards(
          scope,
          csv,
          tokenService.tokenActorOf(getAuditActor(request)),
        );
      } catch (err) {
        if (err instanceof tokenService.FleetCardNotBillableError) {
          await reply.status(409).send(FLEET_CARD_NOT_BILLABLE);
          return;
        }
        throw err;
      }
    },
  );

  app.patch(
    '/fleets/:id/cards/:tokenId',
    {
      onRequest: [authorize('fleets:read', 'fleetCards:write')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'Change an RFID card of a fleet',
        description:
          'Renames the card, turns it on or off, sets its monthly spending limit, or gives it to an active member of the fleet (driverId null takes it back). The value and type never change here. A card an operator turned off cannot be turned on by a fleet user (403 TOKEN_BLOCKED_BY_OPERATOR), and a deactivated card cannot be turned on again here (409 FLEET_CARD_DEACTIVATED). A body without a key answers 400.',
        operationId: 'updateFleetCard',
        security: [{ bearerAuth: [] }],
        params: zodSchema(cardParams),
        body: zodSchema(updateBody),
        response: {
          200: itemResponse(fleetCardItem),
          400: errorWith('No change, or not a member', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.FLEET_CARD_DRIVER_NOT_MEMBER,
          ]),
          403: errorWith('The card cannot be turned on here', [
            ERROR_CODES.TOKEN_BLOCKED_BY_OPERATOR,
          ]),
          404: errorWith('Fleet or card not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.TOKEN_NOT_FOUND,
          ]),
          409: errorWith('The card was deactivated, or the fleet does not bill on account', [
            ERROR_CODES.FLEET_CARD_DEACTIVATED,
            ERROR_CODES.FLEET_CARD_NOT_BILLABLE,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, tokenId } = request.params as z.infer<typeof cardParams>;
      const body = request.body as z.infer<typeof updateBody>;
      if (
        body.label === undefined &&
        body.isActive === undefined &&
        body.driverId === undefined &&
        body.monthlyLimitCents === undefined
      ) {
        await reply.status(400).send({
          error: 'Send label, isActive, driverId or monthlyLimitCents',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      const scope = await fleetScopeOf(request, reply, id, true);
      if (scope == null) return;
      try {
        const updated = await tokenService.updateToken(
          tokenId,
          {
            ...(body.label !== undefined ? { label: body.label } : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
            ...(body.driverId !== undefined ? { driverId: body.driverId } : {}),
            ...(body.monthlyLimitCents !== undefined
              ? { monthlyLimitCents: body.monthlyLimitCents }
              : {}),
          },
          tokenService.tokenActorOf(getAuditActor(request)),
          { fleet: scope },
        );
        if (updated == null) {
          await reply.status(404).send(TOKEN_NOT_FOUND);
          return;
        }
      } catch (err) {
        if (await sendCardWriteError(reply, err, scope.byFleetUser)) return;
        throw err;
      }
      const card = await findCard(id, tokenId);
      if (card == null) {
        await reply.status(404).send(TOKEN_NOT_FOUND);
        return;
      }
      return cardView(card, await cardSpend(request, [card.id]));
    },
  );

  app.delete(
    '/fleets/:id/cards/:tokenId',
    {
      onRequest: [authorize('fleets:read', 'fleetCards:write')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'Deactivate an RFID card of a fleet',
        description:
          'Deactivates the card for good: it stays listed as deactivated and cannot be turned on again through the fleet routes. Its history is kept. A deactivated card answers 200 unchanged. Operators only: a fleet user gets 403 FORBIDDEN and suspends a card with PATCH isActive false instead.',
        operationId: 'deactivateFleetCard',
        security: [{ bearerAuth: [] }],
        params: zodSchema(cardParams),
        response: {
          200: itemResponse(fleetCardItem),
          403: errorWith('A fleet user cannot deactivate a card for good', [ERROR_CODES.FORBIDDEN]),
          404: errorWith('Fleet or card not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.TOKEN_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, tokenId } = request.params as z.infer<typeof cardParams>;
      const scope = await fleetScopeOf(request, reply, id, true);
      if (scope == null) return;
      const current = await findCard(id, tokenId);
      if (current == null) {
        await reply.status(404).send(TOKEN_NOT_FOUND);
        return;
      }
      // A fleet user only suspends a card (PATCH isActive false); an operator
      // deactivates it for good.
      if (scope.byFleetUser) {
        await reply.status(403).send(REVOKE_REFUSED);
        return;
      }
      if (current.revokedAt != null && !current.isActive)
        return cardView(current, await cardSpend(request, [current.id]));
      const updated = await tokenService.updateToken(
        tokenId,
        { isActive: false, revokedReason: FLEET_CARD_DEACTIVATE_REASON },
        tokenService.tokenActorOf(getAuditActor(request)),
        { fleet: { ...scope, revoke: true } },
      );
      const card = updated == null ? null : await findCard(id, tokenId);
      if (card == null) {
        await reply.status(404).send(TOKEN_NOT_FOUND);
        return;
      }
      return cardView(card, await cardSpend(request, [card.id]));
    },
  );
}
