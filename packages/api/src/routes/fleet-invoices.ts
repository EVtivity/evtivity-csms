// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { count, desc, eq } from 'drizzle-orm';
import {
  db,
  fleets,
  invoices,
  invoiceAuditLog,
  writeAudit,
  getSystemTimezone,
} from '@evtivity/database';
import {
  createFleetInvoice,
  previewFleetInvoice,
  previousPeriod,
  FLEET_INVOICE_PERIOD_PATTERN,
} from '@evtivity/services/fleet-invoice.service';
import { sendFleetInvoiceEmail } from '@evtivity/services/fleet-invoice-notice';
import { getInvoice } from '@evtivity/services/invoice.service';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { errorWith, itemResponse, paginatedResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { refuseSiteRestrictedFleetBilling } from '../lib/fleet-billing-access.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { invoiceDetailItem, invoiceListItem, invoiceListColumns } from './invoices.js';

const fleetParams = z.object({ id: ID_PARAMS.fleetId.describe('Fleet ID') });

const periodField = z
  .string()
  .regex(FLEET_INVOICE_PERIOD_PATTERN)
  .describe('Calendar month to bill (YYYY-MM) in the system timezone');

const unbilledQuery = z.object({
  period: periodField
    .optional()
    .describe(
      'Calendar month (YYYY-MM) in the system timezone; default the month before the current one',
    ),
});

const createBody = z.object({ period: periodField });

const fleetInvoiceListQuery = paginationQuery;

const driverTotal = z
  .object({
    driverId: z.string().nullable().describe('Driver ID; null when the driver was deleted'),
    driverName: z.string().describe('Driver name'),
    sessionCount: z.number().int().describe('Sessions billed for the driver'),
    energyWh: z.number().describe('Energy delivered in Wh'),
    netCents: z.number().int().describe('Net amount in cents'),
    taxCents: z.number().int().describe('Tax in cents'),
    totalCents: z.number().int().describe('Gross amount in cents (the subtotal of the driver)'),
  })
  .passthrough();

const excludedSession = z
  .object({
    sessionId: z.string().describe('Charging session ID'),
    driverId: z.string().nullable().describe('Driver ID'),
    driverName: z.string().describe('Driver name'),
    endedAt: z.coerce.date().nullable().describe('When the session ended'),
    reason: z
      .enum(['other_currency', 'zero_cost', 'uncosted'])
      .describe(
        'Why the fleet invoice leaves the session off: other_currency (not billed in the company currency), zero_cost (nothing to bill), uncosted (no final cost)',
      ),
    currency: z.string().describe('Currency of the session'),
    finalCostCents: z.number().int().nullable().describe('Final cost in cents'),
  })
  .passthrough();

const periodInvoice = z
  .object({
    id: z.string().describe('Invoice ID'),
    invoiceNumber: z.string().describe('Invoice number'),
    status: z.string().describe('Invoice status (issued or paid)'),
  })
  .passthrough();

const unbilledResponse = z
  .object({
    fleetId: z.string().describe('Fleet ID'),
    period: z.string().describe('Calendar month (YYYY-MM)'),
    periodStart: z.string().describe('First day of the period (YYYY-MM-DD)'),
    periodEnd: z.string().describe('Last day of the period (YYYY-MM-DD)'),
    currency: z.string().describe('Company currency the invoice bills in'),
    sessionCount: z.number().int().describe('Sessions the invoice would bill'),
    energyWh: z.number().describe('Energy of those sessions in Wh'),
    netCents: z.number().int().describe('Net amount in cents'),
    taxCents: z.number().int().describe('Tax in cents'),
    totalCents: z.number().int().describe('Gross amount in cents'),
    drivers: z.array(driverTotal).describe('Totals per driver, ordered by name'),
    excluded: z
      .array(excludedSession)
      .describe('Unbilled account sessions the invoice leaves off (at most 100)'),
    excludedCount: z.number().int().describe('Number of sessions left off'),
    existingInvoice: periodInvoice
      .nullable()
      .describe(
        'The live invoice of the fleet for the period; generating again is refused while it exists',
      ),
  })
  .passthrough();

const createResponse = invoiceDetailItem
  .extend({
    drivers: z.array(driverTotal).describe('Totals per driver, ordered by name'),
    excluded: z
      .array(excludedSession)
      .describe('Unbilled account sessions the invoice left off (at most 100)'),
    excludedCount: z.number().int().describe('Number of sessions left off'),
    emailed: z
      .boolean()
      .describe(
        'The invoice was emailed to the fleet billing contacts (false when the fleet has none or the email failed)',
      ),
  })
  .passthrough();

export function fleetInvoiceRoutes(app: FastifyInstance): void {
  app.get(
    '/fleets/:id/billing/unbilled',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Preview the fleet invoice of a period',
        description:
          'What the fleet invoice of a calendar month (system timezone) would bill: the fleet sessions billed on account (no payment record) that no invoice billed yet and that ended before the end of the month, with a cost in the company currency, per driver. Sessions in another currency, without a final cost or with a zero cost are listed in excluded and left off. existingInvoice names the live invoice of the period. Reads only. A fleet invoice spans sites: a user restricted to some sites gets 404 FLEET_NOT_FOUND.',
        operationId: 'previewFleetInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(unbilledQuery),
        response: {
          200: itemResponse(unbilledResponse),
          400: errorWith('Invalid period', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (await refuseSiteRestrictedFleetBilling(request, reply)) return;
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { period } = request.query as z.infer<typeof unbilledQuery>;
      const month = period ?? previousPeriod(new Date(), await getSystemTimezone());
      // FLEET_NOT_FOUND and VALIDATION_ERROR are AppErrors the error handler sends.
      return previewFleetInvoice(id, month);
    },
  );

  app.post(
    '/fleets/:id/invoices',
    {
      onRequest: [authorize('payments:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Generate the fleet invoice of a period',
        description:
          "Issues the fleet invoice of a calendar month (system timezone): every fleet session billed on account that no invoice billed yet and that ended before the end of the month, with a cost in the company currency, itemized by driver with each session's tax. Sessions that end later roll into the next invoice. The invoice is issued directly (no draft), numbered INV-YYYYMM-NNNN, due after the fleet's payment terms (else the invoice.paymentTermsDays setting), with the bill-to block and language of the fleet billing profile, and claims its sessions in the same transaction. One live invoice per fleet and period: 409 FLEET_INVOICE_PERIOD_EXISTS (credit it to bill the period again); 409 FLEET_INVOICE_NOTHING_TO_BILL when no session qualifies. The invoice is emailed once with its PDF to the fleet billing contacts (invoice.FleetInvoice) and audited (invoice_generated). A fleet invoice spans sites: a user restricted to some sites gets 404 FLEET_NOT_FOUND.",
        operationId: 'createFleetInvoice',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(createBody),
        response: {
          201: itemResponse(createResponse),
          400: errorWith('Invalid period or a session was billed meanwhile', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.INVOICE_CREATION_FAILED,
          ]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
          409: errorWith('Period already invoiced or nothing to bill', [
            ERROR_CODES.FLEET_INVOICE_PERIOD_EXISTS,
            ERROR_CODES.FLEET_INVOICE_NOTHING_TO_BILL,
          ]),
        },
      },
    },
    async (request, reply) => {
      if (await refuseSiteRestrictedFleetBilling(request, reply)) return;
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { period } = request.body as z.infer<typeof createBody>;

      // The refusals are AppErrors the error handler sends.
      const result = await createFleetInvoice(id, period);
      const { invoice } = result;
      const sessionIds = [
        ...new Set(result.lineItems.map((item) => item.sessionId).filter((s) => s != null)),
      ];

      await writeAudit(
        { table: invoiceAuditLog, idColumn: 'invoice_id' },
        {
          entityId: invoice.id,
          entityIdSnapshot: invoice.id,
          action: 'invoice_generated',
          ...getAuditActor(request),
          before: null,
          // What the invoice billed and left off, so the billing trail stays traceable.
          after: { ...invoice, sessionIds, excludedCount: result.excludedCount },
          notes: period,
        },
        db,
        request.log,
      );

      // Fail-open (P9): the invoice is issued; a failed email can be resent.
      let emailed = false;
      try {
        const sent = await sendFleetInvoiceEmail(invoice.id, 'once', {
          templatesDirs: ALL_TEMPLATES_DIRS,
        });
        emailed = sent.status === 'sent';
        if (sent.status === 'no_contacts') {
          request.log.warn({ fleetId: id, invoiceId: invoice.id }, 'Fleet has no billing contact');
        }
      } catch (err) {
        request.log.warn({ err, invoiceId: invoice.id }, 'Fleet invoice email failed; continuing');
      }

      const detail = await getInvoice(invoice.id);
      await reply.status(201).send({
        ...(detail ?? { invoice, lineItems: result.lineItems }),
        drivers: result.drivers,
        excluded: result.excluded,
        excludedCount: result.excludedCount,
        emailed,
      });
    },
  );

  app.get(
    '/fleets/:id/invoices',
    {
      onRequest: [authorize('payments:read')],
      schema: {
        tags: ['Fleets'],
        summary: "List a fleet's invoices and credit notes",
        description:
          'The fleet invoices of the fleet and the credit notes that credit them, newest first, with the billed period and when each was last emailed (sentAt). A fleet invoice spans sites: a user restricted to some sites gets 404 FLEET_NOT_FOUND.',
        operationId: 'listFleetInvoices',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(fleetInvoiceListQuery),
        response: {
          200: paginatedResponse(invoiceListItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (await refuseSiteRestrictedFleetBilling(request, reply)) return;
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { page, limit } = request.query as z.infer<typeof fleetInvoiceListQuery>;
      const where = eq(invoices.fleetId, id);
      const [data, countResult] = await Promise.all([
        db
          .select(invoiceListColumns)
          .from(invoices)
          .leftJoin(fleets, eq(fleets.id, invoices.fleetId))
          .where(where)
          .orderBy(desc(invoices.createdAt), desc(invoices.id))
          .limit(limit)
          .offset((page - 1) * limit),
        db.select({ count: count() }).from(invoices).where(where),
      ]);
      return {
        data,
        total: countResult[0]?.count ?? 0,
      } satisfies PaginatedResponse<(typeof data)[number]>;
    },
  );
}
