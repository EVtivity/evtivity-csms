// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, and, isNull } from 'drizzle-orm';
import {
  db,
  ocpiTariffMappings,
  tariffs,
  pricingGroups,
  ocpiPartners,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { publishOcpiTariffPush } from '../lib/ocpi-tariff-push.js';
import type { OcpiTariffPushTarget } from '../lib/ocpi-tariff-push.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';

// A tariff mapping publishes one OCPI tariff to one partner (or every
// partner). The OCPI server generates the tariff from the internal tariff or
// pricing group the mapping selects: prices excluding tax, the tax rate as the
// VAT percentage, time prices per hour, the company currency, and, for a
// pricing group, each tariff's restrictions.
const tariffMappingItem = z
  .object({
    id: z.number().int().describe('Tariff mapping ID'),
    ocpiTariffId: z
      .string()
      .max(36)
      .describe('OCPI tariff id (Tariff.id) the partner sees, unique per partner'),
    partnerId: z
      .string()
      .nullable()
      .describe(
        'OCPI partner the tariff is published to, or null for every partner. A partner mapping replaces a mapping for every partner with the same OCPI tariff id',
      ),
    tariffId: z
      .string()
      .nullable()
      .describe(
        'Internal tariff the OCPI tariff is generated from (its prices, without restrictions), or null when a pricing group is selected',
      ),
    pricingGroupId: z
      .string()
      .nullable()
      .describe(
        'Internal pricing group the OCPI tariff is generated from (its active tariffs with their restrictions), or null when a tariff is selected',
      ),
    createdAt: z.coerce.date().describe('Timestamp when created'),
    updatedAt: z.coerce.date().describe('Timestamp when last modified'),
    tariffName: z.string().max(255).nullable().describe('Name of the selected internal tariff'),
    pricingGroupName: z.string().max(255).nullable().describe('Name of the selected pricing group'),
    partnerName: z
      .string()
      .max(255)
      .nullable()
      .describe('Display name of the OCPI partner, or null for every partner'),
  })
  .passthrough();

const tariffMappingQuery = paginationQuery.extend({
  partnerId: ID_PARAMS.ocpiPartnerId.optional().describe('Filter by OCPI partner ID'),
});

const tariffMappingParams = z.object({
  id: z.coerce.number().int().min(1).describe('Tariff mapping ID'),
});

const ocpiTariffIdField = z
  .string()
  .trim()
  .min(1)
  .max(36)
  .describe('OCPI tariff id (Tariff.id, CiString(36)), unique per partner');

const createTariffMappingBody = z.object({
  ocpiTariffId: ocpiTariffIdField,
  partnerId: ID_PARAMS.ocpiPartnerId
    .nullable()
    .optional()
    .describe('OCPI partner to publish to. Null or omitted publishes to every partner'),
  tariffId: ID_PARAMS.tariffId
    .nullable()
    .optional()
    .describe('Internal tariff to publish. Set exactly one of tariffId and pricingGroupId'),
  pricingGroupId: ID_PARAMS.pricingGroupId
    .nullable()
    .optional()
    .describe('Internal pricing group to publish. Set exactly one of tariffId and pricingGroupId'),
});

const updateTariffMappingBody = z.object({
  ocpiTariffId: ocpiTariffIdField.optional(),
  partnerId: ID_PARAMS.ocpiPartnerId
    .nullable()
    .optional()
    .describe('OCPI partner to publish to, or null for every partner. Omitted keeps it'),
  tariffId: ID_PARAMS.tariffId
    .nullable()
    .optional()
    .describe(
      'Internal tariff to publish. Setting it replaces the pricing group. Send at most one of tariffId and pricingGroupId',
    ),
  pricingGroupId: ID_PARAMS.pricingGroupId
    .nullable()
    .optional()
    .describe(
      'Internal pricing group to publish. Setting it replaces the tariff. Send at most one of tariffId and pricingGroupId',
    ),
});

const mappingSelect = {
  id: ocpiTariffMappings.id,
  ocpiTariffId: ocpiTariffMappings.ocpiTariffId,
  partnerId: ocpiTariffMappings.partnerId,
  tariffId: ocpiTariffMappings.tariffId,
  pricingGroupId: ocpiTariffMappings.pricingGroupId,
  createdAt: ocpiTariffMappings.createdAt,
  updatedAt: ocpiTariffMappings.updatedAt,
  tariffName: tariffs.name,
  pricingGroupName: pricingGroups.name,
  partnerName: ocpiPartners.name,
};

function selectMappings() {
  return db
    .select(mappingSelect)
    .from(ocpiTariffMappings)
    .leftJoin(tariffs, eq(ocpiTariffMappings.tariffId, tariffs.id))
    .leftJoin(pricingGroups, eq(ocpiTariffMappings.pricingGroupId, pricingGroups.id))
    .leftJoin(ocpiPartners, eq(ocpiTariffMappings.partnerId, ocpiPartners.id));
}

async function loadMapping(id: number) {
  const [mapping] = await selectMappings().where(eq(ocpiTariffMappings.id, id));
  return mapping ?? null;
}

async function sendValidationError(
  reply: FastifyReply,
  error: string,
  details: Record<string, string>,
): Promise<void> {
  await reply.status(400).send({ error, code: 'VALIDATION_ERROR', details });
}

/** 404 response sent when the selected source or partner does not exist. */
async function checkReferences(
  reply: FastifyReply,
  refs: { tariffId?: string | null; pricingGroupId?: string | null; partnerId?: string | null },
): Promise<boolean> {
  if (refs.tariffId != null) {
    const [row] = await db
      .select({ id: tariffs.id })
      .from(tariffs)
      .where(eq(tariffs.id, refs.tariffId))
      .limit(1);
    if (row == null) {
      await reply.status(404).send({ error: 'Tariff not found', code: 'TARIFF_NOT_FOUND' });
      return false;
    }
  }
  if (refs.pricingGroupId != null) {
    const [row] = await db
      .select({ id: pricingGroups.id })
      .from(pricingGroups)
      .where(eq(pricingGroups.id, refs.pricingGroupId))
      .limit(1);
    if (row == null) {
      await reply
        .status(404)
        .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
      return false;
    }
  }
  if (refs.partnerId != null) {
    const [row] = await db
      .select({ id: ocpiPartners.id })
      .from(ocpiPartners)
      .where(eq(ocpiPartners.id, refs.partnerId))
      .limit(1);
    if (row == null) {
      await reply.status(404).send({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
      return false;
    }
  }
  return true;
}

/** True when another mapping already publishes this OCPI tariff id to the same partner scope. */
async function ocpiTariffIdTaken(
  ocpiTariffId: string,
  partnerId: string | null,
  exceptId?: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: ocpiTariffMappings.id })
    .from(ocpiTariffMappings)
    .where(
      and(
        eq(ocpiTariffMappings.ocpiTariffId, ocpiTariffId),
        partnerId == null
          ? isNull(ocpiTariffMappings.partnerId)
          : eq(ocpiTariffMappings.partnerId, partnerId),
      ),
    );
  return rows.some((r) => r.id !== exceptId);
}

const OCPI_TARIFF_ID_TAKEN = 'This OCPI tariff id is already published to this partner';
const SOURCE_REQUIRED = 'Select exactly one internal tariff or pricing group';

/** Postgres unique violation (a concurrent mapping with the same id won the race). */
function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}

export function ocpiTariffRoutes(app: FastifyInstance): void {
  // GET /ocpi/tariff-mappings - list tariff mappings
  app.get(
    '/ocpi/tariff-mappings',
    {
      onRequest: [authorize('roaming:read')],
      schema: {
        tags: ['OCPI'],
        summary: 'List OCPI tariff mappings',
        operationId: 'listOcpiTariffMappings',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(tariffMappingQuery),
        response: { 200: paginatedResponse(tariffMappingItem) },
      },
    },
    async (request) => {
      const { page, limit, partnerId } = request.query as z.infer<typeof tariffMappingQuery>;
      const offset = (page - 1) * limit;

      const where = partnerId != null ? eq(ocpiTariffMappings.partnerId, partnerId) : undefined;

      const [data, countRows] = await Promise.all([
        selectMappings()
          .where(where)
          .orderBy(desc(ocpiTariffMappings.createdAt), desc(ocpiTariffMappings.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocpiTariffMappings)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // GET /ocpi/tariff-mappings/:id - get single tariff mapping
  app.get(
    '/ocpi/tariff-mappings/:id',
    {
      onRequest: [authorize('roaming:read')],
      schema: {
        tags: ['OCPI'],
        summary: 'Get a single OCPI tariff mapping',
        operationId: 'getOcpiTariffMapping',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tariffMappingParams),
        response: {
          200: itemResponse(tariffMappingItem),
          404: errorWith('Tariff mapping not found', [ERROR_CODES.MAPPING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tariffMappingParams>;
      const mapping = await loadMapping(id);
      if (mapping == null) {
        await reply
          .status(404)
          .send({ error: 'Tariff mapping not found', code: 'MAPPING_NOT_FOUND' });
        return;
      }
      return mapping;
    },
  );

  // POST /ocpi/tariff-mappings - publish an internal tariff or pricing group
  app.post(
    '/ocpi/tariff-mappings',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Create OCPI tariff mapping',
        description:
          'Publishes an internal tariff or pricing group as an OCPI tariff. The OCPI tariff is generated from it on every partner request and push.',
        operationId: 'createOcpiTariffMapping',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createTariffMappingBody),
        response: {
          201: itemResponse(tariffMappingItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Tariff, pricing group, or partner not found', [
            ERROR_CODES.TARIFF_NOT_FOUND,
            ERROR_CODES.PRICING_GROUP_NOT_FOUND,
            ERROR_CODES.PARTNER_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createTariffMappingBody>;
      const tariffId = body.tariffId ?? null;
      const pricingGroupId = body.pricingGroupId ?? null;
      const partnerId = body.partnerId ?? null;

      if ((tariffId == null) === (pricingGroupId == null)) {
        await sendValidationError(reply, SOURCE_REQUIRED, { source: SOURCE_REQUIRED });
        return;
      }
      if (!(await checkReferences(reply, { tariffId, pricingGroupId, partnerId }))) return;
      if (await ocpiTariffIdTaken(body.ocpiTariffId, partnerId)) {
        await sendValidationError(reply, OCPI_TARIFF_ID_TAKEN, {
          ocpiTariffId: OCPI_TARIFF_ID_TAKEN,
        });
        return;
      }

      let createdId: number;
      try {
        const [created] = await db
          .insert(ocpiTariffMappings)
          .values({ ocpiTariffId: body.ocpiTariffId, partnerId, tariffId, pricingGroupId })
          .returning({ id: ocpiTariffMappings.id });
        if (created == null) throw new Error('Tariff mapping insert returned no row');
        createdId = created.id;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await sendValidationError(reply, OCPI_TARIFF_ID_TAKEN, {
          ocpiTariffId: OCPI_TARIFF_ID_TAKEN,
        });
        return;
      }

      await publishOcpiTariffPush({ targets: [{ partnerId, ocpiTariffId: body.ocpiTariffId }] });
      await reply.status(201).send(await loadMapping(createdId));
    },
  );

  // PATCH /ocpi/tariff-mappings/:id - update tariff mapping
  app.patch(
    '/ocpi/tariff-mappings/:id',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Update OCPI tariff mapping',
        operationId: 'updateOcpiTariffMapping',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tariffMappingParams),
        body: zodSchema(updateTariffMappingBody),
        response: {
          200: itemResponse(tariffMappingItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Tariff mapping, tariff, pricing group, or partner not found', [
            ERROR_CODES.MAPPING_NOT_FOUND,
            ERROR_CODES.TARIFF_NOT_FOUND,
            ERROR_CODES.PRICING_GROUP_NOT_FOUND,
            ERROR_CODES.PARTNER_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tariffMappingParams>;
      const body = request.body as z.infer<typeof updateTariffMappingBody>;

      const [existing] = await db
        .select()
        .from(ocpiTariffMappings)
        .where(eq(ocpiTariffMappings.id, id))
        .limit(1);

      if (existing == null) {
        await reply
          .status(404)
          .send({ error: 'Tariff mapping not found', code: 'MAPPING_NOT_FOUND' });
        return;
      }

      if (body.tariffId != null && body.pricingGroupId != null) {
        await sendValidationError(reply, SOURCE_REQUIRED, { source: SOURCE_REQUIRED });
        return;
      }
      // Selecting a tariff clears the pricing group and the other way round.
      let tariffId = existing.tariffId;
      let pricingGroupId = existing.pricingGroupId;
      if (body.tariffId != null) {
        tariffId = body.tariffId;
        pricingGroupId = null;
      } else if (body.pricingGroupId != null) {
        pricingGroupId = body.pricingGroupId;
        tariffId = null;
      }
      const partnerId = body.partnerId !== undefined ? body.partnerId : existing.partnerId;
      const ocpiTariffId = body.ocpiTariffId ?? existing.ocpiTariffId;

      if (
        !(await checkReferences(reply, {
          tariffId: body.tariffId ?? null,
          pricingGroupId: body.pricingGroupId ?? null,
          partnerId: body.partnerId ?? null,
        }))
      ) {
        return;
      }
      if (await ocpiTariffIdTaken(ocpiTariffId, partnerId, id)) {
        await sendValidationError(reply, OCPI_TARIFF_ID_TAKEN, {
          ocpiTariffId: OCPI_TARIFF_ID_TAKEN,
        });
        return;
      }

      try {
        await db
          .update(ocpiTariffMappings)
          .set({ ocpiTariffId, partnerId, tariffId, pricingGroupId, updatedAt: new Date() })
          .where(eq(ocpiTariffMappings.id, id));
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await sendValidationError(reply, OCPI_TARIFF_ID_TAKEN, {
          ocpiTariffId: OCPI_TARIFF_ID_TAKEN,
        });
        return;
      }

      // Push the new tariff, and resync the old id and partner scope: a
      // partner that no longer gets this id has it deleted, or gets the
      // mapping for every partner it falls back to.
      const targets: OcpiTariffPushTarget[] = [{ partnerId, ocpiTariffId }];
      if (existing.partnerId !== partnerId || existing.ocpiTariffId !== ocpiTariffId) {
        targets.push({ partnerId: existing.partnerId, ocpiTariffId: existing.ocpiTariffId });
      }
      await publishOcpiTariffPush({ targets });

      return loadMapping(id);
    },
  );

  // DELETE /ocpi/tariff-mappings/:id - delete tariff mapping
  app.delete(
    '/ocpi/tariff-mappings/:id',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Delete OCPI tariff mapping',
        description:
          'Stops publishing the OCPI tariff. Partners with a tariffs receiver get a DELETE, or the mapping for every partner when one has the same OCPI tariff id.',
        operationId: 'deleteOcpiTariffMapping',
        security: [{ bearerAuth: [] }],
        params: zodSchema(tariffMappingParams),
        response: {
          200: successResponse,
          404: errorWith('Tariff mapping not found', [ERROR_CODES.MAPPING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tariffMappingParams>;

      const [deleted] = await db
        .delete(ocpiTariffMappings)
        .where(eq(ocpiTariffMappings.id, id))
        .returning({
          partnerId: ocpiTariffMappings.partnerId,
          ocpiTariffId: ocpiTariffMappings.ocpiTariffId,
        });

      if (deleted == null) {
        await reply
          .status(404)
          .send({ error: 'Tariff mapping not found', code: 'MAPPING_NOT_FOUND' });
        return;
      }

      await publishOcpiTariffPush({ targets: [deleted] });
      return { success: true };
    },
  );
}
