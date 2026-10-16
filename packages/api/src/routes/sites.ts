// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalidateAutochargeCaches } from '../lib/autocharge-invalidation.js';
import { eq, or, ilike, sql, gte, lte, and, desc, count, inArray, isNotNull } from 'drizzle-orm';
import {
  db,
  writeAudit,
  siteAuditLog,
  clearElectricityRateCache,
  clearAiUsageCache,
  getCompanyCurrency,
  pgErrorCode,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  toDate,
  isOperatorStation,
  operatorStationSql,
  inOperatorStation,
  SITE_INSIGHT_SUPPRESSION_SOURCES,
  siteInsightsOperatorSuppressedSql,
  siteInsightsSuppressedSql,
  siteInsightSuppressionSourcesSql,
} from '@evtivity/database';
import type { SiteInsightSuppressionSource } from '@evtivity/database';
import {
  resumeSiteAiInsights,
  suppressSiteAiInsights,
} from '../services/site-ai-insights.service.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { changedFields } from '../lib/audit-diff.js';
import { inCompanyCurrency, sessionCurrencySql } from '@evtivity/services/company-currency';
import {
  profitCents,
  queryRevenue,
  queryRevenueTotal,
  revenueItem,
} from '@evtivity/services/session-revenue';
import { siteNameEq } from '../lib/site-lookup.js';
import { publishPricingChanged } from '../lib/pricing-events.js';
import { pricingGroupExists } from '../lib/pricing-group-lookup.js';
import {
  sites,
  chargingStations,
  chargingSessions,
  drivers,
  meterValues,
  stationLayoutPositions,
  evses,
  connectors,
  siteLoadManagement,
  displayMessages,
  pricingGroupSites,
  pricingGroups,
  carbonIntensityFactors,
  pricingAssignmentAuditLog,
  siteElectricityRatePeriods,
  sitePaymentConfigs,
  paymentRecords,
} from '@evtivity/database';
import {
  isValidTimezone,
  electricityRateRestrictionsSchema,
  deriveElectricityRatePriority,
  STATION_MESSAGE_LANGUAGES,
  isKnownCountry,
} from '@evtivity/lib';
import type { ElectricityRatePeriodRestrictions } from '@evtivity/lib';
import { parseZodRequest, rejectUnknownBodyKeys, zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
  errorWith,
  errorResponse,
} from '../lib/response-schemas.js';
import {
  buildDerivedStatusSubquery,
  buildStatusReasonSubquery,
} from '@evtivity/services/station-derived-status';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import {
  exportSitesCsv,
  exportSitesTemplateCsv,
  importSitesCsv,
} from '../services/site-import.service.js';
import { getUserSiteIds, requireAllSiteAccess } from '../lib/site-access.js';
import { dateRangeQuery, parseDateRange } from '../lib/date-range.js';
import { enumerateLocalDays, zeroFillDays } from '../lib/daily-series.js';
import { buildUnderMaintenanceSubquery } from '../lib/station-maintenance-flag.js';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize, requestHasPermission } from '../middleware/rbac.js';
import { requestStationMessageRepush } from '@evtivity/services/station-message.service';
import { recalculateSiteElectricityCost } from '@evtivity/services/electricity-cost.service';
import { setSiteFreeVend } from '../services/free-vend.service.js';
import { siteInScope } from '../lib/site-scope.js';
import {
  captureDeletedSiteLocation,
  publishOcpiDeletedSiteLocation,
  publishOcpiLocationPush,
} from '../lib/ocpi-location-push.js';
import type { DeletedSiteLocation } from '../lib/ocpi-location-push.js';

const importSiteRow = z.object({
  siteName: z.string().min(1).max(255),
  stationId: z.string().max(255).optional(),
  stationModel: z.string().max(100).optional(),
  stationSerialNumber: z.string().max(100).optional(),
  stationStatus: z.enum(['available', 'unavailable', 'faulted']).optional(),
  // onboardingStatus is intentionally omitted from import: it has dedicated
  // approve/reject endpoints with state-machine guards (e.g. "not pending"
  // 409s) that the CSV path would otherwise bypass. The column stays in
  // export so operators can audit current state.
  evseId: z.number().int().min(1).optional(),
  connectorId: z.number().int().min(1).optional(),
  connectorType: z.string().max(50).optional(),
  maxPowerKw: z.number().min(0).max(10000).optional(),
  maxCurrentAmps: z.number().int().min(0).max(1000).optional(),
  stationVendor: z.string().max(100).optional(),
});

const importSiteBody = z.object({
  rows: z.array(importSiteRow).max(10000),
  updateExisting: z
    .boolean()
    .describe('When true, updates existing sites/stations matched by name/stationId'),
});

const siteParams = z.object({
  id: ID_PARAMS.siteId.describe('Site ID'),
});

const sitePricingGroupItem = z
  .object({
    id: z.string().describe('Pricing group identifier'),
    name: z.string().max(255).describe('Display name of the pricing group'),
    description: z.string().nullable().describe('Description of the pricing group'),
    isDefault: z.boolean().describe('Whether this is the system default pricing group'),
    tariffCount: z.number().int().min(0).describe('Number of tariffs in this pricing group'),
  })
  .passthrough();

const sitePricingGroupRecordItem = z
  .object({
    siteId: z.string().describe('Site identifier'),
    pricingGroupId: z.string().describe('Pricing group identifier assigned to the site'),
  })
  .passthrough();

const addSitePricingGroupBody = z.object({
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID to assign to the site'),
});

// Stored as a string for fixed-precision preservation, but the value still
// has to parse as a number in the WGS-84 range so the map and OCPI publish
// pipeline don't choke on 'abc' or 999.
const latitudeField = z
  .string()
  .max(20)
  .refine(
    (s) => {
      const n = Number(s);
      return Number.isFinite(n) && n >= -90 && n <= 90;
    },
    { message: 'Latitude must be a number in [-90, 90]' },
  );
const longitudeField = z
  .string()
  .max(20)
  .refine(
    (s) => {
      const n = Number(s);
      return Number.isFinite(n) && n >= -180 && n <= 180;
    },
    { message: 'Longitude must be a number in [-180, 180]' },
  );

const sitePricingGroupParams = z.object({
  id: ID_PARAMS.siteId.describe('Site ID'),
  pricingGroupId: ID_PARAMS.pricingGroupId.describe('Pricing group ID'),
});

// Free-form operating hours: null/empty/whitespace-only collapses to null so
// downstream renderers and the OCPI opening_times override don't have to
// distinguish "" from null.
const hoursOfOperationField = z
  .string()
  .max(500)
  .nullable()
  .optional()
  .transform((v) => {
    if (v == null) return v;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  });

// Roaming partners get the site's country as an ISO 3166-1 alpha-3 code
// (OCPI Location.country), so a site takes only a value that converts to one.
const COUNTRY_MESSAGE = 'Unknown country: use an ISO 3166-1 code or the English country name';
const emptyOrCountry = (value: string): boolean => value.trim() === '' || isKnownCountry(value);

const createSiteBody = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'Name is required')),
  address: z.string().max(500).optional(),
  city: z.string().max(255).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z
    .string()
    .max(100)
    .refine(emptyOrCountry, { message: COUNTRY_MESSAGE })
    .optional()
    .describe('Country: ISO 3166-1 alpha-2 or alpha-3 code, or English name'),
  latitude: latitudeField.optional(),
  longitude: longitudeField.optional(),
  timezone: z
    .string()
    .max(100)
    .refine(isValidTimezone, { message: 'Invalid IANA timezone' })
    .optional(),
  contactName: z.string().max(255).optional(),
  contactEmail: z.string().email().max(255).optional(),
  contactPhone: z.string().max(50).optional(),
  contactIsPublic: z.boolean().optional(),
  hoursOfOperation: hoursOfOperationField,
  metadata: z.record(z.unknown()).optional(),
});

// An optional site field that an update can clear: null or an empty string
// stores null, omitted keeps the stored value.
function clearable(field: z.ZodType<string, z.ZodTypeDef, string>, description: string) {
  return field
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v))
    .describe(`${description}. Null or an empty string clears it`);
}

const emptyOr = (check: (value: string) => boolean) => (value: string) =>
  value === '' || check(value);
const isEmail = (value: string): boolean => z.string().email().safeParse(value).success;
const isLatitude = (value: string): boolean => {
  const n = Number(value);
  return Number.isFinite(n) && n >= -90 && n <= 90;
};
const isLongitude = (value: string): boolean => {
  const n = Number(value);
  return Number.isFinite(n) && n >= -180 && n <= 180;
};

const updateSiteBody = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'Name is required'))
    .optional(),
  address: clearable(z.string().max(500), 'Street address'),
  city: clearable(z.string().max(255), 'City name'),
  state: clearable(z.string().max(100), 'State, province, or region'),
  postalCode: clearable(z.string().max(20), 'Postal or ZIP code'),
  country: clearable(
    z.string().max(100).refine(emptyOrCountry, { message: COUNTRY_MESSAGE }),
    'Country: ISO 3166-1 alpha-2 or alpha-3 code, or English name',
  ),
  latitude: clearable(
    z
      .string()
      .max(20)
      .refine(emptyOr(isLatitude), { message: 'Latitude must be a number in [-90, 90]' }),
    'Latitude in decimal degrees',
  ),
  longitude: clearable(
    z
      .string()
      .max(20)
      .refine(emptyOr(isLongitude), { message: 'Longitude must be a number in [-180, 180]' }),
    'Longitude in decimal degrees',
  ),
  timezone: z
    .string()
    .max(100)
    .refine(isValidTimezone, { message: 'Invalid IANA timezone' })
    .optional(),
  contactName: clearable(z.string().max(255), 'Site contact person name'),
  contactEmail: clearable(
    z.string().max(255).refine(emptyOr(isEmail), { message: 'Invalid email' }),
    'Site contact email address',
  ),
  contactPhone: clearable(z.string().max(50), 'Site contact phone number'),
  contactIsPublic: z.boolean().optional(),
  hoursOfOperation: hoursOfOperationField,
  metadata: z.record(z.unknown()).optional(),
  reservationsEnabled: z
    .boolean()
    .optional()
    .describe('Whether reservations are allowed at this site'),
  autochargeEnabled: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      'Autocharge (charge by plugging in) at this site. Null follows the autocharge.enabled setting',
    ),
  stationMessageLanguage: z
    .enum(STATION_MESSAGE_LANGUAGES)
    .nullable()
    .optional()
    .describe(
      'Display language of the station screens at this site. Null follows the stationMessage.language setting',
    ),
  aiInsightsEnabled: z
    .boolean()
    .optional()
    .describe('Whether automatic insights run for this site. Users with access to every site only'),
  aiMonthlyTokenBudget: z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000_000)
    .nullable()
    .optional()
    .describe(
      'Monthly AI token budget of this site. Null follows the ai.budget.siteMonthlyTokens setting, 0 means no limit. Users with access to every site only',
    ),
});

/** Site fields only a user with access to every site may change (a restricted user gets 404). */
const ALL_SITE_FIELDS = ['aiInsightsEnabled', 'aiMonthlyTokenBudget'] as const;

/** Site columns the OCPI location carries: a change pushes the location to partners. */
const OCPI_LOCATION_FIELDS = [
  'name',
  'address',
  'city',
  'state',
  'postalCode',
  'country',
  'latitude',
  'longitude',
  'timezone',
  'hoursOfOperation',
  'contactName',
  'contactIsPublic',
  'freeVendEnabled',
] as const;

/** Whether a site write changed what roaming partners see in its OCPI location. */
function ocpiLocationChanged(
  before: Partial<Record<(typeof OCPI_LOCATION_FIELDS)[number], unknown>>,
  after: Partial<Record<(typeof OCPI_LOCATION_FIELDS)[number], unknown>>,
): boolean {
  return OCPI_LOCATION_FIELDS.some((field) => before[field] !== after[field]);
}

/** The site name unique index answers a name taken by a concurrent write. */
function isSiteNameUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}

const siteSelect = {
  id: sites.id,
  name: sites.name,
  address: sites.address,
  city: sites.city,
  state: sites.state,
  postalCode: sites.postalCode,
  country: sites.country,
  latitude: sites.latitude,
  longitude: sites.longitude,
  timezone: sites.timezone,
  contactName: sites.contactName,
  contactEmail: sites.contactEmail,
  contactPhone: sites.contactPhone,
  contactIsPublic: sites.contactIsPublic,
  hoursOfOperation: sites.hoursOfOperation,
  metadata: sites.metadata,
  createdAt: sites.createdAt,
  updatedAt: sites.updatedAt,
  stationCount: sql<number>`count(${chargingStations.id})::int`,
  loadManagementEnabled: sql<boolean>`coalesce(${siteLoadManagement.isEnabled}, false)`,
  reservationsEnabled: sites.reservationsEnabled,
  autochargeEnabled: sites.autochargeEnabled,
  freeVendEnabled: sites.freeVendEnabled,
  freeVendTemplateId21: sites.freeVendTemplateId21,
  freeVendTemplateId16: sites.freeVendTemplateId16,
  freeVendRestoreTemplateId21: sites.freeVendRestoreTemplateId21,
  freeVendRestoreTemplateId16: sites.freeVendRestoreTemplateId16,
  stationMessageLanguage: sites.stationMessageLanguage,
  aiInsightsEnabled: sites.aiInsightsEnabled,
  aiMonthlyTokenBudget: sites.aiMonthlyTokenBudget,
  aiInsightsSuppressed: sql<boolean>`${sql.raw(siteInsightsSuppressedSql('sites'))}`,
  aiInsightsSuppressedSources: sql<
    SiteInsightSuppressionSource[]
  >`${sql.raw(siteInsightSuppressionSourcesSql('sites'))}`,
  // The operator suppression, null once its end date passed.
  aiInsightsSuppressedAt: sql<Date | null>`CASE WHEN ${sql.raw(siteInsightsOperatorSuppressedSql('sites'))} THEN ${sites.aiInsightsSuppressedAt} END`,
  aiInsightsSuppressedUntil: sql<Date | null>`CASE WHEN ${sql.raw(siteInsightsOperatorSuppressedSql('sites'))} THEN ${sites.aiInsightsSuppressedUntil} END`,
  aiInsightsSuppressedBy: sql<
    string | null
  >`CASE WHEN ${sql.raw(siteInsightsOperatorSuppressedSql('sites'))} THEN ${sites.aiInsightsSuppressedBy} END`,
  aiInsightsSuppressedByName: sql<
    string | null
  >`CASE WHEN ${sql.raw(siteInsightsOperatorSuppressedSql('sites'))} THEN (SELECT NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), '') FROM users u WHERE u.id = ${sites.aiInsightsSuppressedBy}) END`,
  aiInsightsSuppressedReason: sql<
    string | null
  >`CASE WHEN ${sql.raw(siteInsightsOperatorSuppressedSql('sites'))} THEN ${sites.aiInsightsSuppressedReason} END`,
  underMaintenance: sql<boolean>`EXISTS (
    SELECT 1
    FROM maintenance_events me
    WHERE me.site_id = ${sites.id}
      AND me.status = 'active'
  )`,
  maxPowerKw: sql<number | null>`null::numeric`,
  totalDrawKw: sql<number>`coalesce((
    SELECT sum(latest.kw)
    FROM (
      SELECT DISTINCT ON (mv.station_id)
        CASE WHEN mv.unit = 'kW' THEN mv.value::numeric ELSE mv.value::numeric / 1000 END AS kw
      FROM meter_values mv
      INNER JOIN charging_stations cs ON cs.id = mv.station_id
      WHERE cs.site_id = ${sites.id}
        AND ${sql.raw(operatorStationSql('cs'))}
        AND mv.measurand = 'Power.Active.Import'
        AND mv.timestamp >= now() - interval '60 seconds'
      ORDER BY mv.station_id, mv.timestamp DESC
    ) latest
  ), 0)`,
};

const siteItem = z
  .object({
    id: z.string().describe('Site identifier'),
    name: z.string().describe('Display name of the site'),
    address: z.string().nullable().describe('Street address'),
    city: z.string().nullable().describe('City name'),
    state: z.string().nullable().describe('State, province, or region'),
    postalCode: z.string().nullable().describe('Postal or ZIP code'),
    country: z.string().nullable().describe('Country name or ISO code'),
    latitude: z.string().nullable().describe('Latitude in decimal degrees as string for precision'),
    longitude: z
      .string()
      .nullable()
      .describe('Longitude in decimal degrees as string for precision'),
    timezone: z.string().nullable().describe('IANA timezone name (e.g. America/Los_Angeles)'),
    contactName: z.string().nullable().describe('Site contact person name'),
    contactEmail: z.string().nullable().describe('Site contact email address'),
    contactPhone: z.string().nullable().describe('Site contact phone number'),
    contactIsPublic: z
      .boolean()
      .describe('Whether contact information is visible to drivers in the portal'),
    hoursOfOperation: z.string().nullable().describe('Free-form description of operating hours'),
    metadata: z.record(z.unknown()).nullable().describe('Arbitrary site metadata as JSON object'),
    createdAt: z.coerce.date().describe('Timestamp when the site was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the site was last updated'),
    stationCount: z.number().describe('Number of charging stations at this site'),
    loadManagementEnabled: z.boolean().describe('Whether site-level load management is enabled'),
    underMaintenance: z
      .boolean()
      .describe('True when the site currently has an active maintenance event'),
    maxPowerKw: z.number().nullable().describe('Maximum power available at the site in kilowatts'),
    totalDrawKw: z.number().describe('Current total power draw across all stations in kilowatts'),
    stationMessageLanguage: z
      .string()
      .nullable()
      .describe(
        'Display language of the station screens at this site (en, de, es, ko, zh, zh-TW). Null follows the stationMessage.language setting',
      ),
    aiInsightsEnabled: z.boolean().describe('Whether automatic insights run for this site'),
    aiMonthlyTokenBudget: z
      .number()
      .nullable()
      .describe(
        'Monthly AI token budget of this site. Null follows the ai.budget.siteMonthlyTokens setting, 0 means no limit',
      ),
    aiInsightsSuppressed: z
      .boolean()
      .describe(
        'True while no site-level AI insight is created for the site: an operator suppressed the site (until aiInsightsSuppressedUntil, or until resumed), or an active maintenance event covers all of it. While an operator suppression holds, every station of the site is suppressed too',
      ),
    aiInsightsSuppressedSources: z
      .array(z.enum(SITE_INSIGHT_SUPPRESSION_SOURCES))
      .describe(
        'What suppresses the AI insights of the site now: site (the operator suppression, fields below), maintenance (an active maintenance event of the whole site). Empty when in scope',
      ),
    aiInsightsSuppressedAt: z.coerce
      .date()
      .nullable()
      .describe(
        'When an operator suppressed the AI insights of the site, null when not suppressed',
      ),
    aiInsightsSuppressedUntil: z.coerce
      .date()
      .nullable()
      .describe('End of the operator suppression, null for until resumed'),
    aiInsightsSuppressedBy: z.string().nullable().describe('User who suppressed them'),
    aiInsightsSuppressedByName: z.string().nullable().describe('Name of that user'),
    aiInsightsSuppressedReason: z.string().nullable().describe('Reason given for the suppression'),
  })
  .passthrough();

const siteBase = z
  .object({
    id: z.string().describe('Site identifier'),
    name: z.string().describe('Display name of the site'),
    address: z.string().nullable().describe('Street address'),
    city: z.string().nullable().describe('City name'),
    state: z.string().nullable().describe('State, province, or region'),
    postalCode: z.string().nullable().describe('Postal or ZIP code'),
    country: z.string().nullable().describe('Country name or ISO code'),
    latitude: z.string().nullable().describe('Latitude in decimal degrees as string for precision'),
    longitude: z
      .string()
      .nullable()
      .describe('Longitude in decimal degrees as string for precision'),
    timezone: z.string().nullable().describe('IANA timezone name (e.g. America/Los_Angeles)'),
    hoursOfOperation: z.string().nullable().describe('Free-form description of operating hours'),
    metadata: z.record(z.unknown()).nullable().describe('Arbitrary site metadata as JSON object'),
    autochargeEnabled: z
      .boolean()
      .nullable()
      .describe(
        'Autocharge (charge by plugging in) at this site. Null follows the autocharge.enabled setting',
      ),
    stationMessageLanguage: z
      .string()
      .nullable()
      .describe(
        'Display language of the station screens at this site (en, de, es, ko, zh, zh-TW). Null follows the stationMessage.language setting',
      ),
    aiInsightsEnabled: z.boolean().describe('Whether automatic insights run for this site'),
    aiMonthlyTokenBudget: z
      .number()
      .nullable()
      .describe(
        'Monthly AI token budget of this site. Null follows the ai.budget.siteMonthlyTokens setting, 0 means no limit',
      ),
    createdAt: z.coerce.date().describe('Timestamp when the site was created'),
    updatedAt: z.coerce.date().describe('Timestamp when the site was last updated'),
  })
  .passthrough();

const importResultResponse = z
  .object({
    sitesCreated: z.number().describe('Number of new sites created from the import'),
    sitesUpdated: z.number().describe('Number of existing sites updated by the import'),
    stationsCreated: z.number().describe('Number of new charging stations created'),
    stationsUpdated: z.number().describe('Number of existing charging stations updated'),
    evsesCreated: z.number().describe('Number of new EVSEs created'),
    evsesUpdated: z.number().describe('Number of existing EVSEs updated'),
    connectorsCreated: z.number().describe('Number of new connectors created'),
    connectorsUpdated: z.number().describe('Number of existing connectors updated'),
    errors: z
      .array(z.string())
      .describe('List of error messages encountered during import, one per failing row'),
  })
  .passthrough();

const siteMetricsResponse = z
  .object({
    uptimePercent: z
      .number()
      .describe('Average port uptime percentage over the reporting period (0-100)'),
    portCount: z.number().describe('Total number of charging ports at the site'),
    utilizationPercent: z
      .number()
      .describe('Percentage of total port-hours occupied by sessions over the reporting period'),
    totalSessions: z.number().describe('Total number of charging sessions in the reporting period'),
    completedSessions: z.number().describe('Number of sessions that completed successfully'),
    faultedSessions: z.number().describe('Number of sessions that ended in a fault state'),
    sessionSuccessPercent: z
      .number()
      .describe('Percentage of sessions that completed successfully (0-100)'),
    totalEnergyWh: z.number().describe('Total energy delivered in watt-hours'),
    avgSessionDurationMinutes: z
      .number()
      .describe('Average session duration in minutes for completed sessions'),
    disconnectCount: z
      .number()
      .describe('Number of station disconnect events in the reporting period'),
    avgDowntimeMinutes: z.number().describe('Average duration of disconnect outages in minutes'),
    maxDowntimeMinutes: z.number().describe('Longest single disconnect outage duration in minutes'),
    totalRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Total revenue in the period in cents, tax included. Revenue is the final cost of ended sessions plus reservation fees charged, minus refunds, in the company currency; active sessions are not counted',
      ),
    avgRevenueCentsPerSession: z
      .number()
      .describe('Average revenue per ended session billed in the company currency, in cents'),
    totalTransactions: z
      .number()
      .describe('Number of revenue items: ended billed sessions plus reservation fee charges'),
    totalElectricityCostCents: z
      .number()
      .int()
      .min(0)
      .describe('Total wholesale electricity cost in cents over the reporting period'),
    totalNetRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Total revenue excluding tax in cents. Each amount is split at its own tax rate (a session at its tariff tax rate, a reservation fee at the rate it was taxed at).',
      ),
    totalTaxCents: z
      .number()
      .int()
      .min(0)
      .describe('Tax collected in cents (total revenue minus total net revenue)'),
    totalProfitCents: z
      .number()
      .int()
      .describe(
        'Total profit in cents (revenue excluding tax minus electricity cost); may be negative. Sessions without an electricity cost (costMissingSessionCount) are left out.',
      ),
    costMissingSessionCount: z
      .number()
      .int()
      .min(0)
      .describe(
        'Ended billed sessions in the period that delivered energy but have no electricity cost (no matching site rate period, or no site). Left out of profit.',
      ),
    costMissingRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe('Revenue of those sessions in cents, tax included. Left out of profit.'),
    periodMonths: z.number().describe('Number of months covered by this metrics report'),
    currency: z
      .string()
      .length(3)
      .describe(
        'Company currency (ISO 4217) of the revenue, cost, and profit amounts. Those amounts sum only sessions billed in this currency.',
      ),
  })
  .passthrough();

const siteStationItem = z
  .object({
    id: z.string().describe('Internal station identifier (UUID)'),
    stationId: z.string().describe('OCPP station identifier used by the charging station'),
    siteId: z.string().nullable().describe('Identifier of the site this station belongs to'),
    model: z.string().nullable().describe('Hardware model name reported by the station'),
    serialNumber: z.string().nullable().describe('Hardware serial number reported by the station'),
    availability: z
      .string()
      .describe('Station-level availability state (available, unavailable, faulted)'),
    securityProfile: z
      .number()
      .describe('OCPP security profile level (0=none, 1=basic auth, 2=basic auth + TLS, 3=mTLS)'),
    ocppProtocol: z
      .string()
      .nullable()
      .describe('OCPP protocol the station speaks (ocpp1.6 or ocpp2.1), null before it connects'),
    lastHeartbeat: z.coerce
      .date()
      .nullable()
      .describe('Timestamp of the most recent heartbeat received from the station'),
    isOnline: z.boolean().describe('Whether the station is currently connected to the CSMS'),
    createdAt: z.coerce.date().describe('Timestamp when the station was registered'),
    updatedAt: z.coerce.date().describe('Timestamp when the station record was last updated'),
    status: z
      .string()
      .describe(
        'Station status: a disable, firmware, or station-reported state first, else the connector summary (charging, reserved, faulted, available, unavailable, unknown)',
      ),
    statusReason: z
      .string()
      .nullable()
      .describe(
        'Why the station is not available (operator_disabled, security_disabled, firmware_failed, station_faulted, connector_faulted, firmware_installing, station_unavailable), null when it is',
      ),
    connectorCount: z.number().describe('Number of connectors installed on this station'),
    connectorTypes: z
      .array(z.string())
      .nullable()
      .describe('Distinct connector types present on this station (e.g. CCS2, CHAdeMO, Type2)'),
    underMaintenance: z
      .boolean()
      .describe('Whether an active maintenance event currently covers this station'),
  })
  .passthrough();

const energyHistoryItem = z
  .object({
    date: z.string().describe('Calendar date in YYYY-MM-DD format (in site timezone)'),
    energyWh: z.number().describe('Total energy delivered on this date in watt-hours'),
  })
  .passthrough();

const revenueHistoryItem = z
  .object({
    date: z.string().describe('Calendar date in YYYY-MM-DD format (in site timezone)'),
    revenueCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Revenue on this date in cents, tax included: final costs of sessions started that day plus reservation fees charged that day, minus refunds, in the company currency. Active sessions are not counted',
      ),
    sessionCount: z
      .number()
      .describe(
        'Number of ended sessions billed in the company currency that started on this date',
      ),
  })
  .passthrough();

const meterValueGroup = z
  .object({
    measurand: z
      .string()
      .describe('OCPP measurand name (e.g. Energy.Active.Import.Register, Power.Active.Import)'),
    unit: z.string().nullable().describe('Unit of measure for the values (e.g. Wh, kW, V, A)'),
    values: z
      .array(
        z
          .object({
            timestamp: z.coerce.date().describe('Timestamp when this meter sample was taken'),
            value: z.string().describe('Meter reading value as a string for numeric precision'),
          })
          .passthrough(),
      )
      .describe('Chronologically ordered list of meter readings for this measurand'),
  })
  .passthrough();

const siteSessionItem = z
  .object({
    id: z.string().describe('Session identifier'),
    stationId: z.string().describe('Internal station identifier (UUID)'),
    stationName: z.string().nullable().describe('OCPP station identifier of the charging station'),
    siteName: z.string().nullable().describe('Display name of the site'),
    driverId: z.string().nullable().describe('Identifier of the driver, if known'),
    driverName: z.string().nullable().describe('Full name of the driver (first + last)'),
    transactionId: z
      .string()
      .nullable()
      .describe('OCPP transaction identifier reported by the station'),
    status: z.string().describe('Session status (active, completed, faulted, failed, idling)'),
    energyDeliveredWh: z.coerce
      .number()
      .nullable()
      .describe('Total energy delivered during the session in watt-hours'),
    currentCostCents: z
      .number()
      .nullable()
      .describe('Current accrued cost in cents while the session is active'),
    finalCostCents: z
      .number()
      .nullable()
      .describe('Final billed cost in cents after the session ended'),
    currency: z.string().length(3).describe('ISO 4217 currency the session is billed in'),
    startedAt: z.coerce.date().describe('Timestamp when the charging session started'),
    endedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the session ended, or null if still active'),
    freeVend: z
      .boolean()
      .describe('Whether the session was a free-vend session (no driver authorization or payment)'),
  })
  .passthrough();

const layoutConnector = z
  .object({
    connectorId: z.number().describe('OCPP connector ID within the EVSE'),
    connectorType: z
      .string()
      .nullable()
      .describe('Connector type (e.g. CCS2, CHAdeMO, Type2, Type1, NACS)'),
    maxPowerKw: z.number().nullable().describe('Maximum power rating in kilowatts'),
    status: z.string().describe('Current connector status'),
    isPluggedIn: z
      .boolean()
      .describe('Whether a vehicle is currently plugged in (active session present)'),
    energyDeliveredWh: z
      .number()
      .nullable()
      .describe('Energy delivered during the active session in watt-hours, or null if idle'),
  })
  .passthrough();

const layoutEvse = z
  .object({
    evseId: z.number().describe('OCPP EVSE ID within the station'),
    connectors: z.array(layoutConnector).describe('Connectors belonging to this EVSE'),
  })
  .passthrough();

const layoutStation = z
  .object({
    id: z.string().describe('Internal station identifier (UUID)'),
    stationId: z.string().describe('OCPP station identifier'),
    model: z.string().nullable().describe('Hardware model name'),
    status: z
      .string()
      .nullable()
      .describe(
        'Station status: a disable, firmware, or station-reported state first, else the connector summary (charging, reserved, faulted, available, unavailable, unknown)',
      ),
    statusReason: z
      .string()
      .nullable()
      .describe(
        'Why the station is not available (operator_disabled, security_disabled, firmware_failed, station_faulted, connector_faulted, firmware_installing, station_unavailable), null when it is',
      ),
    isOnline: z.boolean().describe('Whether the station is currently connected to the CSMS'),
    securityProfile: z.number().describe('OCPP security profile level (0-3)'),
    positionX: z.number().describe('X coordinate on the site layout canvas'),
    positionY: z.number().describe('Y coordinate on the site layout canvas'),
    displayMessage: z
      .string()
      .nullable()
      .describe('Most recent accepted display message text shown on the station, if any'),
    evses: z.array(layoutEvse).describe('EVSEs installed on this station'),
  })
  .passthrough();

const sitesListQuery = paginationQuery.extend({
  city: z.string().optional().describe('Filter by city'),
  state: z.string().optional().describe('Filter by state'),
  loadManagement: z.enum(['true', 'false']).optional().describe('Filter by load management status'),
  aiInsights: z
    .enum(['in_scope', 'suppressed'])
    .optional()
    .describe(
      'Filter by AI insight scope: suppressed (by an operator, or by an active maintenance event of the whole site) or in_scope',
    ),
});

const locationOption = z
  .object({
    city: z.string().describe('City name'),
    state: z.string().describe('State, province, or region'),
  })
  .passthrough();
const filterOptionsResponse = z
  .object({
    locations: z
      .array(locationOption)
      .describe('Distinct city and state combinations across the user-accessible sites'),
  })
  .passthrough();

export function siteRoutes(app: FastifyInstance): void {
  app.get(
    '/sites',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'List all sites',
        operationId: 'listSites',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(sitesListQuery),
        response: { 200: paginatedResponse(siteItem) },
      },
    },
    async (request) => {
      const { page, limit, search, city, state, loadManagement, aiInsights } =
        request.query as z.infer<typeof sitesListQuery>;
      const offset = (page - 1) * limit;

      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) {
        return { data: [], total: 0 } satisfies PaginatedResponse<never>;
      }

      const conditions = [];

      if (siteIds != null) {
        conditions.push(inArray(sites.id, siteIds));
      }

      if (search) {
        const pattern = `%${search}%`;
        conditions.push(
          or(
            ilike(sites.id, pattern),
            ilike(sites.name, pattern),
            ilike(sites.city, pattern),
            ilike(sites.state, pattern),
          ),
        );
      }
      if (city) {
        conditions.push(ilike(sites.city, city));
      }
      if (state) {
        conditions.push(ilike(sites.state, state));
      }
      if (loadManagement != null) {
        conditions.push(
          loadManagement === 'true'
            ? sql`coalesce(${siteLoadManagement.isEnabled}, false) = true`
            : sql`coalesce(${siteLoadManagement.isEnabled}, false) = false`,
        );
      }
      const aiSuppressed = sql<boolean>`${sql.raw(siteInsightsSuppressedSql('sites'))}`;
      if (aiInsights === 'suppressed') conditions.push(aiSuppressed);
      if (aiInsights === 'in_scope') conditions.push(sql`NOT ${aiSuppressed}`);

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select(siteSelect)
          .from(sites)
          // Conformance test stations do not count at a site.
          .leftJoin(
            chargingStations,
            and(eq(chargingStations.siteId, sites.id), isOperatorStation()),
          )
          .leftJoin(siteLoadManagement, eq(siteLoadManagement.siteId, sites.id))
          .where(where)
          .groupBy(sites.id, siteLoadManagement.isEnabled)
          .orderBy(desc(sites.createdAt), desc(sites.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(sites)
          .leftJoin(siteLoadManagement, eq(siteLoadManagement.siteId, sites.id))
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  app.get(
    '/sites/filter-options',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get distinct filter values for sites',
        operationId: 'getSiteFilterOptions',
        security: [{ bearerAuth: [] }],
        response: { 200: zodSchema(filterOptionsResponse) },
      },
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);

      const conditions = [isNotNull(sites.city), isNotNull(sites.state)];
      if (siteIds != null) {
        if (siteIds.length === 0) return { locations: [] };
        conditions.push(inArray(sites.id, siteIds));
      }

      const rows = await db
        .selectDistinct({ city: sites.city, state: sites.state })
        .from(sites)
        .where(and(...conditions))
        .orderBy(sites.city, sites.state);

      return {
        locations: rows.map((r) => ({ city: r.city as string, state: r.state as string })),
      };
    },
  );

  app.get(
    '/sites/export',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Export sites as CSV',
        description:
          'Exports every site matching the list filters (search, city, state, loadManagement, aiInsights), with their stations, EVSEs and connectors. page and limit are ignored.',
        operationId: 'exportSites',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(sitesListQuery),
      },
    },
    async (request, reply) => {
      const { search, city, state, loadManagement, aiInsights } = request.query as z.infer<
        typeof sitesListQuery
      >;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const csv = await exportSitesCsv(search, siteIds ?? undefined, {
        city,
        state,
        loadManagement,
        aiInsights,
      });
      await reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename=sites.csv')
        .send(csv);
    },
  );

  app.get(
    '/sites/export/template',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Download site import CSV template',
        operationId: 'exportSiteTemplate',
        security: [{ bearerAuth: [] }],
      },
    },
    async (_request, reply) => {
      const csv = exportSitesTemplateCsv();
      await reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename=sites-template.csv')
        .send(csv);
    },
  );

  app.post(
    '/sites/import',
    {
      onRequest: [authorize('sites:write')],
      // The 10,000-row Zod cap can serialize to ~10 MB at worst-case field
      // widths. Default 1 MB body limit silently 413s well below the schema's
      // documented maximum, so raise the route limit to match.
      bodyLimit: 16 * 1024 * 1024,
      schema: {
        tags: ['Sites'],
        summary: 'Import sites from parsed CSV rows',
        operationId: 'importSites',
        security: [{ bearerAuth: [] }],
        description:
          'Creates sites by name and, from rows with a stationId, stations with their EVSEs and connectors. Rows with a stationId also need stations:write (403 INSUFFICIENT_PERMISSIONS).',
        body: zodSchema(importSiteBody),
        response: {
          200: zodSchema(importResultResponse),
          403: errorWith('Station rows without stations:write', [
            ERROR_CODES.INSUFFICIENT_PERMISSIONS,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { rows, updateExisting } = request.body as z.infer<typeof importSiteBody>;
      // Station rows create, move and disable stations: the station permission
      // applies as it does on the station routes.
      if (
        rows.some((row) => row.stationId != null && row.stationId !== '') &&
        !(await requestHasPermission(request, 'stations:write'))
      ) {
        await reply
          .status(403)
          .send({ error: 'Insufficient permissions', code: 'INSUFFICIENT_PERMISSIONS' });
        return;
      }
      const { userId } = request.user as { userId: string };
      const allowedSiteIds = await getUserSiteIds(userId);
      return importSitesCsv(
        rows,
        updateExisting,
        getAuditActor(request),
        allowedSiteIds,
        request.log,
      );
    },
  );

  app.get(
    '/sites/:id',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get a site by ID',
        operationId: 'getSite',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: {
          200: itemResponse(siteItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [row] = await db
        .select(siteSelect)
        .from(sites)
        // Conformance test stations do not count at a site.
        .leftJoin(chargingStations, and(eq(chargingStations.siteId, sites.id), isOperatorStation()))
        .leftJoin(siteLoadManagement, eq(siteLoadManagement.siteId, sites.id))
        .where(eq(sites.id, id))
        .groupBy(sites.id, siteLoadManagement.isEnabled);
      if (row == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      return row;
    },
  );

  const aiSuppressBody = z.object({
    reason: z.string().trim().min(1).max(500).describe('Why the AI insights are suppressed'),
    until: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('End of the suppression (ISO 8601, in the future); omitted for until resumed'),
  });
  const aiSuppressionResponse = z
    .object({
      aiInsightsSuppressedAt: z.coerce.date().nullable().describe('When they were suppressed'),
      aiInsightsSuppressedUntil: z.coerce
        .date()
        .nullable()
        .describe('End of the suppression, null for until resumed'),
      aiInsightsSuppressedBy: z.string().nullable().describe('User who suppressed them'),
      aiInsightsSuppressedByName: z.string().nullable().describe('Name of that user'),
      aiInsightsSuppressedReason: z.string().nullable().describe('Reason of the suppression'),
      insightsDismissed: z
        .number()
        .int()
        .optional()
        .describe('Open insights of the site and its stations dismissed by the suppression'),
      actionsExpired: z
        .number()
        .int()
        .optional()
        .describe(
          'Waiting insight actions of the site and its stations expired by the suppression',
        ),
    })
    .passthrough();

  // Per-site AI insight suppression (site-ai-insights.service.ts).
  app.post(
    '/sites/:id/ai-insights/suppress',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Suppress the AI insights of a site',
        description:
          'Until `until` (or until resumed), every station of the site counts as suppressed (stations added later included: the insight scan and the AI workers create no station insight or action for them, as for a suppressed station), and the site gets no site-level insight (site incidents, site summaries, tariff findings). The open insights of the site and its stations close dismissed with the reason, and their waiting actions expire. The end date passing resumes the insights with no action. Audited in the site history. 400 VALIDATION_ERROR for an end date that is not in the future.',
        operationId: 'suppressSiteAiInsights',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(aiSuppressBody),
        response: {
          200: itemResponse(aiSuppressionResponse),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
      config: { invalidatesCacheTags: ['stations'] },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const body = parseZodRequest(aiSuppressBody, request.body);
      const { userId } = request.user as JwtPayload;
      if (!siteInScope(await getUserSiteIds(userId), id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const until = body.until == null ? null : new Date(body.until);
      if (until != null && until.getTime() <= Date.now()) {
        await reply
          .status(400)
          .send({ error: 'The end date must be in the future', code: 'VALIDATION_ERROR' });
        return;
      }
      const result = await suppressSiteAiInsights(
        id,
        { reason: body.reason, until },
        getAuditActor(request),
        request.log,
      );
      if (result == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      return {
        aiInsightsSuppressedAt: result.suppressedAt,
        aiInsightsSuppressedUntil: result.suppressedUntil,
        aiInsightsSuppressedBy: result.suppressedBy,
        aiInsightsSuppressedByName: result.suppressedByName,
        aiInsightsSuppressedReason: result.reason,
        insightsDismissed: result.insightsDismissed,
        actionsExpired: result.actionsExpired,
      };
    },
  );

  app.post(
    '/sites/:id/ai-insights/resume',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Resume the AI insights of a site',
        description:
          'Ends an operator suppression of the site AI insights; the insight scan and the AI workers watch the site and its stations again (a suppression of a single station and an active maintenance event still suppress them while they last). Audited in the site history.',
        operationId: 'resumeSiteAiInsights',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: {
          200: itemResponse(aiSuppressionResponse),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
      config: { invalidatesCacheTags: ['stations'] },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      if (!siteInScope(await getUserSiteIds(userId), id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const result = await resumeSiteAiInsights(id, getAuditActor(request), request.log);
      if (result == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      return {
        aiInsightsSuppressedAt: result.suppressedAt,
        aiInsightsSuppressedUntil: result.suppressedUntil,
        aiInsightsSuppressedBy: result.suppressedBy,
        aiInsightsSuppressedByName: result.suppressedByName,
        aiInsightsSuppressedReason: result.reason,
      };
    },
  );

  app.post(
    '/sites',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Create a new site',
        operationId: 'createSite',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createSiteBody),
        response: {
          201: itemResponse(siteBase),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      // Creating a site is company-wide: a site-restricted user gets 404.
      if (
        !(await requireAllSiteAccess(request, reply, {
          error: 'Site not found',
          code: 'SITE_NOT_FOUND',
        }))
      ) {
        return;
      }
      const body = parseZodRequest(createSiteBody, request.body);

      // Pre-check the unique name constraint (case-insensitive) so duplicate
      // names return a clean 409 instead of a Postgres unique-violation 500.
      const [existing] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(siteNameEq(body.name))
        .limit(1);
      if (existing != null) {
        await reply
          .status(409)
          .send({ error: 'A site with this name already exists', code: 'DUPLICATE_SITE_NAME' });
        return;
      }

      let site: typeof sites.$inferSelect | undefined;
      try {
        [site] = await db.insert(sites).values(body).returning();
      } catch (err) {
        // A concurrent create took the name after the check above.
        if (!isSiteNameUniqueViolation(err)) throw err;
        await reply
          .status(409)
          .send({ error: 'A site with this name already exists', code: 'DUPLICATE_SITE_NAME' });
        return;
      }
      if (site != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: siteAuditLog, idColumn: 'site_id' },
          {
            entityId: site.id,
            entityIdSnapshot: site.id,
            action: 'created',
            ...actor,
            after: site,
          },
          db,
          request.log,
        );
      }
      await reply.status(201).send(site);
    },
  );

  app.patch(
    '/sites/:id',
    {
      onRequest: [authorize('sites:write')],
      // Ajv drops unknown keys, so `freeVendEnabled` here answered 200 and
      // changed nothing: refuse every key the body does not name.
      preValidation: [
        rejectUnknownBodyKeys(updateSiteBody, {
          freeVendEnabled: 'free vend is set with POST /v1/sites/:id/free-vend',
        }),
      ],
      schema: {
        tags: ['Sites'],
        summary: 'Update a site',
        description:
          'Updates the given fields. A field the body does not define (such as freeVendEnabled, set with POST /v1/sites/:id/free-vend) answers 400 VALIDATION_ERROR.',
        operationId: 'updateSite',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(updateSiteBody),
        response: {
          200: itemResponse(siteBase),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const body = parseZodRequest(updateSiteBody, request.body);
      // A restricted operator cannot change company-wide AI controls of its own site.
      if (ALL_SITE_FIELDS.some((field) => body[field] !== undefined) && siteIds !== null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [before] = await db.select().from(sites).where(eq(sites.id, id));

      // If the name is actually changing, pre-check the unique constraint
      // (case-insensitive) so duplicates return a clean 409 instead of a
      // Postgres unique-violation 500.
      if (body.name != null && before != null && body.name !== before.name) {
        const [existing] = await db
          .select({ id: sites.id })
          .from(sites)
          .where(and(siteNameEq(body.name), sql`${sites.id} <> ${id}`))
          .limit(1);
        if (existing != null) {
          await reply
            .status(409)
            .send({ error: 'A site with this name already exists', code: 'DUPLICATE_SITE_NAME' });
          return;
        }
      }

      let site: typeof sites.$inferSelect | undefined;
      try {
        [site] = await db
          .update(sites)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(sites.id, id))
          .returning();
      } catch (err) {
        // A concurrent write took the name after the check above.
        if (!isSiteNameUniqueViolation(err)) throw err;
        await reply
          .status(409)
          .send({ error: 'A site with this name already exists', code: 'DUPLICATE_SITE_NAME' });
        return;
      }
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const actor = getAuditActor(request);
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: site.id,
          entityIdSnapshot: site.id,
          action: 'updated',
          ...actor,
          before: before ?? null,
          after: site,
        },
        db,
        request.log,
      );
      if (
        before != null &&
        body.stationMessageLanguage !== undefined &&
        before.stationMessageLanguage !== site.stationMessageLanguage
      ) {
        await requestStationMessageRepush(request.log, { siteId: site.id });
      }
      if (body.aiMonthlyTokenBudget !== undefined) clearAiUsageCache();
      // Push partners hold a copy of the location: send them the new address,
      // coordinates, hours or contact (OCPI 8.1, fail-open).
      if (before != null && ocpiLocationChanged(before, site)) {
        await publishOcpiLocationPush(site.id, null, request.log);
      }
      if (body.autochargeEnabled !== undefined) await invalidateAutochargeCaches(request.log);
      return site;
    },
  );

  app.delete(
    '/sites/:id',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Delete a site',
        description:
          'Deletes a site that has no stations (a deleted station keeps its site for its history, so it still counts: 409 SITE_HAS_STATIONS). The site payment configuration, its payout account link and open payout onboarding links go with the site; a site whose payment configuration has payments is kept (409 SITE_PAYMENT_CONFIG_IN_USE).',
        operationId: 'deleteSite',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: {
          200: itemResponse(siteBase),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
          409: errorWith(
            'The site has stations (deleted stations included), or its payment configuration has payments',
            [ERROR_CODES.SITE_HAS_STATIONS, ERROR_CODES.SITE_PAYMENT_CONFIG_IN_USE],
          ),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const hasStationsBody = {
        error: 'Cannot delete site with stations. Remove or reassign stations first.',
        code: 'SITE_HAS_STATIONS',
      };
      const hasPaymentsBody = {
        error: "This site's payment configuration has payments, so the site cannot be deleted.",
        code: 'SITE_PAYMENT_CONFIG_IN_USE',
      };
      // The site row lock orders this delete with a station or payment config
      // that names the site (their foreign key check locks the site row), so
      // the checks below cannot miss one written meanwhile.
      let outcome:
        | { kind: 'missing' }
        | { kind: 'stations' }
        | { kind: 'payments' }
        | {
            kind: 'deleted';
            site: typeof sites.$inferSelect;
            paymentConfig: typeof sitePaymentConfigs.$inferSelect | null;
            ocpiLocation: DeletedSiteLocation | null;
          };
      try {
        outcome = await db.transaction(async (tx) => {
          const [locked] = await tx.select().from(sites).where(eq(sites.id, id)).for('update');
          if (locked == null) return { kind: 'missing' as const };
          const [station] = await tx
            .select({ id: chargingStations.id })
            .from(chargingStations)
            .where(eq(chargingStations.siteId, id))
            .limit(1);
          if (station != null) return { kind: 'stations' as const };
          // The payment config goes with the site (cascade), but payments keep
          // their config for their history, so a site with payments stays.
          const [paymentConfig] = await tx
            .select()
            .from(sitePaymentConfigs)
            .where(eq(sitePaymentConfigs.siteId, id));
          if (paymentConfig != null) {
            const [payment] = await tx
              .select({ id: paymentRecords.id })
              .from(paymentRecords)
              .where(eq(paymentRecords.sitePaymentConfigId, paymentConfig.id))
              .limit(1);
            if (payment != null) return { kind: 'payments' as const };
          }
          // The delete cascades the publish row and the removed EVSEs: read
          // the location partners have before it goes.
          const ocpiLocation = await captureDeletedSiteLocation(locked, request.log);
          await tx.delete(sites).where(eq(sites.id, id));
          return {
            kind: 'deleted' as const,
            site: locked,
            paymentConfig: paymentConfig ?? null,
            ocpiLocation,
          };
        });
      } catch (err) {
        // A row written after the checks (outside the lock order) still names
        // the site or its payment config: answer as the checks would have.
        if (pgErrorCode(err) !== PG_FOREIGN_KEY_VIOLATION) throw err;
        const [station] = await db
          .select({ id: chargingStations.id })
          .from(chargingStations)
          .where(eq(chargingStations.siteId, id))
          .limit(1);
        await reply.status(409).send(station != null ? hasStationsBody : hasPaymentsBody);
        return;
      }

      if (outcome.kind === 'missing') {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (outcome.kind === 'stations') {
        await reply.status(409).send(hasStationsBody);
        return;
      }
      if (outcome.kind === 'payments') {
        await reply.status(409).send(hasPaymentsBody);
        return;
      }
      const { site, paymentConfig, ocpiLocation } = outcome;
      if (ocpiLocation != null) await publishOcpiDeletedSiteLocation(ocpiLocation, request.log);
      const actor = getAuditActor(request);
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: null,
          entityIdSnapshot: site.id,
          action: 'deleted',
          ...actor,
          // The payment config and its payout account went with the site.
          before: paymentConfig != null ? { ...site, paymentConfig } : site,
        },
        db,
        request.log,
      );
      return site;
    },
  );

  const siteMetricsQuery = z.object({
    months: z.coerce
      .number()
      .int()
      .min(1)
      .max(24)
      .default(12)
      .describe('Number of months to look back for metrics'),
  });

  app.get(
    '/sites/:id/metrics',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get performance metrics for a site',
        operationId: 'getSiteMetrics',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(siteMetricsQuery),
        response: {
          200: zodSchema(siteMetricsResponse),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { months } = request.query as z.infer<typeof siteMetricsQuery>;
      const since = new Date();
      since.setMonth(since.getMonth() - months);

      const periodMinutes = Math.floor((Date.now() - since.getTime()) / 60000);
      const periodMinutesLiteral = sql.raw(String(periodMinutes));
      const sinceIso = since.toISOString();

      const uptimeRows = await db.execute(sql`
        WITH site_stations AS (
          SELECT id AS station_uuid FROM charging_stations
          WHERE site_id = ${id} AND ${sql.raw(operatorStationSql('charging_stations'))}
        ),
        site_ports AS (
          SELECT DISTINCT e.station_id, e.evse_id
          FROM evses e
          INNER JOIN site_stations ss ON ss.station_uuid = e.station_id
          WHERE e.retired_at IS NULL
        ),
        pre_period_status AS (
          SELECT DISTINCT ON (psl.station_id, psl.evse_id)
            psl.station_id,
            psl.evse_id,
            psl.new_status,
            ${sinceIso}::timestamptz AS timestamp
          FROM port_status_log psl
          INNER JOIN site_ports sp ON sp.station_id = psl.station_id AND sp.evse_id = psl.evse_id
          WHERE psl.timestamp < ${sinceIso}::timestamptz
          ORDER BY psl.station_id, psl.evse_id, psl.timestamp DESC
        ),
        seeded_log AS (
          SELECT station_id, evse_id, new_status, timestamp FROM pre_period_status
          UNION ALL
          SELECT psl.station_id, psl.evse_id, psl.new_status, psl.timestamp
          FROM port_status_log psl
          INNER JOIN site_ports sp ON sp.station_id = psl.station_id AND sp.evse_id = psl.evse_id
          WHERE psl.timestamp >= ${sinceIso}::timestamptz
        ),
        port_transitions AS (
          SELECT
            station_id,
            evse_id,
            new_status,
            timestamp,
            LEAD(timestamp) OVER (PARTITION BY station_id, evse_id ORDER BY timestamp) AS next_timestamp
          FROM seeded_log
        ),
        outage_minutes AS (
          SELECT
            station_id,
            evse_id,
            SUM(
              EXTRACT(EPOCH FROM (COALESCE(next_timestamp, now()) - timestamp)) / 60
            ) AS down_minutes
          FROM port_transitions
          WHERE new_status IN ('faulted', 'unavailable')
          GROUP BY station_id, evse_id
        )
        SELECT
          COALESCE(AVG(
            CASE WHEN ${periodMinutesLiteral} > 0
              THEN GREATEST(0, ((${periodMinutesLiteral} - COALESCE(down_minutes, 0)) / ${periodMinutesLiteral}) * 100)
              ELSE 100
            END
          ), 100) AS uptime_percent,
          COUNT(*) AS port_count
        FROM site_ports sp
        LEFT JOIN outage_minutes om ON om.station_id = sp.station_id AND om.evse_id = sp.evse_id
      `);

      // Sessions of conformance test stations never count at a site.
      const siteSessionsSince = and(
        eq(chargingSessions.siteId, id),
        gte(chargingSessions.startedAt, since),
        inOperatorStation(chargingSessions.stationId),
      );
      const [sessionStats] = await db
        .select({
          totalSessions: count(),
          completedSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'completed')`,
          faultedSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'faulted')`,
          totalEnergyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
          avgDurationMinutes: sql<number>`coalesce(avg(extract(epoch from (${chargingSessions.endedAt} - ${chargingSessions.startedAt})) / 60) filter (where ${chargingSessions.endedAt} is not null), 0)`,
        })
        .from(chargingSessions)
        .where(siteSessionsSince);

      const [utilizationStats] = await db
        .select({
          sessionHours: sql<number>`coalesce(sum(extract(epoch from (coalesce(${chargingSessions.endedAt}, now()) - ${chargingSessions.startedAt})) / 3600), 0)`,
          portCount: sql<number>`(select count(*) from evses e inner join charging_stations cs on cs.id = e.station_id where cs.site_id = ${id} and ${sql.raw(operatorStationSql('cs'))} and e.retired_at is null)`,
        })
        .from(chargingSessions)
        .where(siteSessionsSince);

      const totalPortHours = (utilizationStats?.portCount ?? 1) * (periodMinutes / 60);
      const utilization =
        totalPortHours > 0
          ? Math.round(((utilizationStats?.sessionHours ?? 0) / totalPortHours) * 100)
          : 0;

      const currency = await getCompanyCurrency();
      const billed = inCompanyCurrency(chargingSessions.currency, currency);
      const [[financialStats], revenue] = await Promise.all([
        db
          .select({
            totalElectricityCostCents:
              sql<number>`coalesce(sum(${chargingSessions.electricityCostCents}) filter (where ${billed}), 0)`.mapWith(
                Number,
              ),
          })
          .from(chargingSessions)
          .where(siteSessionsSince),
        // Revenue (session-revenue.ts): ended sessions and reservation fees,
        // minus refunds.
        queryRevenueTotal({
          companyCurrency: currency,
          where: [
            sql`${revenueItem.siteId} = ${id}`,
            sql`${revenueItem.occurredAt} >= ${since.toISOString()}::timestamptz`,
            inOperatorStation(revenueItem.stationId),
          ],
        }),
      ]);

      const total = sessionStats?.totalSessions ?? 0;
      const completed = sessionStats?.completedSessions ?? 0;

      const uptimeRow = uptimeRows[0] as { uptime_percent: string; port_count: string } | undefined;

      const disconnectRows = await db.execute(sql`
        WITH ordered_events AS (
          SELECT
            cl.event,
            cl.created_at,
            LEAD(cl.created_at) OVER (PARTITION BY cl.station_id ORDER BY cl.created_at) AS next_at,
            LEAD(cl.event) OVER (PARTITION BY cl.station_id ORDER BY cl.created_at) AS next_event
          FROM connection_logs cl
          INNER JOIN charging_stations cs ON cs.id = cl.station_id
          WHERE cs.site_id = ${id}
            AND ${sql.raw(operatorStationSql('cs'))}
            AND cl.created_at >= ${sinceIso}::timestamptz
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
        totalRevenueCents: revenue.grossCents,
        avgRevenueCentsPerSession:
          revenue.sessionCount > 0
            ? Math.round(revenue.sessionGrossCents / revenue.sessionCount)
            : 0,
        totalTransactions: revenue.itemCount,
        totalElectricityCostCents: financialStats?.totalElectricityCostCents ?? 0,
        totalNetRevenueCents: revenue.netCents,
        totalTaxCents: revenue.taxCents,
        totalProfitCents: profitCents(revenue, financialStats?.totalElectricityCostCents ?? 0),
        costMissingSessionCount: revenue.costMissingCount,
        costMissingRevenueCents: revenue.costMissingGrossCents,
        periodMonths: months,
        currency,
      };
    },
  );

  const stationsQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
  });

  app.get(
    '/sites/:id/stations',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'List stations at a site',
        operationId: 'listSiteStations',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(stationsQuery),
        response: {
          200: paginatedResponse(siteStationItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { page, limit } = request.query as z.infer<typeof stationsQuery>;
      const offset = (page - 1) * limit;

      const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id));
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const where = and(eq(chargingStations.siteId, id), isOperatorStation());
      const [data, countRows] = await Promise.all([
        db
          .select({
            id: chargingStations.id,
            stationId: chargingStations.stationId,
            siteId: chargingStations.siteId,
            model: chargingStations.model,
            serialNumber: chargingStations.serialNumber,
            availability: chargingStations.availability,
            securityProfile: chargingStations.securityProfile,
            ocppProtocol: chargingStations.ocppProtocol,
            lastHeartbeat: chargingStations.lastHeartbeat,
            isOnline: chargingStations.isOnline,
            createdAt: chargingStations.createdAt,
            updatedAt: chargingStations.updatedAt,
            status: buildDerivedStatusSubquery(chargingStations.id),
            statusReason: buildStatusReasonSubquery(chargingStations.id),
            connectorCount: sql<number>`COUNT(${connectors.id})::int`,
            connectorTypes: sql<
              string[]
            >`array_agg(DISTINCT ${connectors.connectorType}) FILTER (WHERE ${connectors.connectorType} IS NOT NULL)`,
            underMaintenance: buildUnderMaintenanceSubquery(
              chargingStations.id,
              chargingStations.siteId,
            ),
          })
          .from(chargingStations)
          .leftJoin(evses, eq(evses.stationId, chargingStations.id))
          .leftJoin(connectors, eq(connectors.evseId, evses.id))
          .where(where)
          .groupBy(chargingStations.id)
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(chargingStations)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 };
    },
  );

  app.get(
    '/sites/:id/energy-history',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get daily energy delivery history for a site',
        operationId: 'getSiteEnergyHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(dateRangeQuery),
        response: {
          200: arrayResponse(energyHistoryItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { since, until } = parseDateRange(
        request.query as { days?: string; from?: string; to?: string },
      );

      const [siteRow] = await db
        .select({ timezone: sites.timezone })
        .from(sites)
        .where(eq(sites.id, id));
      const tz = siteRow?.timezone ?? 'America/New_York';

      const rows = await db
        .select({
          date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          energyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
        })
        .from(chargingSessions)
        .where(
          and(
            eq(chargingSessions.siteId, id),
            gte(chargingSessions.startedAt, since),
            until ? lte(chargingSessions.startedAt, until) : undefined,
            inOperatorStation(chargingSessions.stationId),
          ),
        )
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      return rows.map((r) => ({ date: r.date, energyWh: r.energyWh }));
    },
  );

  app.get(
    '/sites/:id/revenue-history',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get daily revenue history for a site',
        operationId: 'getSiteRevenueHistory',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(dateRangeQuery),
        response: {
          200: arrayResponse(revenueHistoryItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { since, until } = parseDateRange(
        request.query as { days?: string; from?: string; to?: string },
      );

      const [siteRow] = await db
        .select({ timezone: sites.timezone })
        .from(sites)
        .where(eq(sites.id, id));
      const tz = siteRow?.timezone ?? 'America/New_York';

      // Revenue per day (session-revenue.ts): ended sessions and reservation
      // fees billed in the company currency, minus refunds, tax included.
      const where = [
        sql`${revenueItem.siteId} = ${id}`,
        sql`${revenueItem.occurredAt} >= ${since.toISOString()}::timestamptz`,
        inOperatorStation(revenueItem.stationId),
      ];
      if (until) where.push(sql`${revenueItem.occurredAt} <= ${until.toISOString()}::timestamptz`);
      const byDay = await queryRevenue({
        companyCurrency: await getCompanyCurrency(),
        key: sql`date_trunc('day', ${revenueItem.occurredAt} AT TIME ZONE ${tz})::date`,
        where,
      });

      return zeroFillDays(
        enumerateLocalDays(since, until, tz),
        [...byDay]
          .filter((entry): entry is [string, (typeof entry)[1]] => entry[0] != null)
          .map(([date, revenue]) => ({
            date,
            revenueCents: revenue.grossCents,
            sessionCount: revenue.sessionCount,
          })),
        (date) => ({ date, revenueCents: 0, sessionCount: 0 }),
      );
    },
  );

  const popularTimesQuery = z.object({
    weeks: z.coerce
      .number()
      .int()
      .min(1)
      .max(12)
      .default(4)
      .describe('Number of weeks to look back'),
  });

  const popularTimesItem = z
    .object({
      dow: z.number().describe('Day of week (0=Sunday through 6=Saturday) in site timezone'),
      hour: z.number().describe('Hour of day (0-23) in site timezone'),
      avgSessions: z
        .number()
        .describe('Average number of sessions started in this day-of-week and hour bucket'),
    })
    .passthrough();

  app.get(
    '/sites/:id/popular-times',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get average session count by day-of-week and hour for a site',
        operationId: 'getSitePopularTimes',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(popularTimesQuery),
        response: {
          200: arrayResponse(popularTimesItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { weeks } = request.query as z.infer<typeof popularTimesQuery>;
      const since = new Date();
      since.setDate(since.getDate() - weeks * 7);

      const [siteRow] = await db
        .select({ timezone: sites.timezone })
        .from(sites)
        .where(eq(sites.id, id));
      const tz = siteRow?.timezone ?? 'America/New_York';

      const rows = await db
        .select({
          dow: sql<number>`extract(dow from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          hour: sql<number>`extract(hour from ${chargingSessions.startedAt} at time zone ${tz})::int`,
          totalSessions: count(),
        })
        .from(chargingSessions)
        .where(
          and(
            eq(chargingSessions.siteId, id),
            gte(chargingSessions.startedAt, since),
            inOperatorStation(chargingSessions.stationId),
          ),
        )
        .groupBy(sql`1`, sql`2`)
        .orderBy(sql`1`, sql`2`);

      return rows.map((r) => ({
        dow: r.dow,
        hour: r.hour,
        avgSessions: Math.round((r.totalSessions / weeks) * 10) / 10,
      }));
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
    measurand: z
      .string()
      .max(100)
      .optional()
      .describe('Limit to one measurand, summed per minute across stations'),
  });

  app.get(
    '/sites/:id/meter-values',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get meter value time series for a site',
        operationId: 'getSiteMeterValues',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(meterValuesQuery),
        response: {
          200: arrayResponse(meterValueGroup),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { hours, measurand } = request.query as z.infer<typeof meterValuesQuery>;
      const since = new Date(Date.now() - hours * 3600 * 1000);

      // With a measurand filter, aggregate per minute across the site's
      // stations: raw rows from many stations interleave into one zigzag
      // series, and a 25-station site can emit hundreds of thousands of rows
      // per day. The site-level reading is the per-bucket sum.
      if (measurand != null) {
        const bucketRows = await db
          .select({
            // A sql field has no column mapper: postgres text, mapped below.
            timestamp: sql<Date | string>`date_trunc('minute', ${meterValues.timestamp})`,
            value: sql<string>`sum(${meterValues.value}::numeric)::text`,
            unit: sql<string | null>`max(${meterValues.unit})`,
          })
          .from(meterValues)
          .innerJoin(chargingStations, eq(meterValues.stationId, chargingStations.id))
          .where(
            and(
              eq(chargingStations.siteId, id),
              isOperatorStation(),
              eq(meterValues.measurand, measurand),
              gte(meterValues.timestamp, since),
            ),
          )
          .groupBy(sql`1`)
          .orderBy(sql`1`);
        return [
          {
            measurand,
            unit: bucketRows[0]?.unit ?? null,
            values: bucketRows.map((r) => ({ timestamp: toDate(r.timestamp), value: r.value })),
          },
        ];
      }

      const rows = await db
        .select({
          measurand: meterValues.measurand,
          unit: meterValues.unit,
          timestamp: meterValues.timestamp,
          value: meterValues.value,
        })
        .from(meterValues)
        .innerJoin(chargingStations, eq(meterValues.stationId, chargingStations.id))
        .where(
          and(
            eq(chargingStations.siteId, id),
            isOperatorStation(),
            gte(meterValues.timestamp, since),
          ),
        )
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

  const sessionsQuery = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    status: z
      .enum(['active', 'completed', 'faulted', 'idling'])
      .optional()
      .describe('Filter by session status'),
    stationId: z.string().optional().describe('Filter by station ID'),
  });

  app.get(
    '/sites/:id/sessions',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'List charging sessions at a site',
        operationId: 'listSiteSessions',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        querystring: zodSchema(sessionsQuery),
        response: {
          200: paginatedResponse(siteSessionItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { page, limit, status, stationId } = request.query as z.infer<typeof sessionsQuery>;
      const offset = (page - 1) * limit;
      // Sessions that happened at the site, also from a station that moved away.
      // Sessions of conformance test stations are never listed.
      const conditions = [
        eq(chargingSessions.siteId, id),
        inOperatorStation(chargingSessions.stationId),
      ];
      if (stationId != null) {
        conditions.push(eq(chargingSessions.stationId, stationId));
      }
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
            energyDeliveredWh: chargingSessions.energyDeliveredWh,
            currentCostCents: chargingSessions.currentCostCents,
            finalCostCents: chargingSessions.finalCostCents,
            currency: sessionCurrencySql(),
            startedAt: chargingSessions.startedAt,
            endedAt: chargingSessions.endedAt,
            freeVend: chargingSessions.freeVend,
          })
          .from(chargingSessions)
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .leftJoin(sites, eq(chargingSessions.siteId, sites.id))
          .leftJoin(drivers, eq(chargingSessions.driverId, drivers.id))
          .where(where)
          .orderBy(desc(chargingSessions.createdAt), desc(chargingSessions.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(chargingSessions)
          .where(where),
      ]);

      return { data: rows, total: countRows[0]?.count ?? 0 };
    },
  );

  app.get(
    '/sites/:id/layout',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get station layout positions for a site',
        operationId: 'getSiteLayout',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: {
          200: arrayResponse(layoutStation),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id));
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const stationRows = await db
        .select({
          id: chargingStations.id,
          stationId: chargingStations.stationId,
          model: chargingStations.model,
          status: buildDerivedStatusSubquery(chargingStations.id),
          statusReason: buildStatusReasonSubquery(chargingStations.id),
          isOnline: chargingStations.isOnline,
          securityProfile: chargingStations.securityProfile,
          positionX: stationLayoutPositions.positionX,
          positionY: stationLayoutPositions.positionY,
        })
        .from(chargingStations)
        .leftJoin(stationLayoutPositions, eq(stationLayoutPositions.stationId, chargingStations.id))
        .where(and(eq(chargingStations.siteId, id), isOperatorStation()));

      if (stationRows.length === 0) return [];

      const stationUuids = stationRows.map((s) => s.id);

      const [evseRows, connectorRows, sessionRows, displayMessageRows] = await Promise.all([
        db
          .select({
            id: evses.id,
            stationId: evses.stationId,
            evseId: evses.evseId,
          })
          .from(evses)
          .where(inArray(evses.stationId, stationUuids)),
        db
          .select({
            id: connectors.id,
            evseId: connectors.evseId,
            connectorId: connectors.connectorId,
            connectorType: connectors.connectorType,
            maxPowerKw: connectors.maxPowerKw,
            status: connectors.status,
          })
          .from(connectors)
          .innerJoin(evses, eq(connectors.evseId, evses.id))
          .where(inArray(evses.stationId, stationUuids)),
        db
          .select({
            stationId: chargingSessions.stationId,
            connectorId: chargingSessions.connectorId,
            energyDeliveredWh: chargingSessions.energyDeliveredWh,
          })
          .from(chargingSessions)
          .where(
            and(
              inArray(chargingSessions.stationId, stationUuids),
              eq(chargingSessions.status, 'active'),
            ),
          ),
        db
          .select({
            stationId: displayMessages.stationId,
            content: displayMessages.content,
            priority: displayMessages.priority,
          })
          .from(displayMessages)
          .where(
            and(
              inArray(displayMessages.stationId, stationUuids),
              eq(displayMessages.status, 'accepted'),
            ),
          )
          .orderBy(desc(displayMessages.createdAt)),
      ]);

      const evsesByStation = new Map<string, typeof evseRows>();
      for (const evse of evseRows) {
        const list = evsesByStation.get(evse.stationId) ?? [];
        list.push(evse);
        evsesByStation.set(evse.stationId, list);
      }

      const connectorsByEvse = new Map<string, typeof connectorRows>();
      for (const conn of connectorRows) {
        const list = connectorsByEvse.get(conn.evseId) ?? [];
        list.push(conn);
        connectorsByEvse.set(conn.evseId, list);
      }

      const activeSessionsByConnector = new Map<string, { energyDeliveredWh: string | null }>();
      for (const session of sessionRows) {
        if (session.connectorId != null) {
          activeSessionsByConnector.set(session.connectorId, {
            energyDeliveredWh: session.energyDeliveredWh,
          });
        }
      }

      // First accepted message per station (ordered by createdAt desc)
      const displayMessageByStation = new Map<string, string>();
      for (const msg of displayMessageRows) {
        if (!displayMessageByStation.has(msg.stationId)) {
          displayMessageByStation.set(msg.stationId, msg.content);
        }
      }

      return stationRows.map((station) => {
        const stationEvses = evsesByStation.get(station.id) ?? [];
        return {
          id: station.id,
          stationId: station.stationId,
          model: station.model,
          status: station.status,
          statusReason: station.statusReason,
          isOnline: station.isOnline,
          securityProfile: station.securityProfile,
          positionX: Number(station.positionX ?? '0'),
          positionY: Number(station.positionY ?? '0'),
          displayMessage: displayMessageByStation.get(station.id) ?? null,
          evses: stationEvses.map((evse) => {
            const evseConnectors = connectorsByEvse.get(evse.id) ?? [];
            return {
              evseId: evse.evseId,
              connectors: evseConnectors.map((conn) => {
                const session = activeSessionsByConnector.get(conn.id);
                return {
                  connectorId: conn.connectorId,
                  connectorType: conn.connectorType,
                  maxPowerKw: conn.maxPowerKw,
                  status: conn.status,
                  isPluggedIn: session != null,
                  energyDeliveredWh:
                    session != null ? Number(session.energyDeliveredWh ?? '0') : null,
                };
              }),
            };
          }),
        };
      });
    },
  );

  const layoutBody = z.object({
    positions: z.array(
      z.object({
        stationId: ID_PARAMS.stationId.describe('Station ID'),
        positionX: z.number(),
        positionY: z.number(),
      }),
    ),
  });

  app.put(
    '/sites/:id/layout',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Update station layout positions for a site',
        operationId: 'updateSiteLayout',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(layoutBody),
        response: {
          200: zodSchema(
            z
              .object({
                ok: z.boolean().describe('True when the layout positions were saved successfully'),
              })
              .passthrough(),
          ),
          404: errorWith('Site or station not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { positions } = request.body as z.infer<typeof layoutBody>;

      const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id));
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      // Every position must name a station of this site. The upsert keys on
      // the station, so a foreign station would otherwise get a layout row
      // pointing at this site.
      const requested = [...new Set(positions.map((p) => p.stationId))];
      let previousPositions: { stationId: string; positionX: number; positionY: number }[] = [];
      if (requested.length > 0) {
        const own = await db
          .select({ id: chargingStations.id })
          .from(chargingStations)
          .where(and(inArray(chargingStations.id, requested), eq(chargingStations.siteId, id)));
        if (own.length !== requested.length) {
          await reply.status(404).send({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
          return;
        }
        const previousRows = await db
          .select({
            stationId: stationLayoutPositions.stationId,
            positionX: stationLayoutPositions.positionX,
            positionY: stationLayoutPositions.positionY,
          })
          .from(stationLayoutPositions)
          .where(inArray(stationLayoutPositions.stationId, requested));
        previousPositions = previousRows.map((row) => ({
          stationId: row.stationId,
          positionX: Number(row.positionX),
          positionY: Number(row.positionY),
        }));
      }

      // One position row per station: a station that moved here from another
      // site takes this site with its new position, and the layout saves whole.
      await db.transaction(async (tx) => {
        for (const pos of positions) {
          await tx
            .insert(stationLayoutPositions)
            .values({
              siteId: id,
              stationId: pos.stationId,
              positionX: String(pos.positionX),
              positionY: String(pos.positionY),
            })
            .onConflictDoUpdate({
              target: stationLayoutPositions.stationId,
              set: {
                siteId: id,
                positionX: String(pos.positionX),
                positionY: String(pos.positionY),
                updatedAt: new Date(),
              },
            });
        }
      });

      if (positions.length > 0) {
        await writeAudit(
          { table: siteAuditLog, idColumn: 'site_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: 'updated',
            ...getAuditActor(request),
            before: { layoutPositions: previousPositions },
            after: { layoutPositions: positions },
            notes: 'station layout updated',
          },
          db,
          request.log,
        );
      }

      return { ok: true };
    },
  );

  // --- Pricing Groups ---

  app.get(
    '/sites/:id/pricing-groups',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get the pricing group for a site',
        operationId: 'getSitePricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: {
          200: itemResponse(sitePricingGroupItem.nullable()),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
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
        .from(pricingGroupSites)
        .innerJoin(pricingGroups, eq(pricingGroupSites.pricingGroupId, pricingGroups.id))
        .where(eq(pricingGroupSites.siteId, id))
        .limit(1);
      return rows[0] ?? null;
    },
  );

  app.post(
    '/sites/:id/pricing-groups',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Assign a pricing group to a site',
        operationId: 'addSitePricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(addSitePricingGroupBody),
        response: {
          201: itemResponse(sitePricingGroupRecordItem),
          404: errorWith('Site or pricing group not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.PRICING_GROUP_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const body = request.body as z.infer<typeof addSitePricingGroupBody>;
      // Pre-check the site exists so an FK race on the INSERT below can be
      // safely attributed to the pricing group (the only remaining unknown
      // FK). The siteIds filter above only covers non-all-access operators.
      const [siteRow] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id));
      if (siteRow == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (!(await pricingGroupExists(body.pricingGroupId))) {
        await reply
          .status(404)
          .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
        return;
      }
      const [previous] = await db
        .select()
        .from(pricingGroupSites)
        .where(eq(pricingGroupSites.siteId, id));
      let record;
      try {
        [record] = await db
          .insert(pricingGroupSites)
          .values({ siteId: id, pricingGroupId: body.pricingGroupId })
          .onConflictDoUpdate({
            target: [pricingGroupSites.siteId],
            set: { pricingGroupId: body.pricingGroupId, createdAt: new Date() },
          })
          .returning();
      } catch (err) {
        // The pre-checks are non-transactional, so the pricing group can be
        // deleted between the check and this INSERT. Map the FK violation
        // to the same 404 the pre-check would have produced.
        if (pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION) {
          await reply
            .status(404)
            .send({ error: 'Pricing group not found', code: 'PRICING_GROUP_NOT_FOUND' });
          return;
        }
        throw err;
      }
      await writeAudit(
        { table: pricingAssignmentAuditLog, idColumn: 'pricing_assignment_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: previous == null ? 'created' : 'updated',
          ...getAuditActor(request),
          before:
            previous == null
              ? null
              : { scope: 'site', siteId: id, pricingGroupId: previous.pricingGroupId },
          after: { scope: 'site', siteId: id, pricingGroupId: body.pricingGroupId },
        },
        db,
        request.log,
      );
      await publishPricingChanged({
        pricingGroupId: body.pricingGroupId,
        action: 'assignment.changed',
        siteId: id,
      });
      await reply.status(201).send(record);
    },
  );

  app.delete(
    '/sites/:id/pricing-groups/:pricingGroupId',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Remove a pricing group from a site',
        operationId: 'removeSitePricingGroup',
        security: [{ bearerAuth: [] }],
        params: zodSchema(sitePricingGroupParams),
        response: {
          200: itemResponse(sitePricingGroupRecordItem),
          404: errorWith('Site or pricing assignment not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.PRICING_ASSIGNMENT_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id, pricingGroupId } = request.params as z.infer<typeof sitePricingGroupParams>;
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [record] = await db
        .delete(pricingGroupSites)
        .where(
          and(
            eq(pricingGroupSites.siteId, id),
            eq(pricingGroupSites.pricingGroupId, pricingGroupId),
          ),
        )
        .returning();
      if (record == null) {
        await reply.status(404).send({
          error: 'Pricing group not found for site',
          code: 'PRICING_ASSIGNMENT_NOT_FOUND',
        });
        return;
      }
      await writeAudit(
        { table: pricingAssignmentAuditLog, idColumn: 'pricing_assignment_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'deleted',
          ...getAuditActor(request),
          before: { scope: 'site', siteId: id, pricingGroupId },
        },
        db,
        request.log,
      );
      await publishPricingChanged({ pricingGroupId, action: 'assignment.changed', siteId: id });
      return record;
    },
  );

  // Free vend toggle
  const freeVendBody = z.object({
    enabled: z.boolean().describe('Enable or disable free vend mode for this site'),
  });

  const freeVendResponse = z
    .object({
      success: z.boolean().describe('True when the free vend toggle was applied successfully'),
      pushId21: z
        .string()
        .optional()
        .describe(
          'Identifier of the OCPP 2.1 config push (free vend on, or the authorization restore when off) for stations at the site, empty when no online station got one',
        ),
      pushId16: z
        .string()
        .optional()
        .describe(
          'Identifier of the OCPP 1.6 config push (free vend on, or the authorization restore when off) for stations at the site, empty when no online station got one',
        ),
    })
    .passthrough();

  app.post(
    '/sites/:id/free-vend',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Toggle free vend mode for a site',
        description:
          'On: creates the free vend config templates when missing and pushes them to the online stations of the site. When the site was off, the values the stations report then (2.1 TxCtrlr.TxStartPoint, 1.6 LocalPreAuthorize and LocalAuthorizeOffline) are kept in the restore templates. Off: pushes the restore templates, which turn authorization back on (2.1 AuthCtrlr.Enabled true, 1.6 AllowOfflineTxForUnknownId false). A value no station reported restores to PowerPathClosed (2.1), LocalPreAuthorize false and LocalAuthorizeOffline true (1.6). pushId21 and pushId16 name the config pushes.',
        operationId: 'toggleSiteFreeVend',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(freeVendBody),
        response: {
          200: itemResponse(freeVendResponse),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { enabled } = request.body as z.infer<typeof freeVendBody>;
      const { userId } = request.user as JwtPayload;

      const siteIds = await getUserSiteIds(userId);
      if (!siteInScope(siteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const [site] = await db.select().from(sites).where(eq(sites.id, id));
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const { pushId21, pushId16 } = await setSiteFreeVend(
        site,
        enabled,
        getAuditActor(request),
        request.log,
      );
      return { success: true, pushId21, pushId16 };
    },
  );

  // --- Carbon Region ---

  const carbonRegionResponse = z
    .object({
      regionCode: z
        .string()
        .nullable()
        .describe('Carbon intensity region code assigned to the site, or null if unset'),
      regionName: z
        .string()
        .nullable()
        .describe('Human-readable name of the carbon intensity region'),
      carbonIntensityKgPerKwh: z
        .string()
        .nullable()
        .describe(
          'Carbon intensity for this region in kilograms of CO2 per kilowatt-hour, as string for precision',
        ),
    })
    .passthrough();

  const carbonRegionBody = z.object({
    regionCode: z.string().nullable().describe('Carbon intensity region code, or null to clear'),
  });

  app.get(
    '/sites/:id/carbon-region',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'Get carbon region for a site',
        operationId: 'getSiteCarbonRegion',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: {
          200: itemResponse(carbonRegionResponse),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const userSiteIds = await getUserSiteIds(userId);
      if (!siteInScope(userSiteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [site] = await db
        .select({ carbonRegionCode: sites.carbonRegionCode })
        .from(sites)
        .where(eq(sites.id, id))
        .limit(1);
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (site.carbonRegionCode == null) {
        return { regionCode: null, regionName: null, carbonIntensityKgPerKwh: null };
      }
      const [factor] = await db
        .select()
        .from(carbonIntensityFactors)
        .where(eq(carbonIntensityFactors.regionCode, site.carbonRegionCode))
        .limit(1);
      return {
        regionCode: site.carbonRegionCode,
        regionName: factor?.regionName ?? null,
        carbonIntensityKgPerKwh: factor?.carbonIntensityKgPerKwh ?? null,
      };
    },
  );

  app.put(
    '/sites/:id/carbon-region',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Set carbon region for a site',
        operationId: 'updateSiteCarbonRegion',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(carbonRegionBody),
        response: {
          200: successResponse,
          400: errorWith('Invalid region code', [ERROR_CODES.INVALID_REGION_CODE]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { regionCode } = request.body as z.infer<typeof carbonRegionBody>;
      const { userId } = request.user as JwtPayload;
      const userSiteIds = await getUserSiteIds(userId);
      if (!siteInScope(userSiteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [site] = await db.select().from(sites).where(eq(sites.id, id)).limit(1);
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      if (regionCode != null) {
        const [factor] = await db
          .select({ id: carbonIntensityFactors.id })
          .from(carbonIntensityFactors)
          .where(eq(carbonIntensityFactors.regionCode, regionCode))
          .limit(1);
        if (factor == null) {
          await reply
            .status(400)
            .send({ error: 'Invalid region code', code: 'INVALID_REGION_CODE' });
          return;
        }
      }
      const [updated] = await db
        .update(sites)
        .set({ carbonRegionCode: regionCode, updatedAt: new Date() })
        .where(eq(sites.id, id))
        .returning();
      const actor = getAuditActor(request);
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: site.id,
          entityIdSnapshot: site.id,
          action: 'updated',
          ...actor,
          before: site,
          after: updated ?? site,
          notes: 'carbon-region updated',
        },
        db,
        request.log,
      );
      return { success: true };
    },
  );

  const electricityRateItem = z
    .object({
      id: z.number().int().describe('Rate period ID'),
      siteId: z.string().describe('Site ID'),
      name: z.string().describe('Rate period name'),
      ratePerKwh: z.number().describe('Wholesale electricity rate per kWh in the company currency'),
      restrictions: z
        .record(z.unknown())
        .nullable()
        .describe(
          'When the period applies (timeRange/daysOfWeek/dateRange), or null for the default flat rate',
        ),
      priority: z.number().int().describe('Resolution priority derived from the restriction shape'),
      isDefault: z.boolean().describe('True for the flat-rate fallback period'),
    })
    .passthrough();

  const electricityRateBody = z.object({
    name: z.string().min(1).max(100).describe('Rate period name'),
    ratePerKwh: z
      .number()
      .nonnegative()
      .max(9999.999999)
      .describe(
        'Wholesale electricity rate per kWh in the company currency (major units, up to 6 decimals)',
      ),
    restrictions: electricityRateRestrictionsSchema
      .nullable()
      .optional()
      .describe('When the period applies, or null/omitted for the default flat rate'),
  });

  const electricityRateParams = z.object({
    id: ID_PARAMS.siteId.describe('Site ID'),
    periodId: z.coerce.number().int().describe('Electricity rate period ID'),
  });

  app.get(
    '/sites/:id/electricity-rates',
    {
      onRequest: [authorize('sites:read')],
      schema: {
        tags: ['Sites'],
        summary: 'List electricity rate periods for a site',
        operationId: 'listSiteElectricityRates',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: {
          200: arrayResponse(electricityRateItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const userSiteIds = await getUserSiteIds(userId);
      if (!siteInScope(userSiteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const rows = await db
        .select()
        .from(siteElectricityRatePeriods)
        .where(eq(siteElectricityRatePeriods.siteId, id))
        .orderBy(desc(siteElectricityRatePeriods.priority), desc(siteElectricityRatePeriods.id));
      return rows.map((row) => ({
        id: row.id,
        siteId: row.siteId,
        name: row.name,
        ratePerKwh: parseFloat(row.ratePerKwh),
        restrictions: row.restrictions as Record<string, unknown> | null,
        priority: row.priority,
        isDefault: row.isDefault,
      }));
    },
  );

  app.post(
    '/sites/:id/electricity-rates',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Create an electricity rate period for a site',
        operationId: 'createSiteElectricityRate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        body: zodSchema(electricityRateBody),
        response: {
          201: itemResponse(electricityRateItem),
          400: errorWith('Invalid rate restrictions', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const body = request.body as z.infer<typeof electricityRateBody>;
      const { userId } = request.user as JwtPayload;
      const userSiteIds = await getUserSiteIds(userId);
      if (!siteInScope(userSiteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const restrictions = (body.restrictions ?? null) as ElectricityRatePeriodRestrictions | null;
      const parsedRestrictions = electricityRateRestrictionsSchema
        .nullable()
        .safeParse(restrictions);
      if (!parsedRestrictions.success) {
        await reply
          .status(400)
          .send({ error: 'Invalid rate restrictions', code: 'VALIDATION_ERROR' });
        return;
      }
      const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id)).limit(1);
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [created] = await db
        .insert(siteElectricityRatePeriods)
        .values({
          siteId: id,
          name: body.name,
          ratePerKwh: String(body.ratePerKwh),
          restrictions,
          priority: deriveElectricityRatePriority(restrictions),
          isDefault: restrictions == null,
        })
        .returning();
      if (created == null) {
        throw new Error('Electricity rate insert returned no row');
      }
      clearElectricityRateCache(id);
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'electricity_rates_changed',
          ...getAuditActor(request),
          before: null,
          after: { electricityRate: created },
          notes: `electricity rate created: ${created.name}`,
        },
        db,
        request.log,
      );
      await reply.status(201).send({
        id: created.id,
        siteId: created.siteId,
        name: created.name,
        ratePerKwh: parseFloat(created.ratePerKwh),
        restrictions: created.restrictions as Record<string, unknown> | null,
        priority: created.priority,
        isDefault: created.isDefault,
      });
    },
  );

  app.patch(
    '/sites/:id/electricity-rates/:periodId',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Update an electricity rate period',
        operationId: 'updateSiteElectricityRate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(electricityRateParams),
        body: zodSchema(electricityRateBody),
        response: {
          200: itemResponse(electricityRateItem),
          400: errorWith('Invalid rate restrictions', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Electricity rate not found', [ERROR_CODES.ELECTRICITY_RATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, periodId } = request.params as z.infer<typeof electricityRateParams>;
      const body = request.body as z.infer<typeof electricityRateBody>;
      const { userId } = request.user as JwtPayload;
      const userSiteIds = await getUserSiteIds(userId);
      if (!siteInScope(userSiteIds, id)) {
        await reply
          .status(404)
          .send({ error: 'Electricity rate not found', code: 'ELECTRICITY_RATE_NOT_FOUND' });
        return;
      }
      const restrictions = (body.restrictions ?? null) as ElectricityRatePeriodRestrictions | null;
      const parsedRestrictions = electricityRateRestrictionsSchema
        .nullable()
        .safeParse(restrictions);
      if (!parsedRestrictions.success) {
        await reply
          .status(400)
          .send({ error: 'Invalid rate restrictions', code: 'VALIDATION_ERROR' });
        return;
      }
      const [previous] = await db
        .select()
        .from(siteElectricityRatePeriods)
        .where(
          and(
            eq(siteElectricityRatePeriods.id, periodId),
            eq(siteElectricityRatePeriods.siteId, id),
          ),
        );
      const [updated] = await db
        .update(siteElectricityRatePeriods)
        .set({
          name: body.name,
          ratePerKwh: String(body.ratePerKwh),
          restrictions,
          priority: deriveElectricityRatePriority(restrictions),
          isDefault: restrictions == null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(siteElectricityRatePeriods.id, periodId),
            eq(siteElectricityRatePeriods.siteId, id),
          ),
        )
        .returning();
      if (updated == null) {
        await reply
          .status(404)
          .send({ error: 'Electricity rate not found', code: 'ELECTRICITY_RATE_NOT_FOUND' });
        return;
      }
      clearElectricityRateCache(id);
      const rateChange = changedFields(previous ?? {}, updated);
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'electricity_rates_changed',
          ...getAuditActor(request),
          before: { electricityRateId: updated.id, ...rateChange.before },
          after: { electricityRateId: updated.id, ...rateChange.after },
          notes: `electricity rate updated: ${updated.name}`,
        },
        db,
        request.log,
      );
      return {
        id: updated.id,
        siteId: updated.siteId,
        name: updated.name,
        ratePerKwh: parseFloat(updated.ratePerKwh),
        restrictions: updated.restrictions as Record<string, unknown> | null,
        priority: updated.priority,
        isDefault: updated.isDefault,
      };
    },
  );

  app.delete(
    '/sites/:id/electricity-rates/:periodId',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Delete an electricity rate period',
        operationId: 'deleteSiteElectricityRate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(electricityRateParams),
        response: {
          200: successResponse,
          404: errorWith('Electricity rate not found', [ERROR_CODES.ELECTRICITY_RATE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id, periodId } = request.params as z.infer<typeof electricityRateParams>;
      const { userId } = request.user as JwtPayload;
      const userSiteIds = await getUserSiteIds(userId);
      if (!siteInScope(userSiteIds, id)) {
        await reply
          .status(404)
          .send({ error: 'Electricity rate not found', code: 'ELECTRICITY_RATE_NOT_FOUND' });
        return;
      }
      const [deleted] = await db
        .delete(siteElectricityRatePeriods)
        .where(
          and(
            eq(siteElectricityRatePeriods.id, periodId),
            eq(siteElectricityRatePeriods.siteId, id),
          ),
        )
        .returning();
      if (deleted == null) {
        await reply
          .status(404)
          .send({ error: 'Electricity rate not found', code: 'ELECTRICITY_RATE_NOT_FOUND' });
        return;
      }
      clearElectricityRateCache(id);
      await writeAudit(
        { table: siteAuditLog, idColumn: 'site_id' },
        {
          entityId: id,
          entityIdSnapshot: id,
          action: 'electricity_rates_changed',
          ...getAuditActor(request),
          before: { electricityRate: deleted },
          after: null,
          notes: `electricity rate deleted: ${deleted.name}`,
        },
        db,
        request.log,
      );
      return { success: true };
    },
  );

  const recalculateElectricityCostResponse = z
    .object({
      updated: z
        .number()
        .int()
        .min(0)
        .describe('Sessions that got an electricity cost from this request'),
      remaining: z
        .number()
        .int()
        .min(0)
        .describe(
          'Billed sessions at the site still without an electricity cost: send the request again while it is above 0 and updated was above 0 (one request writes at most 5000 costs); sessions whose end time matches no rate period stay',
        ),
    })
    .passthrough();

  app.post(
    '/sites/:id/electricity-cost/recalculate',
    {
      onRequest: [authorize('sites:write')],
      schema: {
        tags: ['Sites'],
        summary: 'Fill missing electricity costs from the site rates',
        description:
          "Computes the electricity cost of the site's billed sessions in the company currency that delivered energy and have none, from the site's current rate periods at each session's end time in the site timezone, as session end does. Never overwrites a cost, so it is safe to repeat.",
        operationId: 'recalculateSiteElectricityCost',
        security: [{ bearerAuth: [] }],
        params: zodSchema(siteParams),
        response: {
          200: itemResponse(recalculateElectricityCostResponse),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof siteParams>;
      const { userId } = request.user as JwtPayload;
      const userSiteIds = await getUserSiteIds(userId);
      if (!siteInScope(userSiteIds, id)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id)).limit(1);
      if (site == null) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }
      const { before, updated, remaining } = await recalculateSiteElectricityCost(id, {
        companyCurrency: await getCompanyCurrency(),
      });
      if (updated > 0) {
        await writeAudit(
          { table: siteAuditLog, idColumn: 'site_id' },
          {
            entityId: id,
            entityIdSnapshot: id,
            action: 'updated',
            ...getAuditActor(request),
            before: { sessionsWithoutElectricityCost: before },
            after: { sessionsWithoutElectricityCost: remaining, electricityCostsFilled: updated },
            notes: 'electricity cost recalculated',
          },
          db,
          request.log,
        );
      }
      return { updated, remaining };
    },
  );
}
