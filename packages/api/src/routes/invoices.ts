// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, and, count } from 'drizzle-orm';
import { db, client, invoices, invoiceStatusEnum } from '@evtivity/database';
import { dispatchDriverNotification, AppError } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  paginatedResponse,
  itemResponse,
  errorWith,
  successResponse,
} from '../lib/response-schemas.js';
import { getPubSub } from '../lib/pubsub.js';
import { ALL_TEMPLATES_DIRS } from '../lib/template-dirs.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
const invoiceListItem = z
  .object({
    id: z.string().describe('Invoice ID'),
    invoiceNumber: z.string().describe('Human-readable invoice number, e.g. INV-202603-0042'),
    driverId: z.string().nullable().describe('Driver ID this invoice is billed to'),
    status: z
      .enum(invoiceStatusEnum.enumValues)
      .describe('Invoice status (draft, issued, paid, void)'),
    issuedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the invoice was issued to the driver'),
    dueAt: z.coerce.date().nullable().describe('Payment due timestamp'),
    currency: z.string().length(3).describe('ISO 4217 currency code'),
    subtotalCents: z.number().int().min(0).describe('Subtotal amount in cents (pre-tax)'),
    taxCents: z.number().int().min(0).describe('Tax amount in cents'),
    totalCents: z.number().int().min(0).describe('Total amount in cents (subtotal + tax)'),
    createdAt: z.coerce.date().describe('Timestamp when the invoice was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the invoice was last updated'),
  })
  .passthrough();

const invoiceRecord = z
  .object({
    id: z.string().describe('Invoice ID'),
    invoiceNumber: z.string().describe('Human-readable invoice number'),
    driverId: z.string().nullable().describe('Driver ID this invoice is billed to'),
    status: z.enum(invoiceStatusEnum.enumValues).describe('Invoice status'),
    issuedAt: z.string().nullable().describe('Timestamp when the invoice was issued'),
    dueAt: z.string().nullable().describe('Timestamp when payment is due'),
    currency: z.string().length(3).describe('ISO 4217 currency code'),
    subtotalCents: z.number().int().min(0).describe('Subtotal amount in cents (pre-tax)'),
    taxCents: z.number().int().min(0).describe('Tax amount in cents'),
    totalCents: z.number().int().min(0).describe('Total amount in cents (subtotal + tax)'),
    metadata: z.record(z.unknown()).nullable().describe('Free-form invoice metadata'),
    createdAt: z.string().describe('Timestamp when the invoice was created'),
    updatedAt: z.string().describe('Timestamp when the invoice was last updated'),
  })
  .passthrough();

const invoiceLineItem = z
  .object({
    id: z.number().int().min(1).describe('Line item ID'),
    invoiceId: z.string().describe('Invoice ID this line item belongs to'),
    sessionId: z.string().nullable().describe('Charging session ID linked to this line item'),
    description: z.string().max(500).describe('Line item description'),
    quantity: z.string().describe('Quantity (numeric string)'),
    unitPriceCents: z.number().int().min(0).describe('Unit price in cents'),
    totalCents: z.number().int().min(0).describe('Line item total in cents'),
    taxCents: z.number().int().min(0).describe('Tax amount in cents for this line item'),
    metadata: z.record(z.unknown()).nullable().describe('Free-form line item metadata'),
    createdAt: z.string().describe('Timestamp when the line item was created'),
  })
  .passthrough();

const invoiceDriver = z
  .object({
    id: z.string().describe('Driver ID'),
    firstName: z.string().describe('Driver first name'),
    lastName: z.string().describe('Driver last name'),
    email: z.string().nullable().describe('Driver email address'),
  })
  .passthrough();

const invoiceDetailItem = z
  .object({
    invoice: invoiceRecord.describe('Invoice header record'),
    lineItems: z.array(invoiceLineItem).describe('Line items associated with the invoice'),
    driver: invoiceDriver
      .nullable()
      .optional()
      .describe(
        'Driver this invoice is billed to (null when unassigned). Present on the detail response; omitted on create responses.',
      ),
  })
  .passthrough();
import { authorize } from '../middleware/rbac.js';
import {
  createSessionInvoice,
  createAggregatedInvoice,
  getInvoice,
  voidInvoice,
} from '../services/invoice.service.js';
import { generateInvoicePdf } from '../services/invoice-pdf.service.js';

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
          .orderBy(desc(invoices.createdAt), desc(invoices.id))
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
        response: {
          200: itemResponse(invoiceDetailItem),
          404: errorWith('Invoice not found', [ERROR_CODES.INVOICE_NOT_FOUND]),
        },
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
        description:
          'Builds an invoice from the session and its tariff snapshot, allocating a sequential invoice number from invoice_number_seq. Inserts the invoice header and line items in a transaction. Returns 400 if the session is not eligible (no driver, no final cost, or already invoiced).',
        operationId: 'createSessionInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sessionIdParams),
        response: {
          201: itemResponse(invoiceDetailItem),
          400: errorWith('Invoice creation failed', [ERROR_CODES.INVOICE_CREATION_FAILED]),
        },
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
        description:
          'Aggregates every uninvoiced completed session for the driver between startDate and endDate into a single invoice with one line item per session. Allocates an invoice number from invoice_number_seq. Returns 400 if no eligible sessions are found in the window.',
        operationId: 'createAggregatedInvoice',
        security: [{ bearerAuth: [] }],
        body: zodSchema(aggregatedInvoiceBody),
        response: {
          201: itemResponse(invoiceDetailItem),
          400: errorWith('Invoice creation failed', [
            ERROR_CODES.INVOICE_NO_SESSIONS,
            ERROR_CODES.INVOICE_CREATION_FAILED,
          ]),
        },
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
        if (err instanceof AppError) {
          await reply.status(400).send({ error: err.message, code: err.code });
          return;
        }
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
        description:
          'Marks an invoice as void. Voiding does not issue refunds; use the payments refund endpoint for that. Returns 200 with the invoice unchanged when called against an already-voided invoice (idempotent).',
        operationId: 'voidInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
        response: {
          200: itemResponse(invoiceRecord),
          404: errorWith('Invoice not found', [ERROR_CODES.INVOICE_NOT_FOUND]),
        },
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

  // Email an invoice to its driver
  app.post(
    '/invoices/:id/send',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Invoices'],
        summary: 'Email an invoice to its driver',
        description:
          'Renders the invoice.Sent driver notification and dispatches it via the configured channels. Safe to call repeatedly; each call sends again (deliberate resend semantics).',
        operationId: 'sendInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
        response: {
          200: successResponse,
          400: errorWith('Invoice has no driver', [ERROR_CODES.INVOICE_NO_DRIVER]),
          404: errorWith('Invoice not found', [ERROR_CODES.INVOICE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof invoiceIdParams>;
      const result = await getInvoice(id);

      if (result == null) {
        await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
        return;
      }

      const { invoice } = result;
      if (invoice.driverId == null) {
        await reply.status(400).send({ error: 'Invoice has no driver', code: 'INVOICE_NO_DRIVER' });
        return;
      }

      await dispatchDriverNotification(
        client,
        'invoice.Sent',
        invoice.driverId,
        {
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          issuedAt: invoice.issuedAt?.toISOString() ?? '',
          dueAt: invoice.dueAt?.toISOString() ?? '',
          total: `${(invoice.totalCents / 100).toFixed(2)} ${invoice.currency}`,
        },
        ALL_TEMPLATES_DIRS,
        getPubSub(),
      );

      return { success: true };
    },
  );

  // Download invoice as a PDF
  app.get(
    '/invoices/:id/pdf',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Invoices'],
        summary: 'Download an invoice as a PDF',
        description:
          'Renders a portrait A4 PDF of the invoice with the company logo, billed-to driver, line items, and totals. Streams application/pdf as an attachment.',
        operationId: 'downloadInvoicePdf',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
        response: { 404: errorWith('Invoice not found', [ERROR_CODES.INVOICE_NOT_FOUND]) },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof invoiceIdParams>;
      const result = await getInvoice(id);

      if (result == null) {
        await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
        return;
      }

      const pdf = await generateInvoicePdf(result);

      await reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${result.invoice.invoiceNumber}.pdf"`)
        .send(pdf);
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
        response: { 404: errorWith('Invoice not found', [ERROR_CODES.INVOICE_NOT_FOUND]) },
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
