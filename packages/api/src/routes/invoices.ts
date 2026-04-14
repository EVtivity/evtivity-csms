// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, and, count } from 'drizzle-orm';
import { db, invoices } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { errorResponse, paginatedResponse, itemResponse } from '../lib/response-schemas.js';

const invoiceListItem = z
  .object({
    id: z.string(),
    invoiceNumber: z.string(),
    driverId: z.string().nullable(),
    status: z.string(),
    issuedAt: z.coerce.date().nullable(),
    dueAt: z.coerce.date().nullable(),
    currency: z.string(),
    subtotalCents: z.number(),
    taxCents: z.number(),
    totalCents: z.number(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const invoiceDetailItem = z.object({}).passthrough();
import { authorize } from '../middleware/rbac.js';
import {
  createSessionInvoice,
  createAggregatedInvoice,
  getInvoice,
  voidInvoice,
} from '../services/invoice.service.js';

const invoiceIdParams = z.object({ id: ID_PARAMS.invoiceId.describe('Invoice ID') });
const sessionIdParams = z.object({
  sessionId: ID_PARAMS.sessionId.describe('Charging session ID'),
});

const invoiceListQuery = paginationQuery.extend({
  driverId: ID_PARAMS.driverId.optional().describe('Filter by driver ID'),
  status: z
    .enum(['draft', 'issued', 'paid', 'void'])
    .optional()
    .describe('Filter by invoice status'),
});

const aggregatedInvoiceBody = z.object({
  driverId: ID_PARAMS.driverId.describe('Driver ID to invoice'),
  startDate: z.string().datetime().describe('Start of billing period (ISO 8601)'),
  endDate: z.string().datetime().describe('End of billing period (ISO 8601)'),
});

export function invoiceRoutes(app: FastifyInstance): void {
  // List invoices
  app.get(
    '/invoices',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Invoices'],
        summary: 'List invoices',
        operationId: 'listInvoices',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(invoiceListQuery),
        response: { 200: paginatedResponse(invoiceListItem) },
      },
    },
    async (request) => {
      const { page, limit, driverId, status } = request.query as z.infer<typeof invoiceListQuery>;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (driverId != null) {
        conditions.push(eq(invoices.driverId, driverId));
      }
      if (status != null) {
        conditions.push(eq(invoices.status, status));
      }
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countResult] = await Promise.all([
        db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            driverId: invoices.driverId,
            status: invoices.status,
            issuedAt: invoices.issuedAt,
            dueAt: invoices.dueAt,
            currency: invoices.currency,
            subtotalCents: invoices.subtotalCents,
            taxCents: invoices.taxCents,
            totalCents: invoices.totalCents,
            createdAt: invoices.createdAt,
            updatedAt: invoices.updatedAt,
          })
          .from(invoices)
          .where(whereClause)
          .orderBy(desc(invoices.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(invoices).where(whereClause),
      ]);

      return {
        data,
        total: countResult[0]?.count ?? 0,
      } satisfies PaginatedResponse<(typeof data)[number]>;
    },
  );

  // Get single invoice with line items
  app.get(
    '/invoices/:id',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Invoices'],
        summary: 'Get an invoice with line items',
        operationId: 'getInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
        response: { 200: itemResponse(invoiceDetailItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof invoiceIdParams>;
      const result = await getInvoice(id);

      if (result == null) {
        await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
        return;
      }

      return result;
    },
  );

  // Generate invoice for a single session
  app.post(
    '/invoices/session/:sessionId',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Invoices'],
        summary: 'Generate an invoice for a single charging session',
        operationId: 'createSessionInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        response: { 201: itemResponse(invoiceDetailItem), 400: errorResponse },
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params as z.infer<typeof sessionIdParams>;

      try {
        const result = await createSessionInvoice(sessionId);
        await reply.status(201).send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to create invoice';
        await reply.status(400).send({ error: message, code: 'INVOICE_CREATION_FAILED' });
      }
    },
  );

  // Generate aggregated invoice
  app.post(
    '/invoices/aggregated',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Invoices'],
        summary: 'Generate an aggregated invoice for a driver over a date range',
        operationId: 'createAggregatedInvoice',
        security: [{ bearerAuth: [] }],
        body: zodSchema(aggregatedInvoiceBody),
        response: { 201: itemResponse(invoiceDetailItem), 400: errorResponse },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof aggregatedInvoiceBody>;

      try {
        const result = await createAggregatedInvoice(
          body.driverId,
          new Date(body.startDate),
          new Date(body.endDate),
        );
        await reply.status(201).send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to create invoice';
        await reply.status(400).send({ error: message, code: 'INVOICE_CREATION_FAILED' });
      }
    },
  );

  // Void an invoice
  app.patch(
    '/invoices/:id/void',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Invoices'],
        summary: 'Void an invoice',
        operationId: 'voidInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
        response: { 200: itemResponse(invoiceDetailItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof invoiceIdParams>;
      const result = await voidInvoice(id);

      if (result == null) {
        await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
        return;
      }

      return result;
    },
  );

  // Download invoice as JSON
  app.get(
    '/invoices/:id/download',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Invoices'],
        summary: 'Download an invoice as JSON',
        operationId: 'downloadInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof invoiceIdParams>;
      const result = await getInvoice(id);

      if (result == null) {
        await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
        return;
      }

      await reply
        .header('Content-Type', 'application/json')
        .header(
          'Content-Disposition',
          `attachment; filename="${result.invoice.invoiceNumber}.json"`,
        )
        .send(result);
    },
  );
}
