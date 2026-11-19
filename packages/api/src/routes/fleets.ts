// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sessionChargingPointShape } from '../lib/session-charging-point.js';
import * as fleetService from '../services/fleet.service.js';
import {
  db,
  writeAudit,
  fleetAuditLog,
  driverAuditLog,
  pricingAssignmentAuditLog,
  drivers,
  chargingStations,
  pgErrorCode,
  PG_FOREIGN_KEY_VIOLATION,
  INVOICE_DATE_MODES,
} from '@evtivity/database';
import type { AccountInvoiceRecipient } from '@evtivity/database';
import { eq } from 'drizzle-orm';
import { AppError, OCPP_PROTOCOLS } from '@evtivity/lib';
import { getAuditActor } from '../lib/audit-actor.js';
import { userLanguage } from '../lib/user-language.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { logTimeRangeQuery, parseLogTimeRange } from '../lib/date-range.js';
import {
  FLEET_SESSION_EXPORT_MAX_DAYS,
  fleetSessionExportRange,
  fleetSessionsCsv,
} from '../lib/fleet-session-export.js';
import { endDeletedFleetUserSessions, fleetUserAssignmentsOf } from '../lib/fleet-user-sessions.js';
import { paginationQuery } from '../lib/pagination.js';
import { fleetListSort } from '../lib/sorts/fleet-list-sort.js';
import { driverListSort } from '../lib/sorts/driver-list-sort.js';
import { vehicleListSort } from '../lib/sorts/vehicle-list-sort.js';
import { fleetSessionListSort } from '../lib/sorts/session-list-sort.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import {
  checkStationSiteAccess,
  getUserSiteIds,
  requireAllSiteAccess,
} from '../lib/site-access.js';
import {
  FLEET_BILLING_PROFILE_PERMISSION,
  fieldsOutsideFleetManagerProfile,
  fleetManagerProfileView,
  refuseFleetBillingRead,
  refuseSiteRestrictedFleetBilling,
  refuseSiteRestrictedFleetMembership,
} from '../lib/fleet-billing-access.js';
import { isFleetUser, requireFleetAccess } from '../lib/fleet-scope.js';
import { fleetReaderOf, sortsByHiddenField } from '../lib/fleet-reader.js';
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
import { avatarItem } from '../lib/avatar-item.js';
import { tokenActorOf } from '../services/token.service.js';

// Company-wide configuration: a site-restricted user gets this 404 before any
// read or write (requireAllSiteAccess, features/site-access-control.md).
const ALL_SITES_PRICING_GROUP_NOT_FOUND = {
  error: 'Pricing group not found',
  code: 'PRICING_GROUP_NOT_FOUND',
} as const;

const MAX_BILLING_CONTACTS = 10;

// The fleet billing profile, as stored on the fleet (features/fleet-billing.md).
const billingProfileFields = {
  billingContactEmails: z
    .array(z.email().max(255))
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
  invoiceDateMode: z
    .enum(INVOICE_DATE_MODES)
    .describe(
      'Date of the fleet and member invoices: run_date (the day they are issued) or period_end (the last day of the billed month, system timezone; an invoice of the current month is dated today). The number prefix follows the date',
    ),
};
const optionalBillingProfileFields = Object.fromEntries(
  Object.entries(billingProfileFields).map(([key, schema]) => [key, schema.optional()]),
) as { [K in keyof typeof billingProfileFields]: z.ZodOptional<(typeof billingProfileFields)[K]> };

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
    stationCount: z
      .number()
      .int()
      .min(0)
      .describe(
        "Number of stations assigned to this fleet; for a site-restricted user only the stations of the user's sites",
      ),
  })
  .loose();

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
    // Omitted for a site-restricted user (with the credit limit fields).
    ...optionalBillingProfileFields,
    accountInvoiceRecipient: z
      .enum(['fleet', 'member'])
      .optional()
      .describe(
        "Who the account invoices go to: 'fleet' (one invoice to the billing contacts) or 'member' (one invoice per member driver)",
      ),
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
    hasPricingGroup: z
      .boolean()
      .optional()
      .describe(
        'The fleet has a pricing group (GET /fleets/:id only). A user restricted to some sites may change the members only of a fleet with no pricing group and no account billing.',
      ),
    createdAt: z.coerce.date().describe('Timestamp when the fleet was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the fleet was last updated'),
  })
  .loose();

const fleetDriverItem = z
  .object({
    id: z.string().describe('Driver identifier'),
    firstName: z.string().max(100).nullable().describe('Driver first name'),
    lastName: z.string().max(100).nullable().describe('Driver last name'),
    email: z
      .email()
      .max(255)
      .nullable()
      .optional()
      .describe('Driver email address (left out for a fleet user)'),
    phone: z
      .string()
      .max(50)
      .nullable()
      .optional()
      .describe('Driver phone number in E.164 format (left out for a fleet user)'),
    isActive: z.boolean().describe('Whether the driver account is enabled'),
    accountBillingOptOut: z
      .boolean()
      .optional()
      .describe(
        'The member pays by card although the fleet bills on account (opt-out of charge on account; left out for a fleet user)',
      ),
    createdAt: z.coerce
      .date()
      .optional()
      .describe('Timestamp when the driver was created (left out for a fleet user)'),
    avatar: avatarItem.optional(),
  })
  .loose();

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
  .loose();

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
      .enum(OCPP_PROTOCOLS)
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
  .loose();

const fleetStationRecordItem = z
  .object({
    fleetId: z.string().describe('Fleet identifier'),
    stationId: z.string().describe('Station identifier'),
  })
  .loose();

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
    vin: z
      .string()
      .max(17)
      .nullable()
      .optional()
      .describe('Vehicle identification number (17 chars; left out for a fleet user)'),
    licensePlate: z.string().max(20).nullable().describe('Vehicle license plate'),
  })
  .loose();

const fleetSessionItem = z
  .object({
    id: z.string().describe('Charging session identifier'),
    stationId: z.string().describe('Station identifier where the session occurred'),
    stationName: z.string().max(255).nullable().describe('Station OCPP id (display label)'),
    siteName: z.string().max(255).nullable().describe('Site name where the station is located'),
    ...sessionChargingPointShape,
    transactionId: z
      .string()
      .nullable()
      .optional()
      .describe('OCPP transaction identifier (left out for a fleet user)'),
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
      .optional()
      .describe(
        'Running cost in cents during active session (left out for a fleet user without payments:read)',
      ),
    finalCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        'Final billed cost in cents after session completes (left out for a fleet user without payments:read)',
      ),
    currency: z
      .string()
      .length(3)
      .optional()
      .describe(
        'ISO 4217 currency the session is billed in (left out for a fleet user without payments:read)',
      ),
  })
  .loose();

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
  .loose();

const energyHistoryItem = z
  .object({
    date: z.string().describe('Day in ISO date format (YYYY-MM-DD)'),
    energyWh: z.number().describe('Total energy delivered on this day in watt-hours'),
  })
  .loose();

const fleetPricingGroupItem = z
  .object({
    id: z.string().describe('Pricing group identifier'),
    name: z.string().describe('Pricing group display name'),
    description: z.string().nullable().describe('Pricing group description'),
    isDefault: z.boolean().describe('Whether this is the system default pricing group'),
    tariffCount: z.number().describe('Number of tariffs in this pricing group'),
  })
  .loose();

const fleetPricingGroupRecordItem = z
  .object({
    fleetId: z.string().describe('Fleet identifier'),
    pricingGroupId: z.string().describe('Pricing group identifier'),
  })
  .loose();

const fleetParams = z.object({
  id: ID_PARAMS.fleetId.describe('Fleet ID'),
});

const fleetSessionParams = fleetParams.extend({
  sessionId: ID_PARAMS.sessionId.describe('Charging session ID'),
});

const fleetSessionDetailItem = z
  .object({
    id: z.string().describe('Charging session identifier'),
    status: z.string().max(50).describe('Session status (active, completed, faulted, etc.)'),
    startedAt: z.coerce.date().nullable().describe('Timestamp when the session started'),
    endedAt: z.coerce.date().nullable().describe('Timestamp when the session ended'),
    energyDeliveredWh: z.number().min(0).describe('Total energy delivered in watt-hours'),
    siteName: z.string().max(255).nullable().describe('Site the session happened at'),
    stationName: z.string().max(255).nullable().describe('Station OCPP id (display label)'),
    ...sessionChargingPointShape,
    driverName: z
      .string()
      .nullable()
      .describe('Name of the driver, null for a fleet card and for an erased driver'),
    driverErased: z
      .boolean()
      .optional()
      .describe('The driver of the session was erased: no name or other personal data is shown'),
    cardLabel: z
      .string()
      .nullable()
      .describe('Label of the fleet RFID card the session used; null for any other card'),
    currentCostCents: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('Running cost in cents (only with payments:read)'),
    finalCostCents: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('Final cost in cents (only with payments:read)'),
    currency: z
      .string()
      .length(3)
      .optional()
      .describe('ISO 4217 currency of the cost (only with payments:read)'),
  })
  .loose();

const createFleetBody = z.object({
  name: z.string().max(255).describe('Fleet display name'),
  description: z.string().max(500).optional().describe('Fleet description'),
});

const updateFleetBody = z.object({
  name: z.string().max(255).optional().describe('Fleet display name'),
  description: z.string().max(500).optional().describe('Fleet description'),
});

const INVOICE_RECIPIENTS = [
  'fleet',
  'member',
] as const satisfies readonly AccountInvoiceRecipient[];

// At least one field (checked in the handler: Fastify validates the body
// with the JSON Schema only, which drops a zod refine).
const fleetBillingBody = z.object({
  accountBillingEnabled: z
    .boolean()
    .optional()
    .describe(
      "Charge on account: bill the members' sessions on account (no card, no hold). Off: members pay by card.",
    ),
  accountInvoiceRecipient: z
    .enum(INVOICE_RECIPIENTS)
    .optional()
    .describe(
      "Who the account invoices go to: 'fleet' (one invoice per month to the fleet billing contacts) or 'member' (one invoice per month to each member driver). Applies to sessions started after the change.",
    ),
});

const optionalText = (max: number, what: string) =>
  z.string().max(max).nullable().optional().describe(`${what}; null or blank clears it`);

const fleetBillingProfileBody = z.object({
  billingContactEmails: z
    .array(z.email().trim().max(255))
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
  invoiceDateMode: z
    .enum(INVOICE_DATE_MODES)
    .optional()
    .describe(
      'Date of the fleet and member invoices: run_date (the issue day) or period_end (the last day of the billed month)',
    ),
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
  .loose();

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
  .loose();

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

const fleetSessionFilterQuery = {
  from: logTimeRangeQuery.from.describe('ISO datetime, sessions started at or after it'),
  to: logTimeRangeQuery.to.describe(
    'ISO datetime, sessions started at or before it; must not be before `from`',
  ),
  driverId: ID_PARAMS.driverId
    .optional()
    .describe('Sessions of this fleet member only; a driver who is not a member lists nothing'),
  tokenId: ID_PARAMS.driverTokenId
    .optional()
    .describe(
      'Sessions with this fleet RFID card only; a card the fleet does not own lists nothing',
    ),
};

const fleetSessionsQuery = sessionsQuery.extend({
  ...fleetSessionListSort.query,
  ...fleetSessionFilterQuery,
});

const fleetListQuery = paginationQuery.extend({ ...fleetListSort(null).query });

const HIDDEN_SORT = {
  error: 'This list cannot be sorted by a field you are not shown',
  code: 'VALIDATION_ERROR',
} as const;
const fleetDriversQuery = sessionsQuery.extend({
  ...driverListSort.query,
  search: z
    .string()
    .max(100)
    .optional()
    .describe('Matches the member name (for an operator also the email), as typed'),
  active: z.enum(['true', 'false']).optional().describe('true lists only active members'),
});
const fleetVehiclesQuery = sessionsQuery.extend({ ...vehicleListSort.query });

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

// Fields of GET /fleets/:id a site-restricted user does not see: the billing
// profile, the invoice recipient and the credit limit (account billing spans
// every site).
const FLEET_BILLING_FIELDS = new Set<string>([
  ...Object.keys(billingProfileFields),
  'creditLimitCents',
  'creditLimitWarningPercent',
  'accountInvoiceRecipient',
]);

function omitFleetBillingFields<T extends Record<string, unknown>>(fleet: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fleet).filter(([key]) => !FLEET_BILLING_FIELDS.has(key)),
  ) as Partial<T>;
}

export function fleetRoutes(app: FastifyInstance): void {
  app.get(
    '/fleets',
    {
      onRequest: [authorize('fleets:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'List fleets',
        description:
          'Every fleet for an operator. A fleet user lists only its assigned fleets, with a station count of 0 (it has no sites).',
        operationId: 'listFleets',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(fleetListQuery),
        response: { 200: paginatedResponse(fleetListItem) },
      },
    },
    async (request) => {
      const params = request.query as z.infer<typeof fleetListQuery>;
      return fleetService.listFleets(params, await fleetReaderOf(request));
    },
  );

  app.get(
    '/fleets/:id',
    {
      onRequest: [authorize('fleets:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'Get a fleet by ID',
        description:
          'A user restricted to some sites, and a fleet user, does not get the billing profile and credit limit fields: account billing spans every site. A fleet user with fleetBilling:read (or write) gets the billing profile fields it may edit: the contacts, the bill-to name and address, the VAT ID and the invoice language. A fleet user reaches only its assigned fleets (else 404 FLEET_NOT_FOUND).',
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
      if (!(await requireFleetAccess(request, reply, id))) return;
      const fleet = await fleetService.getFleet(id);
      if (fleet == null) {
        await reply.status(404).send({ error: 'Fleet not found', code: 'FLEET_NOT_FOUND' });
        return;
      }
      const withPricing = {
        ...fleet,
        hasPricingGroup: await fleetService.fleetHasPricingGroup(id),
      };
      // Account billing spans every site: a site-restricted user does not
      // see the billing profile or the credit limit (the billing routes
      // answer it 404), only that the fleet bills on account.
      const { userId } = request.user as { userId: string };
      if ((await getUserSiteIds(userId)) != null) {
        const omitted = omitFleetBillingFields(withPricing);
        // A fleet user who manages the billing profile reads its editable fields.
        if (
          (await isFleetUser(userId)) &&
          (await requestHasPermission(request, 'fleetBilling:read'))
        ) {
          return { ...omitted, ...fleetManagerProfileView(withPricing) };
        }
        return omitted;
      }
      return withPricing;
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
      const { userId } = request.user as { userId: string };
      if ((await getUserSiteIds(userId)) != null) return omitFleetBillingFields(fleet);
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
          'Deletes the fleet and its memberships. Refused with 409 FLEET_HAS_OPEN_BILLING while sessions are billed to the fleet account (unbilled, invoiced or paid): turn off account billing instead. Refused with 409 FLEET_HAS_RESERVATIONS while any fleet reservation (cancelled ones included) names the fleet: reservations are kept as history. Refused with 409 FLEET_HAS_CARDS while the fleet owns RFID cards. The fleet users assigned to it lose it: their sessions end (their API keys stay, with the fleets they keep) and each gets a user history row. A user restricted to some sites gets 404 FLEET_NOT_FOUND: the fleet spans every site.',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: {
          200: itemResponse(fleetItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
          409: errorWith('Fleet has account billing, fleet reservations or RFID cards', [
            ERROR_CODES.FLEET_HAS_OPEN_BILLING,
            ERROR_CODES.FLEET_HAS_RESERVATIONS,
            ERROR_CODES.FLEET_HAS_CARDS,
          ]),
        },
      },
    },
    async (request, reply) => {
      // Deleting a fleet removes its memberships and station links at every
      // site, so it needs access to every site.
      if (await refuseSiteRestrictedFleetBilling(request, reply)) return;
      const { id } = request.params as z.infer<typeof fleetParams>;
      // Read before the delete, which cascades the assignments away.
      const fleetUsers = await fleetUserAssignmentsOf(id);
      let fleet;
      try {
        fleet = await fleetService.deleteFleet(id);
      } catch (err) {
        if (err instanceof AppError && err.code === 'FLEET_HAS_OPEN_BILLING') {
          await reply.status(409).send({ error: err.message, code: 'FLEET_HAS_OPEN_BILLING' });
          return;
        }
        if (err instanceof AppError && err.code === 'FLEET_HAS_RESERVATIONS') {
          await reply.status(409).send({ error: err.message, code: 'FLEET_HAS_RESERVATIONS' });
          return;
        }
        if (err instanceof AppError && err.code === 'FLEET_HAS_CARDS') {
          await reply.status(409).send({ error: err.message, code: 'FLEET_HAS_CARDS' });
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
      await endDeletedFleetUserSessions(id, fleetUsers, actor, request.log);
      return fleet;
    },
  );

  // --- Billing ---

  app.patch(
    '/fleets/:id/billing',
    {
      onRequest: [authorize('fleets:write', 'payments:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Change charge on account and the invoice recipient of a fleet',
        description:
          "accountBillingEnabled on: the members' new sessions are billed on account, with no card and no hold (members who opted out pay by card). Off: new sessions are paid by card; running sessions keep how they started and unbilled sessions are still billed on account. accountInvoiceRecipient: 'fleet' bills the account sessions on one monthly fleet invoice to the billing contacts, 'member' on one monthly invoice per member driver, sent to that driver only; it applies to sessions started after the change. At least one field (400 VALIDATION_ERROR). Turning account billing on answers 409 FLEET_BILLING_OLD_PODS_CONNECTED (details: reason, oldConnections, hosts, lastOldSeenAt, allowedFrom, watchCheckedAt; allowedFrom is set when no older process is connected now but one was seen less than 10 minutes ago, and gives the time the change is allowed from) while processes before v0.1.41 may run, switching to 'member' while processes before v0.1.46 may run. When no older process is connected or was seen recently but the worker's process version check has not run recently (the worker is down), the 409 is FLEET_BILLING_VERSION_CHECK_STALE with the same details (reason version_check_stale). Turning it off and switching back to 'fleet' are never refused. A change is audited (billing_updated with the changed fields) and the worker sends fleet.AccountBillingChanged to each member whose billing it moved (a background job); a request that changes nothing does neither. A user restricted to some sites gets 404 FLEET_NOT_FOUND: account billing spans every site.",
        operationId: 'updateFleetBilling',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(fleetBillingBody),
        response: {
          200: itemResponse(fleetItem),
          400: errorWith('No field to change', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
          409: errorWith(
            'Processes of an older release are connected, or the version check is stale',
            [
              ERROR_CODES.FLEET_BILLING_OLD_PODS_CONNECTED,
              ERROR_CODES.FLEET_BILLING_VERSION_CHECK_STALE,
            ],
          ),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { accountBillingEnabled, accountInvoiceRecipient } = request.body as z.infer<
        typeof fleetBillingBody
      >;
      // Account billing spans every site the members charge at (fleet-billing-access.ts).
      if (await refuseSiteRestrictedFleetBilling(request, reply)) return;
      if (accountBillingEnabled === undefined && accountInvoiceRecipient === undefined) {
        await reply.status(400).send({
          error: 'Set accountBillingEnabled or accountInvoiceRecipient',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      let fleet;
      try {
        fleet = await fleetService.setFleetAccountBilling(
          id,
          { enabled: accountBillingEnabled, recipient: accountInvoiceRecipient },
          { actor: getAuditActor(request), log: request.log },
        );
      } catch (err) {
        if (err instanceof fleetService.FleetBillingUpgradePendingError) {
          await reply.status(409).send({
            error: err.message,
            code:
              err.details.reason === 'version_check_stale'
                ? 'FLEET_BILLING_VERSION_CHECK_STALE'
                : 'FLEET_BILLING_OLD_PODS_CONNECTED',
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
      onRequest: [authorize('fleets:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'Update the fleet billing profile',
        description:
          'Sets who the fleet invoice goes to and how: billing contacts, the bill-to block (legal name, address, VAT or tax ID), the invoice language, the payment terms (overrides the invoice.paymentTermsDays setting), automatic monthly invoicing and the invoice date. Fields left out keep their value; null or a blank string clears a text field. An operator needs fleets:write and payments:write for every field; with fleetBilling:write alone (a fleet user, or an operator) only the contacts, the bill-to name and address, the VAT ID and the invoice language, any other field answers 403 INSUFFICIENT_PERMISSIONS. A fleet user reaches only its assigned fleets, decided under the fleet row lock (else 404 FLEET_NOT_FOUND). A new VAT ID applies to invoices issued after the change; issued invoices keep theirs. A change of the VAT ID notifies the operators (fleet.BillingTaxIdChanged). Turning on automatic invoicing, or removing the last contact while it is on, answers 400 FLEET_BILLING_CONTACT_REQUIRED. A change is audited (billing_updated with the changed fields); a request that changes nothing is not. A user restricted to some sites gets 404 FLEET_NOT_FOUND: account billing spans every site.',
        operationId: 'updateFleetBillingProfile',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        body: zodSchema(fleetBillingProfileBody),
        response: {
          200: itemResponse(fleetItem),
          400: errorWith('Automatic invoicing needs a billing contact', [
            ERROR_CODES.FLEET_BILLING_CONTACT_REQUIRED,
          ]),
          403: errorWith('Insufficient permissions', [ERROR_CODES.INSUFFICIENT_PERMISSIONS]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const body = request.body as z.infer<typeof fleetBillingProfileBody>;
      // A fleet user never holds fleets:write or payments:write (the fleet user
      // ceiling drops them), so the whole profile is an operator's.
      const full =
        (await requestHasPermission(request, 'fleets:write')) &&
        (await requestHasPermission(request, 'payments:write'));
      const limited = await requestHasPermission(request, FLEET_BILLING_PROFILE_PERMISSION);
      if (!full && !limited) {
        await reply
          .status(403)
          .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
        return;
      }
      const { userId } = request.user as { userId: string };
      const byFleetUser = await isFleetUser(userId);
      if (byFleetUser) {
        if (!(await requireFleetAccess(request, reply, id))) return;
      } else if (await refuseSiteRestrictedFleetBilling(request, reply)) {
        return;
      }
      if (byFleetUser && !limited) {
        await reply
          .status(403)
          .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
        return;
      }
      const outside = full && !byFleetUser ? [] : fieldsOutsideFleetManagerProfile(body);
      if (outside.length > 0) {
        await reply.status(403).send({
          error: `Only an operator changes ${outside.join(', ')}`,
          code: 'INSUFFICIENT_PERMISSIONS',
        });
        return;
      }
      let fleet;
      try {
        fleet = await fleetService.updateFleetBillingProfile(id, body, {
          actor: getAuditActor(request),
          log: request.log,
          fleetUserId: byFleetUser ? userId : undefined,
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
      if (byFleetUser)
        return { ...omitFleetBillingFields(fleet), ...fleetManagerProfileView(fleet) };
      return fleet;
    },
  );

  // --- Credit limit ---

  app.get(
    '/fleets/:id/credit-limit',
    {
      onRequest: [authorize('fleets:read', 'payments:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: "Get a fleet's credit limit and exposure",
        description:
          'The credit limit of the account billing and the exposure it is checked against: ended account sessions on no invoice, account sessions on an issued unpaid invoice, and the running cost of active account sessions, in the company currency. Sessions with a payment record are paid by card and do not count. A user restricted to some sites gets 404 FLEET_NOT_FOUND: account billing spans every site. A fleet user reads only its assigned fleets.',
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
      if (await refuseFleetBillingRead(request, reply, id)) return;
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
      onRequest: [authorize('fleets:write', 'payments:write')],
      schema: {
        tags: ['Fleets'],
        summary: "Set a fleet's credit limit",
        description:
          "Sets the credit limit of the fleet's account billing (null removes it) and the warning percent. A driver start billed to the fleet is refused while the exposure is at or above the limit: the portal answers 402 FLEET_CREDIT_LIMIT_REACHED, and the payment gate stops an RFID start (stopped reason AccountCreditLimit). The fleet is warned once per month at the warning percent (fleet.CreditLimitWarning) and once per month at the limit (fleet.CreditLimitReached). Checked at the start only. A change is audited (billing_updated). A user restricted to some sites gets 404 FLEET_NOT_FOUND: account billing spans every site.",
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
      if (await refuseSiteRestrictedFleetBilling(request, reply)) return;
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
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'List drivers in a fleet',
        description:
          'A fleet user reaches only its assigned fleets (else 404 FLEET_NOT_FOUND) and gets each member with id, name and status only.',
        operationId: 'listFleetDrivers',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(fleetDriversQuery),
        response: {
          200: paginatedResponse(fleetDriverItem),
          400: errorWith('A fleet user sorted by a field it is not shown', [
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      if (!(await requireFleetAccess(request, reply, id))) return;
      const { page, limit, sort, order, search, active } = request.query as z.infer<
        typeof fleetDriversQuery
      >;
      const reader = await fleetReaderOf(request);
      if (sortsByHiddenField(reader, 'drivers', sort)) {
        await reply.status(400).send(HIDDEN_SORT);
        return;
      }
      return fleetService.getFleetDrivers(id, page, limit, { sort, order }, reader, {
        search,
        active: active === 'true',
      });
    },
  );

  app.post(
    '/fleets/:id/drivers',
    {
      onRequest: [authorize('fleets:write')],
      schema: {
        tags: ['Fleets'],
        summary: 'Add a driver to a fleet',
        description:
          'A user restricted to some sites may add members only to a fleet with no pricing group and no account billing; otherwise it gets 404 FLEET_NOT_FOUND.',
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
      if (await refuseSiteRestrictedFleetMembership(request, reply, id)) return;
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
      await writeAudit(
        { table: driverAuditLog, idColumn: 'driver_id' },
        {
          entityId: body.driverId,
          entityIdSnapshot: body.driverId,
          action: 'fleet_assignment_changed',
          ...actor,
          before: null,
          after: { fleetId: id },
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
      onRequest: [authorize('fleets:write', 'payments:write')],
      schema: {
        tags: ['Fleets'],
        summary: "Set a member's opt-out of charge on account",
        description:
          'An opted-out member pays by card although the fleet bills on account. A change is audited (member_billing_opt_out_changed) and the driver gets fleet.AccountBillingChanged when it moved their billing; a request that changes nothing does neither. Running sessions keep how they started. A user restricted to some sites gets 404 FLEET_NOT_FOUND: the opt-out applies at every site.',
        operationId: 'updateFleetDriverBilling',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        body: zodSchema(memberBillingBody),
        response: {
          200: itemResponse(fleetDriverRecordItem),
          404: errorWith('Fleet or driver not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.DRIVER_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      // The opt-out decides how the member pays at every site.
      if (await refuseSiteRestrictedFleetBilling(request, reply)) return;
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
        description:
          'A user restricted to some sites may remove members only from a fleet with no pricing group and no account billing; otherwise it gets 404 FLEET_NOT_FOUND.',
        operationId: 'removeFleetDriver',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        response: {
          200: itemResponse(fleetDriverRecordItem),
          404: errorWith('Fleet or driver not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.DRIVER_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, driverId } = request.params as z.infer<typeof driverParams>;
      if (await refuseSiteRestrictedFleetMembership(request, reply, id)) return;
      const record = await fleetService.removeDriverFromFleet(
        id,
        driverId,
        tokenActorOf(getAuditActor(request)),
      );
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
      await writeAudit(
        { table: driverAuditLog, idColumn: 'driver_id' },
        {
          entityId: driverId,
          entityIdSnapshot: driverId,
          action: 'fleet_assignment_changed',
          ...actor,
          before: { fleetId: id },
          after: null,
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
        description:
          'The stations of the fleet. A user restricted to some sites sees only the stations at those sites.',
        operationId: 'listFleetStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        response: { 200: arrayResponse(fleetStationItem) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      const { userId } = request.user as { userId: string };
      return fleetService.getFleetStations(id, await getUserSiteIds(userId));
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
      // A station outside the user's sites answers like a missing one (P11).
      const { userId } = request.user as { userId: string };
      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, body.stationId));
      if (station == null || !(await checkStationSiteAccess(body.stationId, userId))) {
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
      const { userId } = request.user as { userId: string };
      if (!(await checkStationSiteAccess(stationId, userId))) {
        await reply
          .status(404)
          .send({ error: 'Station not found in fleet', code: 'STATION_NOT_FOUND' });
        return;
      }
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
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'List vehicles in a fleet',
        description: 'A fleet user reaches only its assigned fleets (else 404 FLEET_NOT_FOUND).',
        operationId: 'listFleetVehicles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(fleetVehiclesQuery),
        response: {
          200: paginatedResponse(fleetVehicleItem),
          400: errorWith('A fleet user sorted by a field it is not shown', [
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      if (!(await requireFleetAccess(request, reply, id))) return;
      const { page, limit, sort, order } = request.query as z.infer<typeof fleetVehiclesQuery>;
      const reader = await fleetReaderOf(request);
      if (sortsByHiddenField(reader, 'vehicles', sort)) {
        await reply.status(400).send(HIDDEN_SORT);
        return;
      }
      return fleetService.getFleetVehicles(id, page, limit, { sort, order }, reader);
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
            search: z
              .string()
              .default('')
              .describe('Search the vehicle make, model, VIN and plate and the driver name'),
            limit: z.coerce
              .number()
              .int()
              .min(1)
              .max(100)
              .default(10)
              .describe('Most vehicles to list'),
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
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'List charging sessions for a fleet',
        description:
          "The charging sessions of the fleet's drivers and of the fleet's RFID cards, filtered by start time (from, to), member (driverId) and fleet RFID card (tokenId). A user restricted to some sites sees only the sessions at those sites. A fleet user reaches only its assigned fleets (else 404 FLEET_NOT_FOUND) and sees the sessions billed to the fleet on account and not passed on to a member, at every site.",
        operationId: 'listFleetSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(fleetSessionsQuery),
        response: {
          200: paginatedResponse(fleetSessionItem),
          400: errorWith('Invalid filter', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      if (!(await requireFleetAccess(request, reply, id))) return;
      const { page, limit, sort, order, driverId, tokenId, ...range } = request.query as z.infer<
        typeof fleetSessionsQuery
      >;
      const reader = await fleetReaderOf(request);
      if (sortsByHiddenField(reader, 'sessions', sort)) {
        await reply.status(400).send(HIDDEN_SORT);
        return;
      }
      return fleetService.getFleetSessions(
        id,
        page,
        limit,
        reader,
        { sort, order },
        { ...parseLogTimeRange(range), driverId, tokenId },
      );
    },
  );

  app.get(
    '/fleets/:id/sessions/export',
    {
      onRequest: [authorize('fleets:read', 'sessions:read')],
      config: {
        fleetScope: true,
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => {
            const user = request.user as { userId?: string } | undefined;
            return user?.userId ?? request.ip;
          },
        },
      },
      schema: {
        tags: ['Fleets'],
        summary: 'Export the charging sessions of a fleet as CSV',
        description: `The fleet session list with its filters (from, to, driverId, tokenId), newest first, at most ${String(fleetService.FLEET_SESSION_EXPORT_MAX_ROWS)} rows. The start time range covers at most ${String(FLEET_SESSION_EXPORT_MAX_DAYS)} days: to defaults to now and from to ${String(FLEET_SESSION_EXPORT_MAX_DAYS)} days before it; a longer range answers 400 VALIDATION_ERROR. Columns: sessionId, startedAt, endedAt, status, site, station, unit, evse, connector, connectorType, driver (name; an erased member reads Erased driver in the exporting user's language), cardLabel (the label of a fleet RFID card), energyKwh; cost and currency only with payments:read; rfidCard and transactionId for operators only, never for a fleet user. Every text cell is formula safe. 10 exports a minute per user. A fleet user reaches only its assigned fleets (else 404 FLEET_NOT_FOUND).`,
        operationId: 'exportFleetSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(z.object(fleetSessionFilterQuery)),
        response: {
          400: errorWith('Invalid filter or range', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      if (!(await requireFleetAccess(request, reply, id))) return;
      const { driverId, tokenId, ...range } = request.query as z.infer<
        z.ZodObject<typeof fleetSessionFilterQuery>
      >;
      const reader = await fleetReaderOf(request);
      const rows = await fleetService.listFleetSessionsForExport(id, reader, {
        ...fleetSessionExportRange(parseLogTimeRange(range)),
        driverId,
        tokenId,
      });
      const { userId } = request.user as { userId: string };
      const csv = fleetSessionsCsv(rows, {
        cost: await requestHasPermission(request, 'payments:read'),
        operator: reader.kind === 'sites',
        language: await userLanguage(userId, request.log),
      });
      await reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename=fleet-sessions.csv')
        .send(csv);
    },
  );

  app.get(
    '/fleets/:id/sessions/:sessionId',
    {
      onRequest: [authorize('fleets:read', 'sessions:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'Get a session of a fleet',
        description:
          'One session of the fleet session list in a reduced view: site, station, EVSE, times, energy, the driver name and the label of a fleet RFID card, and the cost only with payments:read. Never the RFID value, a payment record, meter values or OCPP data. A session outside the fleet session list of the caller answers 404 SESSION_NOT_FOUND; a fleet user reaches only its assigned fleets (else 404 FLEET_NOT_FOUND).',
        operationId: 'getFleetSession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetSessionParams),
        response: {
          200: itemResponse(fleetSessionDetailItem),
          404: errorWith('Fleet or session not found', [
            ERROR_CODES.FLEET_NOT_FOUND,
            ERROR_CODES.SESSION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, sessionId } = request.params as z.infer<typeof fleetSessionParams>;
      if (!(await requireFleetAccess(request, reply, id))) return;
      const session = await fleetService.getFleetSession(
        id,
        sessionId,
        await fleetReaderOf(request),
        await requestHasPermission(request, 'payments:read'),
      );
      if (session == null) {
        await reply.status(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      return session;
    },
  );

  // --- Metrics ---

  app.get(
    '/fleets/:id/metrics',
    {
      onRequest: [authorize('fleets:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'Get fleet metrics',
        description:
          'Session, energy and driver metrics of the fleet, over the sessions of the fleet session list. For a user restricted to some sites the session figures count only the sessions at those sites. A fleet user reaches only its assigned fleets (else 404 FLEET_NOT_FOUND).',
        operationId: 'getFleetMetrics',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(metricsQuery),
        response: {
          200: itemResponse(fleetMetricsItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      if (!(await requireFleetAccess(request, reply, id))) return;
      const { months } = request.query as z.infer<typeof metricsQuery>;
      return fleetService.getFleetMetrics(id, months, await fleetReaderOf(request));
    },
  );

  // --- Energy History ---

  app.get(
    '/fleets/:id/energy-history',
    {
      onRequest: [authorize('fleets:read')],
      config: { fleetScope: true },
      schema: {
        tags: ['Fleets'],
        summary: 'Get fleet energy delivery history',
        description:
          'Energy delivered per day over the sessions of the fleet session list. For a user restricted to some sites only the sessions at those sites count. A fleet user reaches only its assigned fleets (else 404 FLEET_NOT_FOUND).',
        operationId: 'getFleetEnergyHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(fleetParams),
        querystring: zodSchema(energyHistoryQuery),
        response: {
          200: arrayResponse(energyHistoryItem),
          404: errorWith('Fleet not found', [ERROR_CODES.FLEET_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof fleetParams>;
      if (!(await requireFleetAccess(request, reply, id))) return;
      const { days } = request.query as z.infer<typeof energyHistoryQuery>;
      return fleetService.getFleetEnergyHistory(id, days, await fleetReaderOf(request));
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
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_PRICING_GROUP_NOT_FOUND))) return;
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
            ERROR_CODES.PRICING_GROUP_NOT_FOUND,
            ERROR_CODES.PRICING_ASSIGNMENT_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_PRICING_GROUP_NOT_FOUND))) return;
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
