// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hash } from 'argon2';
import { eq, or, ilike, and, sql, gte, desc, count, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db, writeAudit, stationAuditLog } from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import {
  chargingStations,
  evses,
  connectors,
  chargingSessions,
  drivers,
  meterValues,
  sites,
  vendors,
  ocppMessageLogs,
  connectionLogs,
  stationCertificates,
  pricingGroupStations,
  pricingGroups,
  securityEvents,
  stationEvents,
  stationConfigurations,
  firmwareUpdates,
  firmwareCampaigns,
  chargingProfiles,
  evChargingNeeds,
  variableMonitoringRules,
  eventAlerts,
  chargingProfileTemplates,
  configTemplates,
  guestSessions,
  pricingAssignmentAuditLog,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getPubSub } from '../lib/pubsub.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { getUserSiteIds, checkStationSiteAccess } from '../lib/site-access.js';
import { sendOcppCommandAndWait, triggerAndWaitForStatus } from '../lib/ocpp-command.js';
import { enableCssPair, disableCssPair } from '../lib/css-pairing.js';
import { authorize } from '../middleware/rbac.js';
import type { JwtPayload } from '../plugins/auth.js';

const stationParams = z.object({
  id: ID_PARAMS.stationId.describe('Station ID'),
});

const stationPricingGroupItem = z
  .object({
    id: z.string().describe('Pricing group identifier'),
    name: z.string().describe('Pricing group display name'),
    description: z
      .string()
      .nullable()
      .describe('Operator-provided description of the pricing group'),
    isDefault: z
      .boolean()
      .describe('Whether this is the default pricing group used when no other group matches'),
    tariffCount: z.number().describe('Number of tariffs configured under this pricing group'),
  })
  .passthrough();

const stationPricingGroupRecordItem = z
  .object({
    stationId: z.string().describe('Internal station identifier (nanoid)'),
    pricingGroupId: z.string().describe('Pricing group identifier assigned to the station'),
  })
  .passthrough();

const addStationPricingGroupBody = z.object({
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID to assign to the station'),
});

const stationPricingGroupParams = z.object({
  id: ID_PARAMS.stationId.describe('Station ID'),
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID'),
});

const stationMeterValueItem = z
  .object({
    id: z.number().describe('Meter value row ID'),
    timestamp: z.coerce.date().describe('Timestamp when the meter sample was taken on the station'),
    measurand: z
      .string()
      .nullable()
      .describe('OCPP measurand name (e.g., Energy.Active.Import.Register, Power.Active.Import)'),
    value: z.string().describe('Reported numeric value (stored as string to preserve precision)'),
    unit: z.string().nullable().describe('Unit of measure (e.g., Wh, W, A, V)'),
    phase: z
      .string()
      .nullable()
      .describe('Electrical phase the value applies to (L1, L2, L3, N, etc.)'),
    location: z
      .string()
      .nullable()
      .describe('Physical location of the meter (Body, Cable, EV, Inlet, Outlet)'),
    context: z
      .string()
      .nullable()
      .describe('Reading context (e.g., Sample.Periodic, Transaction.Begin, Transaction.End)'),
  })
  .passthrough();

const stationMeterValueQuery = paginationQuery.extend({
  measurand: z.string().optional().describe('Filter by measurand name'),
});

const stationListQuery = paginationQuery.merge(
  z.object({
    siteId: ID_PARAMS.siteId.optional().describe('Filter by site ID'),
    status: z
      .enum(['charging', 'reserved', 'faulted', 'available', 'unavailable', 'unknown'])
      .optional()
      .describe('Filter by derived station status'),
    onboardingStatus: z
      .enum(['pending', 'accepted', 'blocked'])
      .optional()
      .describe('Filter by onboarding status'),
    isOnline: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional()
      .describe('Filter by online/offline state'),
    isSimulator: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional()
      .describe('Filter by simulator flag'),
  }),
);

const createStationBody = z.object({
  stationId: z.string().min(1).max(255).describe('OCPP station identifier'),
  model: z.string().max(255).optional(),
  serialNumber: z.string().max(255).optional(),
  vendorId: ID_PARAMS.vendorId.optional().describe('Vendor ID'),
  siteId: ID_PARAMS.siteId.optional().describe('Site ID to assign the station to'),
  ocppProtocol: z
    .enum(['ocpp1.6', 'ocpp2.1'])
    .optional()
    .default('ocpp1.6')
    .describe('OCPP protocol version (defaults to ocpp1.6)'),
  securityProfile: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe('OCPP security profile (0=none, 1=basic auth, 2=TLS+basic auth, 3=mTLS)'),
  password: z.string().min(8).max(128).optional().describe('Basic auth password for SP1/SP2'),
  isSimulator: z.boolean().optional().describe('Whether this station is a simulator'),
  latitude: z.string().max(20).optional().describe('Station latitude'),
  longitude: z.string().max(20).optional().describe('Station longitude'),
});

const updateStationBody = z.object({
  model: z.string().max(255).optional(),
  serialNumber: z.string().max(255).optional(),
  availability: z
    .enum(['available', 'unavailable', 'faulted'])
    .optional()
    .describe('Station availability status'),
  siteId: ID_PARAMS.siteId.nullable().optional().describe('Site ID to assign the station to'),
  securityProfile: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe('OCPP security profile (0=none, 1=basic auth, 2=TLS+basic auth, 3=mTLS)'),
  password: z.string().min(8).max(128).optional().describe('Basic auth password for SP1/SP2'),
  isSimulator: z.boolean().optional().describe('Whether this station is a simulator'),
  latitude: z.string().max(20).optional().describe('Station latitude'),
  longitude: z.string().max(20).optional().describe('Station longitude'),
  reservationsEnabled: z
    .boolean()
    .optional()
    .describe('Whether reservations are allowed at this station'),
});

const setCredentialsBody = z.object({
  password: z.string().min(8).max(128),
});

const stationItem = z
  .object({
    id: z.string().describe('Internal station identifier (nanoid)'),
    stationId: z
      .string()
      .max(255)
      .describe('OCPP station identity used by the charging station to authenticate'),
    siteId: z.string().nullable().describe('Site this station belongs to, if any'),
    vendorId: z.string().nullable().describe('Vendor (manufacturer) identifier, if known'),
    model: z.string().max(100).nullable().describe('Manufacturer model name'),
    serialNumber: z.string().max(100).nullable().describe('Manufacturer serial number'),
    firmwareVersion: z.string().max(50).nullable().describe('Currently installed firmware version'),
    iccid: z.string().max(20).nullable().describe('SIM card ICCID for cellular-connected stations'),
    imsi: z.string().max(20).nullable().describe('SIM card IMSI for cellular-connected stations'),
    availability: z
      .enum(['available', 'unavailable', 'faulted'])
      .describe('Operator-controlled availability state'),
    onboardingStatus: z
      .enum(['pending', 'accepted', 'blocked'])
      .describe('Provisioning lifecycle state (pending awaiting approval, accepted, blocked)'),
    lastHeartbeat: z.coerce
      .date()
      .nullable()
      .describe('Timestamp of the last OCPP Heartbeat received from the station'),
    isOnline: z.boolean().describe('Whether the station is currently connected via WebSocket'),
    isSimulator: z
      .boolean()
      .describe('Whether this station is backed by the built-in CSS simulator'),
    loadPriority: z
      .number()
      .int()
      .min(1)
      .max(10)
      .describe('Load management priority (1 = lowest, 10 = highest)'),
    securityProfile: z
      .number()
      .int()
      .min(0)
      .max(3)
      .describe('OCPP security profile: 0=plain, 1=Basic Auth, 2=TLS+Basic, 3=mTLS'),
    ocppProtocol: z
      .enum(['ocpp1.6', 'ocpp2.1'])
      .nullable()
      .describe('OCPP protocol version negotiated with the station'),
    hasPassword: z
      .boolean()
      .describe('Whether a Basic Auth password is configured for this station'),
    metadata: z
      .record(z.unknown())
      .nullable()
      .describe('Free-form operator metadata stored as a JSON object'),
    createdAt: z.coerce.date().describe('When the station record was created'),
    updatedAt: z.coerce.date().describe('When the station record was last updated'),
    status: z
      .string()
      .max(50)
      .describe(
        'Derived station status across all connectors (charging, reserved, faulted, available, unavailable, unknown)',
      ),
    connectorCount: z
      .number()
      .int()
      .min(0)
      .describe('Total number of connectors across all EVSEs on this station'),
    connectorTypes: z
      .array(z.string().max(50))
      .max(20)
      .nullable()
      .describe('Distinct connector types present on this station'),
    siteFreeVendEnabled: z
      .boolean()
      .describe("Whether the station's site has free vend mode enabled"),
  })
  .passthrough();

const stationDetail = z
  .object({
    id: z.string().describe('Internal station identifier (nanoid)'),
    stationId: z
      .string()
      .max(255)
      .describe('OCPP station identity used by the charging station to authenticate'),
    siteId: z.string().nullable().describe('Site this station belongs to, if any'),
    vendorId: z.string().nullable().describe('Vendor (manufacturer) identifier, if known'),
    vendorName: z
      .string()
      .max(255)
      .nullable()
      .describe('Vendor display name (joined from the vendors table)'),
    model: z.string().max(100).nullable().describe('Manufacturer model name'),
    serialNumber: z.string().max(100).nullable().describe('Manufacturer serial number'),
    firmwareVersion: z.string().max(50).nullable().describe('Currently installed firmware version'),
    iccid: z.string().max(20).nullable().describe('SIM card ICCID for cellular-connected stations'),
    imsi: z.string().max(20).nullable().describe('SIM card IMSI for cellular-connected stations'),
    availability: z
      .enum(['available', 'unavailable', 'faulted'])
      .describe('Operator-controlled availability state'),
    onboardingStatus: z
      .enum(['pending', 'accepted', 'blocked'])
      .describe('Provisioning lifecycle state (pending awaiting approval, accepted, blocked)'),
    lastHeartbeat: z.coerce
      .date()
      .nullable()
      .describe('Timestamp of the last OCPP Heartbeat received from the station'),
    isOnline: z.boolean().describe('Whether the station is currently connected via WebSocket'),
    isSimulator: z
      .boolean()
      .describe('Whether this station is backed by the built-in CSS simulator'),
    loadPriority: z
      .number()
      .int()
      .min(1)
      .max(10)
      .describe('Load management priority (1 = lowest, 10 = highest)'),
    securityProfile: z
      .number()
      .int()
      .min(0)
      .max(3)
      .describe('OCPP security profile: 0=plain, 1=Basic Auth, 2=TLS+Basic, 3=mTLS'),
    ocppProtocol: z
      .enum(['ocpp1.6', 'ocpp2.1'])
      .nullable()
      .describe('OCPP protocol version negotiated with the station'),
    hasPassword: z
      .boolean()
      .describe('Whether a Basic Auth password is configured for this station'),
    metadata: z
      .record(z.unknown())
      .nullable()
      .describe('Free-form operator metadata stored as a JSON object'),
    createdAt: z.coerce.date().describe('When the station record was created'),
    updatedAt: z.coerce.date().describe('When the station record was last updated'),
    status: z
      .string()
      .max(50)
      .describe(
        'Derived station status across all connectors (charging, reserved, faulted, available, unavailable, unknown)',
      ),
    siteHoursOfOperation: z
      .string()
      .max(500)
      .nullable()
      .describe("Free-form text describing the site's hours of operation"),
    siteFreeVendEnabled: z
      .boolean()
      .describe("Whether the station's site has free vend mode enabled"),
  })
  .passthrough();

const stationCreated = z
  .object({
    id: z.string().describe('Internal station identifier (nanoid)'),
    stationId: z
      .string()
      .max(255)
      .describe('OCPP station identity used by the charging station to authenticate'),
    siteId: z.string().nullable().describe('Site this station belongs to, if any'),
    vendorId: z.string().nullable().describe('Vendor (manufacturer) identifier, if known'),
    model: z.string().max(100).nullable().describe('Manufacturer model name'),
    serialNumber: z.string().max(100).nullable().describe('Manufacturer serial number'),
    firmwareVersion: z.string().max(50).nullable().describe('Currently installed firmware version'),
    availability: z
      .enum(['available', 'unavailable', 'faulted'])
      .describe('Operator-controlled availability state'),
    onboardingStatus: z
      .enum(['pending', 'accepted', 'blocked'])
      .describe('Provisioning lifecycle state (pending awaiting approval, accepted, blocked)'),
    isOnline: z.boolean().describe('Whether the station is currently connected via WebSocket'),
    isSimulator: z
      .boolean()
      .describe('Whether this station is backed by the built-in CSS simulator'),
    loadPriority: z
      .number()
      .int()
      .min(1)
      .max(10)
      .describe('Load management priority (1 = lowest, 10 = highest)'),
    securityProfile: z
      .number()
      .int()
      .min(0)
      .max(3)
      .describe('OCPP security profile: 0=plain, 1=Basic Auth, 2=TLS+Basic, 3=mTLS'),
    hasPassword: z
      .boolean()
      .describe('Whether a Basic Auth password is configured for this station'),
    createdAt: z.coerce.date().describe('When the station record was created'),
    updatedAt: z.coerce.date().describe('When the station record was last updated'),
  })
  .passthrough();

const connectorDetail = z
  .object({
    connectorId: z.number().int().min(1).describe('OCPP connector ID within the EVSE (1-based)'),
    connectorType: z
      .string()
      .max(50)
      .nullable()
      .describe('Physical connector type (CCS2, CHAdeMO, Type2, Type1, GBT, Tesla, NACS)'),
    maxPowerKw: z.number().min(0).nullable().describe('Maximum charging power in kilowatts'),
    maxCurrentAmps: z.number().min(0).nullable().describe('Maximum charging current in amps'),
    status: z
      .string()
      .max(50)
      .describe('Current connector operational status (available, charging, faulted, etc.)'),
    autoCreated: z
      .boolean()
      .describe('Whether the connector was created automatically from an OCPP StatusNotification'),
    isIdling: z
      .boolean()
      .describe(
        'Whether an active session on this connector has entered idle (paused) state and is accruing idle time',
      ),
  })
  .passthrough();

const evseDetail = z
  .object({
    evseId: z.number().describe('OCPP EVSE id (1-based)'),
    autoCreated: z
      .boolean()
      .describe('Whether the EVSE was created automatically from an OCPP message'),
    connectors: z.array(connectorDetail).describe('Connectors on this EVSE'),
  })
  .passthrough();

const evseResponse = z
  .object({
    evseId: z.number().describe('OCPP EVSE id (1-based)'),
    connectors: z
      .array(
        z
          .object({
            connectorId: z.number().describe('OCPP connector ID within the EVSE (1-based)'),
            connectorType: z
              .string()
              .nullable()
              .describe('Physical connector type (CCS2, CHAdeMO, Type2, Type1, GBT, Tesla, NACS)'),
            maxPowerKw: z.number().nullable().describe('Maximum charging power in kilowatts'),
            maxCurrentAmps: z.number().nullable().describe('Maximum charging current in amps'),
            status: z.string().describe('Current connector operational status'),
          })
          .passthrough(),
      )
      .describe('Connectors on this EVSE'),
  })
  .passthrough();

const connectorResponse = z
  .object({
    connectorId: z.number().describe('OCPP connector ID within the EVSE (1-based)'),
    connectorType: z
      .string()
      .nullable()
      .describe('Physical connector type (CCS2, CHAdeMO, Type2, Type1, GBT, Tesla, NACS)'),
    maxPowerKw: z.number().nullable().describe('Maximum charging power in kilowatts'),
    maxCurrentAmps: z.number().nullable().describe('Maximum charging current in amps'),
    status: z.string().describe('Current connector operational status'),
  })
  .passthrough();

const deleteResponse = z
  .object({ status: z.string().describe('Result of the delete operation (e.g., "deleted")') })
  .passthrough();

const meterValueGroup = z
  .object({
    measurand: z.string().describe('OCPP measurand name this group of samples belongs to'),
    unit: z.string().nullable().describe('Unit of measure for the values in this group'),
    values: z
      .array(
        z
          .object({
            timestamp: z.coerce.date().describe('Timestamp when the sample was taken'),
            value: z.string().describe('Sample value (string to preserve numeric precision)'),
          })
          .passthrough(),
      )
      .describe('Time-ordered list of meter samples for this measurand'),
  })
  .passthrough();

const energyHistoryItem = z
  .object({
    date: z.string().describe('Calendar date in YYYY-MM-DD (in the site timezone)'),
    energyWh: z.number().describe('Total energy delivered on that date in watt-hours'),
  })
  .passthrough();

const revenueHistoryItem = z
  .object({
    date: z.string().describe('Calendar date in YYYY-MM-DD (in the site timezone)'),
    revenueCents: z
      .number()
      .int()
      .min(0)
      .describe('Total revenue collected on that date in the smallest currency unit (cents)'),
    sessionCount: z.number().describe('Number of revenue-generating sessions on that date'),
  })
  .passthrough();

const stationMetricsResponse = z
  .object({
    uptimePercent: z
      .number()
      .describe('NEVI-formula uptime percentage averaged across all ports for the period'),
    portCount: z.number().describe('Number of ports (EVSEs) on the station'),
    utilizationPercent: z
      .number()
      .describe(
        'Percentage of available port-hours spent actively charging (0-100, can exceed 100 for overlapping sessions)',
      ),
    totalSessions: z.number().describe('Total number of charging sessions in the period'),
    completedSessions: z
      .number()
      .describe('Number of sessions that completed successfully in the period'),
    faultedSessions: z.number().describe('Number of sessions that ended in a faulted state'),
    sessionSuccessPercent: z
      .number()
      .describe('Percentage of sessions that completed successfully (0-100)'),
    totalEnergyWh: z.number().describe('Total energy delivered in the period in watt-hours'),
    avgSessionDurationMinutes: z
      .number()
      .describe('Average duration of completed sessions in minutes'),
    disconnectCount: z
      .number()
      .describe('Number of times the station disconnected from the CSMS in the period'),
    avgDowntimeMinutes: z.number().describe('Average downtime per disconnect in minutes'),
    maxDowntimeMinutes: z.number().describe('Longest single downtime period in minutes'),
    totalRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe('Total revenue in the period in the smallest currency unit (cents)'),
    avgRevenueCentsPerSession: z
      .number()
      .describe('Average revenue per session in the smallest currency unit (cents)'),
    totalTransactions: z
      .number()
      .describe('Number of revenue-generating transactions in the period'),
    periodMonths: z.number().describe('Number of months covered by these metrics'),
  })
  .passthrough();

const sessionItem = z
  .object({
    id: z.string().describe('Internal session identifier (nanoid)'),
    stationId: z.string().describe('Internal station identifier (nanoid) the session belongs to'),
    stationName: z.string().nullable().describe('OCPP station identity for display'),
    siteName: z.string().nullable().describe('Name of the site this station belongs to'),
    driverId: z
      .string()
      .nullable()
      .describe('Internal driver identifier, null for guest or free-vend sessions'),
    driverName: z
      .string()
      .nullable()
      .describe('Driver full name (first + last), null for guest or free-vend sessions'),
    transactionId: z.string().nullable().describe('OCPP transaction id reported by the station'),
    status: z.string().describe('Session status (active, completed, failed, faulted)'),
    startedAt: z.coerce.date().describe('When the session started'),
    endedAt: z.coerce.date().nullable().describe('When the session ended, null if still active'),
    energyDeliveredWh: z.coerce
      .number()
      .nullable()
      .describe('Total energy delivered in the session in watt-hours'),
    currentCostCents: z
      .number()
      .nullable()
      .describe('Running cost of the session in the smallest currency unit (cents)'),
    finalCostCents: z
      .number()
      .nullable()
      .describe('Final cost after the session ended in the smallest currency unit (cents)'),
    currency: z.string().nullable().describe('ISO 4217 currency code for cost fields'),
    isGuestSession: z
      .boolean()
      .describe('Whether this session was started by an unauthenticated guest with a card payment'),
  })
  .passthrough();

const ocppLogItem = z
  .object({
    id: z.string().describe('OCPP log row identifier'),
    stationId: z.string().describe('Internal station identifier (nanoid) the message belongs to'),
    action: z
      .string()
      .nullable()
      .describe('OCPP action name (e.g., BootNotification, Heartbeat, TransactionEvent)'),
    direction: z
      .string()
      .describe('Message direction (inbound = from station to CSMS, outbound = CSMS to station)'),
    messageId: z
      .string()
      .nullable()
      .describe('OCPP message id used to correlate request and response'),
    payload: z.unknown().describe('Raw OCPP payload object'),
    createdAt: z.coerce.date().describe('When the message was logged'),
  })
  .passthrough();

const ocppLogsResponse = z
  .object({
    data: z.array(ocppLogItem).describe('Page of OCPP log entries'),
    total: z.number().describe('Total number of matching log entries across all pages'),
    actions: z
      .array(z.string())
      .describe('Distinct OCPP action names seen on this station, for filter dropdowns'),
  })
  .passthrough();

const securityLogItem = z
  .object({
    id: z.string().describe('Security log row identifier'),
    event: z
      .string()
      .describe(
        'Security event type (auth_failed, password_changed, credentials_rotated, connected, disconnected)',
      ),
    remoteAddress: z
      .string()
      .nullable()
      .describe('Remote IP address of the station when the event occurred, if available'),
    metadata: z.record(z.unknown()).nullable().describe('Event-specific metadata as a JSON object'),
    createdAt: z.coerce.date().describe('When the event was recorded'),
  })
  .passthrough();

const certificateItem = z
  .object({
    id: z.string().describe('Station certificate row identifier'),
    stationId: z
      .string()
      .describe('Internal station identifier (nanoid) the certificate belongs to'),
    certificateType: z
      .string()
      .describe(
        'Certificate type (e.g., V2GRootCertificate, ChargingStationCertificate, CSMSRootCertificate)',
      ),
    status: z.string().describe('Certificate lifecycle status (active, expired, revoked)'),
    createdAt: z.coerce.date().describe('When the certificate was first stored'),
    updatedAt: z.coerce.date().describe('When the certificate record was last updated'),
  })
  .passthrough();

export function stationRoutes(app: FastifyInstance): void {
  app.get(
    '/stations',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List all stations',
        operationId: 'listStations',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(stationListQuery),
        response: { 200: paginatedResponse(stationItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof stationListQuery>;
      const { page, limit, search, siteId, isOnline, isSimulator, onboardingStatus } = query;
      const statusFilter = query.status;
      const offset = (page - 1) * limit;

      const { userId } = request.user as JwtPayload;
      const accessibleSiteIds = await getUserSiteIds(userId);
      if (accessibleSiteIds != null && accessibleSiteIds.length === 0) {
        return { data: [], total: 0 };
      }

      const conditions = [];
      if (accessibleSiteIds != null) {
        conditions.push(
          or(isNull(chargingStations.siteId), inArray(chargingStations.siteId, accessibleSiteIds)),
        );
      }
      if (siteId != null) {
        conditions.push(eq(chargingStations.siteId, siteId));
      }
      if (search) {
        const pattern = `%${search}%`;
        conditions.push(
          or(
            ilike(chargingStations.id, pattern),
            ilike(chargingStations.stationId, pattern),
            ilike(chargingStations.model, pattern),
          ),
        );
      }
      if (isOnline != null) {
        conditions.push(eq(chargingStations.isOnline, isOnline));
      }
      if (isSimulator != null) {
        conditions.push(eq(chargingStations.isSimulator, isSimulator));
      }
      if (onboardingStatus != null) {
        conditions.push(eq(chargingStations.onboardingStatus, onboardingStatus));
      }

      // Subquery-based derived status avoids multiplicative JOIN expansion
      const derivedStatusSubquery = sql<string>`(
        SELECT CASE
          WHEN COUNT(c2.id) FILTER (WHERE c2.status IN ('occupied', 'charging', 'preparing', 'ev_connected', 'suspended_ev', 'suspended_evse')) > 0 THEN 'charging'
          WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'reserved') > 0 THEN 'reserved'
          WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'faulted') > 0 THEN 'faulted'
          WHEN COUNT(c2.id) = 0 THEN 'unknown'
          WHEN COUNT(c2.id) FILTER (WHERE c2.status = 'available') = COUNT(c2.id) THEN 'available'
          ELSE 'unavailable'
        END
        FROM ${evses} e2
        JOIN ${connectors} c2 ON c2.evse_id = e2.id
        WHERE e2.station_id = ${chargingStations.id}
      )`;

      if (statusFilter != null) {
        conditions.push(sql`${derivedStatusSubquery} = ${statusFilter}`);
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const baseQuery = db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          vendorId: chargingStations.vendorId,
          vendorName: vendors.name,
          model: chargingStations.model,
          serialNumber: chargingStations.serialNumber,
          firmwareVersion: chargingStations.firmwareVersion,
          iccid: chargingStations.iccid,
          imsi: chargingStations.imsi,
          availability: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
          lastHeartbeat: chargingStations.lastHeartbeat,
          isOnline: chargingStations.isOnline,
          isSimulator: chargingStations.isSimulator,
          loadPriority: chargingStations.loadPriority,
          securityProfile: chargingStations.securityProfile,
          ocppProtocol: chargingStations.ocppProtocol,
          hasPassword: sql<boolean>`${chargingStations.basicAuthPasswordHash} IS NOT NULL`,
          metadata: chargingStations.metadata,
          createdAt: chargingStations.createdAt,
          updatedAt: chargingStations.updatedAt,
          status: derivedStatusSubquery,
          connectorCount: sql<number>`(
            SELECT COUNT(c3.id)::int
            FROM ${evses} e3
            JOIN ${connectors} c3 ON c3.evse_id = e3.id
            WHERE e3.station_id = ${chargingStations.id}
          )`,
          connectorTypes: sql<string[]>`(
            SELECT array_agg(DISTINCT c4.connector_type)
            FROM ${evses} e4
            JOIN ${connectors} c4 ON c4.evse_id = e4.id
            WHERE e4.station_id = ${chargingStations.id}
            AND c4.connector_type IS NOT NULL
          )`,
          siteFreeVendEnabled: sql<boolean>`coalesce(${sites.freeVendEnabled}, false)`,
        })
        .from(chargingStations)
        .leftJoin(vendors, eq(vendors.id, chargingStations.vendorId))
        .leftJoin(sites, eq(sites.id, chargingStations.siteId))
        .where(where);

      const data = await baseQuery.limit(limit).offset(offset);

      const countResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(chargingStations)
        .where(where);

      return { data, total: countResult[0]?.count ?? 0 };
    },
  );

  app.get(
    '/stations/:id',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get a station by ID',
        operationId: 'getStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: itemResponse(stationDetail),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const derivedStatus = sql<string>`CASE
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} IN ('occupied', 'charging', 'preparing', 'ev_connected', 'suspended_ev', 'suspended_evse')) > 0 THEN 'charging'
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'reserved') > 0 THEN 'reserved'
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'faulted') > 0 THEN 'faulted'
        WHEN COUNT(${connectors.id}) = 0 THEN 'unknown'
        WHEN COUNT(${connectors.id}) FILTER (WHERE ${connectors.status} = 'available') = COUNT(${connectors.id}) THEN 'available'
        ELSE 'unavailable'
      END`;
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          siteId: chargingStations.siteId,
          vendorId: chargingStations.vendorId,
          vendorName: vendors.name,
          model: chargingStations.model,
          serialNumber: chargingStations.serialNumber,
          firmwareVersion: chargingStations.firmwareVersion,
          iccid: chargingStations.iccid,
          imsi: chargingStations.imsi,
          availability: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
          lastHeartbeat: chargingStations.lastHeartbeat,
          isOnline: chargingStations.isOnline,
          isSimulator: chargingStations.isSimulator,
          loadPriority: chargingStations.loadPriority,
          securityProfile: chargingStations.securityProfile,
          ocppProtocol: chargingStations.ocppProtocol,
          hasPassword: sql<boolean>`${chargingStations.basicAuthPasswordHash} IS NOT NULL`,
          metadata: chargingStations.metadata,
          createdAt: chargingStations.createdAt,
          updatedAt: chargingStations.updatedAt,
          status: derivedStatus,
          siteHoursOfOperation: sites.hoursOfOperation,
          siteFreeVendEnabled: sql<boolean>`coalesce(${sites.freeVendEnabled}, false)`,
          latitude: chargingStations.latitude,
          longitude: chargingStations.longitude,
          reservationsEnabled: chargingStations.reservationsEnabled,
        })
        .from(chargingStations)
        .leftJoin(vendors, eq(vendors.id, chargingStations.vendorId))
        .leftJoin(sites, eq(sites.id, chargingStations.siteId))
        .leftJoin(evses, eq(evses.stationId, chargingStations.id))
        .leftJoin(connectors, eq(connectors.evseId, evses.id))
        .where(eq(chargingStations.id, id))
        .groupBy(chargingStations.id, vendors.name, sites.hoursOfOperation, sites.freeVendEnabled);
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && station.siteId != null && !siteIds.includes(station.siteId)) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      return station;
    },
  );

  // Refresh station configurations via OCPP
  app.post(
    '/stations/:id/configurations/refresh',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Refresh station configurations from the station via OCPP',
        description:
          'Dispatches GetConfiguration (OCPP 1.6) or GetBaseReport(FullInventory) (OCPP 2.1) to pull the current variable set. The station response is processed asynchronously by the event projection, which upserts rows in station_configurations. Returns 400 if the station is offline and 502 if the station rejects the command.',
        operationId: 'refreshStationConfigurations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          400: errorWith('Station offline', [ERROR_CODES.STATION_OFFLINE]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          502: errorWith('Ocpp command failed', [ERROR_CODES.OCPP_COMMAND_FAILED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      let result;
      if (station.ocppProtocol === 'ocpp1.6') {
        result = await sendOcppCommandAndWait(station.stationId, 'GetConfiguration', {}, '1.6');
      } else {
        result = await sendOcppCommandAndWait(
          station.stationId,
          'GetBaseReport',
          {
            requestId: Math.floor(Math.random() * 2147483647),
            reportBase: 'FullInventory',
          },
          '2.1',
        );
      }

      if (result.error != null) {
        await reply.status(502).send({ error: result.error, code: 'OCPP_COMMAND_FAILED' });
        return;
      }

      return { success: true };
    },
  );

  app.post(
    '/stations',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Create a new station',
        operationId: 'createStation',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createStationBody),
        response: {
          201: itemResponse(stationCreated),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          409: errorWith('Station id exists', [ERROR_CODES.STATION_ID_EXISTS]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createStationBody>;
      if (body.siteId != null) {
        const { userId } = request.user as JwtPayload;
        const siteIds = await getUserSiteIds(userId);
        if (siteIds != null && !siteIds.includes(body.siteId)) {
          await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
          return;
        }
      }

      // Pre-check station_id uniqueness so the client gets a friendly 409
      // instead of a 500 from a Postgres unique violation.
      const [existing] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, body.stationId));
      if (existing != null) {
        await reply.status(409).send({
          error: 'A station with this ID already exists',
          code: 'STATION_ID_EXISTS',
        });
        return;
      }

      const { password, ...insertFields } = body;
      const basicAuthPasswordHash = password != null ? await hash(password) : undefined;

      // The chargingStations INSERT and the css_stations pairing must commit
      // atomically. Without the transaction, a failure inside enableCssPair
      // leaves an orphan charging_stations row, which then trips the unique
      // constraint on retry and the operator gets a confusing duplicate error.
      const station = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(chargingStations)
          .values({
            ...insertFields,
            ...(basicAuthPasswordHash != null ? { basicAuthPasswordHash } : {}),
          })
          .returning({
            id: chargingStations.id,
            stationId: chargingStations.stationId,
            siteId: chargingStations.siteId,
            vendorId: chargingStations.vendorId,
            model: chargingStations.model,
            serialNumber: chargingStations.serialNumber,
            firmwareVersion: chargingStations.firmwareVersion,
            availability: chargingStations.availability,
            onboardingStatus: chargingStations.onboardingStatus,
            isOnline: chargingStations.isOnline,
            isSimulator: chargingStations.isSimulator,
            loadPriority: chargingStations.loadPriority,
            securityProfile: chargingStations.securityProfile,
            ocppProtocol: chargingStations.ocppProtocol,
            createdAt: chargingStations.createdAt,
            updatedAt: chargingStations.updatedAt,
          });

        if (created != null && created.isSimulator) {
          await enableCssPair(
            {
              stationId: created.stationId,
              ocppProtocol: created.ocppProtocol === 'ocpp2.1' ? 'ocpp2.1' : 'ocpp1.6',
              securityProfile: created.securityProfile,
              serverUrl: process.env['OCPP_SERVER_URL'] ?? 'ws://ocpp:8080',
              tlsServerUrl: process.env['OCPP_TLS_SERVER_URL'] ?? 'wss://ocpp:8443',
              password: password ?? null,
            },
            tx,
          );
        }

        // Auto-create an empty config template owned by this station. Cascade
        // delete is wired on the FK so removing the station also removes the
        // template.
        if (created != null) {
          const tplOcppVersion = created.ocppProtocol === 'ocpp2.1' ? '2.1' : '1.6';
          const tplFilter: {
            stationId: string;
            siteId?: string;
            vendorId?: string;
            model?: string;
          } = { stationId: created.id };
          if (created.siteId != null) tplFilter.siteId = created.siteId;
          if (created.vendorId != null) tplFilter.vendorId = created.vendorId;
          if (created.model != null) tplFilter.model = created.model;
          await tx.insert(configTemplates).values({
            name: `${created.stationId} - Configurations`,
            description: `Auto generated. ${created.stationId} configurations (OCPP ${tplOcppVersion})`,
            ocppVersion: tplOcppVersion,
            variables: [],
            stationId: created.id,
            targetFilter: tplFilter,
          });
        }

        return created;
      });

      if (station != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: stationAuditLog, idColumn: 'station_id' },
          {
            entityId: station.id,
            entityIdSnapshot: station.id,
            action: 'created',
            ...actor,
            after: station,
          },
          db,
          request.log,
        );
      }

      await reply.status(201).send({ ...station, hasPassword: basicAuthPasswordHash != null });
    },
  );

  app.patch(
    '/stations/:id',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Update a station',
        operationId: 'updateStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(updateStationBody),
        response: {
          200: itemResponse(stationCreated),
          400: errorWith('Password required', [ERROR_CODES.PASSWORD_REQUIRED]),
          404: errorWith('Resource not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null) {
        const [current] = await db
          .select({ siteId: chargingStations.siteId })
          .from(chargingStations)
          .where(eq(chargingStations.id, id));
        if (current == null) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
        if (current.siteId != null && !siteIds.includes(current.siteId)) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
      }
      const { password, ...body } = request.body as z.infer<typeof updateStationBody>;
      // Check access to the new siteId if being reassigned
      if (body.siteId != null && siteIds != null && !siteIds.includes(body.siteId)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      // Upgrading to SP1/SP2 requires a password if none is configured (SP3 uses client certs)
      if (
        body.securityProfile != null &&
        body.securityProfile >= 1 &&
        body.securityProfile < 3 &&
        password == null
      ) {
        const [existing] = await db
          .select({
            hasPassword: sql<boolean>`${chargingStations.basicAuthPasswordHash} IS NOT NULL`,
          })
          .from(chargingStations)
          .where(eq(chargingStations.id, id));
        if (existing != null && !existing.hasPassword) {
          await reply.status(400).send({
            error: 'Password required when upgrading to SP1 or SP2',
            code: 'PASSWORD_REQUIRED',
          });
          return;
        }
      }

      const updates: Record<string, unknown> = { ...body, updatedAt: new Date() };
      if (password != null) {
        updates.basicAuthPasswordHash = await hash(password);
      } else if (body.securityProfile === 0 || body.securityProfile === 3) {
        updates.basicAuthPasswordHash = null;
      }

      // When enabling simulator, ensure ocpp_protocol is set so the simulator can negotiate
      // a WebSocket subprotocol. Stations created without an explicit protocol default to 1.6.
      if (body.isSimulator === true) {
        const [current] = await db
          .select({ ocppProtocol: chargingStations.ocppProtocol })
          .from(chargingStations)
          .where(eq(chargingStations.id, id));
        if (current?.ocppProtocol == null) {
          updates.ocppProtocol = 'ocpp1.6';
        }
      }

      const [beforeStation] = await db
        .select()
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      // Run the chargingStations UPDATE and any css_stations sync atomically so
      // a failure in pairing rolls the parent update back instead of leaving
      // the two tables out of sync.
      const station = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(chargingStations)
          .set(updates)
          .where(eq(chargingStations.id, id))
          .returning({
            id: chargingStations.id,
            stationId: chargingStations.stationId,
            siteId: chargingStations.siteId,
            vendorId: chargingStations.vendorId,
            model: chargingStations.model,
            serialNumber: chargingStations.serialNumber,
            firmwareVersion: chargingStations.firmwareVersion,
            availability: chargingStations.availability,
            onboardingStatus: chargingStations.onboardingStatus,
            isOnline: chargingStations.isOnline,
            isSimulator: chargingStations.isSimulator,
            loadPriority: chargingStations.loadPriority,
            securityProfile: chargingStations.securityProfile,
            ocppProtocol: chargingStations.ocppProtocol,
            hasPassword: sql<boolean>`${chargingStations.basicAuthPasswordHash} IS NOT NULL`,
            createdAt: chargingStations.createdAt,
            updatedAt: chargingStations.updatedAt,
          });

        if (updated == null) return null;

        if (body.isSimulator !== undefined) {
          if (body.isSimulator) {
            await enableCssPair(
              {
                stationId: updated.stationId,
                ocppProtocol: updated.ocppProtocol === 'ocpp2.1' ? 'ocpp2.1' : 'ocpp1.6',
                securityProfile: updated.securityProfile,
                serverUrl: process.env['OCPP_SERVER_URL'] ?? 'ws://ocpp:8080',
                tlsServerUrl: process.env['OCPP_TLS_SERVER_URL'] ?? 'wss://ocpp:8443',
                password: password ?? null,
                // SP3 cert population is out of scope for this task
              },
              tx,
            );
          } else {
            await disableCssPair(updated.stationId, tx);
          }
        }

        return updated;
      });

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const actor = getAuditActor(request);
      // Determine the most specific action verb
      let action: string = 'updated';
      if (
        beforeStation != null &&
        body.availability != null &&
        body.availability !== beforeStation.availability
      ) {
        action = 'availability_changed';
      } else if (
        beforeStation != null &&
        body.isSimulator != null &&
        body.isSimulator !== beforeStation.isSimulator
      ) {
        action = 'simulator_toggled';
      }
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: station.id,
          entityIdSnapshot: station.id,
          action,
          ...actor,
          before: beforeStation ?? null,
          after: station,
        },
        db,
        request.log,
      );

      // Push security profile change to station via OCPP SetVariables (if online and profile changed)
      if (body.securityProfile != null && station.isOnline) {
        const setVariableData: Array<{
          component: { name: string };
          variable: { name: string };
          attributeValue: string;
        }> = [
          {
            component: { name: 'SecurityCtrlr' },
            variable: { name: 'SecurityProfile' },
            attributeValue: String(body.securityProfile),
          },
        ];

        if (password != null) {
          setVariableData.push({
            component: { name: 'SecurityCtrlr' },
            variable: { name: 'BasicAuthPassword' },
            attributeValue: password,
          });
        }

        const commandPayload = {
          commandId: randomUUID(),
          stationId: station.stationId,
          action: 'SetVariables',
          payload: { setVariableData },
        };

        await getPubSub().publish('ocpp_commands', JSON.stringify(commandPayload));

        // Reset the station so it reconnects with the new security profile
        const resetPayload = {
          commandId: randomUUID(),
          stationId: station.stationId,
          action: 'Reset',
          payload: { type: 'OnIdle' },
        };
        await getPubSub().publish('ocpp_commands', JSON.stringify(resetPayload));
      }

      return station;
    },
  );

  app.delete(
    '/stations/:id',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a station (marks as removed)',
        operationId: 'deleteStation',
        security: [{ bearerAuth: [] }],
        response: {
          200: zodSchema(stationCreated),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null) {
        const [current] = await db
          .select({ siteId: chargingStations.siteId })
          .from(chargingStations)
          .where(eq(chargingStations.id, id));
        if (current == null) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
        if (current.siteId != null && !siteIds.includes(current.siteId)) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
      }
      const [beforeStation] = await db
        .select()
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      const [station] = await db
        .update(chargingStations)
        .set({ onboardingStatus: 'blocked', updatedAt: new Date() })
        .where(eq(chargingStations.id, id))
        .returning();
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: station.id,
          entityIdSnapshot: station.id,
          action: 'deleted',
          ...actor,
          before: beforeStation ?? null,
          after: station,
        },
        db,
        request.log,
      );
      return {
        ...station,
        hasPassword: station.basicAuthPasswordHash != null,
      };
    },
  );

  app.get(
    '/stations/:id/connectors',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List EVSEs and connectors for a station',
        operationId: 'listStationConnectors',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: arrayResponse(evseDetail),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const rows = await db
        .select({
          evseId: evses.evseId,
          evseAutoCreated: evses.autoCreated,
          connectorId: connectors.connectorId,
          connectorType: connectors.connectorType,
          maxPowerKw: connectors.maxPowerKw,
          maxCurrentAmps: connectors.maxCurrentAmps,
          connectorStatus: connectors.status,
          connectorAutoCreated: connectors.autoCreated,
          isIdling: sql<boolean>`EXISTS (
            SELECT 1 FROM charging_sessions cs
            WHERE cs.connector_id = ${connectors.id}
              AND cs.status = 'active'
              AND cs.idle_started_at IS NOT NULL
          )`,
        })
        .from(evses)
        .leftJoin(connectors, eq(connectors.evseId, evses.id))
        .where(eq(evses.stationId, id))
        .orderBy(evses.evseId, connectors.connectorId);

      const grouped = new Map<
        number,
        {
          evseId: number;
          autoCreated: boolean;
          connectors: {
            connectorId: number;
            connectorType: string | null;
            maxPowerKw: string | null;
            maxCurrentAmps: number | null;
            status: string;
            autoCreated: boolean;
            isIdling: boolean;
          }[];
        }
      >();

      for (const row of rows) {
        if (!grouped.has(row.evseId)) {
          grouped.set(row.evseId, {
            evseId: row.evseId,
            autoCreated: row.evseAutoCreated,
            connectors: [],
          });
        }
        const evse = grouped.get(row.evseId);
        if (row.connectorId != null && evse != null) {
          evse.connectors.push({
            connectorId: row.connectorId,
            connectorType: row.connectorType,
            maxPowerKw: row.maxPowerKw,
            maxCurrentAmps: row.maxCurrentAmps,
            status: row.connectorStatus ?? 'unavailable',
            autoCreated: row.connectorAutoCreated ?? false,
            isIdling: row.isIdling,
          });
        }
      }

      return [...grouped.values()];
    },
  );

  const evseParams = z.object({
    id: ID_PARAMS.stationId.describe('Station ID'),
    evseId: z.coerce.number().int().min(1).describe('OCPP EVSE ID (integer)'),
  });

  const connectorParams = z.object({
    id: ID_PARAMS.stationId.describe('Station ID'),
    evseId: z.coerce.number().int().min(1).describe('OCPP EVSE ID (integer)'),
    connectorId: z.coerce.number().int().min(1).describe('OCPP connector ID (integer)'),
  });

  const connectorTypes = ['CCS2', 'CHAdeMO', 'Type2', 'Type1', 'GBT', 'Tesla', 'NACS'] as const;

  const createEvseBody = z.object({
    evseId: z.number().int().min(1).describe('OCPP EVSE ID (integer)'),
    connectors: z
      .array(
        z.object({
          connectorId: z.number().int().min(1).describe('OCPP connector ID (integer)'),
          connectorType: z.enum(connectorTypes).describe('Connector plug type'),
          maxPowerKw: z.number().int().min(1).describe('Maximum power output in kW'),
          maxCurrentAmps: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Maximum current output in amps'),
        }),
      )
      .min(1),
  });

  // POST /stations/:id/evses - Add an EVSE with connectors
  app.post(
    '/stations/:id/evses',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Add an EVSE with connectors to a station',
        description:
          'Inserts a new EVSE row plus its connector rows in a single request. The EVSE starts with status=unavailable until the station reports a StatusNotification. Returns 409 if the OCPP evseId already exists on the station.',
        operationId: 'addStationEvse',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(createEvseBody),
        response: {
          201: itemResponse(evseResponse),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          409: errorWith('Duplicate evse id', [ERROR_CODES.DUPLICATE_EVSE_ID]),
          500: errorWith('Internal error', [ERROR_CODES.INTERNAL_ERROR]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof createEvseBody>;

      // Verify station exists
      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Check for duplicate evseId
      const [existing] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, body.evseId)));
      if (existing != null) {
        await reply.status(409).send({
          error: `EVSE ID ${String(body.evseId)} already exists on this station`,
          code: 'DUPLICATE_EVSE_ID',
        });
        return;
      }

      // Insert EVSE
      const [evse] = await db
        .insert(evses)
        .values({ stationId: id, evseId: body.evseId })
        .returning();
      if (evse == null) {
        await reply.status(500).send({ error: 'Failed to create EVSE', code: 'INTERNAL_ERROR' });
        return;
      }

      // Insert connectors
      const connectorRows = await db
        .insert(connectors)
        .values(
          body.connectors.map((c) => ({
            evseId: evse.id,
            connectorId: c.connectorId,
            connectorType: c.connectorType,
            maxPowerKw: String(c.maxPowerKw),
            maxCurrentAmps: c.maxCurrentAmps,
            status: 'unavailable' as const,
          })),
        )
        .returning();

      await reply.status(201).send({
        evseId: evse.evseId,
        connectors: connectorRows.map((c) => ({
          connectorId: c.connectorId,
          connectorType: c.connectorType,
          maxPowerKw: c.maxPowerKw,
          maxCurrentAmps: c.maxCurrentAmps,
          status: c.status,
        })),
      });
    },
  );

  const updateEvseBody = z.object({
    connectors: z.array(
      z.object({
        connectorId: z.number().int().min(1).describe('OCPP connector ID (integer)'),
        connectorType: z.enum(connectorTypes).optional().describe('Connector plug type'),
        maxPowerKw: z.number().int().min(1).optional().describe('Maximum power output in kW'),
        maxCurrentAmps: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum current output in amps'),
      }),
    ),
  });

  // PATCH /stations/:id/evses/:evseId - Update connectors on an EVSE
  app.patch(
    '/stations/:id/evses/:evseId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Update connectors on an EVSE',
        operationId: 'updateStationEvse',
        security: [{ bearerAuth: [] }],
        params: zodSchema(evseParams),
        body: zodSchema(updateEvseBody),
        response: {
          200: itemResponse(evseResponse),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, evseId: ocppEvseId } = request.params as z.infer<typeof evseParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof updateEvseBody>;

      // Look up EVSE by station UUID + OCPP evseId
      const [evse] = await db
        .select({ id: evses.id, evseId: evses.evseId })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, ocppEvseId)));
      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      // Update each connector
      for (const c of body.connectors) {
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (c.connectorType != null) updates['connectorType'] = c.connectorType;
        if (c.maxPowerKw != null) updates['maxPowerKw'] = String(c.maxPowerKw);
        if (c.maxCurrentAmps != null) updates['maxCurrentAmps'] = c.maxCurrentAmps;

        await db
          .update(connectors)
          .set(updates)
          .where(and(eq(connectors.evseId, evse.id), eq(connectors.connectorId, c.connectorId)));
      }

      // Return updated EVSE with connectors
      const updatedConnectors = await db
        .select({
          connectorId: connectors.connectorId,
          connectorType: connectors.connectorType,
          maxPowerKw: connectors.maxPowerKw,
          maxCurrentAmps: connectors.maxCurrentAmps,
          status: connectors.status,
        })
        .from(connectors)
        .where(eq(connectors.evseId, evse.id))
        .orderBy(connectors.connectorId);

      return {
        evseId: evse.evseId,
        connectors: updatedConnectors,
      };
    },
  );

  // POST /stations/:id/evses/:evseId/refresh-status -- TriggerMessage(StatusNotification)
  // and wait for the station to report back. Works for both OCPP 1.6 and 2.1; the helper
  // builds the version-specific payload internally.
  app.post(
    '/stations/:id/evses/:evseId/refresh-status',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: "Force the station to re-report this EVSE's connector status",
        description:
          'Dispatches TriggerMessage(StatusNotification) for the first connector on the EVSE and waits for the station to report back. Returns the fresh status; returns null status when the station is offline or fails to respond within the trigger window.',
        operationId: 'refreshEvseConnectorStatus',
        security: [{ bearerAuth: [] }],
        params: zodSchema(evseParams),
        response: {
          200: itemResponse(
            z
              .object({
                status: z
                  .string()
                  .nullable()
                  .describe(
                    'Fresh connector status reported by the station, or null if the station is offline or did not respond in time',
                  ),
                error: z
                  .string()
                  .optional()
                  .describe('Error message when the trigger could not be completed'),
              })
              .passthrough(),
          ),
          404: errorWith('Resource not found', [
            ERROR_CODES.CONNECTOR_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, evseId: ocppEvseId } = request.params as z.infer<typeof evseParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      if (!station.isOnline) {
        return { status: null, error: 'Station is offline' };
      }

      // First connector on the EVSE -- TriggerMessage takes a single connector_id.
      // For multi-connector EVSEs we cycle through; for the typical 1-connector case
      // this just fetches that one.
      const connectorRows = await db.execute<{ connector_id: number }>(
        sql`SELECT c.connector_id FROM connectors c
            JOIN evses e ON c.evse_id = e.id
            WHERE e.station_id = ${id} AND e.evse_id = ${ocppEvseId}
            ORDER BY c.connector_id ASC LIMIT 1`,
      );
      const connectorRow = connectorRows[0];
      if (connectorRow == null) {
        await reply.status(404).send({ error: 'Connector not found', code: 'CONNECTOR_NOT_FOUND' });
        return;
      }

      const result = await triggerAndWaitForStatus(
        station.stationId,
        ocppEvseId,
        connectorRow.connector_id,
        id,
        station.ocppProtocol ?? undefined,
      );
      return { status: result.status, error: result.error };
    },
  );

  // POST /stations/:id/evses/:evseId/stop-active-session -- forcibly stop whatever
  // session is currently active on this EVSE. Used to recover from stuck sessions
  // (e.g. simulator never sends StopTransaction, station firmware glitches).
  app.post(
    '/stations/:id/evses/:evseId/stop-active-session',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Force-stop the active charging session on this EVSE',
        description:
          'Sends RequestStopTransaction (OCPP 2.1) or RemoteStopTransaction (OCPP 1.6) and waits up to 35s for the station response. If the station rejects with reasonCode=TxNotFound (a "ghost session" where the CSMS thinks a transaction is active but the station has no record), the API automatically marks the session faulted in the database and returns ghostRecovered=true. Returns 404 if no active session exists on the EVSE, 504 if the station does not respond within the timeout window.',
        operationId: 'stopActiveEvseSession',
        security: [{ bearerAuth: [] }],
        params: zodSchema(evseParams),
        response: {
          200: itemResponse(
            z
              .object({
                sessionId: z
                  .string()
                  .describe('Internal identifier of the session that was stopped or recovered'),
                transactionId: z
                  .string()
                  .describe('OCPP transaction id of the session that was stopped or recovered'),
                ghostRecovered: z
                  .boolean()
                  .describe(
                    'True when the station rejected with TxNotFound and the session was force-cleaned in the database',
                  ),
              })
              .passthrough(),
          ),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          504: errorWith('Station timeout', [ERROR_CODES.STATION_TIMEOUT]),
        },
      },
    },
    async (request, reply) => {
      const { id, evseId: ocppEvseId } = request.params as z.infer<typeof evseParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, ocppEvseId)));
      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      const [activeSession] = await db
        .select({ id: chargingSessions.id, transactionId: chargingSessions.transactionId })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.evseId, evse.id), eq(chargingSessions.status, 'active')))
        .limit(1);
      if (activeSession == null) {
        await reply
          .status(404)
          .send({ error: 'No active session on this EVSE', code: 'NO_ACTIVE_SESSION' });
        return;
      }

      const cmdResult = await sendOcppCommandAndWait(
        station.stationId,
        'RequestStopTransaction',
        { transactionId: activeSession.transactionId },
        station.ocppProtocol ?? undefined,
      );

      if (cmdResult.error != null) {
        await reply.status(504).send({ error: 'Station did not respond', code: 'STATION_TIMEOUT' });
        return;
      }

      const status = cmdResult.response?.['status'] as string | undefined;
      const statusInfo = cmdResult.response?.['statusInfo'] as { reasonCode?: string } | undefined;
      const isGhost = status === 'Rejected' && statusInfo?.reasonCode === 'TxNotFound';

      if (isGhost) {
        // Ghost session: station has no record of this transaction. Force-clean
        // the DB so the connector tile clears immediately rather than waiting
        // for the stale-session worker.
        await db.execute(sql`
          UPDATE charging_sessions
          SET status = 'faulted',
              stopped_reason = 'TxNotFound',
              ended_at = now(),
              final_cost_cents = COALESCE(final_cost_cents, current_cost_cents),
              updated_at = now()
          WHERE id = ${activeSession.id} AND status = 'active'
        `);
        await db.execute(sql`
          UPDATE session_tariff_segments
          SET ended_at = now(),
              duration_minutes = EXTRACT(EPOCH FROM (now() - started_at)) / 60
          WHERE session_id = ${activeSession.id} AND ended_at IS NULL
        `);
        request.log.info(
          { sessionId: activeSession.id, transactionId: activeSession.transactionId },
          'Ghost session recovered: station returned TxNotFound, marked DB faulted',
        );
        return {
          sessionId: activeSession.id,
          transactionId: activeSession.transactionId,
          ghostRecovered: true,
        };
      }

      // Station accepted the stop. The natural TransactionEvent.Ended will close
      // the session in the projection.
      return {
        sessionId: activeSession.id,
        transactionId: activeSession.transactionId,
        ghostRecovered: false,
      };
    },
  );

  const addConnectorBody = z.object({
    connectorId: z.number().int().min(1).describe('OCPP connector ID (integer)'),
    connectorType: z.enum(connectorTypes).describe('Connector plug type'),
    maxPowerKw: z.number().int().min(1).describe('Maximum power output in kW'),
    maxCurrentAmps: z.number().int().min(1).optional().describe('Maximum current output in amps'),
  });

  // POST /stations/:id/evses/:evseId/connectors - Add a connector to an EVSE
  app.post(
    '/stations/:id/evses/:evseId/connectors',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Add a connector to an EVSE',
        operationId: 'addStationConnector',
        security: [{ bearerAuth: [] }],
        params: zodSchema(evseParams),
        body: zodSchema(addConnectorBody),
        response: {
          201: itemResponse(connectorResponse),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Duplicate connector id', [ERROR_CODES.DUPLICATE_CONNECTOR_ID]),
          500: errorWith('Internal server error', [ERROR_CODES.INTERNAL_ERROR]),
        },
      },
    },
    async (request, reply) => {
      const { id, evseId: ocppEvseId } = request.params as z.infer<typeof evseParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof addConnectorBody>;

      // Look up EVSE
      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, ocppEvseId)));
      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      // Check for duplicate connectorId
      const [existing] = await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(and(eq(connectors.evseId, evse.id), eq(connectors.connectorId, body.connectorId)));
      if (existing != null) {
        await reply.status(409).send({
          error: `Connector ID ${String(body.connectorId)} already exists on this EVSE`,
          code: 'DUPLICATE_CONNECTOR_ID',
        });
        return;
      }

      const [connector] = await db
        .insert(connectors)
        .values({
          evseId: evse.id,
          connectorId: body.connectorId,
          connectorType: body.connectorType,
          maxPowerKw: String(body.maxPowerKw),
          maxCurrentAmps: body.maxCurrentAmps,
          status: 'unavailable',
        })
        .returning();
      if (connector == null) {
        await reply
          .status(500)
          .send({ error: 'Failed to create connector', code: 'INTERNAL_ERROR' });
        return;
      }

      await reply.status(201).send({
        connectorId: connector.connectorId,
        connectorType: connector.connectorType,
        maxPowerKw: connector.maxPowerKw,
        maxCurrentAmps: connector.maxCurrentAmps,
        status: connector.status,
      });
    },
  );

  // DELETE /stations/:id/evses/:evseId - Remove an EVSE and all its connectors
  app.delete(
    '/stations/:id/evses/:evseId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete an EVSE and all its connectors',
        description:
          'Removes the EVSE row and cascade-deletes its connectors. Returns 409 if any connector on the EVSE is currently occupied (active session, charging, or any in-use status).',
        operationId: 'deleteStationEvse',
        security: [{ bearerAuth: [] }],
        params: zodSchema(evseParams),
        response: {
          200: zodSchema(deleteResponse),
          404: errorWith('Resource not found', [
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Connector occupied', [ERROR_CODES.CONNECTOR_OCCUPIED]),
        },
      },
    },
    async (request, reply) => {
      const { id, evseId: ocppEvseId } = request.params as z.infer<typeof evseParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Look up EVSE
      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, ocppEvseId)));
      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      // Reject if any connector is in use
      const activeStatuses = [
        'occupied',
        'charging',
        'preparing',
        'ev_connected',
        'suspended_ev',
        'suspended_evse',
      ];
      const [inUse] = await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(
          and(
            eq(connectors.evseId, evse.id),
            sql`${connectors.status} IN (${sql.join(
              activeStatuses.map((s) => sql`${s}`),
              sql`, `,
            )})`,
          ),
        );
      if (inUse != null) {
        await reply.status(409).send({
          error: 'Cannot delete EVSE with occupied connectors',
          code: 'CONNECTOR_OCCUPIED',
        });
        return;
      }

      await db.delete(evses).where(eq(evses.id, evse.id));
      return { status: 'deleted' };
    },
  );

  // DELETE /stations/:id/evses/:evseId/connectors/:connectorId - Remove a connector
  app.delete(
    '/stations/:id/evses/:evseId/connectors/:connectorId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a connector from an EVSE',
        operationId: 'deleteStationConnector',
        security: [{ bearerAuth: [] }],
        params: zodSchema(connectorParams),
        response: {
          200: zodSchema(deleteResponse),
          404: errorWith('Resource not found', [
            ERROR_CODES.CONNECTOR_NOT_FOUND,
            ERROR_CODES.EVSE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
          409: errorWith('Connector occupied', [ERROR_CODES.CONNECTOR_OCCUPIED]),
        },
      },
    },
    async (request, reply) => {
      const {
        id,
        evseId: ocppEvseId,
        connectorId: ocppConnectorId,
      } = request.params as z.infer<typeof connectorParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Look up EVSE
      const [evse] = await db
        .select({ id: evses.id })
        .from(evses)
        .where(and(eq(evses.stationId, id), eq(evses.evseId, ocppEvseId)));
      if (evse == null) {
        await reply.status(404).send({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
        return;
      }

      // Find the connector
      const [connector] = await db
        .select({ id: connectors.id, status: connectors.status })
        .from(connectors)
        .where(and(eq(connectors.evseId, evse.id), eq(connectors.connectorId, ocppConnectorId)));
      if (connector == null) {
        await reply.status(404).send({ error: 'Connector not found', code: 'CONNECTOR_NOT_FOUND' });
        return;
      }

      // Reject if in use
      const inUseStatuses = [
        'occupied',
        'charging',
        'preparing',
        'ev_connected',
        'suspended_ev',
        'suspended_evse',
        'idle',
        'discharging',
      ];
      if (inUseStatuses.includes(connector.status)) {
        await reply.status(409).send({
          error: 'Cannot delete occupied connector',
          code: 'CONNECTOR_OCCUPIED',
        });
        return;
      }

      await db.delete(connectors).where(eq(connectors.id, connector.id));
      return { status: 'deleted' };
    },
  );

  const meterValuesQuery = z.object({
    hours: z.coerce
      .number()
      .int()
      .min(1)
      .max(168)
      .default(24)
      .describe('Number of hours to look back'),
  });

  app.get(
    '/stations/:id/meter-values',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get meter value time series for a station',
        operationId: 'getStationMeterValues',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(meterValuesQuery),
        response: {
          200: arrayResponse(meterValueGroup),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { hours } = request.query as z.infer<typeof meterValuesQuery>;
      const since = new Date(Date.now() - hours * 3600 * 1000);

      const rows = await db
        .select({
          measurand: meterValues.measurand,
          unit: meterValues.unit,
          timestamp: meterValues.timestamp,
          value: meterValues.value,
        })
        .from(meterValues)
        .where(and(eq(meterValues.stationId, id), gte(meterValues.timestamp, since)))
        .orderBy(meterValues.measurand, meterValues.timestamp);

      const grouped = new Map<
        string,
        { measurand: string; unit: string | null; values: { timestamp: Date; value: string }[] }
      >();

      for (const row of rows) {
        const key = row.measurand ?? 'unknown';
        if (!grouped.has(key)) {
          grouped.set(key, { measurand: key, unit: row.unit, values: [] });
        }
        const group = grouped.get(key);
        if (group != null) {
          group.values.push({ timestamp: row.timestamp, value: row.value });
        }
      }

      return [...grouped.values()];
    },
  );

  const energyHistoryQuery = z.object({
    days: z.coerce.number().int().min(1).max(90).default(7).describe('Number of days to look back'),
  });

  app.get(
    '/stations/:id/energy-history',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get daily energy delivery history for a station',
        operationId: 'getStationEnergyHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(energyHistoryQuery),
        response: {
          200: arrayResponse(energyHistoryItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { days } = request.query as z.infer<typeof energyHistoryQuery>;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const [stationRow] = await db
        .select({ siteTimezone: sites.timezone })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.id, id));
      const tz = stationRow?.siteTimezone ?? 'America/New_York';

      const rows = await db
        .select({
          date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          energyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
        })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.stationId, id), gte(chargingSessions.startedAt, since)))
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      return rows.map((r) => ({ date: r.date, energyWh: r.energyWh }));
    },
  );

  const revenueHistoryQuery = z.object({
    days: z.coerce.number().int().min(1).max(90).default(7).describe('Number of days to look back'),
  });

  app.get(
    '/stations/:id/revenue-history',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get daily revenue history for a station',
        operationId: 'getStationRevenueHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(revenueHistoryQuery),
        response: {
          200: arrayResponse(revenueHistoryItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { days } = request.query as z.infer<typeof revenueHistoryQuery>;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const [stationRow] = await db
        .select({ siteTimezone: sites.timezone })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.id, id));
      const tz = stationRow?.siteTimezone ?? 'America/New_York';

      const rows = await db
        .select({
          date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          revenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          sessionCount: count(),
        })
        .from(chargingSessions)
        .where(
          and(
            eq(chargingSessions.stationId, id),
            gte(chargingSessions.startedAt, since),
            sql`coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null`,
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      return rows.map((r) => ({
        date: r.date,
        revenueCents: r.revenueCents,
        sessionCount: r.sessionCount,
      }));
    },
  );

  const uptimeHistoryQuery = z.object({
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(90)
      .default(30)
      .describe('Number of days to look back'),
  });

  const uptimeHistoryItem = z
    .object({
      date: z.string().describe('Calendar date in YYYY-MM-DD (in the site timezone)'),
      uptimePercent: z
        .number()
        .describe('Average uptime percentage across all ports for that day (0-100)'),
    })
    .passthrough();

  app.get(
    '/stations/:id/uptime-history',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get daily uptime percentage history for a station',
        operationId: 'getStationUptimeHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(uptimeHistoryQuery),
        response: {
          200: arrayResponse(uptimeHistoryItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { days } = request.query as z.infer<typeof uptimeHistoryQuery>;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const [stationRow] = await db
        .select({ siteTimezone: sites.timezone })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.id, id));
      const tz = stationRow?.siteTimezone ?? 'America/New_York';
      const sinceIso = since.toISOString();

      const rows = await db.execute(sql`
        WITH date_series AS (
          SELECT generate_series(
            date_trunc('day', ${sinceIso}::timestamptz AT TIME ZONE ${tz}),
            date_trunc('day', now() AT TIME ZONE ${tz}),
            '1 day'::interval
          )::date AS day
        ),
        ports AS (
          SELECT DISTINCT evse_id FROM evses WHERE station_id = ${id}
        ),
        pre_period_status AS (
          SELECT DISTINCT ON (psl.evse_id)
            psl.evse_id,
            psl.new_status,
            ${sinceIso}::timestamptz AS timestamp
          FROM port_status_log psl
          INNER JOIN ports p ON p.evse_id = psl.evse_id
          WHERE psl.station_id = ${id} AND psl.timestamp < ${sinceIso}::timestamptz
          ORDER BY psl.evse_id, psl.timestamp DESC
        ),
        seeded_log AS (
          SELECT evse_id, new_status, timestamp FROM pre_period_status
          UNION ALL
          SELECT psl.evse_id, psl.new_status, psl.timestamp
          FROM port_status_log psl
          INNER JOIN ports p ON p.evse_id = psl.evse_id
          WHERE psl.station_id = ${id} AND psl.timestamp >= ${sinceIso}::timestamptz
        ),
        port_transitions AS (
          SELECT
            evse_id,
            new_status,
            timestamp AT TIME ZONE ${tz} AS local_ts,
            LEAD(timestamp AT TIME ZONE ${tz}) OVER (PARTITION BY evse_id ORDER BY timestamp) AS next_local_ts
          FROM seeded_log
        ),
        daily_outages AS (
          SELECT
            ds.day,
            pt.evse_id,
            SUM(
              EXTRACT(EPOCH FROM (
                LEAST(COALESCE(pt.next_local_ts, now() AT TIME ZONE ${tz}), (ds.day + '1 day'::interval))
                - GREATEST(pt.local_ts, ds.day::timestamp)
              )) / 60
            ) AS down_minutes
          FROM date_series ds
          INNER JOIN port_transitions pt
            ON pt.new_status IN ('faulted', 'unavailable')
            AND pt.local_ts < (ds.day + '1 day'::interval)
            AND COALESCE(pt.next_local_ts, now() AT TIME ZONE ${tz}) > ds.day::timestamp
          GROUP BY ds.day, pt.evse_id
        ),
        daily_uptime AS (
          SELECT
            ds.day,
            COALESCE(AVG(
              GREATEST(0, (1440 - COALESCE(do2.down_minutes, 0)) / 1440) * 100
            ), 100) AS uptime_percent
          FROM date_series ds
          CROSS JOIN ports p
          LEFT JOIN daily_outages do2 ON do2.day = ds.day AND do2.evse_id = p.evse_id
          GROUP BY ds.day
        )
        SELECT day::text AS date, uptime_percent
        FROM daily_uptime
        ORDER BY day
      `);

      return (rows as unknown as { date: string; uptime_percent: number | string }[]).map((r) => ({
        date: r.date,
        uptimePercent: Math.round(Number(r.uptime_percent) * 100) / 100,
      }));
    },
  );

  const popularTimesQuery = z.object({
    weeks: z.coerce
      .number()
      .int()
      .min(1)
      .max(52)
      .default(4)
      .describe('Number of weeks to average over'),
  });

  const popularTimesItem = z
    .object({
      dow: z.number().describe('Day of week as integer (0 = Sunday, 6 = Saturday)'),
      hour: z.number().describe('Hour of day in 24-hour format (0-23, in the site timezone)'),
      avgSessions: z
        .number()
        .describe('Average number of sessions started in that day-of-week / hour bucket'),
    })
    .passthrough();

  app.get(
    '/stations/:id/popular-times',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get average session count by day-of-week and hour for a station',
        operationId: 'getStationPopularTimes',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(popularTimesQuery),
        response: {
          200: arrayResponse(popularTimesItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { weeks } = request.query as z.infer<typeof popularTimesQuery>;
      const since = new Date();
      since.setDate(since.getDate() - weeks * 7);

      const [stationRow] = await db
        .select({ siteTimezone: sites.timezone })
        .from(chargingStations)
        .leftJoin(sites, eq(chargingStations.siteId, sites.id))
        .where(eq(chargingStations.id, id));
      const tz = stationRow?.siteTimezone ?? 'America/New_York';

      const rows = await db
        .select({
          dow: sql<number>`extract(dow from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          hour: sql<number>`extract(hour from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          totalSessions: count(),
        })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.stationId, id), gte(chargingSessions.startedAt, since)))
        .groupBy(sql`1`, sql`2`)
        .orderBy(sql`1`, sql`2`);

      return rows.map((r) => ({
        dow: r.dow,
        hour: r.hour,
        avgSessions: Math.round((r.totalSessions / weeks) * 10) / 10,
      }));
    },
  );

  const metricsQuery = z.object({
    months: z.coerce
      .number()
      .int()
      .min(1)
      .max(24)
      .default(12)
      .describe('Number of months to look back for metrics'),
  });

  app.get(
    '/stations/:id/metrics',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get performance metrics for a station',
        operationId: 'getStationMetrics',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(metricsQuery),
        response: {
          200: zodSchema(stationMetricsResponse),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { months } = request.query as z.infer<typeof metricsQuery>;
      const since = new Date();
      since.setMonth(since.getMonth() - months);

      const periodMinutes = Math.floor((Date.now() - since.getTime()) / 60000);
      const periodMinutesLiteral = sql.raw(String(periodMinutes));
      const sinceIso = since.toISOString();

      const uptimeRows = await db.execute(sql`
        WITH ports AS (
          SELECT DISTINCT evse_id FROM evses WHERE station_id = ${id}
        ),
        pre_period_status AS (
          SELECT DISTINCT ON (psl.evse_id)
            psl.evse_id,
            psl.new_status,
            ${sinceIso}::timestamptz AS timestamp
          FROM port_status_log psl
          INNER JOIN ports p ON p.evse_id = psl.evse_id
          WHERE psl.station_id = ${id} AND psl.timestamp < ${sinceIso}::timestamptz
          ORDER BY psl.evse_id, psl.timestamp DESC
        ),
        seeded_log AS (
          SELECT evse_id, new_status, timestamp FROM pre_period_status
          UNION ALL
          SELECT psl.evse_id, psl.new_status, psl.timestamp
          FROM port_status_log psl
          INNER JOIN ports p ON p.evse_id = psl.evse_id
          WHERE psl.station_id = ${id} AND psl.timestamp >= ${sinceIso}::timestamptz
        ),
        port_transitions AS (
          SELECT
            evse_id,
            new_status,
            timestamp,
            LEAD(timestamp) OVER (PARTITION BY evse_id ORDER BY timestamp) AS next_timestamp
          FROM seeded_log
        ),
        outage_minutes AS (
          SELECT
            evse_id,
            SUM(
              EXTRACT(EPOCH FROM (COALESCE(next_timestamp, now()) - timestamp)) / 60
            ) AS down_minutes
          FROM port_transitions
          WHERE new_status IN ('faulted', 'unavailable')
          GROUP BY evse_id
        )
        SELECT
          COALESCE(AVG(
            CASE WHEN ${periodMinutesLiteral} > 0
              THEN GREATEST(0, ((${periodMinutesLiteral} - COALESCE(down_minutes, 0)) / ${periodMinutesLiteral}) * 100)
              ELSE 100
            END
          ), 100) AS uptime_percent,
          COUNT(DISTINCT ports.evse_id) AS port_count
        FROM ports
        LEFT JOIN outage_minutes USING (evse_id)
      `);

      const [sessionStats] = await db
        .select({
          totalSessions: count(),
          completedSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'completed')`,
          faultedSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'faulted')`,
          totalEnergyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
          avgDurationMinutes: sql<number>`coalesce(avg(extract(epoch from (${chargingSessions.endedAt} - ${chargingSessions.startedAt})) / 60) filter (where ${chargingSessions.endedAt} is not null), 0)`,
        })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.stationId, id), gte(chargingSessions.startedAt, since)));

      const [utilizationStats] = await db
        .select({
          sessionHours: sql<number>`coalesce(sum(extract(epoch from (coalesce(${chargingSessions.endedAt}, now()) - ${chargingSessions.startedAt})) / 3600), 0)`,
          portCount: sql<number>`(select count(*) from evses where station_id = ${id})`,
        })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.stationId, id), gte(chargingSessions.startedAt, since)));

      const [financialStats] = await db
        .select({
          totalRevenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          avgRevenueCentsPerSession: sql<number>`coalesce(avg(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          totalTransactions: sql<number>`count(*) filter (where coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null)`,
        })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.stationId, id), gte(chargingSessions.startedAt, since)));

      const totalPortHours = (utilizationStats?.portCount ?? 1) * (periodMinutes / 60);
      const utilization =
        totalPortHours > 0
          ? Math.round(((utilizationStats?.sessionHours ?? 0) / totalPortHours) * 100)
          : 0;

      const total = sessionStats?.totalSessions ?? 0;
      const completed = sessionStats?.completedSessions ?? 0;

      const uptimeRow = uptimeRows[0] as { uptime_percent: string; port_count: string } | undefined;

      const disconnectRows = await db.execute(sql`
        WITH ordered_events AS (
          SELECT
            event,
            created_at,
            LEAD(created_at) OVER (ORDER BY created_at) AS next_at,
            LEAD(event) OVER (ORDER BY created_at) AS next_event
          FROM connection_logs
          WHERE station_id = ${id} AND created_at >= ${sinceIso}::timestamptz
        )
        SELECT
          count(*) AS disconnect_count,
          coalesce(avg(EXTRACT(EPOCH FROM (next_at - created_at)) / 60) FILTER (WHERE next_event = 'connected'), 0) AS avg_downtime_minutes,
          coalesce(max(EXTRACT(EPOCH FROM (next_at - created_at)) / 60) FILTER (WHERE next_event = 'connected'), 0) AS max_downtime_minutes
        FROM ordered_events
        WHERE event = 'disconnected'
      `);

      const disconnectRow = disconnectRows[0] as
        | { disconnect_count: string; avg_downtime_minutes: string; max_downtime_minutes: string }
        | undefined;

      return {
        uptimePercent: Math.round(Number(uptimeRow?.uptime_percent ?? 100) * 100) / 100,
        portCount: Number(uptimeRow?.port_count ?? 0),
        utilizationPercent: utilization,
        totalSessions: total,
        completedSessions: completed,
        faultedSessions: sessionStats?.faultedSessions ?? 0,
        sessionSuccessPercent: total > 0 ? Math.round((completed / total) * 100) : 100,
        totalEnergyWh: sessionStats?.totalEnergyWh ?? 0,
        avgSessionDurationMinutes: Math.round(sessionStats?.avgDurationMinutes ?? 0),
        disconnectCount: Number(disconnectRow?.disconnect_count ?? 0),
        avgDowntimeMinutes: Math.round(Number(disconnectRow?.avg_downtime_minutes ?? 0)),
        maxDowntimeMinutes: Math.round(Number(disconnectRow?.max_downtime_minutes ?? 0)),
        totalRevenueCents: financialStats?.totalRevenueCents ?? 0,
        avgRevenueCentsPerSession: Math.round(financialStats?.avgRevenueCentsPerSession ?? 0),
        totalTransactions: financialStats?.totalTransactions ?? 0,
        periodMonths: months,
      };
    },
  );

  const sessionsQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    status: z
      .enum(['active', 'completed', 'faulted', 'idling'])
      .optional()
      .describe('Filter by session status'),
  });

  app.get(
    '/stations/:id/sessions',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List charging sessions for a station',
        operationId: 'listStationSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(sessionsQuery),
        response: {
          200: paginatedResponse(sessionItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { page, limit, status } = request.query as z.infer<typeof sessionsQuery>;
      const offset = (page - 1) * limit;
      const conditions = [eq(chargingSessions.stationId, id)];
      if (status != null) {
        if (status === 'idling') {
          conditions.push(eq(chargingSessions.status, 'active'));
          conditions.push(isNotNull(chargingSessions.idleStartedAt));
        } else {
          conditions.push(eq(chargingSessions.status, status));
        }
      }
      const where = and(...conditions);

      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: chargingSessions.id,
            stationId: chargingSessions.stationId,
            stationName: chargingStations.stationId,
            siteName: sites.name,
            driverId: chargingSessions.driverId,
            driverName: sql<
              string | null
            >`CASE WHEN ${drivers.firstName} IS NOT NULL THEN ${drivers.firstName} || ' ' || ${drivers.lastName} ELSE NULL END`,
            transactionId: chargingSessions.transactionId,
            status: chargingSessions.status,
            startedAt: chargingSessions.startedAt,
            endedAt: chargingSessions.endedAt,
            energyDeliveredWh: chargingSessions.energyDeliveredWh,
            currentCostCents: chargingSessions.currentCostCents,
            finalCostCents: chargingSessions.finalCostCents,
            currency: chargingSessions.currency,
            freeVend: chargingSessions.freeVend,
            guestSessionToken: guestSessions.sessionToken,
          })
          .from(chargingSessions)
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .leftJoin(sites, eq(chargingStations.siteId, sites.id))
          .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
          .leftJoin(guestSessions, eq(guestSessions.chargingSessionId, chargingSessions.id))
          .where(where)
          .orderBy(desc(chargingSessions.startedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(chargingSessions)
          .where(where),
      ]);

      const data = rows.map(({ guestSessionToken, ...rest }) => ({
        ...rest,
        isGuestSession: guestSessionToken != null,
      }));

      return { data, total: countRows[0]?.count ?? 0 };
    },
  );

  const ocppLogsQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    action: z.string().optional().describe('Filter by OCPP action name'),
    direction: z.enum(['inbound', 'outbound']).optional().describe('Filter by message direction'),
  });

  app.get(
    '/stations/:id/ocpp-logs',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get OCPP message logs for a station',
        operationId: 'getStationOcppLogs',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(ocppLogsQuery),
        response: {
          200: zodSchema(ocppLogsResponse),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof ocppLogsQuery>;
      const offset = (query.page - 1) * query.limit;

      const conditions = [eq(ocppMessageLogs.stationId, id)];
      if (query.action != null && query.action !== '') {
        conditions.push(eq(ocppMessageLogs.action, query.action));
      }
      if (query.direction != null) {
        conditions.push(eq(ocppMessageLogs.direction, query.direction));
      }
      const where = and(...conditions);

      const [rows, countRows] = await Promise.all([
        db
          .select()
          .from(ocppMessageLogs)
          .where(where)
          .orderBy(desc(ocppMessageLogs.createdAt))
          .limit(query.limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ocppMessageLogs)
          .where(where),
      ]);

      // Get distinct actions for filter dropdown
      const actionRows = await db
        .selectDistinct({ action: ocppMessageLogs.action })
        .from(ocppMessageLogs)
        .where(eq(ocppMessageLogs.stationId, id))
        .orderBy(ocppMessageLogs.action);

      return {
        data: rows,
        total: countRows[0]?.count ?? 0,
        actions: actionRows.map((r) => r.action).filter((a): a is string => a != null),
      };
    },
  );

  // Set or update station password
  app.post(
    '/stations/:id/credentials',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Set or update station Basic Auth password',
        description:
          'Hashes the provided password with argon2 and stores it on the station record. If the station is online, dispatches SetVariables(SecurityCtrlr.BasicAuthPassword) and a Reset(OnIdle) command so the station reconnects with the new credential. Logs a password_changed entry to the connection log.',
        operationId: 'setStationCredentials',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(setCredentialsBody),
        response: {
          200: successResponse,
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { password } = request.body as z.infer<typeof setCredentialsBody>;

      const passwordHash = await hash(password);
      const [station] = await db
        .update(chargingStations)
        .set({ basicAuthPasswordHash: passwordHash, updatedAt: new Date() })
        .where(eq(chargingStations.id, id))
        .returning({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
        });

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      await db.insert(connectionLogs).values({
        stationId: id,
        event: 'password_changed',
        metadata: { changedBy: 'operator' },
      });

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: station.id,
          entityIdSnapshot: station.id,
          action: 'updated',
          ...actor,
          notes: 'Station credentials set',
        },
        db,
        request.log,
      );

      // Push password to station via OCPP SetVariables (if online)
      if (station.isOnline) {
        const commandPayload = {
          commandId: randomUUID(),
          stationId: station.stationId,
          action: 'SetVariables',
          payload: {
            setVariableData: [
              {
                component: { name: 'SecurityCtrlr' },
                variable: { name: 'BasicAuthPassword' },
                attributeValue: password,
              },
            ],
          },
        };
        await getPubSub().publish('ocpp_commands', JSON.stringify(commandPayload));

        // Reset the station so it reconnects with the new password
        const resetPayload = {
          commandId: randomUUID(),
          stationId: station.stationId,
          action: 'Reset',
          payload: { type: 'OnIdle' },
        };
        await getPubSub().publish('ocpp_commands', JSON.stringify(resetPayload));
      }

      return { success: true };
    },
  );

  // Rotate station credentials via OCPP SetVariables
  app.post(
    '/stations/:id/rotate-credentials',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Rotate station Basic Auth password via OCPP',
        description:
          'Generates a fresh 20-character Basic Auth password, dispatches SetVariables(SecurityCtrlr.BasicAuthPassword) to the station, and stores the new hash on success. Times out after 35s; the previous credential remains active until the new one is acknowledged. Returns 502 if the station rejects the SetVariables call and 409 if the station is offline.',
        operationId: 'rotateStationCredentials',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          409: errorWith('Station offline', [ERROR_CODES.STATION_OFFLINE]),
          502: errorWith('Station rejected the command', [ERROR_CODES.STATION_REJECTED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Verify station exists and is online
      const [station] = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(409).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      // Generate new password
      const newPassword = randomBytes(15).toString('base64url').slice(0, 20);

      // Send SetVariables command via pg_notify
      const commandId = randomUUID();
      const commandPayload = {
        commandId,
        stationId: station.stationId,
        action: 'SetVariables',
        payload: {
          setVariableData: [
            {
              component: { name: 'SecurityCtrlr' },
              variable: { name: 'BasicAuthPassword' },
              attributeValue: newPassword,
            },
          ],
        },
      };

      await getPubSub().publish('ocpp_commands', JSON.stringify(commandPayload));

      // Wait for result on ocpp_command_results channel
      const pubsub = getPubSub();
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ success: false, error: 'Command timed out' });
        }, 35_000);

        void pubsub
          .subscribe('ocpp_command_results', (payload: string) => {
            try {
              const parsed = JSON.parse(payload) as {
                commandId: string;
                success: boolean;
                error?: string;
              };
              if (parsed.commandId !== commandId) return;

              clearTimeout(timeout);
              resolve(
                parsed.error != null
                  ? { success: parsed.success, error: parsed.error }
                  : { success: parsed.success },
              );
            } catch {
              // Ignore parse errors from other messages
            }
          })
          .catch(() => {
            clearTimeout(timeout);
            resolve({ success: false, error: 'Failed to listen for result' });
          });
      });

      if (!result.success) {
        await reply
          .status(502)
          .send({ error: result.error ?? 'Credential rotation failed', code: 'ROTATION_FAILED' });
        return;
      }

      // On success, hash and store the new password
      const passwordHash = await hash(newPassword);
      await db
        .update(chargingStations)
        .set({ basicAuthPasswordHash: passwordHash, updatedAt: new Date() })
        .where(eq(chargingStations.id, id));

      // Log the event
      await db.insert(connectionLogs).values({
        stationId: id,
        event: 'credentials_rotated',
        metadata: { rotatedBy: 'operator' },
      });

      // Reset the station so it reconnects with the new password
      const resetPayload = {
        commandId: randomUUID(),
        stationId: station.stationId,
        action: 'Reset',
        payload: { type: 'OnIdle' },
      };
      await getPubSub().publish('ocpp_commands', JSON.stringify(resetPayload));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: station.id,
          entityIdSnapshot: station.id,
          action: 'command_dispatched',
          ...actor,
          notes: 'Credentials rotated via SetVariables',
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  // Security event logs
  const securityLogsQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  app.get(
    '/stations/:id/security-logs',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get security event logs for a station',
        operationId: 'getStationSecurityLogs',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(securityLogsQuery),
        response: {
          200: paginatedResponse(securityLogItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof securityLogsQuery>;
      const offset = (query.page - 1) * query.limit;

      const securityEvents = [
        'auth_failed',
        'password_changed',
        'credentials_rotated',
        'connected',
        'disconnected',
      ];

      const where = and(
        eq(connectionLogs.stationId, id),
        inArray(connectionLogs.event, securityEvents),
      );

      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: connectionLogs.id,
            event: connectionLogs.event,
            remoteAddress: connectionLogs.remoteAddress,
            metadata: connectionLogs.metadata,
            createdAt: connectionLogs.createdAt,
          })
          .from(connectionLogs)
          .where(where)
          .orderBy(desc(connectionLogs.createdAt))
          .limit(query.limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(connectionLogs)
          .where(where),
      ]);

      return { data: rows, total: countRows[0]?.count ?? 0 };
    },
  );

  // --- Station Certificates ---

  const stationCertQuery = paginationQuery.extend({
    status: z
      .enum(['active', 'expired', 'revoked'])
      .optional()
      .describe('Filter by certificate status'),
  });

  const installCertBody = z.object({
    certificateType: z.string().min(1),
    certificate: z.string().min(1),
  });

  const deleteCertBody = z.object({
    certificateHashData: z.object({
      hashAlgorithm: z.string(),
      issuerNameHash: z.string(),
      issuerKeyHash: z.string(),
      serialNumber: z.string(),
    }),
  });

  const getInstalledCertsBody = z.object({
    certificateType: z
      .array(
        z.enum([
          'V2GRootCertificate',
          'MORootCertificate',
          'CSMSRootCertificate',
          'V2GCertificateChain',
          'ManufacturerRootCertificate',
          'OEMRootCertificate',
        ]),
      )
      .max(20)
      .optional()
      .describe('OCPP 2.1 GetCertificateIdUseEnumType filter'),
  });

  app.get(
    '/stations/:id/certificates',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List certificates for a station',
        operationId: 'listStationCertificates',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(stationCertQuery),
        response: {
          200: paginatedResponse(certificateItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof stationCertQuery>;
      const offset = (query.page - 1) * query.limit;

      const conditions = [eq(stationCertificates.stationId, id)];
      if (query.status != null) {
        conditions.push(eq(stationCertificates.status, query.status));
      }

      const where = and(...conditions);

      const [rows, [countResult]] = await Promise.all([
        db
          .select()
          .from(stationCertificates)
          .where(where)
          .orderBy(desc(stationCertificates.createdAt))
          .limit(query.limit)
          .offset(offset),
        db.select({ count: count() }).from(stationCertificates).where(where),
      ]);

      return { data: rows, total: countResult?.count ?? 0 } satisfies PaginatedResponse<
        (typeof rows)[number]
      >;
    },
  );

  app.post(
    '/stations/:id/certificates/install',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Install a certificate on a station',
        description:
          'Dispatches OCPP InstallCertificate to the station and returns immediately. The station response is processed asynchronously by the certificate event projection, which records the install result. Used for both V2G (PnC) and ChargingStationCertificate (SP3/mTLS) certificates.',
        operationId: 'installStationCertificate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(installCertBody),
        response: {
          200: successResponse,
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof installCertBody>;

      const stationRows = await db.execute(
        sql`SELECT station_id FROM charging_stations WHERE id = ${id}`,
      );
      const stationRow = stationRows[0];
      if (stationRow == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const commandPayload = JSON.stringify({
        commandId: randomUUID(),
        stationId: stationRow.station_id as string,
        action: 'InstallCertificate',
        payload: {
          certificateType: body.certificateType,
          certificate: body.certificate,
        },
      });

      await getPubSub().publish('ocpp_commands', commandPayload);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'certificate_installed',
          ...actor,
          notes: `Install certificate type ${body.certificateType}`,
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  app.post(
    '/stations/:id/certificates/delete',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a certificate from a station',
        description:
          'Dispatches OCPP DeleteCertificate to the station with the supplied hash data and returns immediately. The result is processed asynchronously and reflected in the station_certificates mirror.',
        operationId: 'deleteStationCertificate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(deleteCertBody),
        response: {
          200: successResponse,
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof deleteCertBody>;

      const stationRows = await db.execute(
        sql`SELECT station_id FROM charging_stations WHERE id = ${id}`,
      );
      const stationRow = stationRows[0];
      if (stationRow == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const commandPayload = JSON.stringify({
        commandId: randomUUID(),
        stationId: stationRow.station_id as string,
        action: 'DeleteCertificate',
        payload: {
          certificateHashData: body.certificateHashData,
        },
      });

      await getPubSub().publish('ocpp_commands', commandPayload);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'command_dispatched',
          ...actor,
          notes: 'DeleteCertificate dispatched',
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  app.post(
    '/stations/:id/certificates/query',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Query installed certificate IDs from a station',
        description:
          'Dispatches OCPP GetInstalledCertificateIds to the station to enumerate certificates of the requested types. The station response is handled asynchronously and updates the station_certificates mirror.',
        operationId: 'queryStationCertificates',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(getInstalledCertsBody),
        response: {
          200: successResponse,
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof getInstalledCertsBody>;

      const stationRows = await db.execute(
        sql`SELECT station_id FROM charging_stations WHERE id = ${id}`,
      );
      const stationRow = stationRows[0];
      if (stationRow == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const commandPayload = JSON.stringify({
        commandId: randomUUID(),
        stationId: stationRow.station_id as string,
        action: 'GetInstalledCertificateIds',
        payload: {
          certificateType: body.certificateType,
        },
      });

      await getPubSub().publish('ocpp_commands', commandPayload);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'command_dispatched',
          ...actor,
          notes: 'GetInstalledCertificateIds dispatched',
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  // --- Pricing Groups ---

  app.get(
    '/stations/:id/pricing-groups',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'Get the pricing group for a station',
        operationId: 'getStationPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: itemResponse(stationPricingGroupItem.nullable()),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const rows = await db
        .select({
          id: pricingGroups.id,
          name: pricingGroups.name,
          description: pricingGroups.description,
          isDefault: pricingGroups.isDefault,
          tariffCount: sql<number>`(select count(*)::int from tariffs where tariffs.pricing_group_id = ${pricingGroups.id})`,
        })
        .from(pricingGroupStations)
        .innerJoin(pricingGroups, eq(pricingGroupStations.pricingGroupId, pricingGroups.id))
        .where(eq(pricingGroupStations.stationId, id))
        .limit(1);
      return rows[0] ?? null;
    },
  );

  app.post(
    '/stations/:id/pricing-groups',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Assign a pricing group to a station',
        operationId: 'addStationPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(addStationPricingGroupBody),
        response: {
          201: itemResponse(stationPricingGroupRecordItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof addStationPricingGroupBody>;
      const [previous] = await db
        .select()
        .from(pricingGroupStations)
        .where(eq(pricingGroupStations.stationId, id));
      const [record] = await db
        .insert(pricingGroupStations)
        .values({ stationId: id, pricingGroupId: body.pricingGroupId })
        .onConflictDoUpdate({
          target: [pricingGroupStations.stationId],
          set: { pricingGroupId: body.pricingGroupId, createdAt: new Date() },
        })
        .returning();
      await writeAudit(
        { table: pricingAssignmentAuditLog, idColumn: 'pricing_assignment_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: previous == null ? 'created' : 'updated',
          actor: 'operator',
          actorUserId: userId,
          before:
            previous == null
              ? null
              : { scope: 'station', stationId: id, pricingGroupId: previous.pricingGroupId },
          after: { scope: 'station', stationId: id, pricingGroupId: body.pricingGroupId },
        },
        db,
        request.log,
      );
      await reply.status(201).send(record);
    },
  );

  app.delete(
    '/stations/:id/pricing-groups/:pricingGroupId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Remove a pricing group from a station',
        operationId: 'removeStationPricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationPricingGroupParams),
        response: {
          200: itemResponse(stationPricingGroupRecordItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, pricingGroupId } = request.params as z.infer<typeof stationPricingGroupParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const [record] = await db
        .delete(pricingGroupStations)
        .where(
          and(
            eq(pricingGroupStations.stationId, id),
            eq(pricingGroupStations.pricingGroupId, pricingGroupId),
          ),
        )
        .returning();
      if (record == null) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found for station', code: 'NOT_FOUND' });
        return;
      }
      await writeAudit(
        { table: pricingAssignmentAuditLog, idColumn: 'pricing_assignment_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'deleted',
          actor: 'operator',
          actorUserId: userId,
          before: { scope: 'station', stationId: id, pricingGroupId },
        },
        db,
        request.log,
      );
      return record;
    },
  );

  // --- Station approval / rejection ---

  app.post(
    '/stations/:id/approve',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Approve a pending station',
        operationId: 'approveStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const [station] = await db
        .select({
          onboardingStatus: chargingStations.onboardingStatus,
          stationId: chargingStations.stationId,
          isSimulator: chargingStations.isSimulator,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (station.onboardingStatus !== 'pending') {
        await reply
          .status(409)
          .send({ error: 'Station is not pending approval', code: 'NOT_PENDING' });
        return;
      }

      await db
        .update(chargingStations)
        .set({ onboardingStatus: 'accepted', updatedAt: new Date() })
        .where(eq(chargingStations.id, id));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'updated',
          ...actor,
          before: { onboardingStatus: 'pending' },
          after: { onboardingStatus: 'accepted' },
          notes: 'Station approved',
        },
        db,
        request.log,
      );

      const pubsub = getPubSub();
      await pubsub.publish(
        'csms_events',
        JSON.stringify({ eventType: 'station.status', stationId: id }),
      );

      // Nudge a simulator out of a stale Pending boot state. Real stations
      // re-attempt BootNotification on their own retry interval, so this
      // only matters for simulators where the SimulatorManager listens on
      // css_commands and translates the action into a fresh BootNotification.
      if (station.isSimulator) {
        try {
          await pubsub.publish(
            'css_commands',
            JSON.stringify({
              commandId: randomUUID(),
              stationId: station.stationId,
              action: 'rebootStation',
              params: {},
            }),
          );
        } catch {
          // Pub/sub failure is non-fatal: the simulator's own retry timer
          // will eventually re-boot. Log and continue.
        }
      }

      return { success: true };
    },
  );

  app.post(
    '/stations/:id/unblock',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Unblock a station (sets status to pending)',
        operationId: 'unblockStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          409: errorWith('Not blocked', [ERROR_CODES.NOT_BLOCKED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;

      const [station] = await db
        .select({ onboardingStatus: chargingStations.onboardingStatus })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (station.onboardingStatus !== 'blocked') {
        await reply.status(409).send({ error: 'Station is not blocked', code: 'NOT_BLOCKED' });
        return;
      }

      await db
        .update(chargingStations)
        .set({ onboardingStatus: 'pending', updatedAt: new Date() })
        .where(eq(chargingStations.id, id));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'updated',
          ...actor,
          before: { onboardingStatus: 'blocked' },
          after: { onboardingStatus: 'pending' },
          notes: 'Station unblocked',
        },
        db,
        request.log,
      );

      const pubsub = getPubSub();
      await pubsub.publish(
        'csms_events',
        JSON.stringify({ eventType: 'station.status', stationId: id }),
      );

      return { success: true };
    },
  );

  app.post(
    '/stations/:id/reject',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Reject a pending station',
        operationId: 'rejectStation',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const [station] = await db
        .select({ onboardingStatus: chargingStations.onboardingStatus })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (station.onboardingStatus !== 'pending') {
        await reply
          .status(409)
          .send({ error: 'Station is not pending approval', code: 'NOT_PENDING' });
        return;
      }

      await db
        .update(chargingStations)
        .set({ onboardingStatus: 'blocked', updatedAt: new Date() })
        .where(eq(chargingStations.id, id));

      const actor = getAuditActor(request);
      await writeAudit(
        { table: stationAuditLog, idColumn: 'station_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'updated',
          ...actor,
          before: { onboardingStatus: 'pending' },
          after: { onboardingStatus: 'blocked' },
          notes: 'Station rejected',
        },
        db,
        request.log,
      );

      const pubsub = getPubSub();
      await pubsub.publish(
        'csms_events',
        JSON.stringify({ eventType: 'station.status', stationId: id }),
      );

      return { success: true };
    },
  );

  // --- Security events ---

  const securityEventItem = z
    .object({
      id: z.number().describe('Security event row ID'),
      stationId: z
        .string()
        .describe('Internal station identifier (nanoid) the event was raised on'),
      type: z
        .string()
        .describe(
          'OCPP security event type (e.g., FirmwareUpdated, InvalidTLSVersion, TamperDetectionActivated)',
        ),
      severity: z.string().describe('Severity level (critical, high, medium, low, info)'),
      timestamp: z.coerce.date().describe('Timestamp when the event occurred on the station'),
      techInfo: z
        .string()
        .nullable()
        .describe('Optional vendor-specific technical information about the event'),
      createdAt: z.coerce.date().describe('When the event row was inserted into the CSMS'),
    })
    .passthrough();

  const securityEventsQuery = paginationQuery.merge(
    z.object({
      severity: z
        .enum(['critical', 'high', 'medium', 'low', 'info'])
        .optional()
        .describe('Filter by severity level'),
    }),
  );

  app.get(
    '/stations/:id/security-events',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List security events for a station',
        operationId: 'listStationSecurityEvents',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(securityEventsQuery),
        response: {
          200: paginatedResponse(securityEventItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof securityEventsQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const conditions = [eq(securityEvents.stationId, id)];
      if (query.severity != null) {
        conditions.push(eq(securityEvents.severity, query.severity));
      }
      if (query.search != null && query.search.length > 0) {
        conditions.push(ilike(securityEvents.type, `%${query.search}%`));
      }

      const where = and(...conditions);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(securityEvents)
          .where(where)
          .orderBy(desc(securityEvents.timestamp))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(securityEvents).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  // --- Station events ---

  const stationEventItem = z
    .object({
      id: z.number().describe('Event row ID'),
      stationId: z.string().describe('Station ID'),
      generatedAt: z.string().describe('Timestamp when the event was generated on the station'),
      seqNo: z.number().describe('Per-station sequence number'),
      tbc: z.boolean().describe('To-be-continued flag for multi-part reports'),
      eventData: z.record(z.unknown()).describe('Raw OCPP event payload'),
      createdAt: z.string().describe('When the row was inserted'),
    })
    .passthrough();

  app.get(
    '/stations/:id/events',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List OCPP events for a station',
        operationId: 'listStationEvents',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(stationEventItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof paginationQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const where = eq(stationEvents.stationId, id);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(stationEvents)
          .where(where)
          .orderBy(desc(stationEvents.generatedAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(stationEvents).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  // --- Station variables ---

  const stationVariableItem = z
    .object({
      id: z.number().describe('Configuration row ID'),
      stationId: z.string().describe('Station ID'),
      component: z.string().describe('OCPP component name'),
      instance: z.string().nullable().describe('Component instance label'),
      evseId: z.number().nullable().describe('EVSE ID this variable belongs to'),
      connectorId: z.number().nullable().describe('Connector ID this variable belongs to'),
      variable: z.string().describe('OCPP variable name'),
      variableInstance: z.string().nullable().describe('Variable instance label'),
      value: z.string().nullable().describe('Reported variable value'),
      attributeType: z
        .enum(['Actual', 'Target', 'MinSet', 'MaxSet'])
        .describe('OCPP 2.1 AttributeEnumType'),
      source: z.string().describe('Where the row originated (e.g., NotifyReport, GetVariables)'),
      createdAt: z.string().describe('When the row was first observed'),
      updatedAt: z.string().describe('When the row was last updated'),
    })
    .passthrough();

  app.get(
    '/stations/:id/variables',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List reported variables for a station',
        operationId: 'listStationVariables',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(stationVariableItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof paginationQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const conditions = [eq(stationConfigurations.stationId, id)];
      if (query.search != null && query.search.length > 0) {
        const searchCondition = or(
          ilike(stationConfigurations.component, `%${query.search}%`),
          ilike(stationConfigurations.variable, `%${query.search}%`),
          ilike(stationConfigurations.value, `%${query.search}%`),
        );
        if (searchCondition != null) conditions.push(searchCondition);
      }

      const where = and(...conditions);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(stationConfigurations)
          .where(where)
          .orderBy(stationConfigurations.component, stationConfigurations.variable)
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(stationConfigurations).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  // --- Firmware history ---

  const firmwareHistoryItem = z
    .object({
      id: z.number().describe('Firmware update row ID'),
      stationId: z.string().describe('Station ID'),
      requestId: z.number().nullable().describe('OCPP request ID'),
      firmwareUrl: z.string().describe('URL the station downloads firmware from'),
      retrieveDateTime: z
        .string()
        .nullable()
        .describe('When the station should retrieve the firmware'),
      status: z.string().nullable().describe('Latest firmware update status reported by station'),
      statusInfo: z.record(z.unknown()).nullable().describe('Additional OCPP status info'),
      campaignId: z.string().nullable().describe('Linked firmware campaign ID, if any'),
      initiatedAt: z.string().describe('When the firmware update was initiated'),
      lastStatusAt: z.string().nullable().describe('When the most recent status was received'),
      createdAt: z.string().describe('Row creation timestamp'),
      updatedAt: z.string().describe('Row update timestamp'),
      version: z
        .string()
        .nullable()
        .describe('Target firmware version from the linked campaign, if any'),
    })
    .passthrough();

  app.get(
    '/stations/:id/firmware-history',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List firmware update history for a station',
        operationId: 'listStationFirmwareHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(firmwareHistoryItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof paginationQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const where = eq(firmwareUpdates.stationId, id);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select({
            id: firmwareUpdates.id,
            stationId: firmwareUpdates.stationId,
            requestId: firmwareUpdates.requestId,
            firmwareUrl: firmwareUpdates.firmwareUrl,
            retrieveDateTime: firmwareUpdates.retrieveDateTime,
            status: firmwareUpdates.status,
            statusInfo: firmwareUpdates.statusInfo,
            campaignId: firmwareUpdates.campaignId,
            initiatedAt: firmwareUpdates.initiatedAt,
            lastStatusAt: firmwareUpdates.lastStatusAt,
            createdAt: firmwareUpdates.createdAt,
            updatedAt: firmwareUpdates.updatedAt,
            version: firmwareCampaigns.version,
          })
          .from(firmwareUpdates)
          .leftJoin(firmwareCampaigns, eq(firmwareCampaigns.id, firmwareUpdates.campaignId))
          .where(where)
          .orderBy(desc(firmwareUpdates.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(firmwareUpdates).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  // --- Charging profiles ---

  const chargingProfileItem = z
    .object({
      id: z.number().describe('Charging profile row ID'),
      stationId: z.string().describe('Station ID'),
      source: z.string().describe('Where the profile originated (csms_set or station_reported)'),
      evseId: z.number().nullable().describe('EVSE ID the profile applies to (0 = whole station)'),
      requestId: z.number().nullable().describe('OCPP request ID'),
      chargingLimitSource: z.string().nullable().describe('OCPP charging limit source'),
      tbc: z.boolean().describe('To-be-continued flag for multi-part reports'),
      profileData: z.unknown().describe('Raw OCPP charging profile payload (object or array)'),
      sentAt: z.string().nullable().describe('When the CSMS sent the profile to the station'),
      reportedAt: z.string().nullable().describe('When the station reported the profile'),
      createdAt: z.string().describe('Row creation timestamp'),
      templateId: z
        .string()
        .nullable()
        .describe('Linked charging profile template ID, if any (csms_set rows only)'),
      templateName: z
        .string()
        .nullable()
        .describe('Linked charging profile template name, if any (csms_set rows only)'),
    })
    .passthrough();

  app.get(
    '/stations/:id/charging-profiles',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List charging profiles for a station',
        operationId: 'listStationChargingProfiles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(chargingProfileItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof paginationQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const where = eq(chargingProfiles.stationId, id);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      // Soft-link CSMS-pushed profiles back to their template by matching the
      // OCPP profile.id stored in profile_data against chargingProfileTemplates.profileId.
      // Station-reported profiles can carry a non-numeric `id` (or omit it entirely),
      // so guard the ::int cast with a regex predicate to avoid a 500 on malformed
      // rows. Only attempt the join for csms_set rows where the projection writes
      // a numeric id; null out template fields for everything else in JS.
      const profileIdExpr = sql<number>`CASE WHEN ${chargingProfiles.profileData} ->> 'id' ~ '^-?[0-9]+$' THEN (${chargingProfiles.profileData} ->> 'id')::int ELSE NULL END`;

      const [rows, countResult] = await Promise.all([
        db
          .select({
            profile: chargingProfiles,
            templateId: chargingProfileTemplates.id,
            templateName: chargingProfileTemplates.name,
          })
          .from(chargingProfiles)
          .leftJoin(chargingProfileTemplates, eq(chargingProfileTemplates.profileId, profileIdExpr))
          .where(where)
          .orderBy(desc(chargingProfiles.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(chargingProfiles).where(where),
      ]);

      const data = rows.map((row) => ({
        ...row.profile,
        templateId: row.profile.source === 'csms_set' ? row.templateId : null,
        templateName: row.profile.source === 'csms_set' ? row.templateName : null,
      }));

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  // POST /stations/:id/charging-profiles/refresh
  app.post(
    '/stations/:id/charging-profiles/refresh',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Refresh charging profiles from the station via OCPP GetChargingProfiles',
        description:
          'Dispatches GetChargingProfiles to pull the current set of profiles from the station. The station response is processed asynchronously by the ReportChargingProfiles event projection, which mirrors profiles into the charging_profiles table. OCPP 1.6 is not supported (returns 400). Returns 502 on station rejection or timeout.',
        operationId: 'refreshStationChargingProfiles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: successResponse,
          400: errorWith('Station offline', [ERROR_CODES.STATION_OFFLINE]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          502: errorWith('Ocpp command failed', [ERROR_CODES.OCPP_COMMAND_FAILED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      if (station.ocppProtocol === 'ocpp1.6') {
        await reply
          .status(400)
          .send({ error: 'Not supported for OCPP 1.6', code: 'NOT_SUPPORTED' });
        return;
      }

      const payload = {
        requestId: Math.floor(Math.random() * 2147483647),
        chargingProfile: {},
      };
      const result = await sendOcppCommandAndWait(
        station.stationId,
        'GetChargingProfiles',
        payload,
        '2.1',
      );

      if (result.error != null) {
        await reply.status(502).send({ error: result.error, code: 'OCPP_COMMAND_FAILED' });
        return;
      }

      return { success: true };
    },
  );

  // POST /stations/:id/charging-profiles/composite
  const compositeBody = z.object({
    evseId: z.number().int().optional().describe('EVSE ID (defaults to 0)'),
    duration: z.number().int().optional().describe('Duration in seconds (defaults to 86400)'),
    chargingRateUnit: z.string().optional().describe('Charging rate unit (W or A)'),
  });

  // OCPP GetCompositeScheduleResponse passes through unchanged.
  const compositeScheduleResponse = z
    .object({
      status: z.string().optional().describe('OCPP composite schedule status (Accepted/Rejected)'),
      statusInfo: z.record(z.unknown()).optional().describe('Additional OCPP status info'),
      schedule: z.record(z.unknown()).optional().describe('Composite charging schedule payload'),
    })
    .passthrough();

  app.post(
    '/stations/:id/charging-profiles/composite',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Get composite charging schedule from the station',
        operationId: 'getStationCompositeSchedule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(compositeBody),
        response: {
          200: itemResponse(compositeScheduleResponse),
          400: errorWith('Station offline', [ERROR_CODES.STATION_OFFLINE]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          502: errorWith('Ocpp command failed', [ERROR_CODES.OCPP_COMMAND_FAILED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const body = request.body as z.infer<typeof compositeBody>;

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      const version = station.ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';
      const payload = {
        evseId: body.evseId ?? 0,
        duration: body.duration ?? 86400,
        chargingRateUnit: body.chargingRateUnit,
      };

      const result = await sendOcppCommandAndWait(
        station.stationId,
        'GetCompositeSchedule',
        payload,
        version,
      );

      if (result.error != null) {
        await reply.status(502).send({ error: result.error, code: 'OCPP_COMMAND_FAILED' });
        return;
      }

      return result.response ?? {};
    },
  );

  // POST /stations/:id/charging-profiles/clear
  const clearProfileBody = z.object({
    chargingProfileId: z
      .number()
      .int()
      .optional()
      .describe('Specific charging profile ID to clear'),
    chargingProfilePurpose: z.string().optional().describe('Clear all profiles with this purpose'),
    stackLevel: z.number().int().optional().describe('Stack level to clear'),
    evseId: z.number().int().optional().describe('EVSE ID to clear profiles for'),
  });

  // OCPP ClearChargingProfileResponse passes through. When the station never
  // returned a payload, the handler falls back to `{ success: true }`.
  const clearChargingProfileResponse = z
    .object({
      status: z.string().optional().describe('OCPP clear status (Accepted/Unknown)'),
      statusInfo: z.record(z.unknown()).optional().describe('Additional OCPP status info'),
      success: z.boolean().optional().describe('Set when no station response was available'),
    })
    .passthrough();

  app.post(
    '/stations/:id/charging-profiles/clear',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Clear charging profiles from the station',
        description:
          'Dispatches ClearChargingProfile with the supplied criteria (purpose, stackLevel, evseId) or a specific chargingProfileId. On Accepted, deletes the matching rows from the charging_profiles mirror and triggers a best-effort GetChargingProfiles refresh on OCPP 2.1 stations. Returns 502 on station rejection or timeout.',
        operationId: 'clearStationChargingProfiles',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(clearProfileBody),
        response: {
          200: itemResponse(clearChargingProfileResponse),
          400: errorWith('Station offline', [ERROR_CODES.STATION_OFFLINE]),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          502: errorWith('Ocpp command failed', [ERROR_CODES.OCPP_COMMAND_FAILED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const body = request.body as z.infer<typeof clearProfileBody>;

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      const version = station.ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';

      // Reshape API body into OCPP 2.1 ClearChargingProfileRequest. Criteria
      // (purpose/stackLevel/evseId) live under `chargingProfileCriteria`;
      // `chargingProfileId` stays at the top level. Empty criteria object is
      // omitted so "clear all" sends `{}` rather than an empty filter.
      const criteria: Record<string, unknown> = {};
      if (body.chargingProfilePurpose != null)
        criteria.chargingProfilePurpose = body.chargingProfilePurpose;
      if (body.stackLevel != null) criteria.stackLevel = body.stackLevel;
      if (body.evseId != null) criteria.evseId = body.evseId;
      const ocppPayload: Record<string, unknown> = {};
      if (body.chargingProfileId != null) ocppPayload.chargingProfileId = body.chargingProfileId;
      if (Object.keys(criteria).length > 0) ocppPayload.chargingProfileCriteria = criteria;

      const result = await sendOcppCommandAndWait(
        station.stationId,
        'ClearChargingProfile',
        ocppPayload,
        version,
      );

      if (result.error != null) {
        await reply.status(502).send({ error: result.error, code: 'OCPP_COMMAND_FAILED' });
        return;
      }

      // Mirror the on-station deletion in the CSMS DB. The station's
      // ClearChargingProfile is idempotent — Accepted means the matching
      // profiles are gone (or no match found), so the prior rows in
      // `charging_profiles` no longer reflect on-station state.
      //
      // profile_data is stored two shapes: csms_set rows are a single profile
      // OBJECT, station_reported rows are an ARRAY of profile objects (per
      // the OCPP ReportChargingProfiles payload). The match predicates need
      // to handle both — `jsonb_path_exists` searches across either shape.
      const response = result.response as { status?: string } | undefined;
      if (response?.status === 'Accepted') {
        const conditions = [eq(chargingProfiles.stationId, id)];
        if (body.chargingProfileId != null) {
          conditions.push(
            sql`jsonb_path_exists(profile_data, ('$ ? (@.id == ' || ${body.chargingProfileId}::text || ')')::jsonpath)
                OR jsonb_path_exists(profile_data, ('$[*] ? (@.id == ' || ${body.chargingProfileId}::text || ')')::jsonpath)`,
          );
        }
        if (body.chargingProfilePurpose != null) {
          conditions.push(
            sql`jsonb_path_exists(profile_data, ('$ ? (@.chargingProfilePurpose == "' || ${body.chargingProfilePurpose} || '")')::jsonpath)
                OR jsonb_path_exists(profile_data, ('$[*] ? (@.chargingProfilePurpose == "' || ${body.chargingProfilePurpose} || '")')::jsonpath)`,
          );
        }
        if (body.stackLevel != null) {
          conditions.push(
            sql`jsonb_path_exists(profile_data, ('$ ? (@.stackLevel == ' || ${body.stackLevel}::text || ')')::jsonpath)
                OR jsonb_path_exists(profile_data, ('$[*] ? (@.stackLevel == ' || ${body.stackLevel}::text || ')')::jsonpath)`,
          );
        }
        if (body.evseId != null) {
          conditions.push(eq(chargingProfiles.evseId, body.evseId));
        }
        await db.delete(chargingProfiles).where(and(...conditions));

        // Auto-refresh station_reported rows on OCPP 2.1 stations. Fire-and-forget
        // GetChargingProfiles so the projection re-mirrors the station's actual
        // current state. 1.6 has no equivalent command (and no ReportChargingProfiles
        // payload), so the explicit DELETE above is the only mechanism for 1.6.
        if (station.ocppProtocol === '2.1' || station.ocppProtocol === 'ocpp2.1') {
          void sendOcppCommandAndWait(
            station.stationId,
            'GetChargingProfiles',
            { requestId: Math.floor(Math.random() * 2147483647), chargingProfile: {} },
            '2.1',
          ).catch(() => {
            // Best-effort refresh; don't fail the clear response on transport issues.
          });
        }
      }

      return result.response ?? { success: true };
    },
  );

  // POST /stations/:id/charging-profiles/push
  const pushChargingProfileBody = z.object({
    templateId: z.string().min(1).describe('Charging profile template ID'),
  });

  app.post(
    '/stations/:id/charging-profiles/push',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Push a charging profile template to this station',
        description:
          'Dispatches a best-effort ClearChargingProfile for the same purpose/stackLevel/evseId, then SetChargingProfile with the template payload. On Accepted, fires a background GetChargingProfiles to refresh the CSMS mirror (OCPP 2.1 only). Returns success=false with the station status when rejected.',
        operationId: 'pushStationChargingProfile',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(pushChargingProfileBody),
        response: {
          200: itemResponse(
            z
              .object({
                success: z
                  .boolean()
                  .describe('Whether the station accepted the charging profile push'),
                status: z
                  .string()
                  .describe('OCPP SetChargingProfile response status (Accepted, Rejected, etc.)'),
                errorInfo: z
                  .string()
                  .optional()
                  .describe('Error description when the push failed or was rejected'),
              })
              .passthrough(),
          ),
          400: errorWith('Station offline', [ERROR_CODES.STATION_OFFLINE]),
          404: errorWith('Resource not found', [
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.TEMPLATE_NOT_FOUND,
          ]),
          502: errorWith('Station rejected the command', [ERROR_CODES.STATION_REJECTED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const body = request.body as z.infer<typeof pushChargingProfileBody>;

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      const [template] = await db
        .select()
        .from(chargingProfileTemplates)
        .where(eq(chargingProfileTemplates.id, body.templateId));

      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const version = station.ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';

      // Best-effort clear existing profile with same purpose/stackLevel/evseId.
      // OCPP 2.1 wants the criteria nested under `chargingProfileCriteria`.
      try {
        await sendOcppCommandAndWait(
          station.stationId,
          'ClearChargingProfile',
          {
            chargingProfileCriteria: {
              chargingProfilePurpose: template.profilePurpose,
              stackLevel: template.stackLevel,
              evseId: template.evseId,
            },
          },
          version,
        );
      } catch {
        // Non-critical: clear failure should not block set
      }

      // Build SetChargingProfile payload
      const payload = {
        evseId: template.evseId,
        chargingProfile: {
          id: template.profileId,
          stackLevel: template.stackLevel,
          chargingProfilePurpose: template.profilePurpose,
          chargingProfileKind: template.profileKind,
          recurrencyKind: template.recurrencyKind || undefined,
          validFrom: template.validFrom?.toISOString() || undefined,
          validTo: template.validTo?.toISOString() || undefined,
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: template.chargingRateUnit,
              startSchedule: template.startSchedule?.toISOString() || undefined,
              duration: template.duration || undefined,
              chargingSchedulePeriod: template.schedulePeriods,
            },
          ],
        },
      };

      const result = await sendOcppCommandAndWait(
        station.stationId,
        'SetChargingProfile',
        payload,
        version,
      );

      if (result.error != null) {
        return { success: false, status: 'Failed', errorInfo: result.error };
      }

      const response = result.response as { status?: string } | undefined;
      const status = response?.status ?? 'Unknown';

      // Auto-refresh station_reported rows on OCPP 2.1 stations so the CSMS
      // mirror reflects the new on-station profile set without a manual
      // Refresh click. Fire-and-forget; do not block the push response.
      if (status === 'Accepted' && version === '2.1') {
        void sendOcppCommandAndWait(
          station.stationId,
          'GetChargingProfiles',
          { requestId: Math.floor(Math.random() * 2147483647), chargingProfile: {} },
          '2.1',
        ).catch(() => {});
      }

      if (status === 'Accepted') {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: stationAuditLog, idColumn: 'station_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: 'configuration_pushed',
            ...actor,
            notes: `Charging profile template ${body.templateId} pushed`,
          },
          db,
          request.log,
        );
      }

      return {
        success: status === 'Accepted',
        status,
        errorInfo: status !== 'Accepted' ? status : undefined,
      };
    },
  );

  // POST /stations/:id/configurations/push
  const pushConfigBody = z.object({
    templateId: z.string().min(1).describe('Configuration template ID'),
  });

  app.post(
    '/stations/:id/configurations/push',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Push a configuration template to this station',
        description:
          'Iterates the template variables and dispatches SetVariables (OCPP 2.1, batched) or one ChangeConfiguration per variable (OCPP 1.6). Per-variable results are returned with the per-variable status. After a successful push, a refresh (GetBaseReport on 2.1, GetConfiguration on 1.6) updates the CSMS mirror. Returns success=true only when every variable was Accepted.',
        operationId: 'pushStationConfiguration',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(pushConfigBody),
        response: {
          200: itemResponse(
            z
              .object({
                success: z
                  .boolean()
                  .describe('Whether every variable in the template was accepted by the station'),
                results: z
                  .array(
                    z
                      .object({
                        component: z
                          .string()
                          .describe('OCPP component name the variable belongs to'),
                        variable: z.string().describe('OCPP variable name'),
                        status: z
                          .string()
                          .describe(
                            'Per-variable result (Accepted, Rejected, NotSupported, error message, etc.)',
                          ),
                      })
                      .passthrough(),
                  )
                  .describe('Per-variable push result, in the order the variables were sent'),
              })
              .passthrough(),
          ),
          400: errorWith('Station offline', [ERROR_CODES.STATION_OFFLINE]),
          404: errorWith('Resource not found', [
            ERROR_CODES.STATION_NOT_FOUND,
            ERROR_CODES.TEMPLATE_NOT_FOUND,
          ]),
          502: errorWith('Station rejected the command', [ERROR_CODES.STATION_REJECTED]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const body = request.body as z.infer<typeof pushConfigBody>;

      const [station] = await db
        .select({
          stationId: chargingStations.stationId,
          isOnline: chargingStations.isOnline,
          ocppProtocol: chargingStations.ocppProtocol,
        })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      if (!station.isOnline) {
        await reply.status(400).send({ error: 'Station is offline', code: 'STATION_OFFLINE' });
        return;
      }

      const [template] = await db
        .select()
        .from(configTemplates)
        .where(eq(configTemplates.id, body.templateId));

      if (template == null) {
        await reply.status(404).send({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
        return;
      }

      const variables = template.variables as Array<{
        component: string;
        variable: string;
        value: string;
      }>;

      if (variables.length === 0) {
        return { success: true, results: [] };
      }

      const ocppVersion = station.ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';
      const results: Array<{ component: string; variable: string; status: string }> = [];
      let hasFailure = false;

      if (ocppVersion === '1.6') {
        // OCPP 1.6: one SetVariables per variable
        for (const v of variables) {
          const result = await sendOcppCommandAndWait(
            station.stationId,
            'SetVariables',
            {
              setVariableData: [
                {
                  component: { name: v.component },
                  variable: { name: v.variable },
                  attributeValue: v.value,
                },
              ],
            },
            ocppVersion,
          );

          if (result.error != null) {
            results.push({ component: v.component, variable: v.variable, status: result.error });
            hasFailure = true;
          } else {
            const setResult = result.response as {
              setVariableResult?: Array<{ attributeStatus?: string }>;
              status?: string;
            };
            const status =
              setResult.setVariableResult?.[0]?.attributeStatus ?? setResult.status ?? 'Unknown';
            results.push({ component: v.component, variable: v.variable, status });
            if (status !== 'Accepted') hasFailure = true;
          }
        }
      } else {
        // OCPP 2.1: bulk SetVariables
        const result = await sendOcppCommandAndWait(
          station.stationId,
          'SetVariables',
          {
            setVariableData: variables.map((v) => ({
              component: { name: v.component },
              variable: { name: v.variable },
              attributeValue: v.value,
            })),
          },
          ocppVersion,
        );

        if (result.error != null) {
          for (const v of variables) {
            results.push({ component: v.component, variable: v.variable, status: result.error });
          }
          hasFailure = true;
        } else {
          const response = result.response as {
            setVariableResult?: Array<{
              attributeStatus?: string;
              component?: { name?: string };
              variable?: { name?: string };
            }>;
          };
          const setResults = response.setVariableResult ?? [];
          for (const r of setResults) {
            const status = r.attributeStatus ?? 'Unknown';
            results.push({
              component: r.component?.name ?? '',
              variable: r.variable?.name ?? '',
              status,
            });
            if (status !== 'Accepted') hasFailure = true;
          }
        }
      }

      // After push, refresh station configurations
      try {
        if (ocppVersion === '1.6') {
          await sendOcppCommandAndWait(station.stationId, 'GetConfiguration', {}, ocppVersion);
        } else {
          await sendOcppCommandAndWait(
            station.stationId,
            'GetBaseReport',
            {
              requestId: Math.floor(Math.random() * 2147483647),
              reportBase: 'FullInventory',
            },
            ocppVersion,
          );
        }
      } catch {
        // Non-critical
      }

      if (!hasFailure) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: stationAuditLog, idColumn: 'station_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: 'configuration_pushed',
            ...actor,
            notes: `Config template ${body.templateId} pushed`,
          },
          db,
          request.log,
        );
      }

      return { success: !hasFailure, results };
    },
  );

  // --- EV Charging Needs ---

  const evChargingNeedsItem = z
    .object({
      id: z.number().describe('EV charging needs row ID'),
      stationId: z.string().describe('Station ID'),
      evseId: z.number().describe('EVSE ID the needs apply to'),
      chargingNeeds: z.record(z.unknown()).describe('Raw OCPP NotifyEVChargingNeeds payload'),
      departureTime: z.string().nullable().describe('Driver-provided departure time'),
      requestedEnergyTransfer: z
        .string()
        .nullable()
        .describe('Requested energy transfer mode (e.g., DC, AC_single_phase)'),
      controlMode: z.string().nullable().describe('Control mode (e.g., ScheduledControl)'),
      maxScheduleTuples: z.number().nullable().describe('Maximum number of schedule tuples'),
      createdAt: z.string().describe('Row creation timestamp'),
      updatedAt: z.string().describe('Row update timestamp'),
    })
    .passthrough();

  app.get(
    '/stations/:id/ev-charging-needs',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List EV charging needs for a station',
        operationId: 'listStationEvChargingNeeds',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        response: {
          200: arrayResponse(evChargingNeedsItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const data = await db
        .select()
        .from(evChargingNeeds)
        .where(eq(evChargingNeeds.stationId, id))
        .orderBy(desc(evChargingNeeds.updatedAt));

      return data;
    },
  );

  // --- Variable Monitoring Rules ---

  const monitoringRuleItem = z
    .object({
      id: z.number().describe('Monitoring rule row ID'),
      stationId: z.string().describe('Station ID'),
      monitoringId: z
        .number()
        .nullable()
        .describe('OCPP monitor ID assigned by the station, if any'),
      component: z.string().describe('OCPP component name being monitored'),
      variable: z.string().describe('OCPP variable name being monitored'),
      type: z
        .enum(['UpperThreshold', 'LowerThreshold', 'Delta', 'Periodic', 'PeriodicClockAligned'])
        .describe('Monitor type (OCPP 2.1 MonitorEnumType)'),
      value: z.string().describe('Threshold or interval value (numeric stored as string)'),
      severity: z.number().describe('OCPP severity level 0-9'),
      status: z.enum(['pending', 'active', 'cleared', 'error']).describe('Rule status'),
      errorInfo: z.string().nullable().describe('Error info when status is error'),
      createdAt: z.string().describe('Row creation timestamp'),
      updatedAt: z.string().describe('Row update timestamp'),
    })
    .passthrough();

  const createMonitoringRuleBody = z.object({
    component: z.string().min(1).describe('OCPP component name'),
    variable: z.string().min(1).describe('OCPP variable name'),
    type: z
      .enum(['UpperThreshold', 'LowerThreshold', 'Delta', 'Periodic', 'PeriodicClockAligned'])
      .describe('Monitor type (OCPP 2.1 MonitorEnumType)'),
    value: z.number().describe('Threshold value or interval'),
    severity: z.number().int().min(0).max(9).default(0).describe('OCPP severity level 0-9'),
  });

  app.get(
    '/stations/:id/monitoring-rules',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List variable monitoring rules for a station',
        operationId: 'listStationMonitoringRules',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(paginationQuery),
        response: {
          200: paginatedResponse(monitoringRuleItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof paginationQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const where = eq(variableMonitoringRules.stationId, id);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(variableMonitoringRules)
          .where(where)
          .orderBy(desc(variableMonitoringRules.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(variableMonitoringRules).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  app.post(
    '/stations/:id/monitoring-rules',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Create a variable monitoring rule and dispatch SetVariableMonitoring',
        description:
          'Inserts a variable_monitoring_rules row in pending state and dispatches SetVariableMonitoring to the station via pub/sub. The station response is processed asynchronously and updates the rule status to active or rejected.',
        operationId: 'createStationMonitoringRule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        body: zodSchema(createMonitoringRuleBody),
        response: {
          201: itemResponse(monitoringRuleItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
          502: errorWith('Station rejected the command', [ERROR_CODES.STATION_REJECTED]),
          504: errorWith('Station did not respond within timeout', [ERROR_CODES.STATION_TIMEOUT]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof createMonitoringRuleBody>;

      const [station] = await db
        .select({ id: chargingStations.id, stationId: chargingStations.stationId })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      // Insert the rule in pending state
      const [rule] = await db
        .insert(variableMonitoringRules)
        .values({
          stationId: id,
          component: body.component,
          variable: body.variable,
          type: body.type,
          value: String(body.value),
          severity: body.severity,
          status: 'pending',
        })
        .returning();

      // Dispatch SetVariableMonitoring OCPP command
      const commandPayload = {
        commandId: randomUUID(),
        stationId: station.stationId,
        action: 'SetVariableMonitoring',
        payload: {
          setMonitoringData: [
            {
              component: { name: body.component },
              variable: { name: body.variable },
              type: body.type,
              value: body.value,
              severity: body.severity,
            },
          ],
        },
      };

      try {
        const pubsub = (await import('../lib/pubsub.js')).getPubSub();
        await pubsub.publish('ocpp_commands', JSON.stringify(commandPayload));
      } catch {
        // Command dispatch is best-effort; rule is still created
      }

      return reply.status(201).send(rule);
    },
  );

  const monitoringRuleIdParams = z.object({
    id: z.string().describe('Station ID'),
    ruleId: z.coerce.number().int().describe('Monitoring rule ID'),
  });

  app.delete(
    '/stations/:id/monitoring-rules/:ruleId',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Delete a variable monitoring rule and dispatch ClearVariableMonitoring',
        description:
          'Dispatches ClearVariableMonitoring to the station and removes the rule row. The station may take a moment to acknowledge; the local row is removed eagerly so the rule no longer appears in lists.',
        operationId: 'deleteStationMonitoringRule',
        security: [{ bearerAuth: [] }],
        params: zodSchema(monitoringRuleIdParams),
        response: {
          204: { type: 'null' as const },
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, ruleId } = request.params as z.infer<typeof monitoringRuleIdParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [rule] = await db
        .select()
        .from(variableMonitoringRules)
        .where(
          and(eq(variableMonitoringRules.id, ruleId), eq(variableMonitoringRules.stationId, id)),
        );
      if (rule == null) {
        await reply
          .status(404)
          .send({ error: 'Monitoring rule not found', code: 'RULE_NOT_FOUND' });
        return;
      }

      // If the rule has a monitoringId from the station, dispatch ClearVariableMonitoring
      if (rule.monitoringId != null) {
        const [station] = await db
          .select({ stationId: chargingStations.stationId })
          .from(chargingStations)
          .where(eq(chargingStations.id, id));

        if (station != null) {
          const commandPayload = {
            commandId: randomUUID(),
            stationId: station.stationId,
            action: 'ClearVariableMonitoring',
            payload: { id: [rule.monitoringId] },
          };

          try {
            const pubsub = (await import('../lib/pubsub.js')).getPubSub();
            await pubsub.publish('ocpp_commands', JSON.stringify(commandPayload));
          } catch {
            // Best-effort
          }
        }
      }

      // Mark as cleared
      await db
        .update(variableMonitoringRules)
        .set({ status: 'cleared', updatedAt: new Date() })
        .where(eq(variableMonitoringRules.id, ruleId));

      return reply.status(204).send();
    },
  );

  // --- Event Alerts ---

  const eventAlertItem = z
    .object({
      id: z.number().describe('Event alert row ID'),
      stationId: z.string().describe('Station ID'),
      stationEventId: z
        .number()
        .nullable()
        .describe('Linked station_events row ID, if alert was raised by an event'),
      ruleId: z.number().nullable().describe('Linked event_alert_rules row ID, if any'),
      component: z.string().nullable().describe('OCPP component name that triggered the alert'),
      variable: z.string().nullable().describe('OCPP variable name that triggered the alert'),
      severity: z.number().nullable().describe('Severity level 0-9'),
      trigger: z
        .string()
        .nullable()
        .describe('Trigger reason (e.g., Alerting, Delta, Periodic, UpperThreshold)'),
      actualValue: z.string().nullable().describe('Reported value at the time of the alert'),
      techInfo: z.string().nullable().describe('Vendor-specific technical info'),
      acknowledgedAt: z.string().nullable().describe('When the alert was acknowledged'),
      acknowledgedBy: z.string().nullable().describe('User ID that acknowledged the alert'),
      createdAt: z.string().describe('Row creation timestamp'),
    })
    .passthrough();

  const eventAlertsQuery = paginationQuery.extend({
    severity: z.coerce.number().int().min(0).max(9).optional().describe('Filter by max severity'),
    acknowledged: z.enum(['true', 'false']).optional().describe('Filter by acknowledged status'),
  });

  app.get(
    '/stations/:id/event-alerts',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List event alerts for a station',
        operationId: 'listStationEventAlerts',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(eventAlertsQuery),
        response: {
          200: paginatedResponse(eventAlertItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const query = request.query as z.infer<typeof eventAlertsQuery>;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id));
      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const conditions = [eq(eventAlerts.stationId, id)];
      if (query.severity != null) {
        conditions.push(sql`${eventAlerts.severity} <= ${query.severity}`);
      }
      if (query.acknowledged === 'true') {
        conditions.push(isNotNull(eventAlerts.acknowledgedAt));
      } else if (query.acknowledged === 'false') {
        conditions.push(sql`${eventAlerts.acknowledgedAt} IS NULL`);
      }

      const where = and(...conditions);
      const page = query.page;
      const limit = query.limit;
      const offset = (page - 1) * limit;

      const [data, countResult] = await Promise.all([
        db
          .select()
          .from(eventAlerts)
          .where(where)
          .orderBy(desc(eventAlerts.createdAt))
          .limit(limit)
          .offset(offset),
        db.select({ total: count() }).from(eventAlerts).where(where),
      ]);

      return { data, total: countResult[0]?.total ?? 0 } satisfies PaginatedResponse<
        typeof data extends (infer U)[] ? U : never
      >;
    },
  );

  const alertIdParams = z.object({
    id: ID_PARAMS.stationId.describe('Station ID'),
    alertId: z.coerce.number().int().describe('Alert ID'),
  });

  app.post(
    '/stations/:id/event-alerts/:alertId/acknowledge',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['Stations'],
        summary: 'Acknowledge an event alert',
        operationId: 'acknowledgeEventAlert',
        security: [{ bearerAuth: [] }],
        params: zodSchema(alertIdParams),
        response: {
          200: successResponse,
          404: errorWith('Resource not found', [
            ERROR_CODES.ALERT_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, alertId } = request.params as z.infer<typeof alertIdParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const [updated] = await db
        .update(eventAlerts)
        .set({
          acknowledgedAt: new Date(),
          acknowledgedBy: userId,
        })
        .where(and(eq(eventAlerts.id, alertId), eq(eventAlerts.stationId, id)))
        .returning({ id: eventAlerts.id });

      if (updated == null) {
        await reply.status(404).send({ error: 'Alert not found', code: 'ALERT_NOT_FOUND' });
        return;
      }

      return { success: true as const };
    },
  );

  // Standalone meter values (not linked to a session)
  app.get(
    '/stations/:id/standalone-meter-values',
    {
      onRequest: [authorize('stations:read')],
      schema: {
        tags: ['Stations'],
        summary: 'List standalone meter values for a station',
        operationId: 'listStationMeterValues',
        security: [{ bearerAuth: [] }],
        params: zodSchema(stationParams),
        querystring: zodSchema(stationMeterValueQuery),
        response: {
          200: paginatedResponse(stationMeterValueItem),
          404: errorWith('Station not found', [ERROR_CODES.STATION_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof stationParams>;
      const { userId } = request.user as JwtPayload;
      if (!(await checkStationSiteAccess(id, userId))) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }
      const { page, limit, measurand } = request.query as z.infer<typeof stationMeterValueQuery>;
      const offset = (page - 1) * limit;

      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.id, id))
        .limit(1);

      if (station == null) {
        await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        return;
      }

      const conditions = [eq(meterValues.stationId, id), isNull(meterValues.sessionId)];
      if (measurand != null) {
        conditions.push(eq(meterValues.measurand, measurand));
      }
      const where = and(...conditions);

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: meterValues.id,
            timestamp: meterValues.timestamp,
            measurand: meterValues.measurand,
            value: meterValues.value,
            unit: meterValues.unit,
            phase: meterValues.phase,
            location: meterValues.location,
            context: meterValues.context,
          })
          .from(meterValues)
          .where(where)
          .orderBy(desc(meterValues.timestamp))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(meterValues)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );
}
