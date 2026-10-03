// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, sql, and } from 'drizzle-orm';
import { db, createCreditCdr, ocpiCdrs, ocpiPartners } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';

const cdrListItem = z
  .object({
    id: z.string().describe('Identifier'),
    partnerId: z.string().nullable().describe('OCPI partner ID, when known'),
    ocpiCdrId: z.string().max(36).describe('OCPI CDR identifier (UUID) used by partners'),
    chargingSessionId: z
      .string()
      .nullable()
      .describe('Linked CSMS charging session ID, when this CDR maps to a local session'),
    totalEnergy: z
      .string()
      .nullable()
      .describe('Total energy delivered in kWh, as a decimal string'),
    totalCost: z
      .string()
      .nullable()
      .describe(
        'Total cost excluding tax as a decimal string (OCPI excl_vat in 2.2.1, before_taxes in 2.3.0). Negative on a credit CDR',
      ),
    currency: z.string().length(3).nullable().describe('ISO 4217 currency code'),
    isCredit: z.boolean().describe('True when this CDR is a credit (refund) for an earlier CDR'),
    pushStatus: z
      .enum(['pending', 'sent', 'confirmed', 'failed'])
      .describe('Outbound delivery status to the partner'),
    createdAt: z.coerce.date().describe('Timestamp when the CDR was created'),
    partnerName: z.string().max(255).nullable().describe('Display name of the OCPI partner'),
  })
  .passthrough();

const creditCdrResponse = z
  .object({
    cdrId: z
      .string()
      .describe(
        'OCPI id of the credit CDR. Crediting a CDR that already has a credit CDR returns that one',
      ),
  })
  .passthrough();

const cdrQuery = paginationQuery.extend({
  partnerId: ID_PARAMS.ocpiPartnerId.optional().describe('Filter by OCPI partner ID'),
  pushStatus: z
    .enum(['pending', 'sent', 'confirmed', 'failed'])
    .optional()
    .describe('Filter by CDR push status'),
});

const creditCdrBody = z.object({
  originalCdrId: z.string().min(1).describe('OCPI CDR ID to credit'),
  reason: z.string().min(1).max(500).describe('Reason for the credit CDR'),
});

export function ocpiCdrRoutes(app: FastifyInstance): void {
  // GET /ocpi/cdrs - paginated CDRs
  app.get(
    '/ocpi/cdrs',
    {
      onRequest: [authorize('roaming:read')],
      schema: {
        tags: ['OCPI'],
        summary: 'List OCPI charge detail records',
        operationId: 'listOcpiCdrs',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(cdrQuery),
        response: { 200: paginatedResponse(cdrListItem) },
      },
    },
    async (request) => {
      const { page, limit, partnerId, pushStatus } = request.query as z.infer<typeof cdrQuery>;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (partnerId != null) {
        conditions.push(eq(ocpiCdrs.partnerId, partnerId));
      }
      if (pushStatus != null) {
        conditions.push(eq(ocpiCdrs.pushStatus, pushStatus));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: ocpiCdrs.id,
            partnerId: ocpiCdrs.partnerId,
            ocpiCdrId: ocpiCdrs.ocpiCdrId,
            chargingSessionId: ocpiCdrs.chargingSessionId,
            totalEnergy: ocpiCdrs.totalEnergy,
            totalCost: ocpiCdrs.totalCost,
            currency: ocpiCdrs.currency,
            isCredit: ocpiCdrs.isCredit,
            pushStatus: ocpiCdrs.pushStatus,
            createdAt: ocpiCdrs.createdAt,
            partnerName: ocpiPartners.name,
          })
          .from(ocpiCdrs)
          .leftJoin(ocpiPartners, eq(ocpiCdrs.partnerId, ocpiPartners.id))
          .where(where)
          .orderBy(desc(ocpiCdrs.createdAt), desc(ocpiCdrs.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocpiCdrs)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // POST /ocpi/cdrs/credit - create a credit CDR
  app.post(
    '/ocpi/cdrs/credit',
    {
      onRequest: [authorize('roaming:write')],
      schema: {
        tags: ['OCPI'],
        summary: 'Create a credit CDR',
        operationId: 'createOcpiCreditCdr',
        security: [{ bearerAuth: [] }],
        body: zodSchema(creditCdrBody),
        response: {
          201: itemResponse(creditCdrResponse),
          400: errorWith('Credit CDR not possible', [
            ERROR_CODES.INVALID_OPERATION,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Cdr not found', [ERROR_CODES.CDR_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof creditCdrBody>;

      // One credit CDR builder for the API and the OCPI server (OCPI 10.1.1:
      // only total_cost is negated, in the Price shape of the CDR's version).
      const result = await createCreditCdr(body.originalCdrId, body.reason);
      switch (result.status) {
        case 'not_found':
          await reply.status(404).send({ error: 'CDR not found', code: 'CDR_NOT_FOUND' });
          return;
        case 'is_credit':
          await reply
            .status(400)
            .send({ error: 'Cannot credit a credit CDR', code: 'INVALID_OPERATION' });
          return;
        case 'invalid_cdr':
          await reply
            .status(400)
            .send({ error: 'The CDR has no total cost to credit', code: 'VALIDATION_ERROR' });
          return;
        case 'created':
        case 'existing':
          await reply.status(201).send({ cdrId: result.cdrId });
          return;
      }
    },
  );
}
