// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, isNull, notInArray, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db, invoices, fleets, invoiceStatusEnum, INVOICE_KINDS } from '@evtivity/database';
import { getInvoice } from '@evtivity/services/invoice.service';
import type { InvoiceDetail } from '@evtivity/services/invoice.service';
import { generateInvoicePdf } from '@evtivity/services/invoice-pdf.service';
import { zodSchema } from '../../lib/zod-schema.js';
import { ID_PARAMS } from '../../lib/id-validation.js';
import { paginationQuery } from '../../lib/pagination.js';
import type { PaginatedResponse } from '../../lib/pagination.js';
import { paginatedResponse, itemResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

/**
 * The invoices a driver may read: their own ordinary driver invoices and the
 * member invoices a fleet addressed to them, with the credit notes of both.
 * A fleet invoice (fleet_id set, not member_billed) is the fleet's document,
 * even when it bills the driver's sessions. Drafts and void drafts were never
 * issued to anyone. Every portal invoice route reads through this scope, so
 * another driver's invoice, a fleet invoice and a draft all answer 404.
 */
export function driverInvoiceScope(driverId: string): SQL {
  return and(
    eq(invoices.driverId, driverId),
    or(isNull(invoices.fleetId), eq(invoices.memberBilled, true)),
    notInArray(invoices.status, ['draft', 'void']),
  ) as SQL;
}

const invoiceNotFound = { error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' } as const;

const notFoundResponse = errorWith(
  "Invoice not found: unknown, another driver's or a fleet's invoice",
  [ERROR_CODES.INVOICE_NOT_FOUND],
);

const portalInvoiceListQuery = paginationQuery.omit({ search: true });

const portalInvoiceParams = z.object({ id: ID_PARAMS.invoiceId.describe('Invoice ID') });

const portalInvoiceItem = z
  .object({
    id: z.string().describe('Invoice ID'),
    invoiceNumber: z.string().describe('Invoice or credit note number'),
    kind: z
      .enum(INVOICE_KINDS)
      .describe('invoice, or credit_note for a credit note that credits an invoice in full'),
    status: z
      .enum(invoiceStatusEnum.enumValues)
      .describe('issued, paid, or credited (a credit note credited it in full)'),
    viaFleetName: z
      .string()
      .nullable()
      .describe(
        'On a member invoice and its credit note: the fleet whose account the sessions were charged on. Null on ordinary driver invoices',
      ),
    periodStart: z
      .string()
      .nullable()
      .describe('On a member invoice: first day of the billed month (YYYY-MM-DD)'),
    periodEnd: z
      .string()
      .nullable()
      .describe('On a member invoice: last day of the billed month (YYYY-MM-DD)'),
    creditedInvoiceId: z
      .string()
      .nullable()
      .describe('On a credit note: the invoice it credits. Null on invoices'),
    issuedAt: z.coerce.date().nullable().describe('When it was issued'),
    dueAt: z.coerce.date().nullable().describe('Payment due date, null when nothing is due'),
    paidAt: z.coerce.date().nullable().describe('When it was paid in full, null while unpaid'),
    currency: z.string().length(3).describe('ISO 4217 currency code'),
    subtotalCents: z
      .number()
      .int()
      .describe('Net amount in cents (tax excluded), negative on a credit note'),
    taxCents: z.number().int().describe('Tax amount in cents, negative on a credit note'),
    totalCents: z
      .number()
      .int()
      .describe('Total amount in cents (net plus tax), negative on a credit note'),
    createdAt: z.coerce.date().describe('When the invoice was created'),
  })
  .passthrough();

const portalInvoiceLine = z
  .object({
    id: z.number().int().min(1).describe('Line item ID'),
    sessionId: z.string().nullable().describe('Charging session this line bills, if any'),
    description: z.string().describe('Line item description'),
    quantity: z.string().describe('Quantity (numeric string)'),
    unitPriceCents: z
      .number()
      .int()
      .describe('Unit price in cents (tax excluded), negative on a credit note'),
    totalCents: z
      .number()
      .int()
      .describe('Line net amount in cents (tax excluded), negative on a credit note'),
    taxCents: z.number().int().describe('Line tax in cents, negative on a credit note'),
    taxRate: z.string().describe('Tax rate as a decimal fraction string (0.19 is 19%)'),
    kind: z
      .string()
      .nullable()
      .describe(
        'What the line bills (energy, time, sessionFee, idleFee, reservationFee, session, cancellationFee, noShowFee), null when unknown',
      ),
    sessionDate: z
      .string()
      .nullable()
      .describe('On session lines: the session end date (YYYY-MM-DD)'),
    energyWh: z.number().nullable().describe('On session lines: energy delivered in Wh'),
    stationName: z.string().nullable().describe('On member invoice session lines: the station'),
  })
  .passthrough();

const portalInvoiceTaxLine = z
  .object({
    taxRate: z.number().min(0).describe('Tax rate as a fraction (0.19 is 19%)'),
    netCents: z.number().int().describe('Net amount taxed at this rate, in cents'),
    taxCents: z.number().int().describe('Tax amount at this rate, in cents'),
    grossCents: z.number().int().describe('Net amount plus tax at this rate, in cents'),
  })
  .passthrough();

const portalInvoiceReference = z
  .object({
    id: z.string().describe('Invoice ID'),
    invoiceNumber: z.string().describe('Invoice or credit note number'),
  })
  .passthrough();

const portalInvoiceDetail = portalInvoiceItem
  .extend({
    billTo: z
      .record(z.unknown())
      .nullable()
      .describe(
        'On a member invoice: the bill-to block at issue (name, address, email). Null on ordinary driver invoices, which bill the driver by name and email',
      ),
    creditReason: z.string().nullable().describe('On a credit note: the reason given'),
    lineItems: z.array(portalInvoiceLine).describe('Line items'),
    taxBreakdown: z.array(portalInvoiceTaxLine).describe('Net, tax and gross per tax rate'),
    creditedInvoice: portalInvoiceReference
      .nullable()
      .describe('On a credit note: the invoice it credits'),
    creditNote: portalInvoiceReference
      .nullable()
      .describe('On a credited invoice: the credit note that credited it'),
  })
  .passthrough();

type PortalInvoiceLine = z.infer<typeof portalInvoiceLine>;

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' ? v : null;
}

function metaNumber(meta: Record<string, unknown>, key: string): number | null {
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The driver's view of an invoice: the document as printed, without operator
 * fields (payment reference, free-form metadata, line metadata beyond what the
 * PDF prints).
 */
export function toPortalInvoiceDetail(detail: InvoiceDetail): z.infer<typeof portalInvoiceDetail> {
  const { invoice } = detail;
  const memberInvoice = invoice.memberBilled;
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    kind: invoice.kind,
    status: invoice.status,
    viaFleetName: memberInvoice ? (detail.fleet?.name ?? null) : null,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    creditedInvoiceId: invoice.creditedInvoiceId,
    issuedAt: invoice.issuedAt,
    dueAt: invoice.dueAt,
    paidAt: invoice.paidAt,
    currency: invoice.currency,
    subtotalCents: invoice.subtotalCents,
    taxCents: invoice.taxCents,
    totalCents: invoice.totalCents,
    createdAt: invoice.createdAt,
    billTo: memberInvoice ? (invoice.billTo as Record<string, unknown> | null) : null,
    creditReason: invoice.creditReason,
    lineItems: detail.lineItems.map((line): PortalInvoiceLine => {
      const meta = (line.metadata ?? {}) as Record<string, unknown>;
      return {
        id: line.id,
        sessionId: line.sessionId,
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        totalCents: line.totalCents,
        taxCents: line.taxCents,
        taxRate: line.taxRate,
        kind: metaString(meta, 'kind'),
        sessionDate: metaString(meta, 'sessionDate'),
        energyWh: metaNumber(meta, 'energyWh'),
        stationName: metaString(meta, 'stationName'),
      };
    }),
    taxBreakdown: detail.taxBreakdown.map((line) => ({
      taxRate: line.taxRate,
      netCents: line.netCents,
      taxCents: line.taxCents,
      grossCents: line.grossCents,
    })),
    creditedInvoice:
      detail.creditedInvoice != null
        ? {
            id: detail.creditedInvoice.id,
            invoiceNumber: detail.creditedInvoice.invoiceNumber,
          }
        : null,
    creditNote:
      detail.creditNote != null
        ? { id: detail.creditNote.id, invoiceNumber: detail.creditNote.invoiceNumber }
        : null,
  };
}

/** The invoice when the driver may read it (`driverInvoiceScope`), else null. */
async function loadDriverInvoice(driverId: string, id: string): Promise<InvoiceDetail | null> {
  const [own] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.id, id), driverInvoiceScope(driverId)));
  if (own == null) return null;
  return getInvoice(own.id);
}

export function portalInvoiceRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/invoices',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Invoices'],
        summary: "List the driver's invoices",
        description:
          "The signed-in driver's invoices and credit notes, newest first: ordinary driver invoices and the member invoices a fleet addressed to the driver. A fleet's own invoices are never listed, also when they bill the driver's sessions.",
        operationId: 'portalListInvoices',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(portalInvoiceListQuery),
        response: { 200: paginatedResponse(portalInvoiceItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { page, limit } = request.query as z.infer<typeof portalInvoiceListQuery>;
      const where = driverInvoiceScope(driverId);
      const [rows, totals] = await Promise.all([
        db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            kind: invoices.kind,
            status: invoices.status,
            memberBilled: invoices.memberBilled,
            fleetName: fleets.name,
            periodStart: invoices.periodStart,
            periodEnd: invoices.periodEnd,
            creditedInvoiceId: invoices.creditedInvoiceId,
            issuedAt: invoices.issuedAt,
            dueAt: invoices.dueAt,
            paidAt: invoices.paidAt,
            currency: invoices.currency,
            subtotalCents: invoices.subtotalCents,
            taxCents: invoices.taxCents,
            totalCents: invoices.totalCents,
            createdAt: invoices.createdAt,
          })
          .from(invoices)
          .leftJoin(fleets, eq(fleets.id, invoices.fleetId))
          .where(where)
          .orderBy(desc(invoices.createdAt), desc(invoices.id))
          .limit(limit)
          .offset((page - 1) * limit),
        db.select({ count: count() }).from(invoices).where(where),
      ]);
      const data = rows.map(({ memberBilled, fleetName, ...row }) => ({
        ...row,
        viaFleetName: memberBilled ? fleetName : null,
      }));
      return { data, total: totals[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  app.get(
    '/portal/invoices/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Invoices'],
        summary: 'Get one of the driver invoices',
        description:
          "An invoice or credit note of the signed-in driver with its lines and tax breakdown. Another driver's invoice, a fleet invoice and an unknown id all answer 404 INVOICE_NOT_FOUND.",
        operationId: 'portalGetInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(portalInvoiceParams),
        response: { 200: itemResponse(portalInvoiceDetail), 404: notFoundResponse },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof portalInvoiceParams>;
      const detail = await loadDriverInvoice(driverId, id);
      if (detail == null) {
        await reply.status(404).send(invoiceNotFound);
        return;
      }
      return toPortalInvoiceDetail(detail);
    },
  );

  app.get(
    '/portal/invoices/:id/pdf',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Invoices'],
        summary: 'Download one of the driver invoices as a PDF',
        description:
          "The same PDF the operator downloads (GET /v1/invoices/:id/pdf), for an invoice or credit note of the signed-in driver. Streams application/pdf as an attachment. Another driver's invoice, a fleet invoice and an unknown id all answer 404 INVOICE_NOT_FOUND.",
        operationId: 'portalDownloadInvoicePdf',
        security: [{ bearerAuth: [] }],
        params: zodSchema(portalInvoiceParams),
        response: { 404: notFoundResponse },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = request.params as z.infer<typeof portalInvoiceParams>;
      const detail = await loadDriverInvoice(driverId, id);
      if (detail == null) {
        await reply.status(404).send(invoiceNotFound);
        return;
      }
      const pdf = await generateInvoicePdf(detail);
      await reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${detail.invoice.invoiceNumber}.pdf"`)
        .send(pdf);
    },
  );
}
