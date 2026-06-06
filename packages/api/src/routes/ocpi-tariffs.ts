// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, and } from 'drizzle-orm';
import { db, ocpiTariffMappings, tariffs, ocpiPartners } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getPubSub } from '../lib/pubsub.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  errorWith,
} from '../lib/response-schemas.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
const tariffMappingItem = z
  .object({
    id: z.string().describe('Identifier'),
    tariffId: z.string().describe('Internal CSMS tariff identifier this mapping references'),
    partnerId: z
      .string()
      .nullable()
      .describe('OCPI partner ID this mapping applies to, or null for default'),
    ocpiTariffId: z.string().max(36).describe('OCPI tariff identifier exposed to partners'),
    currency: z.string().length(3).describe('ISO 4217 currency code'),
    createdAt: z.coerce.date().describe('Timestamp when created'),
    updatedAt: z.coerce.date().describe('Timestamp when last modified'),
    tariffName: z
      .string()
      .max(255)
      .nullable()
      .optional()
      .describe('Name of the linked internal tariff'),
    partnerName: z
      .string()
      .max(255)
      .nullable()
      .optional()
      .describe('Display name of the OCPI partner'),
  })
  .passthrough();

const tariffMappingQuery = paginationQuery.extend({
  partnerId: ID_PARAMS.ocpiPartnerId.optional().describe('Filter by OCPI partner ID'),
});

const tariffMappingParams = z.object({
  id: z.coerce.number().int().min(1).describe('Tariff mapping ID'),
});

const createTariffMappingBody = z.object({
  tariffId: ID_PARAMS.tariffId.describe('Internal tariff ID to map'),
  partnerId: ID_PARAMS.ocpiPartnerId
    .nullable()
    .optional()
    .describe('OCPI partner ID. Null for default mapping'),
  ocpiTariffId: z.string().min(1).max(36).describe('OCPI tariff identifier'),
  currency: z.string().length(3).describe('ISO 4217 currency code'),
  ocpiTariffData: z.record(z.unknown()).describe('Full OCPI tariff object'),
});

const updateTariffMappingBody = z.object({
  ocpiTariffId: z.string().min(1).max(36).optional().describe('OCPI tariff identifier'),
  currency: z.string().length(3).optional().describe('ISO 4217 currency code'),
  ocpiTariffData: z.record(z.unknown()).optional().describe('Full OCPI tariff object'),
});

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

      const conditions = [];
      if (partnerId != null) {
        conditions.push(eq(ocpiTariffMappings.partnerId, partnerId));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: ocpiTariffMappings.id,
            tariffId: ocpiTariffMappings.tariffId,
            partnerId: ocpiTariffMappings.partnerId,
            ocpiTariffId: ocpiTariffMappings.ocpiTariffId,
            currency: ocpiTariffMappings.currency,
            createdAt: ocpiTariffMappings.createdAt,
            updatedAt: ocpiTariffMappings.updatedAt,
            tariffName: tariffs.name,
            partnerName: ocpiPartners.name,
          })
          .from(ocpiTariffMappings)
          .leftJoin(tariffs, eq(ocpiTariffMappings.tariffId, tariffs.id))
          .leftJoin(ocpiPartners, eq(ocpiTariffMappings.partnerId, ocpiPartners.id))
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

      const [mapping] = await db
        .select({
          id: ocpiTariffMappings.id,
          tariffId: ocpiTariffMappings.tariffId,
          partnerId: ocpiTariffMappings.partnerId,
          ocpiTariffId: ocpiTariffMappings.ocpiTariffId,
          currency: ocpiTariffMappings.currency,
          createdAt: ocpiTariffMappings.createdAt,
          updatedAt: ocpiTariffMappings.updatedAt,
          tariffName: tariffs.name,
          partnerName: ocpiPartners.name,
        })
        .from(ocpiTariffMappings)
        .leftJoin(tariffs, eq(ocpiTariffMappings.tariffId, tariffs.id))
        .leftJoin(ocpiPartners, eq(ocpiTariffMappings.partnerId, ocpiPartners.id))
        .where(eq(ocpiTariffMappings.id, id));

      if (mapping == null) {
        await reply
          .status(404)
          .send({ error: 'Tariff mapping not found', code: 'MAPPING_NOT_FOUND' });
        return;
      }

      return mapping;
    },
  );

  // POST /ocpi/tariff-mappings - create tariff mapping
  app.post(
    '/ocpi/tariff-mappings',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Create OCPI tariff mapping',
        operationId: 'createOcpiTariffMapping',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createTariffMappingBody),
        response: {
          201: itemResponse(tariffMappingItem),
          404: errorWith('Tariff not found', [ERROR_CODES.TARIFF_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createTariffMappingBody>;

      const [tariff] = await db
        .select({ id: tariffs.id })
        .from(tariffs)
        .where(eq(tariffs.id, body.tariffId))
        .limit(1);

      if (tariff == null) {
        await reply.status(404).send({ error: 'Tariff not found', code: 'TARIFF_NOT_FOUND' });
        return;
      }

      const insertValues: {
        tariffId: string;
        ocpiTariffId: string;
        currency: string;
        ocpiTariffData: Record<string, unknown>;
        partnerId?: string;
      } = {
        tariffId: body.tariffId,
        ocpiTariffId: body.ocpiTariffId,
        currency: body.currency,
        ocpiTariffData: body.ocpiTariffData,
      };
      if (body.partnerId != null) {
        insertValues.partnerId = body.partnerId;
      }

      const [created] = await db.insert(ocpiTariffMappings).values(insertValues).returning();

      await reply.status(201).send(created);
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
          404: errorWith('Tariff mapping not found', [ERROR_CODES.MAPPING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof tariffMappingParams>;
      const body = request.body as z.infer<typeof updateTariffMappingBody>;

      const [existing] = await db
        .select({ id: ocpiTariffMappings.id })
        .from(ocpiTariffMappings)
        .where(eq(ocpiTariffMappings.id, id))
        .limit(1);

      if (existing == null) {
        await reply
          .status(404)
          .send({ error: 'Tariff mapping not found', code: 'MAPPING_NOT_FOUND' });
        return;
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.ocpiTariffId != null) updateData['ocpiTariffId'] = body.ocpiTariffId;
      if (body.currency != null) updateData['currency'] = body.currency;
      if (body.ocpiTariffData != null) updateData['ocpiTariffData'] = body.ocpiTariffData;

      const [updated] = await db
        .update(ocpiTariffMappings)
        .set(updateData)
        .where(eq(ocpiTariffMappings.id, id))
        .returning();

      // Notify push service
      if (updated != null) {
        await getPubSub().publish(
          'ocpi_push',
          JSON.stringify({ type: 'tariff', tariffId: updated.tariffId }),
        );
      }

      return updated;
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

      const [existing] = await db
        .select({ id: ocpiTariffMappings.id })
        .from(ocpiTariffMappings)
        .where(eq(ocpiTariffMappings.id, id))
        .limit(1);

      if (existing == null) {
        await reply
          .status(404)
          .send({ error: 'Tariff mapping not found', code: 'MAPPING_NOT_FOUND' });
        return;
      }

      await db.delete(ocpiTariffMappings).where(eq(ocpiTariffMappings.id, id));

      return { success: true };
    },
  );
}
