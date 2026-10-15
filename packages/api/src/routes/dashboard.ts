// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql, eq, and, gte, lt, count, inArray, isNull } from 'drizzle-orm';
import {
  client,
  db,
  getSystemTimezone,
  getCompanyCurrency,
  getOcppFleetHealth,
  inOperatorStation,
  isOperatorStation,
  operatorStationIdSql,
  operatorStationSql,
} from '@evtivity/database';
import {
  chargingStations,
  chargingSessions,
  connectors,
  evses,
  sites,
  paymentRecords,
} from '@evtivity/database';
import { ValidationError } from '@evtivity/lib';
import { itemResponse, arrayResponse, errorWith } from '../lib/response-schemas.js';
import { inCompanyCurrency } from '@evtivity/services/company-currency';
import {
  paymentRecordsAtSites,
  paymentRecordsOfOperatorStations,
} from '../lib/payment-site-scope.js';
import {
  queryRevenue,
  queryRevenueTotal,
  revenueAtSites,
  revenueItem,
  sumRevenue,
  EMPTY_REVENUE,
  paymentsKeptCentsSql,
  profitCents,
} from '@evtivity/services/session-revenue';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { zodSchema } from '../lib/zod-schema.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { buildDerivedStatusSubquery } from '@evtivity/services/station-derived-status';
import {
  addCalendarDays,
  calendarDateIn,
  calendarDayBounds,
  dateRangeQuery,
  fillDates,
  parseCalendarDate,
  resolveCalendarRange,
} from '../lib/date-range.js';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';
import { cachedDashboardTotals, siteScopeKey } from '../lib/dashboard-totals.js';
import {
  averageSnapshotDays,
  EMPTY_SNAPSHOT,
  querySnapshotDays,
  snapshotScope,
  type DatedSnapshot,
} from '../lib/dashboard-snapshots.js';

const dashboardStatsResponse = z
  .object({
    totalStations: z
      .number()
      .int()
      .min(0)
      .describe(
        'Accepted stations (onboarding status accepted) of the user sites. Pending and blocked stations are in onboardingStatusCounts.',
      ),
    onlineStations: z
      .number()
      .int()
      .min(0)
      .describe('Accepted stations currently connected via WebSocket'),
    onlinePercent: z
      .number()
      .min(0)
      .max(100)
      .describe('Percentage of the accepted stations online (0-100)'),
    activeSessions: z
      .number()
      .int()
      .min(0)
      .describe('Number of charging sessions currently in progress'),
    totalSessions: z
      .number()
      .int()
      .min(0)
      .describe(
        'Total number of charging sessions on record. All-time totals are refreshed at most once a minute.',
      ),
    totalEnergyWh: z
      .number()
      .min(0)
      .describe('Total energy delivered across all sessions in watt-hours'),
    faultedStations: z
      .number()
      .int()
      .min(0)
      .describe('Number of accepted stations currently in faulted state'),
    statusCounts: z
      .record(z.number().int().min(0))
      .describe('Map of station availability status to count, accepted stations'),
    onboardingStatusCounts: z
      .record(z.number().int().min(0))
      .describe(
        'Map of station onboarding status (accepted, pending, blocked) to count, every station',
      ),
  })
  .passthrough();

const dateValueItem = z
  .object({
    date: z.string().describe('Date in YYYY-MM-DD format (local timezone)'),
    energyWh: z.number().min(0).describe('Energy delivered on this date in watt-hours'),
  })
  .passthrough();
const dateCountItem = z
  .object({
    date: z.string().describe('Date in YYYY-MM-DD format (local timezone)'),
    count: z.number().int().min(0).describe('Number of sessions started on this date'),
  })
  .passthrough();
const stationStatusItem = z
  .object({
    status: z.string().max(50).describe('Connector status (available, occupied, faulted, etc.)'),
    count: z.number().int().min(0).describe('Number of connectors in this status'),
  })
  .passthrough();
const siteLocationItem = z
  .object({
    siteId: z.string().describe('Site ID'),
    name: z.string().max(255).describe('Site name'),
    latitude: z.string().describe('Site latitude in decimal degrees'),
    longitude: z.string().describe('Site longitude in decimal degrees'),
    stationCount: z.number().int().min(0).describe('Number of stations at this site'),
  })
  .passthrough();
const utilizationItem = z
  .object({
    site: z.string().max(255).nullable().describe('Site name, null if site has no name'),
    utilization: z
      .number()
      .min(0)
      .max(100)
      .describe(
        'Utilization percentage (0-100, not rounded): charging hours of the sessions at the site, clipped to the period, over the port-hours of its EVSEs in service (not retired) for the period so far',
      ),
  })
  .passthrough();
const peakUsageItem = z
  .object({
    hour: z.number().int().min(0).max(23).describe('Hour of day (0-23, local timezone)'),
    dayOfWeek: z.number().int().min(1).max(7).describe('ISO 8601 day of week (1=Monday, 7=Sunday)'),
    count: z
      .number()
      .int()
      .min(0)
      .describe('Number of sessions started in this hour/day-of-week bucket'),
  })
  .passthrough();

const financialStatsResponse = z
  .object({
    totalRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Total revenue in cents, tax included (gross). Revenue is the final cost of ended sessions plus reservation fees charged, minus refunds, in the company currency; active sessions are not counted.',
      ),
    todayRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Revenue of sessions started today and reservation fees charged today, in cents, tax included (gross)',
      ),
    totalNetRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Total revenue excluding tax, in cents. Each amount is split at its own tax rate (a session at its tariff tax rate, a reservation fee at the rate it was taxed at).',
      ),
    todayNetRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe('Revenue excluding tax of sessions started today and fees charged today, in cents'),
    totalTaxCents: z
      .number()
      .int()
      .min(0)
      .describe('Tax collected in cents (total revenue minus total net revenue)'),
    todayTaxCents: z.number().int().min(0).describe('Tax in the revenue of today, in cents'),
    avgRevenueCentsPerSession: z
      .number()
      .min(0)
      .describe('Average revenue per ended session billed in the company currency, in cents'),
    totalTransactions: z
      .number()
      .int()
      .min(0)
      .describe('Number of revenue items: ended billed sessions plus reservation fee charges'),
    totalElectricityCostCents: z
      .number()
      .int()
      .min(0)
      .describe("Operator's total wholesale electricity cost in cents"),
    dayElectricityCostCents: z
      .number()
      .int()
      .min(0)
      .describe('Electricity cost from sessions started today, in cents'),
    totalProfitCents: z
      .number()
      .int()
      .describe(
        'Total revenue excluding tax minus total electricity cost, in cents (may be negative). Sessions without an electricity cost (totalCostMissingSessionCount) are left out.',
      ),
    dayProfitCents: z
      .number()
      .int()
      .describe(
        "Today's revenue excluding tax minus today's electricity cost, in cents (may be negative). Sessions without an electricity cost are left out.",
      ),
    totalCostMissingSessionCount: z
      .number()
      .int()
      .min(0)
      .describe(
        'Ended billed sessions that delivered energy but have no electricity cost (their site has no matching rate period, or the station has no site). Left out of profit.',
      ),
    totalCostMissingRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe('Revenue of those sessions in cents, tax included. Left out of profit.'),
    dayCostMissingSessionCount: z
      .number()
      .int()
      .min(0)
      .describe('Sessions of today without an electricity cost, left out of today profit'),
    dayCostMissingRevenueCents: z
      .number()
      .int()
      .min(0)
      .describe('Revenue of those sessions in cents, tax included'),
    billedOnAccountCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Billed on account: the final cost of ended account sessions (charge on account, billed to a fleet) whose fleet invoice is not paid yet (unbilled, or on an unpaid invoice), in cents, tax included. Not part of revenue until the invoice is paid.',
      ),
    billedOnAccountCount: z.number().int().min(0).describe('Number of those account sessions'),
    currency: z.string().length(3).describe('Company currency (ISO 4217) of every amount'),
  })
  .passthrough();

const revenueHistoryItem = z
  .object({
    date: z.string().describe('Date in YYYY-MM-DD format (local timezone)'),
    revenueCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Revenue on this date in cents, tax included: final costs of sessions started that day plus reservation fees charged that day, minus refunds, in the company currency. Active sessions are not counted',
      ),
    sessionCount: z
      .number()
      .int()
      .min(0)
      .describe(
        'Number of ended sessions billed in the company currency that started on this date',
      ),
  })
  .passthrough();

const paymentBreakdownItem = z
  .object({
    status: z.string().max(50).describe('Payment status (captured, refunded, failed, etc.)'),
    count: z.number().int().min(0).describe('Number of payments in this status'),
    totalCents: z
      .number()
      .int()
      .min(0)
      .describe(
        'Total captured amount minus the amount refunded for payments in this status, in cents, as revenue counts it. Only payments in the company currency are summed.',
      ),
  })
  .passthrough();

const uptimeResponse = z
  .object({
    uptimePercent: z
      .number()
      .min(0)
      .max(100)
      .describe('Average port uptime percentage across the period (0-100)'),
    totalPorts: z
      .number()
      .int()
      .min(0)
      .describe('Total number of ports counted in the uptime calculation'),
    stationsBelowThreshold: z
      .number()
      .int()
      .min(0)
      .describe('Number of stations with uptime below the 97% threshold'),
  })
  .passthrough();

const ocppInstanceHealth = z
  .object({
    instanceId: z
      .string()
      .describe('OCPP server process instance ID (pod name, ECS task ID or hostname)'),
    connectedStations: z
      .number()
      .int()
      .min(0)
      .describe('Stations connected to this process via WebSocket'),
    avgPingLatencyMs: z.number().min(0).describe('Average ping latency of this process in ms'),
    maxPingLatencyMs: z.number().min(0).describe('Maximum ping latency of this process in ms'),
    pingSuccessRate: z
      .number()
      .min(0)
      .max(100)
      .describe('Percentage of successful pings of this process (0-100)'),
    serverStartedAt: z.coerce.date().describe('Timestamp when this process started'),
    updatedAt: z.coerce.date().describe('Timestamp of the last health report of this process'),
  })
  .passthrough();

const ocppHealthResponse = z
  .object({
    connectedStations: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Number of stations currently connected via WebSocket'),
    avgPingLatencyMs: z
      .number()
      .min(0)
      .nullable()
      .describe(
        'Average OCPP ping latency in milliseconds over all OCPP server processes, weighted by connected stations',
      ),
    maxPingLatencyMs: z
      .number()
      .min(0)
      .nullable()
      .describe('Maximum OCPP ping latency in milliseconds over all OCPP server processes'),
    pingSuccessRate: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .describe('Percentage of successful pings (0-100) over all OCPP server processes'),
    totalPingsSent: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Pings sent by all running OCPP server processes since each started'),
    totalPongsReceived: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Pong responses received by all running OCPP server processes since each started'),
    serverStartedAt: z.coerce
      .date()
      .nullable()
      .describe('Start of the longest running OCPP server process'),
    updatedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the health metrics were last updated'),
    instanceCount: z
      .number()
      .int()
      .min(0)
      .describe('Running OCPP server processes (each reported within the last 90 seconds)'),
    instances: z
      .array(ocppInstanceHealth)
      .optional()
      .describe(
        'Health of each running OCPP server process, sorted by instance ID. Omitted for a user restricted to some sites.',
      ),
  })
  .passthrough();

const MONEY_HIDDEN = ' Null for a user without payments:read, who does not see revenue.';

/** Fields of an aggregated snapshot (one date, a date range, or a trend day). */
const snapshotFields = {
  hasData: z
    .boolean()
    .describe(
      'True when at least one dashboard_snapshots row matched the requested date filter. False on early days after deployment before the nightly snapshot worker has populated the table: the dashboard then shows no day-over-day arrows instead of a misleading +/-100%.',
    ),
  totalStations: z
    .number()
    .int()
    .min(0)
    .describe(
      'Accepted stations on this date (station counts of rows before v0.1.46 counted every station)',
    ),
  onlineStations: z.number().int().min(0).describe('Number of stations online on this date'),
  onlinePercent: z
    .number()
    .min(0)
    .max(100)
    .describe('Percentage of stations online on this date (0-100)'),
  uptimePercent: z
    .number()
    .min(0)
    .max(100)
    .describe('Average port uptime percentage on this date (0-100)'),
  activeSessions: z.number().int().min(0).describe('Sessions active at the end of this date'),
  totalEnergyWh: z
    .number()
    .min(0)
    .describe('Cumulative energy delivered through the end of this date in watt-hours'),
  dayEnergyWh: z.number().min(0).describe('Energy delivered on this date in watt-hours'),
  totalSessions: z
    .number()
    .int()
    .min(0)
    .describe('Cumulative session count through the end of this date'),
  daySessions: z.number().int().min(0).describe('Number of sessions started on this date'),
  connectedStations: z
    .number()
    .int()
    .min(0)
    .describe('Number of stations connected via WebSocket on this date'),
  totalRevenueCents: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe(`Cumulative revenue through the end of this date in cents.${MONEY_HIDDEN}`),
  dayRevenueCents: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe(`Revenue earned on this date in cents.${MONEY_HIDDEN}`),
  avgRevenueCentsPerSession: z
    .number()
    .min(0)
    .nullable()
    .describe(
      `Average revenue per billed session in the company currency (reservation fees left out), as the live figure.${MONEY_HIDDEN}`,
    ),
  totalTransactions: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe(
      `Cumulative revenue items (billed sessions and fee charges) through the end of this date.${MONEY_HIDDEN}`,
    ),
  dayTransactions: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe(`Revenue items of this date.${MONEY_HIDDEN}`),
  totalPorts: z.number().int().min(0).describe('Total number of ports tracked on this date'),
  stationsBelowThreshold: z
    .number()
    .int()
    .min(0)
    .describe('Number of stations with uptime below the 97% threshold on this date'),
  avgPingLatencyMs: z
    .number()
    .min(0)
    .describe('Average OCPP ping round-trip latency in milliseconds'),
  pingSuccessRate: z
    .number()
    .min(0)
    .max(100)
    .describe('Percentage of OCPP pings that received a pong response (0-100)'),
};

const snapshotItem = z.object(snapshotFields).passthrough();

const datedSnapshotItem = z
  .object({
    date: z.string().describe('Snapshot date in YYYY-MM-DD format (system timezone)'),
    ...snapshotFields,
  })
  .passthrough();

const trendResponse = z
  .object({
    days: z
      .array(datedSnapshotItem)
      .describe(
        'Per-day snapshot rows of the last 14 days in the system timezone, newest first. Only days with a snapshot are listed, so hasData is always true.',
      ),
  })
  .passthrough();

const dayOverDayResponse = z
  .object({
    current: datedSnapshotItem.describe(
      'The latest snapshot date up to yesterday in the system timezone (yesterday when none has data)',
    ),
    previous: datedSnapshotItem.describe('The calendar day before current'),
  })
  .passthrough();

const snapshotDateQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Single date or range start in YYYY-MM-DD format'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Range end in YYYY-MM-DD format. If omitted, returns data for single date.'),
});

const uptimeQuery = z.object({
  days: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe(
      'Number of trailing days to compute uptime over (1-366). Takes precedence over `months`; the dashboard sends 30.',
    ),
  months: z
    .string()
    .optional()
    .describe('Number of trailing months to compute uptime over (1-24, defaults to 12).'),
});

/**
 * How far before the period an ended session may have started and still be
 * counted: it bounds the scan to an index range. Longer sessions are ended
 * by the stale session cleanup long before this.
 */
const UTILIZATION_LOOKBACK_DAYS = 7;

/**
 * Per user and route. One open dashboard refetches a route at most once per
 * 5 s on CSMS events plus the 60 s poll (about 14 a minute); 120 leaves room
 * for several tabs and windows. The response cache and the one-minute totals
 * cache keep the database load per minute bounded whatever the request rate.
 */
const DASHBOARD_RATE_LIMIT = {
  rateLimit: {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => {
      const user = request.user as { userId?: string } | undefined;
      return user?.userId ?? request.ip;
    },
  },
};

export function dashboardRoutes(app: FastifyInstance): void {
  app.get(
    '/dashboard/stats',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get dashboard statistics',
        operationId: 'listDashboardStats',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(dashboardStatsResponse) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);

      const emptyStats = {
        totalStations: 0,
        onlineStations: 0,
        onlinePercent: 0,
        activeSessions: 0,
        totalSessions: 0,
        totalEnergyWh: 0,
        faultedStations: 0,
        statusCounts: {},
        onboardingStatusCounts: {},
      };

      if (siteIds != null && siteIds.length === 0) {
        return emptyStats;
      }

      // Conformance (OCTT) stations and their sessions are never counted.
      const stationConditions = [isOperatorStation()];
      if (siteIds != null) {
        stationConditions.push(inArray(chargingStations.siteId, siteIds));
      }
      const sessionScope = and(
        inOperatorStation(chargingSessions.stationId),
        siteIds != null ? inArray(chargingSessions.siteId, siteIds) : undefined,
      );

      // All-time session totals: the sessions started before today from the
      // shared one-minute cache, plus today's read live through the start
      // index. Active sessions, station counts and faults are read live.
      const tz = await getSystemTimezone();
      const todayStart = calendarDayBounds(calendarDateIn(new Date(), tz), tz).since;
      const sessionTotalsSql = {
        totalSessions: count(),
        totalEnergyWh:
          sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`.mapWith(
            Number,
          ),
      };
      const earlierTotals = cachedDashboardTotals(
        `stats:${todayStart.toISOString()}:${siteScopeKey(siteIds)}`,
        async () => {
          const [row] = await db
            .select(sessionTotalsSql)
            .from(chargingSessions)
            .where(and(lt(chargingSessions.startedAt, todayStart), sessionScope));
          return { totalSessions: row?.totalSessions ?? 0, totalEnergyWh: row?.totalEnergyWh ?? 0 };
        },
      );
      const todayTotalsQuery = db
        .select(sessionTotalsSql)
        .from(chargingSessions)
        .where(and(gte(chargingSessions.startedAt, todayStart), sessionScope));

      const activeSessionsQuery = db
        .select({ activeSessions: count() })
        .from(chargingSessions)
        .where(and(eq(chargingSessions.status, 'active'), sessionScope));

      // Faulted stations use the station list's display status, so a station
      // charging on one plug while another plug is faulted is not counted.
      const faultedStationsQuery = db
        .select({
          faulted: sql<number>`count(*) filter (where ${buildDerivedStatusSubquery(chargingStations.id)} = 'faulted')`,
        })
        .from(chargingStations)
        .where(and(eq(chargingStations.onboardingStatus, 'accepted'), ...stationConditions));

      const [stationRows, earlier, [todayTotals], [active], [faulted]] = await Promise.all([
        db
          .select({
            status: chargingStations.availability,
            onboardingStatus: chargingStations.onboardingStatus,
            isOnline: chargingStations.isOnline,
            count: count(),
          })
          .from(chargingStations)
          .where(and(...stationConditions))
          .groupBy(
            chargingStations.availability,
            chargingStations.onboardingStatus,
            chargingStations.isOnline,
          ),
        earlierTotals,
        todayTotalsQuery,
        activeSessionsQuery,
        faultedStationsQuery,
      ]);

      // Station counts cover accepted stations: a pending or blocked station
      // is not in service. onboardingStatusCounts counts every station.
      let totalStations = 0;
      let onlineStations = 0;
      const statusCounts: Record<string, number> = {};
      const onboardingStatusCounts: Record<string, number> = {};

      for (const row of stationRows) {
        onboardingStatusCounts[row.onboardingStatus] =
          (onboardingStatusCounts[row.onboardingStatus] ?? 0) + row.count;
        if (row.onboardingStatus !== 'accepted') continue;
        totalStations += row.count;
        if (row.isOnline) onlineStations += row.count;
        statusCounts[row.status] = (statusCounts[row.status] ?? 0) + row.count;
      }

      return {
        totalStations,
        onlineStations,
        onlinePercent: totalStations > 0 ? Math.round((onlineStations / totalStations) * 100) : 0,
        activeSessions: active?.activeSessions ?? 0,
        totalSessions: earlier.totalSessions + (todayTotals?.totalSessions ?? 0),
        totalEnergyWh: earlier.totalEnergyWh + (todayTotals?.totalEnergyWh ?? 0),
        faultedStations: faulted?.faulted ?? 0,
        statusCounts,
        onboardingStatusCounts,
      };
    },
  );

  app.get(
    '/dashboard/energy-history',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get energy delivery history by day',
        operationId: 'listDashboardEnergyHistory',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(dateRangeQuery),
        response: {
          200: arrayResponse(dateValueItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const tz = await getSystemTimezone();
      const range = resolveCalendarRange(
        request.query as { days?: string; from?: string; to?: string },
        tz,
      );

      const conditions = [
        gte(chargingSessions.startedAt, range.since),
        lt(chargingSessions.startedAt, range.until),
        inOperatorStation(chargingSessions.stationId),
      ];
      if (siteIds != null) {
        // The sessions that happened at the user's sites (site_id).
        conditions.push(inArray(chargingSessions.siteId, siteIds));
      }

      const rows = await db
        .select({
          date: sql<string>`(${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          energyWh:
            sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`.mapWith(
              Number,
            ),
        })
        .from(chargingSessions)
        .where(and(...conditions))
        .groupBy(sql`1`);

      return fillDates(range.dates, rows, (date) => ({ date, energyWh: 0 }));
    },
  );

  app.get(
    '/dashboard/session-history',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get charging session count history by day',
        operationId: 'listDashboardSessionHistory',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(dateRangeQuery),
        response: {
          200: arrayResponse(dateCountItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const tz = await getSystemTimezone();
      const range = resolveCalendarRange(
        request.query as { days?: string; from?: string; to?: string },
        tz,
      );

      const conditions = [
        gte(chargingSessions.startedAt, range.since),
        lt(chargingSessions.startedAt, range.until),
        inOperatorStation(chargingSessions.stationId),
      ];
      if (siteIds != null) {
        // The sessions that happened at the user's sites (site_id).
        conditions.push(inArray(chargingSessions.siteId, siteIds));
      }

      const rows = await db
        .select({
          date: sql<string>`(${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          count: count(),
        })
        .from(chargingSessions)
        .where(and(...conditions))
        .groupBy(sql`1`);

      return fillDates(range.dates, rows, (date) => ({ date, count: 0 }));
    },
  );

  app.get(
    '/dashboard/station-status',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get connector counts grouped by status',
        operationId: 'listDashboardStationStatus',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(stationStatusItem) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      // Connectors in service only: a retired connector, or one on a retired
      // EVSE, keeps its last status but is no longer a port.
      // Conformance (OCTT) stations are not ports of the operator.
      const conditions = [
        isNull(connectors.retiredAt),
        isNull(evses.retiredAt),
        isOperatorStation(),
      ];
      if (siteIds != null) conditions.push(inArray(chargingStations.siteId, siteIds));

      return db
        .select({
          status: connectors.status,
          count: count(),
        })
        .from(connectors)
        .innerJoin(evses, eq(connectors.evseId, evses.id))
        .innerJoin(chargingStations, eq(evses.stationId, chargingStations.id))
        .where(and(...conditions))
        .groupBy(connectors.status);
    },
  );

  app.get(
    '/dashboard/utilization',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get site utilization percentages',
        operationId: 'listDashboardUtilization',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(dateRangeQuery),
        response: {
          200: arrayResponse(utilizationItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const tz = await getSystemTimezone();
      const range = resolveCalendarRange(
        request.query as { days?: string; from?: string; to?: string },
        tz,
      );
      const sinceIso = range.since.toISOString();
      const endIso = range.periodEnd.toISOString();
      const periodHours =
        Math.max(range.periodEnd.getTime() - range.since.getTime(), 0) / 3_600_000;

      // Charging hours of the sessions at each site (the session's own site),
      // started in the period, earlier by up to the lookback or still active,
      // each clipped to the period, over the port-hours of the site: its EVSEs
      // in service now (not retired) times the hours of the period so far.
      const siteFilter =
        siteIds != null
          ? sql`WHERE s.id IN (${sql.join(
              siteIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``;
      const rows = await db.execute<{
        site_name: string | null;
        ports: number | string;
        session_hours: number | string;
      }>(sql`
        SELECT s.name AS site_name, p.ports, h.session_hours
        FROM sites s
        CROSS JOIN LATERAL (
          SELECT count(*) AS ports
          FROM evses e
          INNER JOIN charging_stations st ON st.id = e.station_id
          WHERE st.site_id = s.id AND e.retired_at IS NULL
            AND ${sql.raw(operatorStationSql('st'))}
        ) p
        CROSS JOIN LATERAL (
          SELECT coalesce(sum(extract(epoch from (
            least(coalesce(cs.ended_at, now()), ${endIso}::timestamptz)
            - greatest(cs.started_at, ${sinceIso}::timestamptz)
          )) / 3600), 0) AS session_hours
          FROM charging_sessions cs
          WHERE cs.site_id = s.id
            AND cs.started_at < ${endIso}::timestamptz
            AND (cs.started_at >= ${sinceIso}::timestamptz - interval '${sql.raw(String(UTILIZATION_LOOKBACK_DAYS))} days'
                 OR cs.status = 'active')
            AND coalesce(cs.ended_at, now()) > ${sinceIso}::timestamptz
            AND ${sql.raw(operatorStationIdSql('cs.station_id'))}
        ) h
        ${siteFilter}
      `);

      return (
        rows
          .map((r) => {
            const capacity = Number(r.ports) * periodHours;
            const ratio = capacity > 0 ? Number(r.session_hours) / capacity : 0;
            return { site: r.site_name, ratio };
          })
          .sort((a, b) => b.ratio - a.ratio || (a.site ?? '').localeCompare(b.site ?? ''))
          .slice(0, 10)
          // Not rounded: a large, lightly used network sits well under 1%, and the
          // chart bars must stay proportional however small; the labels round.
          .map((r) => ({ site: r.site, utilization: Math.min(r.ratio * 100, 100) }))
      );
    },
  );

  app.get(
    '/dashboard/peak-usage',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get peak usage heatmap by hour and day of week',
        operationId: 'listDashboardPeakUsage',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(dateRangeQuery),
        response: {
          200: arrayResponse(peakUsageItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const tz = await getSystemTimezone();
      const range = resolveCalendarRange(
        request.query as { days?: string; from?: string; to?: string },
        tz,
      );

      const conditions = [
        gte(chargingSessions.startedAt, range.since),
        lt(chargingSessions.startedAt, range.until),
        inOperatorStation(chargingSessions.stationId),
      ];
      if (siteIds != null) {
        // The sessions that happened at the user's sites (site_id).
        conditions.push(inArray(chargingSessions.siteId, siteIds));
      }

      const query = db
        .select({
          hour: sql<number>`extract(hour from ${chargingSessions.startedAt} AT TIME ZONE ${tz})::int`,
          dayOfWeek: sql<number>`extract(isodow from ${chargingSessions.startedAt} AT TIME ZONE ${tz})::int`,
          count: count(),
        })
        .from(chargingSessions);

      const rows = await query.where(and(...conditions)).groupBy(sql`1`, sql`2`);

      return rows.map((r) => ({
        hour: r.hour,
        dayOfWeek: r.dayOfWeek,
        count: r.count,
      }));
    },
  );

  app.get(
    '/dashboard/financial-stats',
    {
      onRequest: [authorize('dashboard:read', 'payments:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get financial summary statistics',
        operationId: 'getDashboardFinancialStats',
        security: [{ bearerAuth: [] }],
        description:
          'Needs payments:read in addition to dashboard:read (403 INSUFFICIENT_PERMISSIONS).',
        response: {
          200: itemResponse(financialStatsResponse),
          403: errorWith('Insufficient permissions', [ERROR_CODES.INSUFFICIENT_PERMISSIONS]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const [siteIds, currency] = await Promise.all([getUserSiteIds(userId), getCompanyCurrency()]);

      const emptyFinancials = {
        totalRevenueCents: 0,
        todayRevenueCents: 0,
        totalNetRevenueCents: 0,
        todayNetRevenueCents: 0,
        totalTaxCents: 0,
        todayTaxCents: 0,
        avgRevenueCentsPerSession: 0,
        totalTransactions: 0,
        totalElectricityCostCents: 0,
        dayElectricityCostCents: 0,
        totalProfitCents: 0,
        dayProfitCents: 0,
        totalCostMissingSessionCount: 0,
        totalCostMissingRevenueCents: 0,
        dayCostMissingSessionCount: 0,
        dayCostMissingRevenueCents: 0,
        billedOnAccountCents: 0,
        billedOnAccountCount: 0,
        currency,
      };

      if (siteIds != null && siteIds.length === 0) return emptyFinancials;

      const tz = await getSystemTimezone();
      const billed = inCompanyCurrency(chargingSessions.currency, currency);
      const today = calendarDayBounds(calendarDateIn(new Date(), tz), tz);
      // Conformance (OCTT) stations and their sessions are never counted.
      const sessionScope = and(
        inOperatorStation(chargingSessions.stationId),
        siteIds != null ? inArray(chargingSessions.siteId, siteIds) : undefined,
      );
      // Revenue items leave conformance stations out themselves (session-revenue).
      const revenueScope = siteIds != null ? [revenueAtSites(siteIds)] : [];

      // All-time totals (session-revenue.ts definition): the items before today
      // from the shared one-minute cache, plus today's items read live through
      // the indexed start and charge dates. Today is fresh after every event;
      // a change to an earlier item (a refund) shows within the minute.
      const electricityCostSql = {
        electricityCostCents:
          sql<number>`coalesce(sum(${chargingSessions.electricityCostCents}), 0)`.mapWith(Number),
      };
      const earlierPromise = cachedDashboardTotals(
        `financial:${currency}:${today.since.toISOString()}:${siteScopeKey(siteIds)}`,
        async () => {
          const [[cost], revenue] = await Promise.all([
            db
              .select(electricityCostSql)
              .from(chargingSessions)
              .where(and(billed, sessionScope, lt(chargingSessions.startedAt, today.since))),
            queryRevenueTotal({
              companyCurrency: currency,
              where: [
                ...revenueScope,
                sql`${revenueItem.occurredAt} < ${today.since.toISOString()}::timestamptz`,
              ],
            }),
          ]);
          return { revenue, electricityCostCents: cost?.electricityCostCents ?? 0 };
        },
      );

      const [earlier, [todayCost], todayRevenue] = await Promise.all([
        earlierPromise,
        db
          .select(electricityCostSql)
          .from(chargingSessions)
          .where(and(billed, sessionScope, gte(chargingSessions.startedAt, today.since))),
        queryRevenueTotal({
          companyCurrency: currency,
          occurredSince: today.since,
          where: revenueScope,
        }),
      ]);
      const totalRevenue = sumRevenue([earlier.revenue, todayRevenue]);
      const dayElectricityCostCents = todayCost?.electricityCostCents ?? 0;
      const totalElectricityCostCents = earlier.electricityCostCents + dayElectricityCostCents;

      return {
        totalRevenueCents: totalRevenue.grossCents,
        todayRevenueCents: todayRevenue.grossCents,
        totalNetRevenueCents: totalRevenue.netCents,
        todayNetRevenueCents: todayRevenue.netCents,
        totalTaxCents: totalRevenue.taxCents,
        todayTaxCents: todayRevenue.taxCents,
        avgRevenueCentsPerSession:
          totalRevenue.sessionCount > 0
            ? Math.round(totalRevenue.sessionGrossCents / totalRevenue.sessionCount)
            : 0,
        totalTransactions: totalRevenue.itemCount,
        totalElectricityCostCents,
        dayElectricityCostCents,
        totalProfitCents: profitCents(totalRevenue, totalElectricityCostCents),
        dayProfitCents: profitCents(todayRevenue, dayElectricityCostCents),
        totalCostMissingSessionCount: totalRevenue.costMissingCount,
        totalCostMissingRevenueCents: totalRevenue.costMissingGrossCents,
        dayCostMissingSessionCount: todayRevenue.costMissingCount,
        dayCostMissingRevenueCents: todayRevenue.costMissingGrossCents,
        billedOnAccountCents: totalRevenue.billedOnAccountCents,
        billedOnAccountCount: totalRevenue.billedOnAccountCount,
        currency,
      };
    },
  );

  app.get(
    '/dashboard/revenue-history',
    {
      onRequest: [authorize('dashboard:read', 'payments:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get revenue history by day',
        operationId: 'listDashboardRevenueHistory',
        security: [{ bearerAuth: [] }],
        description:
          'Needs payments:read in addition to dashboard:read (403 INSUFFICIENT_PERMISSIONS).',
        querystring: zodSchema(dateRangeQuery),
        response: {
          200: arrayResponse(revenueHistoryItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          403: errorWith('Insufficient permissions', [ERROR_CODES.INSUFFICIENT_PERMISSIONS]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const [tz, currency] = await Promise.all([getSystemTimezone(), getCompanyCurrency()]);
      const range = resolveCalendarRange(
        request.query as { days?: string; from?: string; to?: string },
        tz,
      );

      const where = [
        sql`${revenueItem.occurredAt} >= ${range.since.toISOString()}::timestamptz`,
        sql`${revenueItem.occurredAt} < ${range.until.toISOString()}::timestamptz`,
      ];
      if (siteIds != null) where.push(revenueAtSites(siteIds));

      // Revenue per day (session-revenue.ts): ended sessions and reservation
      // fees, minus refunds, tax included.
      const byDay = await queryRevenue({
        companyCurrency: currency,
        key: sql`(${revenueItem.occurredAt} AT TIME ZONE ${tz})::date`,
        where,
        occurredSince: range.since,
      });

      return range.dates.map((date) => {
        const revenue = byDay.get(date) ?? EMPTY_REVENUE;
        return { date, revenueCents: revenue.grossCents, sessionCount: revenue.sessionCount };
      });
    },
  );

  app.get(
    '/dashboard/payment-breakdown',
    {
      onRequest: [authorize('dashboard:read', 'payments:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get payment counts and totals grouped by status',
        operationId: 'listDashboardPaymentBreakdown',
        security: [{ bearerAuth: [] }],
        description:
          'Needs payments:read in addition to dashboard:read (403 INSUFFICIENT_PERMISSIONS).',
        response: {
          200: arrayResponse(paymentBreakdownItem),
          403: errorWith('Insufficient permissions', [ERROR_CODES.INSUFFICIENT_PERMISSIONS]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const [siteIds, currency] = await Promise.all([getUserSiteIds(userId), getCompanyCurrency()]);
      if (siteIds != null && siteIds.length === 0) return [];

      // Session records and reservation fee records of the operator's sites.
      const rows = await db
        .select({
          status: paymentRecords.status,
          count: count(),
          totalCents: sql<number>`${paymentsKeptCentsSql(currency)}`,
        })
        .from(paymentRecords)
        .where(
          and(
            paymentRecordsOfOperatorStations(),
            siteIds != null ? paymentRecordsAtSites(siteIds) : undefined,
          ),
        )
        .groupBy(paymentRecords.status);

      return rows.map((r) => ({
        status: r.status,
        count: r.count,
        totalCents: r.totalCents,
      }));
    },
  );

  app.get(
    '/dashboard/uptime',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get station uptime percentage and port counts',
        operationId: 'getDashboardUptime',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(uptimeQuery),
        response: {
          200: itemResponse(uptimeResponse),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);

      const emptyUptime = { uptimePercent: 100, totalPorts: 0, stationsBelowThreshold: 0 };
      if (siteIds != null && siteIds.length === 0) return emptyUptime;

      const { days, months = '12' } = request.query as { days?: string; months?: string };
      const since = new Date();
      if (days != null) {
        const daysNum = Number(days);
        if (daysNum < 1 || daysNum > 366) {
          throw new ValidationError('"days" must be between 1 and 366');
        }
        since.setTime(since.getTime() - daysNum * 86_400_000);
      } else {
        const monthsNum = Math.min(Number(months) || 12, 24);
        since.setMonth(since.getMonth() - monthsNum);
      }

      const periodMinutes = Math.floor((Date.now() - since.getTime()) / 60000);
      const periodMinutesLiteral = sql.raw(String(periodMinutes));
      const sinceIso = since.toISOString();

      const siteFilter =
        siteIds != null
          ? sql`WHERE cs.site_id IN (${sql.join(
              siteIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``;

      const rows = await db.execute(sql`
        WITH all_ports AS (
          SELECT DISTINCT e.station_id, e.evse_id
          FROM evses e
          INNER JOIN charging_stations cs ON cs.id = e.station_id AND e.retired_at IS NULL
            AND ${sql.raw(operatorStationSql('cs'))}
          ${siteFilter}
        ),
        pre_period_status AS (
          SELECT DISTINCT ON (psl.station_id, psl.evse_id)
            psl.station_id,
            psl.evse_id,
            psl.new_status,
            ${sinceIso}::timestamptz AS timestamp
          FROM port_status_log psl
          INNER JOIN all_ports ap ON ap.station_id = psl.station_id AND ap.evse_id = psl.evse_id
          WHERE psl.timestamp < ${sinceIso}::timestamptz
          ORDER BY psl.station_id, psl.evse_id, psl.timestamp DESC
        ),
        seeded_log AS (
          SELECT station_id, evse_id, new_status, timestamp FROM pre_period_status
          UNION ALL
          SELECT psl.station_id, psl.evse_id, psl.new_status, psl.timestamp
          FROM port_status_log psl
          INNER JOIN all_ports ap ON ap.station_id = psl.station_id AND ap.evse_id = psl.evse_id
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
        ),
        port_uptime AS (
          SELECT
            ap.station_id,
            ap.evse_id,
            CASE WHEN ${periodMinutesLiteral} > 0
              THEN GREATEST(0, ((${periodMinutesLiteral} - COALESCE(om.down_minutes, 0)) / ${periodMinutesLiteral}) * 100)
              ELSE 100
            END AS uptime_pct
          FROM all_ports ap
          LEFT JOIN outage_minutes om ON om.station_id = ap.station_id AND om.evse_id = ap.evse_id
        ),
        station_uptime AS (
          SELECT
            station_id,
            AVG(uptime_pct) AS station_uptime_pct
          FROM port_uptime
          GROUP BY station_id
        )
        SELECT
          COALESCE(AVG(station_uptime_pct), 100) AS uptime_percent,
          (SELECT COUNT(*) FROM all_ports) AS total_ports,
          COUNT(*) FILTER (WHERE station_uptime_pct < 97) AS stations_below_threshold
        FROM station_uptime
      `);

      const row = rows[0] as
        | { uptime_percent: string; total_ports: string; stations_below_threshold: string }
        | undefined;

      return {
        uptimePercent: Math.round(Number(row?.uptime_percent ?? 100) * 100) / 100,
        totalPorts: Number(row?.total_ports ?? 0),
        stationsBelowThreshold: Number(row?.stations_below_threshold ?? 0),
      };
    },
  );

  app.get(
    '/dashboard/ocpp-health',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get OCPP WebSocket server health metrics',
        description:
          "connectedStations counts the online stations of the user's sites. The server process fields (ping statistics, start time, instance count) cover every station of the company, so a user restricted to some sites gets their empty values and no instances list.",
        operationId: 'getDashboardOcppHealth',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(ocppHealthResponse) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);

      // A restricted user gets the empty process statistics and no
      // instances list: the OCPP processes are company infrastructure.
      const emptyHealth = {
        connectedStations: 0,
        avgPingLatencyMs: 0,
        maxPingLatencyMs: 0,
        pingSuccessRate: 100,
        totalPingsSent: 0,
        totalPongsReceived: 0,
        serverStartedAt: null,
        updatedAt: null,
        instanceCount: 0,
      };

      if (siteIds != null && siteIds.length === 0) return emptyHealth;

      const connectedConditions = [eq(chargingStations.isOnline, true), isOperatorStation()];
      if (siteIds != null) {
        connectedConditions.push(inArray(chargingStations.siteId, siteIds));
      }

      const connectedQuery = db
        .select({ count: count() })
        .from(chargingStations)
        .where(and(...connectedConditions));

      // The OCPP process statistics are measured over every connected
      // station, whatever its site, and name the server instances: company
      // infrastructure, all-site users only.
      if (siteIds != null) {
        const [connectedRow] = await connectedQuery;
        return { ...emptyHealth, connectedStations: connectedRow?.count ?? 0 };
      }

      // Ping stats aggregate the fresh row of every OCPP process.
      const [[connectedRow], health] = await Promise.all([
        connectedQuery,
        getOcppFleetHealth(client),
      ]);

      return {
        connectedStations: connectedRow?.count ?? 0,
        avgPingLatencyMs: health.avgPingLatencyMs,
        maxPingLatencyMs: health.maxPingLatencyMs,
        pingSuccessRate: health.pingSuccessRate,
        totalPingsSent: health.totalPingsSent,
        totalPongsReceived: health.totalPongsReceived,
        serverStartedAt: health.serverStartedAt,
        updatedAt: health.updatedAt,
        instanceCount: health.instanceCount,
        instances: health.instances.map((i) => ({
          instanceId: i.instanceId,
          connectedStations: i.connectedStations,
          avgPingLatencyMs: i.avgPingLatencyMs,
          maxPingLatencyMs: i.maxPingLatencyMs,
          pingSuccessRate: i.pingSuccessRate,
          serverStartedAt: i.serverStartedAt,
          updatedAt: i.updatedAt,
        })),
      };
    },
  );

  app.get(
    '/dashboard/site-locations',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Site locations for map',
        operationId: 'getDashboardSiteLocations',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(siteLocationItem) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const conditions = [sql`${sites.latitude} IS NOT NULL`, sql`${sites.longitude} IS NOT NULL`];
      if (siteIds != null) {
        conditions.push(inArray(sites.id, siteIds));
      }

      const rows = await db
        .select({
          siteId: sites.id,
          name: sites.name,
          latitude: sites.latitude,
          longitude: sites.longitude,
          // "sites"."id" written out: a single-table select renders the column
          // unqualified, which inside the subquery names charging_stations.id.
          stationCount: sql<number>`(SELECT count(*)::int FROM charging_stations WHERE charging_stations.site_id = "sites"."id" AND ${sql.raw(operatorStationSql('charging_stations'))})`,
        })
        .from(sites)
        .where(and(...conditions));

      return rows.map((r) => ({
        siteId: r.siteId,
        name: r.name,
        latitude: r.latitude as string,
        longitude: r.longitude as string,
        stationCount: r.stationCount,
      }));
    },
  );

  // --- Snapshot endpoints ---

  app.get(
    '/dashboard/snapshots/trend',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get 14-day trend of dashboard snapshots',
        operationId: 'getDashboardSnapshotTrend',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(trendResponse) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const scope = await snapshotScope(request);
      if (scope == null) return { days: [] };
      const tz = await getSystemTimezone();
      const days = await querySnapshotDays(
        scope,
        sql`snapshot_date >= (now() AT TIME ZONE ${tz})::date - 14`,
      );
      return { days: [...days].reverse().map((d) => scope.present(d)) };
    },
  );

  app.get(
    '/dashboard/snapshots/day-over-day',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get the snapshots the day-over-day arrows compare',
        description:
          'The latest snapshot date up to yesterday in the system timezone and the day before it, aggregated over the user sites like GET /v1/dashboard/snapshots. The dashboard compares the two and labels the comparison with both dates.',
        operationId: 'getDashboardSnapshotDayOverDay',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(dayOverDayResponse) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const tz = await getSystemTimezone();
      const yesterday = addCalendarDays(calendarDateIn(new Date(), tz), -1);
      const scope = await snapshotScope(request);
      const empty = (date: string): DatedSnapshot => ({ date, ...EMPTY_SNAPSHOT });
      if (scope == null) {
        return { current: empty(yesterday), previous: empty(addCalendarDays(yesterday, -1)) };
      }
      const [latest] = await db.execute<{ date: string | null }>(sql`
        SELECT max(snapshot_date)::text AS date
        FROM dashboard_snapshots
        WHERE snapshot_date <= ${yesterday}::date ${scope.siteFilter}
      `);
      const current = latest?.date ?? yesterday;
      const previous = addCalendarDays(current, -1);
      const days = await querySnapshotDays(
        scope,
        sql`snapshot_date IN (${current}::date, ${previous}::date)`,
      );
      const day = (date: string): DatedSnapshot =>
        scope.present(days.find((d) => d.date === date) ?? empty(date));
      return { current: day(current), previous: day(previous) };
    },
  );

  app.get(
    '/dashboard/snapshots/available-dates',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get dates that have snapshot data',
        operationId: 'getDashboardSnapshotAvailableDates',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(z.string()) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const scope = await snapshotScope(request);
      if (scope == null) return [];

      const rows = await db.execute(sql`
        SELECT DISTINCT snapshot_date::text AS date
        FROM dashboard_snapshots
        WHERE 1=1 ${scope.siteFilter}
        ORDER BY date DESC
      `);

      return (rows as unknown as Array<{ date: string }>).map((r) => r.date);
    },
  );

  app.get(
    '/dashboard/snapshots',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get historical dashboard snapshot for a date',
        operationId: 'getDashboardSnapshot',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(snapshotDateQuery),
        response: {
          200: itemResponse(snapshotItem),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { date, to } = request.query as z.infer<typeof snapshotDateQuery>;

      // Regex on snapshotDateQuery only checks the YYYY-MM-DD shape; reject
      // syntactically-valid-but-impossible dates like "2024-02-30" here so
      // operators see a clear 400 instead of a generic 500 from the
      // PostgreSQL ::date cast. Also reject an inverted range so behaviour
      // matches the documented contract for the live endpoints.
      const dateMs = parseCalendarDate(date);
      if (dateMs == null) {
        throw new ValidationError('"date" is not a valid calendar date');
      }
      if (to != null) {
        const toMs = parseCalendarDate(to);
        if (toMs == null) {
          throw new ValidationError('"to" is not a valid calendar date');
        }
        if (toMs < dateMs) {
          throw new ValidationError('"to" must be on or after "date"');
        }
      }

      const scope = await snapshotScope(request);
      if (scope == null) return EMPTY_SNAPSHOT;

      const isRange = to != null && to !== date;
      const days = await querySnapshotDays(
        scope,
        isRange
          ? sql`snapshot_date >= ${date}::date AND snapshot_date <= ${to}::date`
          : sql`snapshot_date = ${date}::date`,
      );
      // A range averages the per-day aggregates over the days with data.
      return scope.present(averageSnapshotDays(days));
    },
  );

  // --- Carbon stats ---

  const carbonStatsResponse = z
    .object({
      totalCo2AvoidedKg: z.number().describe('Total CO2 avoided across the period in kilograms'),
      sessionCount: z.number().describe('Number of completed sessions with carbon data'),
      avgCo2AvoidedKgPerSession: z
        .number()
        .describe('Average CO2 avoided per session in kilograms'),
    })
    .passthrough();

  const carbonStatsQuery = z.object({
    from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
    to: z.string().optional().describe('End date (YYYY-MM-DD)'),
  });

  app.get(
    '/dashboard/carbon-stats',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get carbon impact statistics',
        operationId: 'getDashboardCarbonStats',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(carbonStatsQuery),
        response: {
          200: itemResponse(carbonStatsResponse),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { from: fromDate, to: toDate } = request.query as z.infer<typeof carbonStatsQuery>;
      // from > to silently returns 0 from the aggregation, indistinguishable
      // from "no data exists" on the dashboard. (Zod .refine() doesn't help
      // here -- zod-to-json-schema strips refines before Fastify validates.)
      if (fromDate != null && toDate != null && fromDate > toDate) {
        await reply.status(400).send({
          error: '"from" date must be on or before "to" date',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      const siteIds = await getUserSiteIds(userId);

      const empty = { totalCo2AvoidedKg: 0, sessionCount: 0, avgCo2AvoidedKgPerSession: 0 };
      if (siteIds != null && siteIds.length === 0) return empty;

      const tz = await getSystemTimezone();
      const conditions = [
        eq(chargingSessions.status, 'completed'),
        sql`${chargingSessions.co2AvoidedKg} IS NOT NULL`,
        inOperatorStation(chargingSessions.stationId),
      ];
      // Compare endedAt projected into the system timezone so YYYY-MM-DD
      // filters mean "the operator's local day", not UTC midnight.
      if (fromDate != null) {
        conditions.push(
          sql`(${chargingSessions.endedAt} AT TIME ZONE ${tz})::date >= ${fromDate}::date`,
        );
      }
      if (toDate != null) {
        conditions.push(
          sql`(${chargingSessions.endedAt} AT TIME ZONE ${tz})::date <= ${toDate}::date`,
        );
      }

      const query = db
        .select({
          totalCo2: sql<number>`coalesce(sum(${chargingSessions.co2AvoidedKg}::numeric), 0)`,
          sessionCount: sql<number>`count(*)`,
          avgCo2: sql<number>`coalesce(avg(${chargingSessions.co2AvoidedKg}::numeric), 0)`,
        })
        .from(chargingSessions);

      // The sessions that happened at the user's sites (site_id), as every
      // other session aggregate counts them.
      if (siteIds != null) conditions.push(inArray(chargingSessions.siteId, siteIds));

      const [stats] = await query.where(and(...conditions));

      return {
        totalCo2AvoidedKg: Math.round((stats?.totalCo2 ?? 0) * 100) / 100,
        sessionCount: stats?.sessionCount ?? 0,
        avgCo2AvoidedKgPerSession: Math.round((stats?.avgCo2 ?? 0) * 100) / 100,
      };
    },
  );
}
