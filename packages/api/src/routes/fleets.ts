// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as fleetService from '../services/fleet.service.js';
import {
  db,
  writeAudit,
  fleetAuditLog,
  pricingAssignmentAuditLog,
  drivers,
  chargingStations,
  pgErrorCode,
  PG_FOREIGN_KEY_VIOLATION,
} from '@evtivity/database';
import { eq } from 'drizzle-orm';
import { AppError } from '@evtivity/lib';
import { getAuditActor } from '../lib/audit-actor.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';
import { publishPricingChanged } from '../lib/pricing-events.js';
import { pricingGroupExists } from '../lib/pricing-group-lookup.js';
import {
  paginatedResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { INVOICE_LANGUAGES } from '@evtivity/services/invoice-labels';

const MAX_BILLING_CONTACTS = 10;

// The fleet billing profile, as stored on the fleet (features/fleet-billing.md).
const billingProfileFields = {
  billingContactEmails: z
    .array(z.string().email().max(255))
    .describe('Billing contacts: the fleet invoice is emailed to these addresses'),
  billingLegalName: z
    .string()
    .max(255)
    .nullable()
    .describe('Legal name on the invoice bill-to block; null uses the fleet name'),
  billingStreet: z.string().max(255).nullable().describe('Bill-to street address'),
  billingCity: z.string().max(100).nullable().describe('Bill-to city'),
  billingState: z.string().max(100).nullable().describe('Bill-to state or region'),
  billingZip: z.string().max(20).nullable().describe('Bill-to postal code'),
  billingCountry: z.string().max(100).nullable().describe('Bill-to country'),
  billingTaxId: z.string().max(50).nullable().describe('VAT ID or tax ID printed on the invoice'),
  invoiceLanguage: z
    .enum(INVOICE_LANGUAGES)
    .describe('Language of the fleet invoice and its email'),
  paymentTermsDays: z
    .number()
    .int()
    .min(0)
    .max(365)
    .nullable()
    .describe('Days from issue to the due date; null uses the invoice.paymentTermsDays setting'),
  autoInvoice: z
    .boolean()
    .describe('The monthly run invoices the fleet and emails the invoice to the billing contacts'),
};
const fleetListItem = z
  .object({
    id: z.string().describe('Fleet identifier'),
    name: z.string().max(255).describe('Fleet display name'),
    description: z.string().max(1000).nullable().describe('Fleet description'),
    accountBillingEnabled: z
      .boolean()
      .describe(
        "Charge on account: the members' sessions are billed to the fleet on its invoice (no card, no hold). Members who opted out pay by card.",
      ),
    createdAt: z.coerce.date().describe('Timestamp when the fleet was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the fleet was last updated'),
    driverCount: z.number().int().min(0).describe('Number of drivers in this fleet'),
    stationCount: z.number().int().min(0).describe('Number of stations assigned to this fleet'),
  })
  .passthrough();

const fleetItem = z
  .object({
    id: z.string().describe('Fleet identifier'),
    name: z.string().max(255).describe('Fleet display name'),
    description: z.string().max(1000).nullable().describe('Fleet description'),
    accountBillingEnabled: z
      .boolean()
      .describe(
        "Charge on account: the members' sessions are billed to the fleet on its invoice (no card, no hold). Members who opted out pay by card.",
      ),
    ...billingProfileFields,
    creditLimitCents: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        'Credit limit of the account billing in cents of the company currency; null: no limit. An account start is refused while the exposure is at or above it.',
      ),
    creditLimitWarningPercent: z
      .number()
      .int()
      .optional()
      .describe('Percent of the credit limit at which the fleet is warned (1 to 99)'),
    createdAt: z.coerce.date().describe('Timestamp when the fleet was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the fleet was last updated'),
  })
  .passthrough();

const fleetDriverItem = z
  .object({
    id: z.string().describe('Driver identifier'),
    firstName: z.string().max(100).nullable().describe('Driver first name'),
    lastName: z.string().max(100).nullable().describe('Driver last name'),
    email: z.string().email().max(255).nullable().describe('Driver email address'),
    phone: z.string().max(50).nullable().describe('Driver phone number in E.164 format'),
    isActive: z.boolean().describe('Whether the driver account is enabled'),
    accountBillingOptOut: z
      .boolean()
      .describe(
        'The member pays by card although the fleet bills on account (opt-out of charge on account)',
      ),
    createdAt: z.coerce.date().describe('Timestamp when the driver was created'),
  })
  .passthrough();

const fleetDriverRecordItem = z
  .object({
    fleetId: z.string().describe('Fleet identifier'),
    driverId: z.string().describe('Driver identifier'),
    accountBillingOptOut: z
      .boolean()
      .optional()
      .describe(
        'The member pays by card although the fleet bills on account (opt-out of charge on account)',
      ),
  })
  .passthrough();

const fleetStationItem = z
  .object({
    id: z.string().describe('Station identifier'),
    stationId: z.string().max(255).describe('Station OCPP id (display label)'),
    siteId: z.string().nullable().describe('Site identifier the station belongs to'),
    model: z.string().max(100).nullable().describe('Station hardware model'),
    securityProfile: z
      .number()
      .int()
      .min(0)
      .max(3)
      .nullable()
      .describe('OCPP security profile (0=none, 1=basic, 2=basic+TLS, 3=mTLS)'),
    ocppProtocol: z
      .enum(['ocpp1.6', 'ocpp2.1'])
      .nullable()
      .describe('OCPP protocol version negotiated with the station'),
    status: z
      .string()
      .max(50)
      .describe(
        'Station status: a disable, firmware, or station-reported state first, else the connector summary (charging, reserved, faulted, available, unavailable, unknown)',
      ),
    statusReason: z
      .string()
      .nullable()
      .describe(
        'Why the station is not available (operator_disabled, security_disabled, firmware_failed, station_faulted, connector_faulted, firmware_installing, station_unavailable), null when it is',
      ),
    connectorCount: z.number().int().min(0).describe('Total number of connectors on the station'),
    connectorTypes: z
      .array(z.string().max(50))
      .max(20)
      .nullable()
      .describe('Unique connector types present on the station (e.g. CCS2, Type2)'),
    isOnline: z.boolean().describe('Whether the station currently has an active OCPP connection'),
    lastHeartbeat: z.coerce
      .date()
      .nullable()
      .describe('Timestamp of the most recent OCPP heartbeat'),
    createdAt: z.coerce.date().describe('Timestamp when the station was registered'),
  })
  .passthrough();

const fleetStationRecordItem = z
  .object({
    fleetId: z.string().describe('Fleet identifier'),
    stationId: z.string().describe('Station identifier'),
  })
  .passthrough();

const fleetVehicleItem = z
  .object({
    id: z.string().describe('Vehicle identifier'),
    driverId: z.string().describe('Owning driver identifier'),
    driverName: z.string().max(255).describe('Owning driver full name'),
    make: z.string().max(100).nullable().describe('Vehicle make (e.g. Tesla, BMW)'),
    model: z.string().max(100).nullable().describe('Vehicle model (e.g. Model 3, i4)'),
    year: z
      .string()
      .regex(/^\d{4}$/)
      .nullable()
      .describe('Model year (4-digit)'),
    vin: z.string().max(17).nullable().describe('Vehicle identification number (17 chars)'),
    licensePlate: z.string().max(20).nullable().describe('Vehicle license plate'),
  })
  .passthrough();

const fleetSessionItem = z
  .object({
    id: z.string().describe('Charging session identifier'),
    stationId: z.string().describe('Station identifier where the session occurred'),
    stationName: z.string().max(255).nullable().describe('Station OCPP id (display label)'),
    siteName: z.string().max(255).nullable().describe('Site name where the station is located'),
    transactionId: z.string().nullable().describe('OCPP transaction identifier'),
    status: z
      .string()
      .max(50)
      .describe('Session status (active, completed, failed, faulted, etc.)'),
    startedAt: z.coerce.date().nullable().describe('Timestamp when the session started'),
    endedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the session ended, null if active'),
    idleStartedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the connector went idle during the session'),
    energyDeliveredWh: z.number().min(0).describe('Total energy delivered in watt-hours'),
    currentCostCents: z
      .number()
      .int()
      .min(0)
      .describe('Running cost in cents during active session'),
    finalCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Final billed cost in cents after session completes'),
    currency: z.string().length(3).describe('ISO 4217 currency the session is billed in'),
  })
  .passthrough();

const fleetMetricsItem = z
  .object({
    totalSessions: z
      .number()
      .int()
      .min(0)
      .describe('Total number of charging sessions in the reporting period'),
    completedSessions: z
      .number()
      .int()
      .min(0)
      .describe('Number of sessions that completed successfully'),
    faultedSessions: z
      .number()
      .int()
      .min(0)
      .describe('Number of sessions that ended in a fault state'),
    sessionSuccessPercent: z
      .number()
      .min(0)
      .max(100)
      .describe('Percentage of sessions that completed successfully (0-100)'),
    totalEnergyWh: z.number().min(0).describe('Total energy delivered in watt-hours'),
    avgSessionDurationMinutes: z.number().min(0).describe('Average session duration in minutes'),
    activeDrivers: z
      .number()
      .int()
      .min(0)
      .describe('Number of drivers with at least one session in the period'),
    totalDrivers: z.number().int().min(0).describe('Total number of drivers in this fleet'),
    totalVehicles: z.number().describe('Total number of vehicles owned by fleet drivers'),
    periodMonths: z.number().describe('Number of months included in the metrics window'),
  })
  .passthrough();

const energyHistoryItem = z
  .object({
    date: z.string().describe('Day in ISO date format (YYYY-MM-DD)'),
    energyWh: z.number().describe('Total energy delivered on this day in watt-hours'),
  })
  .passthrough();

const fleetPricingGroupItem = z
  .object({
    id: z.string().describe('Pricing group identifier'),
    name: z.string().describe('Pricing group display name'),
    description: z.string().nullable().describe('Pricing group description'),
    isDefault: z.boolean().describe('Whether this is the system default pricing group'),
    tariffCount: z.number().describe('Number of tariffs in this pricing group'),
  })
  .passthrough();

const fleetPricingGroupRecordItem = z
  .object({
    fleetId: z.string().describe('Fleet identifier'),
    pricingGroupId: z.string().describe('Pricing group identifier'),
  })
  .passthrough();

const fleetParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
});

const createFleetBody = z.object({
  name: z.string().max(255),
  description: z.string().max(500).optional(),
});

const updateFleetBody = z.object({
  name: z.string().max(255).optional(),
  description: z.string().max(500).optional(),
});

const fleetBillingBody = z.object({
  accountBillingEnabled: z
    .boolean()
    .describe(
      "Charge on account: bill the members' sessions to the fleet (no card, no hold). Off: members pay by card.",
    ),
});

const optionalText = (max: number, what: string) =>
  z.string().max(max).nullable().optional().describe(`${what}; null or blank clears it`);

const fleetBillingProfileBody = z.object({
  billingContactEmails: z
    .array(z.string().trim().email().max(255))
    .max(MAX_BILLING_CONTACTS)
    .optional()
    .describe(
      `Billing contacts (up to ${String(MAX_BILLING_CONTACTS)} emails), replacing the stored list`,
    ),
  billingLegalName: optionalText(255, 'Legal name on the invoice'),
  billingStreet: optionalText(255, 'Bill-to street address'),
  billingCity: optionalText(100, 'Bill-to city'),
  billingState: optionalText(100, 'Bill-to state or region'),
  billingZip: optionalText(20, 'Bill-to postal code'),
  billingCountry: optionalText(100, 'Bill-to country'),
  billingTaxId: optionalText(50, 'VAT ID or tax ID'),
  invoiceLanguage: z
    .enum(INVOICE_LANGUAGES)
    .optional()
    .describe('Language of the fleet invoice and its email'),
  paymentTermsDays: z
    .number()
    .int()
    .min(0)
    .max(365)
    .nullable()
    .optional()
    .describe('Days from issue to the due date; null uses the invoice.paymentTermsDays setting'),
  autoInvoice: z
    .boolean()
    .optional()
    .describe('The monthly run invoices the fleet (needs at least one billing contact)'),
});

const fleetCreditLimitBody = z.object({
  creditLimitCents: z
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .nullable()
    .optional()
    .describe(
      'Credit limit in cents of the company currency; null removes the limit. Left out: unchanged.',
    ),
  warningPercent: z
    .number()
    .int()
    .min(1)
    .max(99)
    .optional()
    .describe('Percent of the limit at which the fleet is warned (1 to 99). Left out: unchanged.'),
});

const fleetCreditExposure = z
  .object({
    unbilledCents: z.number().int().describe('Ended account sessions on no invoice yet'),
    invoicedCents: z.number().int().describe('Account sessions on an issued, unpaid invoice'),
    runningCents: z.number().int().describe('Running cost of active account sessions'),
    totalCents: z.number().int().describe('Sum of the three: the exposure checked at a start'),
    currency: z.string().length(3).describe('Company currency of the amounts'),
  })
  .passthrough();

const fleetCreditLimitResponse = z
  .object({
    creditLimitCents: z
      .number()
      .int()
      .nullable()
      .describe('Credit limit in cents of the company currency; null: no limit'),
    warningPercent: z.number().int().describe('Percent of the limit at which the fleet is warned'),
    exposure: fleetCreditExposure.describe(
      'What the fleet owes or will owe on account: sessions billed on account (no payment record) in the company currency',
    ),
    level: z
      .enum(['ok', 'warning', 'reached'])
      .nullable()
      .describe(
        'reached: account starts are refused; warning: at or above the warning percent; null: no limit',
      ),
  })
  .passthrough();

const memberBillingBody = z.object({
  accountBillingOptOut: z
    .boolean()
    .describe('True: the member pays by card although the fleet bills on account'),
});

const addDriverBody = z.object({
  driverId: ID_PARAMS.driverId.describe('Driver ID to add to the fleet'),
});

const driverParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
  driverId: ID_PARAMS.driverId.describe('Driver ID'),
});

const addStationBody = z.object({
  stationId: ID_PARAMS.stationId.describe('Station ID to add to the fleet'),
});

const stationParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
  stationId: ID_PARAMS.stationId.describe('Station ID'),
});

const addPricingGroupBody = z.object({
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID to add to the fleet'),
});

const pricingGroupParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID'),
});

const sessionsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('Page number'),
  limit: z.coerce.number().int().min(1).max(100).default(10).describe('Items per page'),
});

const metricsQuery = z.object({
  months: z.coerce
    .number()
    .int()
    .min(1)
    .max(24)
    .default(12)
    .describe('Number of months to include in metrics'),
});

const energyHistoryQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(90)
    .default(7)
    .describe('Number of days of energy history'),
});

export function fleetRoutes(app: FastifyInstance): void {
  app.get(
    '/fleets',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List fleets',
        operationId: 'listFleets',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(fleetListItem) },
      },
    },
    async (request) => {
      const params = request.query as z.infer<typeof paginationQuery>;
      return fleetService.listFleets(params);
    },
  );

  app.get(
    '/fleets/:id',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Get a fleet by ID',
        operationId: 'getFleet',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: {
          200: itemResponse(fleetItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const fleet = await fleetService.getFleet(id);
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      return fleet;
    },
  );

  app.post(
    '/fleets',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Create a fleet',
        operationId: 'createFleet',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createFleetBody),
        response: { 201: itemResponse(fleetItem) },
      },
    },
    async (request, reply) => {
      const { name, description } = request.body as z.infer<typeof createFleetBody>;
      const fleet = await fleetService.createFleet({
        name,
        ...(description != null ? { description } : {}),
      });
      if (fleet != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: fleetAuditLog, idColumn: 'fleet_id' },
          {
            entityId: fleet.id,
            entityIdSnapshot: fleet.id,
            action: 'created',
            ...actor,
            after: fleet,
          },
          db,
          request.log,
        );
      }
      await reply.status(201).send(fleet);
    },
  );

  app.patch(
    '/fleets/:id',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Update a fleet',
        operationId: 'updateFleet',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(updateFleetBody),
        response: {
          200: itemResponse(fleetItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { name, description } = request.body as z.infer<typeof updateFleetBody>;
      const before = await fleetService.getFleet(id);
      const fleet = await fleetService.updateFleet(id, {
        ...(name != null ? { name } : {}),
        ...(description != null ? { description } : {}),
      });
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: fleet.id,
          entityIdSnapshot: fleet.id,
          action: 'updated',
          ...actor,
          before: before ?? null,
          after: fleet,
        },
        db,
        request.log,
      );
      return fleet;
    },
  );

  app.delete(
    '/fleets/:id',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Delete a fleet',
        operationId: 'deleteFleet',
        description:
          'Deletes the fleet and its memberships. Refused with 409 FLEET_HAS_OPEN_BILLING while sessions are billed to the fleet account (unbilled, invoiced or paid): turn off account billing instead.',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: {
          200: itemResponse(fleetItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
          409: errorWith('Fleet has account billing', [ERROR_CODES.FLEET_HAS_OPEN_BILLING]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      let fleet;
      try {
        fleet = await fleetService.deleteFleet(id);
      } catch (err) {
        if (err instanceof AppError && err.code === 'FLEET_HAS_OPEN_BILLING') {
          await reply.status(409).send({ error: err.message, code: 'FLEET_HAS_OPEN_BILLING' });
          return;
        }
        throw err;
      }
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: null,
          entityIdSnapshot: fleet.id,
          action: 'deleted',
          ...actor,
          before: fleet,
        },
        db,
        request.log,
      );
      return fleet;
    },
  );

  // --- Billing ---

  app.patch(
    '/fleets/:id/billing',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Turn charge on account on or off for a fleet',
        description:
          "On: the members' new sessions are billed to the fleet on its invoice, with no card and no hold (members who opted out pay by card). Off: new sessions are paid by card; running sessions keep how they started and unbilled sessions are still billed to the fleet. Turning it on answers 409 FLEET_BILLING_OLD_PODS_CONNECTED (details: oldConnections, hosts, lastOldSeenAt, watchCheckedAt) while processes before v0.1.41 may run. A change is audited (billing_updated) and the worker sends fleet.AccountBillingChanged to each member whose billing it moved (a background job); a request that changes nothing does neither.",
        operationId: 'updateFleetBilling',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(fleetBillingBody),
        response: {
          200: itemResponse(fleetItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
          409: errorWith('Processes of an older release are connected', [
            ERROR_CODES.FLEET_BILLING_OLD_PODS_CONNECTED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { accountBillingEnabled } = request.body as z.infer<typeof fleetBillingBody>;
      let fleet;
      try {
        fleet = await fleetService.setFleetAccountBilling(id, accountBillingEnabled, {
          actor: getAuditActor(request),
          log: request.log,
        });
      } catch (err) {
        if (err instanceof fleetService.FleetBillingUpgradePendingError) {
          await reply.status(409).send({
            error: err.message,
            code: 'FLEET_BILLING_OLD_PODS_CONNECTED',
            details: err.details,
          });
          return;
        }
        throw err;
      }
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      return fleet;
    },
  );

  app.patch(
    '/fleets/:id/billing-profile',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Update the fleet billing profile',
        description:
          'Sets who the fleet invoice goes to and how: billing contacts, the bill-to block (legal name, address, VAT or tax ID), the invoice language, the payment terms (overrides the invoice.paymentTermsDays setting) and automatic monthly invoicing. Fields left out keep their value; null or a blank string clears a text field. Turning on automatic invoicing, or removing the last contact while it is on, answers 400 FLEET_BILLING_CONTACT_REQUIRED. A change is audited (billing_updated with the changed fields); a request that changes nothing is not.',
        operationId: 'updateFleetBillingProfile',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(fleetBillingProfileBody),
        response: {
          200: itemResponse(fleetItem),
          400: errorWith('Automatic invoicing needs a billing contact', [
            ERROR_CODES.FLEET_BILLING_CONTACT_REQUIRED,
          ]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof fleetBillingProfileBody>;
      let fleet;
      try {
        fleet = await fleetService.updateFleetBillingProfile(id, body, {
          actor: getAuditActor(request),
          log: request.log,
        });
      } catch (err) {
        if (err instanceof AppError && err.code === 'FLEET_BILLING_CONTACT_REQUIRED') {
          await reply
            .status(400)
            .send({ error: err.message, code: 'FLEET_BILLING_CONTACT_REQUIRED' });
          return;
        }
        throw err;
      }
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      return fleet;
    },
  );

  // --- Credit limit ---

  app.get(
    '/fleets/:id/credit-limit',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: "Get a fleet's credit limit and exposure",
        description:
          'The credit limit of the account billing and the exposure it is checked against: ended account sessions on no invoice, account sessions on an issued unpaid invoice, and the running cost of active account sessions, in the company currency. Sessions with a payment record are paid by card and do not count.',
        operationId: 'getFleetCreditLimit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: {
          200: itemResponse(fleetCreditLimitResponse),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const view = await fleetService.getFleetCreditLimit(id);
      if (view == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      return view;
    },
  );

  app.patch(
    '/fleets/:id/credit-limit',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: "Set a fleet's credit limit",
        description:
          "Sets the credit limit of the fleet's account billing (null removes it) and the warning percent. A driver start billed to the fleet is refused while the exposure is at or above the limit: the portal answers 402 FLEET_CREDIT_LIMIT_REACHED, and the payment gate stops an RFID start (stopped reason AccountCreditLimit). The fleet is warned once per month at the warning percent (fleet.CreditLimitWarning) and once per month at the limit (fleet.CreditLimitReached). Checked at the start only. A change is audited (billing_updated).",
        operationId: 'updateFleetCreditLimit',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(fleetCreditLimitBody),
        response: {
          200: itemResponse(fleetCreditLimitResponse),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof fleetCreditLimitBody>;
      const view = await fleetService.setFleetCreditLimit(
        id,
        { creditLimitCents: body.creditLimitCents, warningPercent: body.warningPercent },
        { actor: getAuditActor(request), log: request.log },
      );
      if (view == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      return view;
    },
  );

  // --- Drivers ---

  app.get(
    '/fleets/:id/drivers',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List drivers in a fleet',
        operationId: 'listFleetDrivers',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(sessionsQuery),
        response: { 200: paginatedResponse(fleetDriverItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { page, limit } = request.query as z.infer<typeof sessionsQuery>;
      return fleetService.getFleetDrivers(id, page, limit);
    },
  );

  app.post(
    '/fleets/:id/drivers',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Add a driver to a fleet',
        operationId: 'addFleetDriver',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(addDriverBody),
        response: {
          201: itemResponse(fleetDriverRecordItem),
          404: errorWith('Fleet or driver not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.DRIVER_NOT_FOUND,
          ]),
          409: errorWith('Driver already in fleet', [ERROR_CODES.DRIVER_ALREADY_IN_FLEET]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof addDriverBody>;
      // Pre-check fleet existence so an FK race on the INSERT below can
      // be safely attributed to the driver (the only remaining unknown FK).
      const fleet = await fleetService.getFleet(id);
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      // Pre-check driver existence — without this, an invalid driverId
      // hits the FK constraint and 500s (ON CONFLICT DO NOTHING in the
      // service only catches the uniqueness conflict, not FK violations).
      const [driver] = await db
        .select({ id: drivers.id })
        .from(drivers)
        .where(eq(drivers.id, body.driverId));
      if (driver == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      let record;
      try {
        record = await fleetService.addDriverToFleet(id, body.driverId);
      } catch (err) {
        // Pre-check is non-transactional, so the driver can be deleted
        // between the check and this INSERT. Map the FK violation back
        // to the same 404 the pre-check would have produced.
        if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
          await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
          return;
        }
        throw err;
      }
      // Service returns null when the unique (fleet_id, driver_id)
      // constraint trips, i.e. the driver is already in this fleet.
      if (record == null) {
        await reply
          .status(409)
          .send({ error: 'Driver is already in this fleet', code: 'DRIVER_ALREADY_IN_FLEET' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'member_added',
          ...actor,
          after: { driverId: body.driverId },
        },
        db,
        request.log,
      );
      await fleetService.notifyMemberJoined(id, body.driverId, request.log);
      await reply.status(201).send(record);
    },
  );

  app.patch(
    '/fleets/:id/drivers/:driverId',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: "Set a member's opt-out of charge on account",
        description:
          'An opted-out member pays by card although the fleet bills on account. A change is audited (member_billing_opt_out_changed) and the driver gets fleet.AccountBillingChanged when it moved their billing; a request that changes nothing does neither. Running sessions keep how they started.',
        operationId: 'updateFleetDriverBilling',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        body: zodSchema(memberBillingBody),
        response: {
          200: itemResponse(fleetDriverRecordItem),
          404: errorWith('Driver not found in fleet', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, driverId } = request.params as z.infer<typeof driverParams>;
      const { accountBillingOptOut } = request.body as z.infer<typeof memberBillingBody>;
      const record = await fleetService.setMemberBillingOptOut(id, driverId, accountBillingOptOut, {
        actor: getAuditActor(request),
        log: request.log,
      });
      if (record == null) {
        await reply
          .status(404)
          .send({ error: 'Driver not found in fleet', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      return record;
    },
  );

  app.delete(
    '/fleets/:id/drivers/:driverId',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Remove a driver from a fleet',
        operationId: 'removeFleetDriver',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        response: {
          200: itemResponse(fleetDriverRecordItem),
          404: errorWith('Driver not found in fleet', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, driverId } = request.params as z.infer<typeof driverParams>;
      const record = await fleetService.removeDriverFromFleet(id, driverId);
      if (record == null) {
        await reply
          .status(404)
          .send({ error: 'Driver not found in fleet', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'member_removed',
          ...actor,
          before: { driverId },
        },
        db,
        request.log,
      );
      await fleetService.notifyMemberLeft(record, request.log);
      return record;
    },
  );

  // --- Stations ---

  app.get(
    '/fleets/:id/stations',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List stations in a fleet',
        operationId: 'listFleetStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: { 200: arrayResponse(fleetStationItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      return fleetService.getFleetStations(id);
    },
  );

  app.post(
    '/fleets/:id/stations',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Add a station to a fleet',
        operationId: 'addFleetStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(addStationBody),
        response: {
          201: itemResponse(fleetStationRecordItem),
          404: errorWith('Fleet or station not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Station already in fleet', [ERROR_CODES.STATION_ALREADY_IN_FLEET]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof addStationBody>;
      // Pre-check fleet existence so an FK race on the INSERT below can
      // be safely attributed to the station (the only remaining unknown FK).
      const fleet = await fleetService.getFleet(id);
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      // Pre-check station existence (FK violations bypass ON CONFLICT and
      // would otherwise leak as a 500).
      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, body.stationId));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      let record;
      try {
        record = await fleetService.addStationToFleet(id, body.stationId);
      } catch (err) {
        // Pre-check is non-transactional, so the station can be deleted
        // between the check and this INSERT. Map the FK violation back
        // to the same 404 the pre-check would have produced.
        if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
        throw err;
      }
      // null = (fleet_id, station_id) unique tripped — already in fleet.
      if (record == null) {
        await reply
          .status(409)
          .send({ error: 'Station is already in this fleet', code: 'STATION_ALREADY_IN_FLEET' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'station_added',
          ...actor,
          after: { stationId: body.stationId },
        },
        db,
        request.log,
      );
      await reply.status(201).send(record);
    },
  );

  app.delete(
    '/fleets/:id/stations/:stationId',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Remove a station from a fleet',
        operationId: 'removeFleetStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: itemResponse(fleetStationRecordItem),
          404: errorWith('Station not found in fleet', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, stationId } = request.params as z.infer<typeof stationParams>;
      const record = await fleetService.removeStationFromFleet(id, stationId);
      if (record == null) {
        await reply
          .status(404)
          .send({ error: 'Station not found in fleet', code: 'STATION_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: fleetAuditLog, idColumn: 'fleet_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'station_removed',
          ...actor,
          before: { stationId },
        },
        db,
        request.log,
      );
      return record;
    },
  );

  // --- Vehicles ---

  app.get(
    '/fleets/:id/vehicles',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List vehicles in a fleet',
        operationId: 'listFleetVehicles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(sessionsQuery),
        response: { 200: paginatedResponse(fleetVehicleItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { page, limit } = request.query as z.infer<typeof sessionsQuery>;
      return fleetService.getFleetVehicles(id, page, limit);
    },
  );

  app.get(
    '/fleets/:id/vehicles/available',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Search vehicles not in fleet',
        operationId: 'listAvailableFleetVehicles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(
          z.object({
            search: z.string().default(''),
            limit: z.coerce.number().int().min(1).max(100).default(10),
          }),
        ),
        response: { 200: arrayResponse(fleetVehicleItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { search, limit } = request.query as { search: string; limit: number };
      return fleetService.searchAvailableVehicles(id, search, limit);
    },
  );

  // --- Sessions ---

  app.get(
    '/fleets/:id/sessions',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'List charging sessions for a fleet',
        operationId: 'listFleetSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(sessionsQuery),
        response: { 200: paginatedResponse(fleetSessionItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { page, limit } = request.query as z.infer<typeof sessionsQuery>;
      return fleetService.getFleetSessions(id, page, limit);
    },
  );

  // --- Metrics ---

  app.get(
    '/fleets/:id/metrics',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Get fleet metrics',
        operationId: 'getFleetMetrics',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(metricsQuery),
        response: { 200: itemResponse(fleetMetricsItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { months } = request.query as z.infer<typeof metricsQuery>;
      return fleetService.getFleetMetrics(id, months);
    },
  );

  // --- Energy History ---

  app.get(
    '/fleets/:id/energy-history',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Get fleet energy delivery history',
        operationId: 'getFleetEnergyHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(energyHistoryQuery),
        response: { 200: arrayResponse(energyHistoryItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { days } = request.query as z.infer<typeof energyHistoryQuery>;
      return fleetService.getFleetEnergyHistory(id, days);
    },
  );

  // --- Pricing Groups ---

  app.get(
    '/fleets/:id/pricing-groups',
    {
      onRequest: [authorize('fleets:read')],
      schema: {
        tags: ['Fleets'],
        summary: 'Get the pricing group for a fleet',
        operationId: 'getFleetPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: { 200: itemResponse(fleetPricingGroupItem.nullable()) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      return fleetService.getFleetPricingGroup(id);
    },
  );

  app.post(
    '/fleets/:id/pricing-groups',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Add a pricing group to a fleet',
        operationId: 'addFleetPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(addPricingGroupBody),
        response: {
          201: itemResponse(fleetPricingGroupRecordItem),
          404: errorWith('Fleet or pricing group not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.PRICING_GROUP_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof addPricingGroupBody>;
      // Pre-check fleet existence so the FK race on the INSERT below can
      // be safely attributed to the pricing group (the only remaining
      // unknown FK).
      const fleet = await fleetService.getFleet(id);
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      if (!(await pricingGroupExists(body.pricingGroupId))) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
        return;
      }
      const previous = await fleetService.getFleetPricingGroup(id);
      let record;
      try {
        record = await fleetService.addPricingGroupToFleet(id, body.pricingGroupId);
      } catch (err) {
        // Pre-check is non-transactional, so the pricing group can be deleted
        // between the check and this INSERT. Map the FK violation to the same
        // 404 the operator would have seen on the pre-check.
        if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
          await reply
            .status(404)
            .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
          return;
        }
        throw err;
      }
      const actor = getAuditActor(request);
      // Two independent audit rows for two different tables — write in parallel.
      // Both calls swallow errors internally so the response is never blocked
      // by an audit failure.
      await Promise.all([
        writeAudit(
          { table: pricingAssignmentAuditLog, idColumn: 'pricing_assignment_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: previous == null ? 'created' : 'updated',
            ...actor,
            before:
              previous == null
                ? null
                : { scope: 'fleet', fleetId: id, pricingGroupId: previous.id },
            after: { scope: 'fleet', fleetId: id, pricingGroupId: body.pricingGroupId },
          },
          db,
          request.log,
        ),
        writeAudit(
          { table: fleetAuditLog, idColumn: 'fleet_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: 'pricing_assignment_changed',
            ...actor,
            before: previous == null ? null : { pricingGroupId: previous.id },
            after: { pricingGroupId: body.pricingGroupId },
          },
          db,
          request.log,
        ),
      ]);
      await publishPricingChanged({
        pricingGroupId: body.pricingGroupId,
        action: 'assignment.changed',
        fleetId: id,
      });
      await reply.status(201).send(record);
    },
  );

  app.delete(
    '/fleets/:id/pricing-groups/:pricingGroupId',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Remove a pricing group from a fleet',
        operationId: 'removeFleetPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(pricingGroupParams),
        response: {
          200: itemResponse(fleetPricingGroupRecordItem),
          404: errorWith('Pricing assignment not found', [
            ERROR_CODES.PRICING_ASSIGNMENT_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, pricingGroupId } = request.params as z.infer<typeof pricingGroupParams>;
      const record = await fleetService.removePricingGroupFromFleet(id, pricingGroupId);
      if (record == null) {
        await reply.status(404).send({
          error: 'Pricing group not found for fleet',
          code: 'PRICING_ASSIGNMENT_NOT_FOUND',
        });
        return;
      }
      const actor = getAuditActor(request);
      await Promise.all([
        writeAudit(
          { table: pricingAssignmentAuditLog, idColumn: 'pricing_assignment_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: 'deleted',
            ...actor,
            before: { scope: 'fleet', fleetId: id, pricingGroupId },
          },
          db,
          request.log,
        ),
        writeAudit(
          { table: fleetAuditLog, idColumn: 'fleet_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: 'pricing_assignment_changed',
            ...actor,
            before: { pricingGroupId },
          },
          db,
          request.log,
        ),
      ]);
      await publishPricingChanged({ pricingGroupId, action: 'assignment.changed', fleetId: id });
      return record;
    },
  );
}
