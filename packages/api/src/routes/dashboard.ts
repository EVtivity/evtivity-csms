// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql, eq, and, gte, lte, count, inArray } from 'drizzle-orm';
import { db } from '@evtivity/database';
import {
  chargingStations,
  chargingSessions,
  connectors,
  evses,
  sites,
  settings,
  paymentRecords,
  ocppServerHealth,
} from '@evtivity/database';
import { itemResponse, arrayResponse } from '../lib/response-schemas.js';
import { zodSchema } from '../lib/zod-schema.js';
import { getUserSiteIds } from '../lib/site-access.js';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';

const dashboardStatsResponse = z
  .object({
    totalStations: z.number(),
    onlineStations: z.number(),
    onlinePercent: z.number(),
    activeSessions: z.number(),
    totalSessions: z.number(),
    totalEnergyWh: z.number(),
    faultedStations: z.number(),
    statusCounts: z.record(z.number()),
    onboardingStatusCounts: z.record(z.number()),
  })
  .passthrough();

const dateValueItem = z.object({ date: z.string(), energyWh: z.number() }).passthrough();
const dateCountItem = z.object({ date: z.string(), count: z.number() }).passthrough();
const stationStatusItem = z.object({ status: z.string(), count: z.number() }).passthrough();
const siteLocationItem = z
  .object({
    siteId: z.string(),
    name: z.string(),
    latitude: z.string(),
    longitude: z.string(),
    stationCount: z.number(),
  })
  .passthrough();
const utilizationItem = z
  .object({ site: z.string().nullable(), utilization: z.number() })
  .passthrough();
const peakUsageItem = z
  .object({ hour: z.number(), dayOfWeek: z.number(), count: z.number() })
  .passthrough();

const financialStatsResponse = z
  .object({
    totalRevenueCents: z.number(),
    todayRevenueCents: z.number(),
    avgRevenueCentsPerSession: z.number(),
    totalTransactions: z.number(),
    currency: z.string(),
  })
  .passthrough();

const revenueHistoryItem = z
  .object({ date: z.string(), revenueCents: z.number(), sessionCount: z.number() })
  .passthrough();

const paymentBreakdownItem = z
  .object({ status: z.string(), count: z.number(), totalCents: z.number() })
  .passthrough();

const uptimeResponse = z
  .object({ uptimePercent: z.number(), totalPorts: z.number(), stationsBelowThreshold: z.number() })
  .passthrough();

const ocppHealthResponse = z
  .object({
    connectedStations: z.number().nullable(),
    avgPingLatencyMs: z.number().nullable(),
    maxPingLatencyMs: z.number().nullable(),
    pingSuccessRate: z.number().nullable(),
    totalPingsSent: z.number().nullable(),
    totalPongsReceived: z.number().nullable(),
    serverStartedAt: z.coerce.date().nullable(),
    updatedAt: z.coerce.date().nullable(),
  })
  .passthrough();

const snapshotItem = z
  .object({
    totalStations: z.number(),
    onlineStations: z.number(),
    onlinePercent: z.number(),
    uptimePercent: z.number(),
    activeSessions: z.number(),
    totalEnergyWh: z.number(),
    dayEnergyWh: z.number(),
    totalSessions: z.number(),
    daySessions: z.number(),
    connectedStations: z.number(),
    totalRevenueCents: z.number(),
    dayRevenueCents: z.number(),
    avgRevenueCentsPerSession: z.number(),
    totalTransactions: z.number(),
    dayTransactions: z.number(),
    totalPorts: z.number(),
    stationsBelowThreshold: z.number(),
  })
  .passthrough();

const trendResponse = z
  .object({
    days: z.array(
      z
        .object({
          date: z.string(),
          totalStations: z.number(),
          onlinePercent: z.number(),
          uptimePercent: z.number(),
          totalEnergyWh: z.number(),
          dayEnergyWh: z.number(),
          totalSessions: z.number(),
          daySessions: z.number(),
          connectedStations: z.number(),
          totalRevenueCents: z.number(),
          dayRevenueCents: z.number(),
          avgRevenueCentsPerSession: z.number(),
          totalTransactions: z.number(),
          dayTransactions: z.number(),
          totalPorts: z.number(),
          stationsBelowThreshold: z.number(),
        })
        .passthrough(),
    ),
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

interface DateRange {
  since: Date;
  until: Date | null;
  daysNum: number;
}

function parseDateRange(query: { days?: string; from?: string; to?: string }): DateRange {
  const { days = '7', from, to } = query;

  if (from && to) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return { since: new Date(Date.now() - 7 * 86400000), until: null, daysNum: 7 };
    }
    toDate.setHours(23, 59, 59, 999);
    const diffMs = toDate.getTime() - fromDate.getTime();
    const diffDays = Math.ceil(diffMs / 86400000);
    if (diffDays > 90 || diffDays < 1) {
      return { since: new Date(Date.now() - 7 * 86400000), until: null, daysNum: 7 };
    }
    return { since: fromDate, until: toDate, daysNum: diffDays };
  }

  const daysNum = Math.min(Number(days) || 7, 90);
  const since = new Date();
  since.setDate(since.getDate() - daysNum);
  return { since, until: null, daysNum };
}

const DASHBOARD_RATE_LIMIT = {
  rateLimit: {
    max: 30,
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

      const stationConditions = [];
      if (siteIds != null) {
        stationConditions.push(inArray(chargingStations.siteId, siteIds));
      }

      const stationRows = await db
        .select({
          status: chargingStations.availability,
          onboardingStatus: chargingStations.onboardingStatus,
          isOnline: chargingStations.isOnline,
          count: count(),
        })
        .from(chargingStations)
        .where(stationConditions.length > 0 ? and(...stationConditions) : undefined)
        .groupBy(
          chargingStations.availability,
          chargingStations.onboardingStatus,
          chargingStations.isOnline,
        );

      let totalStations = 0;
      let onlineStations = 0;
      const statusCounts: Record<string, number> = {};
      const onboardingStatusCounts: Record<string, number> = {};

      for (const row of stationRows) {
        totalStations += row.count;
        if (row.isOnline) onlineStations += row.count;
        statusCounts[row.status] = (statusCounts[row.status] ?? 0) + row.count;
        onboardingStatusCounts[row.onboardingStatus] =
          (onboardingStatusCounts[row.onboardingStatus] ?? 0) + row.count;
      }

      const sessionQuery = db
        .select({
          activeSessions: sql<number>`count(*) filter (where ${chargingSessions.status} = 'active')`,
          totalSessions: count(),
          totalEnergyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
        })
        .from(chargingSessions);

      if (siteIds != null) {
        sessionQuery
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .where(inArray(chargingStations.siteId, siteIds));
      }

      const [sessionStats] = await sessionQuery;

      return {
        totalStations,
        onlineStations,
        onlinePercent: totalStations > 0 ? Math.round((onlineStations / totalStations) * 100) : 0,
        activeSessions: sessionStats?.activeSessions ?? 0,
        totalSessions: sessionStats?.totalSessions ?? 0,
        totalEnergyWh: sessionStats?.totalEnergyWh ?? 0,
        faultedStations: statusCounts['faulted'] ?? 0,
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
        response: { 200: arrayResponse(dateValueItem) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const { since, until } = parseDateRange(
        request.query as { days?: string; from?: string; to?: string },
      );

      const [tzRow] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'system.timezone'));
      const tz = typeof tzRow?.value === 'string' ? tzRow.value : 'America/New_York';

      const conditions = [gte(chargingSessions.startedAt, since)];
      if (until) conditions.push(lte(chargingSessions.startedAt, until));
      if (siteIds != null) {
        conditions.push(inArray(chargingStations.siteId, siteIds));
      }

      const query = db
        .select({
          date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          energyWh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric), 0)`,
        })
        .from(chargingSessions);

      if (siteIds != null) {
        query.innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id));
      }

      const rows = await query
        .where(and(...conditions))
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      return rows.map((r) => ({ date: r.date, energyWh: r.energyWh }));
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
        response: { 200: arrayResponse(dateCountItem) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const { since, until } = parseDateRange(
        request.query as { days?: string; from?: string; to?: string },
      );

      const [tzRow] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'system.timezone'));
      const tz = typeof tzRow?.value === 'string' ? tzRow.value : 'America/New_York';

      const conditions = [gte(chargingSessions.startedAt, since)];
      if (until) conditions.push(lte(chargingSessions.startedAt, until));
      if (siteIds != null) {
        conditions.push(inArray(chargingStations.siteId, siteIds));
      }

      const query = db
        .select({
          date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          count: count(),
        })
        .from(chargingSessions);

      if (siteIds != null) {
        query.innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id));
      }

      const rows = await query
        .where(and(...conditions))
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      return rows.map((r) => ({ date: r.date, count: r.count }));
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

      const query = db
        .select({
          status: connectors.status,
          count: count(),
        })
        .from(connectors);

      if (siteIds != null) {
        query
          .innerJoin(evses, eq(connectors.evseId, evses.id))
          .innerJoin(chargingStations, eq(evses.stationId, chargingStations.id))
          .where(inArray(chargingStations.siteId, siteIds));
      }

      const rows = await query.groupBy(connectors.status);

      return rows;
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
        response: { 200: arrayResponse(utilizationItem) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const { since, until, daysNum } = parseDateRange(
        request.query as { days?: string; from?: string; to?: string },
      );

      const sessionConditions = [
        eq(chargingSessions.stationId, chargingStations.id),
        gte(chargingSessions.startedAt, since),
      ];
      if (until) sessionConditions.push(lte(chargingSessions.startedAt, until));

      const siteConditions = [];
      if (siteIds != null) {
        siteConditions.push(inArray(sites.id, siteIds));
      }

      const rows = await db
        .select({
          siteName: sites.name,
          sessionHours: sql<number>`coalesce(sum(extract(epoch from (coalesce(${chargingSessions.endedAt}, now()) - ${chargingSessions.startedAt})) / 3600), 0)`,
          stationCount: sql<number>`count(distinct ${chargingStations.id})`,
        })
        .from(sites)
        .leftJoin(chargingStations, eq(chargingStations.siteId, sites.id))
        .leftJoin(chargingSessions, and(...sessionConditions))
        .where(siteConditions.length > 0 ? and(...siteConditions) : undefined)
        .groupBy(sites.id, sites.name)
        .orderBy(sql`2 desc`)
        .limit(10);

      const totalHours = daysNum * 24;
      return rows.map((r) => ({
        site: r.siteName,
        utilization:
          r.stationCount > 0
            ? Math.round((r.sessionHours / (r.stationCount * totalHours)) * 100)
            : 0,
      }));
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
        response: { 200: arrayResponse(peakUsageItem) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const { since, until } = parseDateRange(
        request.query as { days?: string; from?: string; to?: string },
      );

      const [tzRow] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'system.timezone'));
      const tz = typeof tzRow?.value === 'string' ? tzRow.value : 'America/New_York';

      const conditions = [gte(chargingSessions.startedAt, since)];
      if (until) conditions.push(lte(chargingSessions.startedAt, until));
      if (siteIds != null) {
        conditions.push(inArray(chargingStations.siteId, siteIds));
      }

      const query = db
        .select({
          hour: sql<number>`extract(hour from ${chargingSessions.startedAt} AT TIME ZONE ${tz})::int`,
          dayOfWeek: sql<number>`extract(isodow from ${chargingSessions.startedAt} AT TIME ZONE ${tz})::int`,
          count: count(),
        })
        .from(chargingSessions);

      if (siteIds != null) {
        query.innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id));
      }

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
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get financial summary statistics',
        operationId: 'getDashboardFinancialStats',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(financialStatsResponse) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);

      const emptyFinancials = {
        totalRevenueCents: 0,
        todayRevenueCents: 0,
        avgRevenueCentsPerSession: 0,
        totalTransactions: 0,
        currency: 'USD',
      };

      if (siteIds != null && siteIds.length === 0) return emptyFinancials;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayIso = today.toISOString();

      const query = db
        .select({
          totalRevenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          todayRevenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})) filter (where ${chargingSessions.startedAt} >= ${todayIso}::timestamptz), 0)`,
          avgRevenueCentsPerSession: sql<number>`coalesce(avg(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          totalTransactions: sql<number>`count(*) filter (where coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null)`,
        })
        .from(chargingSessions);

      if (siteIds != null) {
        query
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .where(inArray(chargingStations.siteId, siteIds));
      }

      const [stats] = await query;

      return {
        totalRevenueCents: stats?.totalRevenueCents ?? 0,
        todayRevenueCents: stats?.todayRevenueCents ?? 0,
        avgRevenueCentsPerSession: Math.round(stats?.avgRevenueCentsPerSession ?? 0),
        totalTransactions: stats?.totalTransactions ?? 0,
        currency: 'USD',
      };
    },
  );

  app.get(
    '/dashboard/revenue-history',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get revenue history by day',
        operationId: 'listDashboardRevenueHistory',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(revenueHistoryItem) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const { since, until } = parseDateRange(
        request.query as { days?: string; from?: string; to?: string },
      );

      const [tzRow] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'system.timezone'));
      const tz = typeof tzRow?.value === 'string' ? tzRow.value : 'America/New_York';

      const conditions = [
        gte(chargingSessions.startedAt, since),
        sql`coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents}) is not null`,
      ];
      if (until) conditions.push(lte(chargingSessions.startedAt, until));
      if (siteIds != null) {
        conditions.push(inArray(chargingStations.siteId, siteIds));
      }

      const query = db
        .select({
          date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
          revenueCents: sql<number>`coalesce(sum(coalesce(${chargingSessions.finalCostCents}, ${chargingSessions.currentCostCents})), 0)`,
          sessionCount: count(),
        })
        .from(chargingSessions);

      if (siteIds != null) {
        query.innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id));
      }

      const rows = await query
        .where(and(...conditions))
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      return rows.map((r) => ({
        date: r.date,
        revenueCents: r.revenueCents,
        sessionCount: r.sessionCount,
      }));
    },
  );

  app.get(
    '/dashboard/payment-breakdown',
    {
      onRequest: [authorize('dashboard:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get payment counts and totals grouped by status',
        operationId: 'listDashboardPaymentBreakdown',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(paymentBreakdownItem) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      if (siteIds != null && siteIds.length === 0) return [];

      const query = db
        .select({
          status: paymentRecords.status,
          count: count(),
          totalCents: sql<number>`coalesce(sum(${paymentRecords.capturedAmountCents}), 0)`,
        })
        .from(paymentRecords);

      if (siteIds != null) {
        query
          .innerJoin(chargingSessions, eq(paymentRecords.sessionId, chargingSessions.id))
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .where(inArray(chargingStations.siteId, siteIds));
      }

      const rows = await query.groupBy(paymentRecords.status);

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
        response: { 200: itemResponse(uptimeResponse) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);

      const emptyUptime = { uptimePercent: 100, totalPorts: 0, stationsBelowThreshold: 0 };
      if (siteIds != null && siteIds.length === 0) return emptyUptime;

      const { months = '12' } = request.query as { months?: string };
      const monthsNum = Math.min(Number(months) || 12, 24);
      const since = new Date();
      since.setMonth(since.getMonth() - monthsNum);

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
          INNER JOIN charging_stations cs ON cs.id = e.station_id
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
        operationId: 'getDashboardOcppHealth',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(ocppHealthResponse) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);

      const emptyHealth = {
        connectedStations: 0,
        avgPingLatencyMs: 0,
        maxPingLatencyMs: 0,
        pingSuccessRate: 100,
        totalPingsSent: 0,
        totalPongsReceived: 0,
        serverStartedAt: null,
        updatedAt: null,
      };

      if (siteIds != null && siteIds.length === 0) return emptyHealth;

      const connectedConditions = [eq(chargingStations.isOnline, true)];
      if (siteIds != null) {
        connectedConditions.push(inArray(chargingStations.siteId, siteIds));
      }

      const connectedQuery = db
        .select({ count: count() })
        .from(chargingStations)
        .where(and(...connectedConditions));

      const [[connectedRow], [healthRow]] = await Promise.all([
        connectedQuery,
        db
          .select({
            avgPingLatencyMs: ocppServerHealth.avgPingLatencyMs,
            maxPingLatencyMs: ocppServerHealth.maxPingLatencyMs,
            pingSuccessRate: ocppServerHealth.pingSuccessRate,
            totalPingsSent: ocppServerHealth.totalPingsSent,
            totalPongsReceived: ocppServerHealth.totalPongsReceived,
            serverStartedAt: ocppServerHealth.serverStartedAt,
            updatedAt: ocppServerHealth.updatedAt,
          })
          .from(ocppServerHealth)
          .where(eq(ocppServerHealth.id, 'singleton')),
      ]);

      return {
        connectedStations: connectedRow?.count ?? 0,
        avgPingLatencyMs: healthRow?.avgPingLatencyMs ?? 0,
        maxPingLatencyMs: healthRow?.maxPingLatencyMs ?? 0,
        pingSuccessRate: healthRow?.pingSuccessRate ?? 100,
        totalPingsSent: healthRow?.totalPingsSent ?? 0,
        totalPongsReceived: healthRow?.totalPongsReceived ?? 0,
        serverStartedAt: healthRow?.serverStartedAt ?? null,
        updatedAt: healthRow?.updatedAt ?? null,
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
          stationCount: sql<number>`(SELECT count(*)::int FROM charging_stations WHERE charging_stations.site_id = ${sites.id})`,
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
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);

      if (siteIds != null && siteIds.length === 0) return { days: [] };

      const siteFilter =
        siteIds != null
          ? sql`AND site_id IN (${sql.join(
              siteIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``;

      const rows = await db.execute(sql`
        SELECT
          snapshot_date::text AS date,
          COALESCE(SUM(total_stations), 0) AS total_stations,
          CASE WHEN SUM(total_stations) > 0
            THEN SUM(online_percent::numeric * total_stations) / SUM(total_stations)
            ELSE 0
          END AS online_percent,
          CASE WHEN SUM(total_stations) > 0
            THEN SUM(uptime_percent::numeric * total_stations) / SUM(total_stations)
            ELSE 100
          END AS uptime_percent,
          COALESCE(SUM(total_energy_wh::numeric), 0) AS total_energy_wh,
          COALESCE(SUM(day_energy_wh::numeric), 0) AS day_energy_wh,
          COALESCE(SUM(total_sessions), 0) AS total_sessions,
          COALESCE(SUM(day_sessions), 0) AS day_sessions,
          COALESCE(SUM(connected_stations), 0) AS connected_stations,
          COALESCE(SUM(total_revenue_cents), 0) AS total_revenue_cents,
          COALESCE(SUM(day_revenue_cents), 0) AS day_revenue_cents,
          CASE WHEN SUM(total_sessions) > 0
            THEN SUM(total_revenue_cents) / SUM(total_sessions)
            ELSE 0
          END AS avg_revenue_cents_per_session,
          COALESCE(SUM(total_transactions), 0) AS total_transactions,
          COALESCE(SUM(day_transactions), 0) AS day_transactions,
          COALESCE(SUM(total_ports), 0) AS total_ports,
          COALESCE(SUM(stations_below_threshold), 0) AS stations_below_threshold,
          CASE WHEN SUM(total_stations) > 0
            THEN SUM(avg_ping_latency_ms::numeric * total_stations) / SUM(total_stations)
            ELSE 0
          END AS avg_ping_latency_ms,
          CASE WHEN SUM(total_stations) > 0
            THEN SUM(ping_success_rate::numeric * total_stations) / SUM(total_stations)
            ELSE 100
          END AS ping_success_rate
        FROM dashboard_snapshots
        WHERE snapshot_date >= (CURRENT_DATE - interval '14 days')::date
          ${siteFilter}
        GROUP BY snapshot_date
        ORDER BY snapshot_date DESC
      `);

      const days = (rows as Array<Record<string, string>>).map((row) => ({
        date: row.date,
        totalStations: Number(row.total_stations),
        onlinePercent: Math.round(Number(row.online_percent) * 10) / 10,
        uptimePercent: Math.round(Number(row.uptime_percent) * 100) / 100,
        totalEnergyWh: Number(row.total_energy_wh),
        dayEnergyWh: Number(row.day_energy_wh),
        totalSessions: Number(row.total_sessions),
        daySessions: Number(row.day_sessions),
        connectedStations: Number(row.connected_stations),
        totalRevenueCents: Number(row.total_revenue_cents),
        dayRevenueCents: Number(row.day_revenue_cents),
        avgRevenueCentsPerSession: Number(row.avg_revenue_cents_per_session),
        totalTransactions: Number(row.total_transactions),
        dayTransactions: Number(row.day_transactions),
        totalPorts: Number(row.total_ports),
        stationsBelowThreshold: Number(row.stations_below_threshold),
        avgPingLatencyMs: Math.round(Number(row.avg_ping_latency_ms) * 100) / 100,
        pingSuccessRate: Math.round(Number(row.ping_success_rate) * 10) / 10,
      }));

      return { days };
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
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);

      if (siteIds != null && siteIds.length === 0) return [];

      const siteFilter =
        siteIds != null
          ? sql`AND site_id IN (${sql.join(
              siteIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``;

      const rows = await db.execute(sql`
        SELECT DISTINCT snapshot_date::text AS date
        FROM dashboard_snapshots
        WHERE 1=1 ${siteFilter}
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
        response: { 200: itemResponse(snapshotItem) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const { date, to } = request.query as z.infer<typeof snapshotDateQuery>;
      const isRange = to != null && to !== date;

      const emptySnapshot = {
        totalStations: 0,
        onlineStations: 0,
        onlinePercent: 0,
        uptimePercent: 100,
        activeSessions: 0,
        totalEnergyWh: 0,
        dayEnergyWh: 0,
        totalSessions: 0,
        daySessions: 0,
        connectedStations: 0,
        totalRevenueCents: 0,
        dayRevenueCents: 0,
        avgRevenueCentsPerSession: 0,
        totalTransactions: 0,
        dayTransactions: 0,
        totalPorts: 0,
        stationsBelowThreshold: 0,
        avgPingLatencyMs: 0,
        pingSuccessRate: 100,
      };

      if (siteIds != null && siteIds.length === 0) return emptySnapshot;

      const siteFilter =
        siteIds != null
          ? sql`AND site_id IN (${sql.join(
              siteIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``;

      const dateFilter = isRange
        ? sql`snapshot_date >= ${date}::date AND snapshot_date <= ${to}::date`
        : sql`snapshot_date = ${date}::date`;

      // For ranges, compute per-day aggregates first, then average across days
      const queryText = isRange
        ? sql`
          SELECT
            COUNT(DISTINCT snapshot_date) AS day_count,
            COALESCE(AVG(day_total_stations), 0) AS total_stations,
            COALESCE(AVG(day_online_stations), 0) AS online_stations,
            CASE WHEN AVG(day_total_stations) > 0
              THEN AVG(day_online_percent)
              ELSE 0
            END AS online_percent,
            CASE WHEN AVG(day_total_stations) > 0
              THEN AVG(day_uptime_percent)
              ELSE 100
            END AS uptime_percent,
            COALESCE(AVG(day_active_sessions), 0) AS active_sessions,
            COALESCE(AVG(day_total_energy_wh), 0) AS total_energy_wh,
            COALESCE(AVG(day_day_energy_wh), 0) AS day_energy_wh,
            COALESCE(AVG(day_total_sessions), 0) AS total_sessions,
            COALESCE(AVG(day_day_sessions), 0) AS day_sessions,
            COALESCE(AVG(day_connected_stations), 0) AS connected_stations,
            COALESCE(AVG(day_total_revenue_cents), 0) AS total_revenue_cents,
            COALESCE(AVG(day_day_revenue_cents), 0) AS day_revenue_cents,
            CASE WHEN AVG(day_total_sessions) > 0
              THEN AVG(day_total_revenue_cents) / NULLIF(AVG(day_total_sessions), 0)
              ELSE 0
            END AS avg_revenue_cents_per_session,
            COALESCE(AVG(day_total_transactions), 0) AS total_transactions,
            COALESCE(AVG(day_day_transactions), 0) AS day_transactions,
            COALESCE(AVG(day_total_ports), 0) AS total_ports,
            COALESCE(AVG(day_stations_below), 0) AS stations_below_threshold,
            COALESCE(AVG(day_avg_ping_latency_ms), 0) AS avg_ping_latency_ms,
            COALESCE(AVG(day_ping_success_rate), 100) AS ping_success_rate
          FROM (
            SELECT
              snapshot_date,
              SUM(total_stations) AS day_total_stations,
              SUM(online_stations) AS day_online_stations,
              CASE WHEN SUM(total_stations) > 0
                THEN SUM(online_percent::numeric * total_stations) / SUM(total_stations)
                ELSE 0
              END AS day_online_percent,
              CASE WHEN SUM(total_stations) > 0
                THEN SUM(uptime_percent::numeric * total_stations) / SUM(total_stations)
                ELSE 100
              END AS day_uptime_percent,
              SUM(active_sessions) AS day_active_sessions,
              SUM(total_energy_wh::numeric) AS day_total_energy_wh,
              SUM(day_energy_wh::numeric) AS day_day_energy_wh,
              SUM(total_sessions) AS day_total_sessions,
              SUM(day_sessions) AS day_day_sessions,
              SUM(connected_stations) AS day_connected_stations,
              SUM(total_revenue_cents) AS day_total_revenue_cents,
              SUM(day_revenue_cents) AS day_day_revenue_cents,
              SUM(total_transactions) AS day_total_transactions,
              SUM(day_transactions) AS day_day_transactions,
              SUM(total_ports) AS day_total_ports,
              SUM(stations_below_threshold) AS day_stations_below,
              AVG(avg_ping_latency_ms::numeric) AS day_avg_ping_latency_ms,
              CASE WHEN SUM(total_stations) > 0
                THEN SUM(ping_success_rate::numeric * total_stations) / SUM(total_stations)
                ELSE 100
              END AS day_ping_success_rate
            FROM dashboard_snapshots
            WHERE ${dateFilter} ${siteFilter}
            GROUP BY snapshot_date
          ) per_day
        `
        : sql`
          SELECT
            COALESCE(SUM(total_stations), 0) AS total_stations,
            COALESCE(SUM(online_stations), 0) AS online_stations,
            CASE WHEN SUM(total_stations) > 0
              THEN SUM(online_percent::numeric * total_stations) / SUM(total_stations)
              ELSE 0
            END AS online_percent,
            CASE WHEN SUM(total_stations) > 0
              THEN SUM(uptime_percent::numeric * total_stations) / SUM(total_stations)
              ELSE 100
            END AS uptime_percent,
            COALESCE(SUM(active_sessions), 0) AS active_sessions,
            COALESCE(SUM(total_energy_wh::numeric), 0) AS total_energy_wh,
            COALESCE(SUM(day_energy_wh::numeric), 0) AS day_energy_wh,
            COALESCE(SUM(total_sessions), 0) AS total_sessions,
            COALESCE(SUM(day_sessions), 0) AS day_sessions,
            COALESCE(SUM(connected_stations), 0) AS connected_stations,
            COALESCE(SUM(total_revenue_cents), 0) AS total_revenue_cents,
            COALESCE(SUM(day_revenue_cents), 0) AS day_revenue_cents,
            CASE WHEN SUM(total_sessions) > 0
              THEN SUM(total_revenue_cents) / SUM(total_sessions)
              ELSE 0
            END AS avg_revenue_cents_per_session,
            COALESCE(SUM(total_transactions), 0) AS total_transactions,
            COALESCE(SUM(day_transactions), 0) AS day_transactions,
            COALESCE(SUM(total_ports), 0) AS total_ports,
            COALESCE(SUM(stations_below_threshold), 0) AS stations_below_threshold,
            COALESCE(AVG(avg_ping_latency_ms::numeric), 0) AS avg_ping_latency_ms,
            CASE WHEN SUM(total_stations) > 0
              THEN SUM(ping_success_rate::numeric * total_stations) / SUM(total_stations)
              ELSE 100
            END AS ping_success_rate
          FROM dashboard_snapshots
          WHERE ${dateFilter} ${siteFilter}
        `;

      const rows = await db.execute(queryText);

      const row = rows[0] as Record<string, string> | undefined;
      if (row == null) return emptySnapshot;

      return {
        totalStations: Math.round(Number(row.total_stations)),
        onlineStations: Math.round(Number(row.online_stations)),
        onlinePercent: Math.round(Number(row.online_percent) * 10) / 10,
        uptimePercent: Math.round(Number(row.uptime_percent) * 100) / 100,
        activeSessions: Math.round(Number(row.active_sessions)),
        totalEnergyWh: Math.round(Number(row.total_energy_wh)),
        dayEnergyWh: Math.round(Number(row.day_energy_wh)),
        totalSessions: Math.round(Number(row.total_sessions)),
        daySessions: Math.round(Number(row.day_sessions)),
        connectedStations: Math.round(Number(row.connected_stations)),
        totalRevenueCents: Math.round(Number(row.total_revenue_cents)),
        dayRevenueCents: Math.round(Number(row.day_revenue_cents)),
        avgRevenueCentsPerSession: Math.round(Number(row.avg_revenue_cents_per_session)),
        totalTransactions: Math.round(Number(row.total_transactions)),
        dayTransactions: Math.round(Number(row.day_transactions)),
        totalPorts: Math.round(Number(row.total_ports)),
        stationsBelowThreshold: Math.round(Number(row.stations_below_threshold)),
        avgPingLatencyMs: Math.round(Number(row.avg_ping_latency_ms) * 100) / 100,
        pingSuccessRate: Math.round(Number(row.ping_success_rate) * 10) / 10,
      };
    },
  );

  // --- Carbon stats ---

  const carbonStatsResponse = z
    .object({
      totalCo2AvoidedKg: z.number(),
      sessionCount: z.number(),
      avgCo2AvoidedKgPerSession: z.number(),
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
        response: { 200: itemResponse(carbonStatsResponse) },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request) => {
      const { userId } = request.user as JwtPayload;
      const siteIds = await getUserSiteIds(userId);
      const { from: fromDate, to: toDate } = request.query as z.infer<typeof carbonStatsQuery>;

      const empty = { totalCo2AvoidedKg: 0, sessionCount: 0, avgCo2AvoidedKgPerSession: 0 };
      if (siteIds != null && siteIds.length === 0) return empty;

      const conditions = [
        eq(chargingSessions.status, 'completed'),
        sql`${chargingSessions.co2AvoidedKg} IS NOT NULL`,
      ];
      if (fromDate != null) conditions.push(gte(chargingSessions.endedAt, new Date(fromDate)));
      if (toDate != null)
        conditions.push(lte(chargingSessions.endedAt, new Date(`${toDate}T23:59:59.999Z`)));

      const query = db
        .select({
          totalCo2: sql<number>`coalesce(sum(${chargingSessions.co2AvoidedKg}::numeric), 0)`,
          sessionCount: sql<number>`count(*)`,
          avgCo2: sql<number>`coalesce(avg(${chargingSessions.co2AvoidedKg}::numeric), 0)`,
        })
        .from(chargingSessions);

      if (siteIds != null) {
        query
          .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
          .where(and(...conditions, inArray(chargingStations.siteId, siteIds)));
      } else {
        query.where(and(...conditions));
      }

      const [stats] = await query;

      return {
        totalCo2AvoidedKg: Math.round((stats?.totalCo2 ?? 0) * 100) / 100,
        sessionCount: stats?.sessionCount ?? 0,
        avgCo2AvoidedKgPerSession: Math.round((stats?.avgCo2 ?? 0) * 100) / 100,
      };
    },
  );
}
