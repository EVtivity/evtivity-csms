// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, and, count, isNull } from 'drizzle-orm';
import {
  db,
  client,
  invoices,
  fleets,
  invoiceStatusEnum,
  INVOICE_KINDS,
  invoiceAuditLog,
  writeAudit,
} from '@evtivity/database';
import { dispatchDriverNotification, AppError, notificationMoney } from '@evtivity/lib';
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
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { getUserSiteIds } from '../lib/site-access.js';
import {
  refuseSiteRestrictedFleetBilling,
  refuseSiteRestrictedFleetInvoice,
} from '../lib/fleet-billing-access.js';

export const invoiceListItem = z
  .object({
    id: z.string().describe('Invoice ID'),
    invoiceNumber: z.string().describe('Human-readable invoice number, e.g. INV-202603-0042'),
    driverId: z.string().nullable().describe('Driver ID this invoice is billed to'),
    fleetId: z
      .string()
      .nullable()
      .describe(
        'On a fleet invoice and its credit note: the billed fleet. Null on driver invoices',
      ),
    periodStart: z
      .string()
      .nullable()
      .describe('On a fleet invoice: first day of the billed month (YYYY-MM-DD)'),
    periodEnd: z
      .string()
      .nullable()
      .describe('On a fleet invoice: last day of the billed month (YYYY-MM-DD)'),
    sentAt: z.coerce
      .date()
      .nullable()
      .describe('On a fleet invoice: when it was last emailed to the fleet billing contacts'),
    overdueNoticeSentAt: z.coerce
      .date()
      .nullable()
      .describe(
        'On a fleet invoice: when the overdue notice (invoice.FleetOverdue) went to the fleet billing contacts, null until then',
      ),
    fleetName: z.string().nullable().describe('Name of the billed fleet, null on driver invoices'),
    status: z
      .enum(invoiceStatusEnum.enumValues)
      .describe(
        'Invoice status (draft, issued, paid, void, credited). credited: a credit note credited the invoice in full',
      ),
    kind: z
      .enum(INVOICE_KINDS)
      .describe('invoice, or credit_note for a credit note that credits an invoice in full'),
    creditedInvoiceId: z
      .string()
      .nullable()
      .describe('On a credit note: the invoice it credits. Null on invoices'),
    issuedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the invoice was issued to the driver'),
    dueAt: z.coerce.date().nullable().describe('Payment due timestamp'),
    currency: z.string().length(3).describe('ISO 4217 currency code'),
    subtotalCents: z
      .number()
      .int()
      .describe('Subtotal amount in cents (pre-tax), negative on a credit note'),
    taxCents: z.number().int().describe('Tax amount in cents, negative on a credit note'),
    totalCents: z
      .number()
      .int()
      .describe('Total amount in cents (subtotal + tax), negative on a credit note'),
    createdAt: z.coerce.date().describe('Timestamp when the invoice was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the invoice was last updated'),
  })
  .passthrough();

const invoiceRecord = z
  .object({
    id: z.string().describe('Invoice ID'),
    invoiceNumber: z.string().describe('Human-readable invoice number'),
    driverId: z.string().nullable().describe('Driver ID this invoice is billed to'),
    fleetId: z
      .string()
      .nullable()
      .describe(
        'On a fleet invoice and its credit note: the billed fleet. Null on driver invoices',
      ),
    periodStart: z
      .string()
      .nullable()
      .describe('On a fleet invoice: first day of the billed month (YYYY-MM-DD)'),
    periodEnd: z
      .string()
      .nullable()
      .describe('On a fleet invoice: last day of the billed month (YYYY-MM-DD)'),
    sentAt: z
      .string()
      .nullable()
      .describe('On a fleet invoice: when it was last emailed to the fleet billing contacts'),
    overdueNoticeSentAt: z
      .string()
      .nullable()
      .describe(
        'On a fleet invoice: when the overdue notice (invoice.FleetOverdue) went to the fleet billing contacts, null until then',
      ),
    billTo: z
      .record(z.unknown())
      .nullable()
      .describe(
        'On a fleet invoice: the bill-to block of the fleet billing profile at issue (name, street, city, state, zip, country, taxId)',
      ),
    language: z
      .string()
      .nullable()
      .describe('On a fleet invoice: the language of its PDF and email at issue'),
    status: z
      .enum(invoiceStatusEnum.enumValues)
      .describe('Invoice status (draft, issued, paid, void, credited)'),
    kind: z
      .enum(INVOICE_KINDS)
      .describe('invoice, or credit_note for a credit note that credits an invoice in full'),
    creditedInvoiceId: z
      .string()
      .nullable()
      .describe('On a credit note: the invoice it credits. Null on invoices'),
    creditReason: z
      .string()
      .nullable()
      .describe('On a credit note: the reason the operator gave. Null on invoices'),
    issuedAt: z.string().nullable().describe('Timestamp when the invoice was issued'),
    dueAt: z.string().nullable().describe('Timestamp when payment is due'),
    paidAt: z
      .string()
      .nullable()
      .describe(
        'When the invoice was paid in full: its issue time when every amount on it was already collected, or the payment date an operator recorded with mark paid. Null while unpaid and on invoices paid before this field existed',
      ),
    paymentReference: z
      .string()
      .nullable()
      .describe(
        'The reference an operator recorded for a payment received outside EVtivity, such as a bank transfer reference',
      ),
    currency: z.string().length(3).describe('ISO 4217 currency code'),
    subtotalCents: z
      .number()
      .int()
      .describe('Subtotal amount in cents (pre-tax), negative on a credit note'),
    taxCents: z.number().int().describe('Tax amount in cents, negative on a credit note'),
    totalCents: z
      .number()
      .int()
      .describe('Total amount in cents (subtotal + tax), negative on a credit note'),
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
    paymentRecordId: z
      .number()
      .int()
      .nullable()
      .describe(
        'Payment record of the reservation cancellation or no-show fee this line invoices, null on session lines',
      ),
    description: z.string().max(500).describe('Line item description'),
    quantity: z.string().describe('Quantity (numeric string)'),
    unitPriceCents: z
      .number()
      .int()
      .describe('Unit price in cents (tax excluded), negative on a credit note'),
    totalCents: z
      .number()
      .int()
      .describe('Line item net amount in cents (tax excluded), negative on a credit note'),
    taxCents: z
      .number()
      .int()
      .describe('Tax amount in cents for this line item, negative on a credit note'),
    taxRate: z
      .string()
      .describe('Tax rate of this line item as a decimal fraction string (0.19 is 19%)'),
    metadata: z
      .record(z.unknown())
      .nullable()
      .describe(
        'Line item metadata. kind (energy, time, sessionFee, idleFee, reservationFee, session, cancellationFee, noShowFee) says what the line bills; segment is the 1-based tariff segment of a split session; sessionDate and energyWh describe session lines; chargeDate is the charge date of a reservation fee line; on fleet invoices driverId, driverName and stationName describe session and idleFee lines, and idleMinutes is the idle time billed on an idleFee line (a session idle fee shown as its own line).',
      ),
    createdAt: z.string().describe('Timestamp when the line item was created'),
  })
  .passthrough();

const invoiceDriver = z
  .object({
    id: z.string().describe('Driver ID'),
    firstName: z.string().describe('Driver first name'),
    lastName: z.string().describe('Driver last name'),
    email: z.string().nullable().describe('Driver email address'),
    language: z.string().describe('Driver preferred language; the invoice PDF renders in it'),
  })
  .passthrough();

const invoiceTaxBreakdownLine = z
  .object({
    taxRate: z.number().min(0).describe('Tax rate as a fraction (0.19 is 19%)'),
    netCents: z.number().int().describe('Net amount taxed at this rate, in cents'),
    taxCents: z.number().int().describe('Tax amount at this rate, in cents'),
    grossCents: z.number().int().describe('Net amount plus tax at this rate, in cents'),
  })
  .passthrough();

const invoiceReference = z
  .object({
    id: z.string().describe('Invoice ID'),
    invoiceNumber: z.string().describe('Invoice or credit note number'),
    issuedAt: z.string().nullable().describe('When it was issued'),
    paidAt: z
      .string()
      .nullable()
      .describe(
        'When the credited invoice was paid; a refund of that money is made outside EVtivity',
      ),
  })
  .passthrough();

export const invoiceDetailItem = z
  .object({
    invoice: invoiceRecord.describe('Invoice header record'),
    lineItems: z.array(invoiceLineItem).describe('Line items associated with the invoice'),
    driver: invoiceDriver
      .nullable()
      .optional()
      .describe(
        'Driver this invoice is billed to (null when unassigned). Present on the detail response; omitted on create responses.',
      ),
    taxBreakdown: z
      .array(invoiceTaxBreakdownLine)
      .optional()
      .describe(
        'Net amount, tax rate, tax amount, and gross per tax rate, ordered by rate. Present on the detail response; omitted on create responses.',
      ),
    fleet: z
      .object({
        id: z.string().describe('Fleet ID'),
        name: z.string().describe('Fleet name'),
      })
      .passthrough()
      .nullable()
      .optional()
      .describe(
        'On a fleet invoice or its credit note: the billed fleet. Null otherwise. Present on the detail response.',
      ),
    creditedInvoice: invoiceReference
      .nullable()
      .optional()
      .describe(
        'On a credit note: the invoice it credits. Null otherwise. Present on the detail response.',
      ),
    creditNote: invoiceReference
      .nullable()
      .optional()
      .describe(
        'On a credited invoice: the credit note that credited it. Null otherwise. Present on the detail response.',
      ),
  })
  .passthrough();
import { authorize } from '../middleware/rbac.js';
import { sendFleetInvoiceEmail } from '@evtivity/services/fleet-invoice-notice';
import {
  createSessionInvoice,
  createAggregatedInvoice,
  getInvoice,
  voidInvoice,
  markInvoicePaid,
} from '@evtivity/services/invoice.service';
import type { InvoiceDetail } from '@evtivity/services/invoice.service';
import { creditInvoice } from '@evtivity/services/credit-note.service';
import { generateInvoicePdf } from '@evtivity/services/invoice-pdf.service';

const invoiceIdParams = z.object({ id: ID_PARAMS.invoiceId.describe('Invoice ID') });
const sessionIdParams = z.object({
  sessionId: ID_PARAMS.sessionId.describe('Charging session ID'),
});

const invoiceListQuery = paginationQuery.extend({
  driverId: ID_PARAMS.driverId.optional().describe('Filter by driver ID'),
  fleetId: ID_PARAMS.fleetId.optional().describe('Filter by fleet ID (fleet invoices)'),
  status: z.enum(invoiceStatusEnum.enumValues).optional().describe('Filter by invoice status'),
  kind: z.enum(INVOICE_KINDS).optional().describe('Filter by kind: invoice or credit_note'),
});

const creditNoteBody = z.object({
  reason: z
    .string()
    .max(500)
    .regex(/\S/)
    .describe(
      'Why the invoice is credited (at most 500 characters, not blank, surrounding spaces removed), printed on the credit note',
    ),
});

const markPaidBody = z.object({
  paidAt: z
    .string()
    .datetime({ offset: true })
    .describe('When the payment was received (ISO 8601). Must not be in the future'),
  reference: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Payment reference, such as a bank transfer reference (at most 200 characters, surrounding spaces removed; empty means none)',
    ),
});

// Clock skew allowed between the client and the API for a payment date of now.
const PAID_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const aggregatedInvoiceBody = z.object({
  driverId: ID_PARAMS.driverId.describe('Driver ID to invoice'),
  startDate: z.string().datetime().describe('Start of billing period (ISO 8601)'),
  endDate: z.string().datetime().describe('End of billing period (ISO 8601)'),
});

/**
 * Sends the invoice.CreditNote notification of a credit note to its driver.
 * Amounts are what the driver is credited (positive). The dispatcher is
 * fail-open (warn and continue). No driver: nothing to send.
 */
async function notifyCreditNote(detail: InvoiceDetail): Promise<void> {
  const { invoice, creditedInvoice } = detail;
  if (invoice.driverId == null) return;
  // A credit note of a fleet invoice goes to the fleet billing contacts (notifyFleetDocument).
  if (invoice.fleetId != null) return;
  const creditedCents = Math.abs(invoice.totalCents);
  await dispatchDriverNotification(
    client,
    'invoice.CreditNote',
    invoice.driverId,
    {
      creditNoteNumber: invoice.invoiceNumber,
      invoiceNumber: creditedInvoice?.invoiceNumber ?? '',
      creditReason: invoice.creditReason ?? '',
      issuedAt: invoice.issuedAt?.toISOString() ?? '',
      // Formatted in the driver's language by the dispatcher.
      total: notificationMoney(creditedCents, invoice.currency),
      totalCents: creditedCents,
      currency: invoice.currency,
      wasPaid: creditedInvoice?.paidAt != null,
    },
    ALL_TEMPLATES_DIRS,
    getPubSub(),
  );
}

/** The columns of an invoice list row, shared with the fleet invoice list. */
export const invoiceListColumns = {
  id: invoices.id,
  invoiceNumber: invoices.invoiceNumber,
  driverId: invoices.driverId,
  fleetId: invoices.fleetId,
  fleetName: fleets.name,
  periodStart: invoices.periodStart,
  periodEnd: invoices.periodEnd,
  sentAt: invoices.sentAt,
  overdueNoticeSentAt: invoices.overdueNoticeSentAt,
  status: invoices.status,
  kind: invoices.kind,
  creditedInvoiceId: invoices.creditedInvoiceId,
  issuedAt: invoices.issuedAt,
  dueAt: invoices.dueAt,
  currency: invoices.currency,
  subtotalCents: invoices.subtotalCents,
  taxCents: invoices.taxCents,
  totalCents: invoices.totalCents,
  createdAt: invoices.createdAt,
  updatedAt: invoices.updatedAt,
};

/**
 * Emails a fleet invoice or the credit note of one to the fleet billing
 * contacts with its PDF. Fail-open (P9): a failure is logged and reported as
 * not sent.
 */
async function notifyFleetDocument(
  invoiceId: string,
  mode: 'once' | 'resend',
  log: FastifyInstance['log'],
): Promise<'sent' | 'no_contacts' | 'failed' | 'skipped'> {
  try {
    const result = await sendFleetInvoiceEmail(invoiceId, mode, {
      templatesDirs: ALL_TEMPLATES_DIRS,
    });
    if (result.status === 'sent') return 'sent';
    if (result.status === 'no_contacts') return 'no_contacts';
    return 'skipped';
  } catch (err) {
    log.warn({ err, invoiceId }, 'Fleet invoice email failed; continuing');
    return 'failed';
  }
}

/** The fleet of an invoice or credit note, null for a driver invoice or an unknown id. */
async function invoiceFleetId(id: string): Promise<string | null> {
  const detail = await getInvoice(id);
  return detail?.invoice.fleetId ?? null;
}

// A fleet invoice spans sites: a site-restricted user gets 404 INVOICE_NOT_FOUND,
// as for a missing invoice, on every per-invoice route (refuseSiteRestrictedFleetInvoice).
const invoiceNotFound = errorWith(
  'Invoice not found, or a fleet invoice for a site-restricted user',
  [ERROR_CODES.INVOICE_NOT_FOUND],
);

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
        description:
          'Invoices and credit notes, newest first. Fleet invoices and their credit notes span sites: with fleetId, a user restricted to some sites gets 404 FLEET_NOT_FOUND; without it, the list leaves them out for that user.',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(invoiceListQuery),
        response: {
          200: paginatedResponse(invoiceListItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { page, limit, driverId, fleetId, status, kind } = request.query as z.infer<
        typeof invoiceListQuery
      >;
      if (fleetId != null && (await refuseSiteRestrictedFleetBilling(request, reply))) return;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (fleetId == null) {
        // A fleet invoice spans sites: a site-restricted user sees driver invoices only.
        const { userId } = request.user as { userId: string };
        if ((await getUserSiteIds(userId)) !== null) conditions.push(isNull(invoices.fleetId));
      }
      if (driverId != null) {
        conditions.push(eq(invoices.driverId, driverId));
      }
      if (fleetId != null) {
        conditions.push(eq(invoices.fleetId, fleetId));
      }
      if (status != null) {
        conditions.push(eq(invoices.status, status));
      }
      if (kind != null) {
        conditions.push(eq(invoices.kind, kind));
      }
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countResult] = await Promise.all([
        db
          .select(invoiceListColumns)
          .from(invoices)
          .leftJoin(fleets, eq(fleets.id, invoices.fleetId))
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
          404: invoiceNotFound,
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
      if (
        await refuseSiteRestrictedFleetInvoice(request, reply, () =>
          Promise.resolve(result.invoice.fleetId),
        )
      ) {
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
          'Builds an invoice from the session and its tariff snapshot, allocating the next gap-free invoice number from the invoice counter. Inserts the invoice header and line items in a transaction. Returns 400 if the session is not eligible (no driver, no final cost, or already invoiced).',
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
          'Aggregates every uninvoiced completed session for the driver between startDate and endDate into a single invoice with one line item per session and tax rate, plus one line per reservation cancellation or no-show fee charged in the window and not yet invoiced. Allocates the next gap-free invoice number from the invoice counter. Returns 400 if no eligible sessions or fees are found in the window.',
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
        summary: 'Void a draft invoice',
        description:
          'Marks a draft invoice void and releases its charging sessions and reservation fee charges, so they can be invoiced again. The invoice audit log records what was released. An issued, paid or credited invoice and a credit note are never voided: 409 INVOICE_NOT_VOIDABLE; correct an issued invoice with a credit note (POST /v1/invoices/{id}/credit-note). Voiding does not issue refunds. Returns 200 with the invoice unchanged when called against an already-voided invoice (idempotent).',
        operationId: 'voidInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
        response: {
          200: itemResponse(invoiceRecord),
          404: invoiceNotFound,
          409: errorWith('Only a draft invoice can be voided', [ERROR_CODES.INVOICE_NOT_VOIDABLE]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof invoiceIdParams>;
      if (await refuseSiteRestrictedFleetInvoice(request, reply, () => invoiceFleetId(id))) return;
      // INVOICE_NOT_VOIDABLE is an AppError (409) the error handler sends.
      const result = await voidInvoice(id);

      if (result == null) {
        await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
        return;
      }

      if (result.before.status !== result.invoice.status) {
        await writeAudit(
          { table: invoiceAuditLog, idColumn: 'invoice_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: 'voided',
            ...getAuditActor(request),
            before: result.before,
            // What the void released, so the billing trail stays traceable.
            after: {
              ...result.invoice,
              releasedSessionIds: result.releasedSessionIds,
              releasedFeeRecordIds: result.releasedFeeRecordIds,
            },
          },
          db,
          request.log,
        );
      }

      return result.invoice;
    },
  );

  // Record a payment received outside EVtivity
  app.patch(
    '/invoices/:id/paid',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Invoices'],
        summary: 'Mark an invoice paid',
        description:
          'Records a payment received outside EVtivity, such as a bank transfer: an issued invoice moves to paid with paidAt and the optional reference. No payment provider is called. Returns 400 VALIDATION_ERROR for a paidAt in the future or before the invoice was issued, 409 INVOICE_ALREADY_PAID for a paid invoice, 409 INVOICE_IS_CREDIT_NOTE for a credit note and 409 INVOICE_NOT_ISSUED for a draft, void or credited one. The change is recorded in the invoice audit log.',
        operationId: 'markInvoicePaid',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
        body: zodSchema(markPaidBody),
        response: {
          200: itemResponse(invoiceRecord),
          400: errorWith('Payment date in the future or before the issue date', [
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: invoiceNotFound,
          409: errorWith('Invoice cannot be marked paid', [
            ERROR_CODES.INVOICE_ALREADY_PAID,
            ERROR_CODES.INVOICE_IS_CREDIT_NOTE,
            ERROR_CODES.INVOICE_NOT_ISSUED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof invoiceIdParams>;
      const body = request.body as z.infer<typeof markPaidBody>;
      const paidAt = new Date(body.paidAt);
      if (await refuseSiteRestrictedFleetInvoice(request, reply, () => invoiceFleetId(id))) return;

      if (paidAt.getTime() > Date.now() + PAID_AT_FUTURE_TOLERANCE_MS) {
        await reply
          .status(400)
          .send({ error: 'paidAt must not be in the future', code: 'VALIDATION_ERROR' });
        return;
      }

      // INVOICE_ALREADY_PAID, INVOICE_IS_CREDIT_NOTE and INVOICE_NOT_ISSUED are AppErrors
      // (409) the error handler sends.
      const trimmed = body.reference?.trim() ?? '';
      const reference = trimmed === '' ? null : trimmed;
      const result = await markInvoicePaid(id, { paidAt, reference });
      if (result == null) {
        await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
        return;
      }

      await writeAudit(
        { table: invoiceAuditLog, idColumn: 'invoice_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'marked_paid',
          ...getAuditActor(request),
          before: result.before,
          after: result.invoice,
          notes: reference,
        },
        db,
        request.log,
      );

      return result.invoice;
    },
  );

  // Credit an invoice in full with a credit note
  app.post(
    '/invoices/:id/credit-note',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Invoices'],
        summary: 'Credit an invoice with a credit note',
        description:
          'Corrects an issued or paid invoice the GoBD way: the invoice is never changed; a credit note (kind credit_note, its own gap-free number CN-YYYYMM-NNNN) credits it in full with every line negated and references it. The invoice moves to credited and its charging sessions are released, so the next invoice bills them again; reservation fee charges stay billed. When the invoice was paid, the refund is made outside EVtivity. The credit is recorded in the invoice audit log (invoice_credited) and the driver gets the invoice.CreditNote notification; the credit note of a fleet invoice is emailed once with its PDF to the fleet billing contacts (invoice.FleetCreditNote) and releases the fleet sessions for the next fleet invoice. Returns 409 INVOICE_ALREADY_CREDITED for a credited invoice, 409 INVOICE_IS_CREDIT_NOTE for a credit note and 409 INVOICE_NOT_ISSUED for a draft or void invoice.',
        operationId: 'createCreditNote',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
        body: zodSchema(creditNoteBody),
        response: {
          201: itemResponse(invoiceDetailItem),
          404: invoiceNotFound,
          409: errorWith('Invoice cannot be credited', [
            ERROR_CODES.INVOICE_ALREADY_CREDITED,
            ERROR_CODES.INVOICE_IS_CREDIT_NOTE,
            ERROR_CODES.INVOICE_NOT_ISSUED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof invoiceIdParams>;
      const reason = (request.body as z.infer<typeof creditNoteBody>).reason.trim();
      if (await refuseSiteRestrictedFleetInvoice(request, reply, () => invoiceFleetId(id))) return;

      // The 409 refusals are AppErrors the error handler sends.
      const result = await creditInvoice(id, reason);
      if (result == null) {
        await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
        return;
      }
      const creditNote = result.creditNote.invoice;

      await writeAudit(
        { table: invoiceAuditLog, idColumn: 'invoice_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'invoice_credited',
          ...getAuditActor(request),
          before: result.before,
          // The credit note and what the credit released, so the billing trail stays traceable.
          after: {
            ...result.original,
            creditNoteId: creditNote.id,
            creditNoteNumber: creditNote.invoiceNumber,
            releasedSessionIds: result.releasedSessionIds,
          },
          notes: reason,
        },
        db,
        request.log,
      );

      const detail = await getInvoice(creditNote.id);
      if (detail != null) {
        if (detail.invoice.fleetId != null) {
          await notifyFleetDocument(creditNote.id, 'once', request.log);
        } else {
          await notifyCreditNote(detail);
        }
      }

      await reply.status(201).send(detail ?? result.creditNote);
    },
  );

  // Email an invoice to its driver
  app.post(
    '/invoices/:id/send',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Invoices'],
        summary: 'Email an invoice to its driver or fleet',
        description:
          'Renders the invoice.Sent driver notification (invoice.CreditNote for a credit note) and dispatches it via the configured channels. A fleet invoice (invoice.FleetInvoice) or its credit note (invoice.FleetCreditNote) goes to the fleet billing contacts with the PDF attached and sets sentAt; 400 FLEET_BILLING_CONTACT_REQUIRED when the fleet has none. Safe to call repeatedly; each call sends again (deliberate resend semantics).',
        operationId: 'sendInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
        response: {
          200: successResponse,
          400: errorWith('Invoice has no driver or the fleet has no billing contact', [
            ERROR_CODES.INVOICE_NO_DRIVER,
            ERROR_CODES.FLEET_BILLING_CONTACT_REQUIRED,
          ]),
          404: invoiceNotFound,
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
      if (
        await refuseSiteRestrictedFleetInvoice(request, reply, () =>
          Promise.resolve(invoice.fleetId),
        )
      ) {
        return;
      }
      if (invoice.fleetId != null) {
        // Resend: errors here are not swallowed, the operator sees them.
        const sent = await sendFleetInvoiceEmail(invoice.id, 'resend', {
          templatesDirs: ALL_TEMPLATES_DIRS,
        });
        if (sent.status === 'no_contacts') {
          await reply.status(400).send({
            error: 'The fleet has no billing contact',
            code: 'FLEET_BILLING_CONTACT_REQUIRED',
          });
          return;
        }
        return { success: true };
      }
      if (invoice.driverId == null) {
        await reply.status(400).send({ error: 'Invoice has no driver', code: 'INVOICE_NO_DRIVER' });
        return;
      }

      if (invoice.kind === 'credit_note') {
        await notifyCreditNote(result);
        return { success: true };
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
          // Formatted in the driver's language by the dispatcher.
          total: notificationMoney(invoice.totalCents, invoice.currency),
          totalCents: invoice.totalCents,
          currency: invoice.currency,
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
          "Renders a portrait A4 PDF of the invoice in the driver's language (a fleet invoice in the language stored on it; English otherwise) with the company logo, billed-to driver (a fleet invoice: the fleet's bill-to block, the period, and the lines grouped by driver with a subtotal each), line items with their tax rate, the net amount, tax rate, and tax amount per rate, and the totals. A credit note is titled as one and names the invoice it credits and the reason; a credited invoice names its credit note. Streams application/pdf as an attachment.",
        operationId: 'downloadInvoicePdf',
        security: [{ bearerAuth: [] }],
        params: zodSchema(invoiceIdParams),
        response: { 404: invoiceNotFound },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof invoiceIdParams>;
      const result = await getInvoice(id);

      if (result == null) {
        await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
        return;
      }
      if (
        await refuseSiteRestrictedFleetInvoice(request, reply, () =>
          Promise.resolve(result.invoice.fleetId),
        )
      ) {
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
        response: { 404: invoiceNotFound },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof invoiceIdParams>;
      const result = await getInvoice(id);

      if (result == null) {
        await reply.status(404).send({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
        return;
      }
      if (
        await refuseSiteRestrictedFleetInvoice(request, reply, () =>
          Promise.resolve(result.invoice.fleetId),
        )
      ) {
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
