// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, gte, lte, asc, desc, inArray } from 'drizzle-orm';
import {
  db,
  carbonIntensityFactors,
  chargingSessions,
  chargingStations,
  sites,
} from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { errorResponse, arrayResponse, itemResponse } from '../lib/response-schemas.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';

const carbonFactorItem = z
  .object({
    id: z.number(),
    regionCode: z.string(),
    regionName: z.string(),
    countryCode: z.string(),
    carbonIntensityKgPerKwh: z.string(),
    source: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const reportMonthlySummary = z
  .object({
    month: z.string(),
    co2AvoidedKg: z.number(),
    energyWh: z.number(),
    sessionCount: z.number(),
  })
  .passthrough();

const reportSiteBreakdown = z
  .object({
    siteId: z.string(),
    siteName: z.string(),
    co2AvoidedKg: z.number(),
    energyWh: z.number(),
    sessionCount: z.number(),
  })
  .passthrough();

const reportResponse = z
  .object({
    monthlySummary: z.array(reportMonthlySummary),
    siteBreakdown: z.array(reportSiteBreakdown),
    cumulativeTotal: z
      .object({
        co2AvoidedKg: z.number(),
        energyWh: z.number(),
        sessionCount: z.number(),
        treesEquivalent: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

const countryQuery = z.object({
  country: z.string().optional().describe('Filter by ISO 3166-1 country code'),
});

const regionCodeParams = z.object({
  regionCode: z.string().describe('Carbon intensity region code'),
});

const reportQuery = z.object({
  from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
  to: z.string().optional().describe('End date (YYYY-MM-DD)'),
  siteId: z.string().optional().describe('Filter to a specific site'),
});

const TREES_KG_CO2_PER_YEAR = 21.77;

export function carbonRoutes(app: FastifyInstance): void {
  // GET /carbon/factors - list all carbon intensity factors
  app.get(
    '/carbon/factors',
    {
      onRequest: [authorize('sustainability:read')],
      schema: {
        tags: ['Settings'],
        summary: 'List carbon intensity factors',
        operationId: 'listCarbonFactors',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(countryQuery),
        response: { 200: arrayResponse(carbonFactorItem) },
      },
    },
    async (request) => {
      const { country } = request.query as z.infer<typeof countryQuery>;
      const conditions = [];
      if (country != null && country !== '') {
        conditions.push(eq(carbonIntensityFactors.countryCode, country));
      }
      const rows = await db
        .select()
        .from(carbonIntensityFactors)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(carbonIntensityFactors.countryCode), asc(carbonIntensityFactors.regionName));
      return rows;
    },
  );

  // GET /carbon/factors/:regionCode - single factor by region code
  app.get(
    '/carbon/factors/:regionCode',
    {
      onRequest: [authorize('sustainability:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get a carbon intensity factor by region code',
        operationId: 'getCarbonFactor',
        security: [{ bearerAuth: [] }],
        params: zodSchema(regionCodeParams),
        response: { 200: itemResponse(carbonFactorItem), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { regionCode } = request.params as z.infer<typeof regionCodeParams>;
      const [row] = await db
        .select()
        .from(carbonIntensityFactors)
        .where(eq(carbonIntensityFactors.regionCode, regionCode))
        .limit(1);
      if (row == null) {
        await reply.status(404).send({ error: 'Region not found', code: 'REGION_NOT_FOUND' });
        return;
      }
      return row;
    },
  );

  // GET /carbon/report - sustainability report
  app.get(
    '/carbon/report',
    {
      onRequest: [authorize('sessions:read')],
      schema: {
        tags: ['Reports'],
        summary: 'Get sustainability report with monthly and site breakdowns',
        operationId: 'getCarbonReport',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(reportQuery),
        response: { 200: itemResponse(reportResponse) },
      },
    },
    async (request) => {
      const { from, to, siteId } = request.query as z.infer<typeof reportQuery>;
      const user = request.user as { userId: string };
      const userSiteIds = await getUserSiteIds(user.userId);

      const dateConditions: string[] = [];
      if (from != null) {
        dateConditions.push(`cs.ended_at >= '${from}'::timestamptz`);
      }
      if (to != null) {
        dateConditions.push(`cs.ended_at <= '${to}T23:59:59.999Z'::timestamptz`);
      }
      if (siteId != null) {
        dateConditions.push(`st.site_id = '${siteId}'`);
      }
      if (userSiteIds != null && userSiteIds.length > 0) {
        const ids = userSiteIds.map((id) => `'${id}'`).join(',');
        dateConditions.push(`st.site_id IN (${ids})`);
      } else if (userSiteIds != null && userSiteIds.length === 0) {
        return {
          monthlySummary: [],
          siteBreakdown: [],
          cumulativeTotal: { co2AvoidedKg: 0, energyWh: 0, sessionCount: 0, treesEquivalent: 0 },
        };
      }

      const whereClause = dateConditions.length > 0 ? `AND ${dateConditions.join(' AND ')}` : '';

      const monthlyRows = await db.execute(
        sql.raw(`
          SELECT to_char(cs.ended_at, 'YYYY-MM') AS month,
                 COALESCE(SUM(cs.co2_avoided_kg::numeric), 0) AS co2_avoided_kg,
                 COALESCE(SUM(cs.energy_delivered_wh::numeric), 0) AS energy_wh,
                 COUNT(*)::int AS session_count
          FROM charging_sessions cs
          JOIN charging_stations st ON st.id = cs.station_id
          WHERE cs.status = 'completed' AND cs.co2_avoided_kg IS NOT NULL ${whereClause}
          GROUP BY to_char(cs.ended_at, 'YYYY-MM')
          ORDER BY month
        `),
      );

      const siteRows = await db.execute(
        sql.raw(`
          SELECT st.site_id, s.name AS site_name,
                 COALESCE(SUM(cs.co2_avoided_kg::numeric), 0) AS co2_avoided_kg,
                 COALESCE(SUM(cs.energy_delivered_wh::numeric), 0) AS energy_wh,
                 COUNT(*)::int AS session_count
          FROM charging_sessions cs
          JOIN charging_stations st ON st.id = cs.station_id
          JOIN sites s ON s.id = st.site_id
          WHERE cs.status = 'completed' AND cs.co2_avoided_kg IS NOT NULL ${whereClause}
          GROUP BY st.site_id, s.name
          ORDER BY co2_avoided_kg DESC
        `),
      );

      const monthlySummary = (monthlyRows as unknown as Record<string, unknown>[]).map((r) => ({
        month: r.month as string,
        co2AvoidedKg: Number(r.co2_avoided_kg),
        energyWh: Number(r.energy_wh),
        sessionCount: Number(r.session_count),
      }));

      const siteBreakdown = (siteRows as unknown as Record<string, unknown>[]).map((r) => ({
        siteId: r.site_id as string,
        siteName: r.site_name as string,
        co2AvoidedKg: Number(r.co2_avoided_kg),
        energyWh: Number(r.energy_wh),
        sessionCount: Number(r.session_count),
      }));

      const totalCo2 = monthlySummary.reduce((sum, m) => sum + m.co2AvoidedKg, 0);
      const totalEnergy = monthlySummary.reduce((sum, m) => sum + m.energyWh, 0);
      const totalSessions = monthlySummary.reduce((sum, m) => sum + m.sessionCount, 0);

      return {
        monthlySummary,
        siteBreakdown,
        cumulativeTotal: {
          co2AvoidedKg: Math.round(totalCo2 * 100) / 100,
          energyWh: totalEnergy,
          sessionCount: totalSessions,
          treesEquivalent: Math.round((totalCo2 / TREES_KG_CO2_PER_YEAR) * 10) / 10,
        },
      };
    },
  );

  // GET /carbon/report/export - CSV export
  app.get(
    '/carbon/report/export',
    {
      onRequest: [authorize('sessions:read')],
      schema: {
        tags: ['Reports'],
        summary: 'Export sustainability report as CSV',
        operationId: 'exportCarbonReport',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(reportQuery),
      },
    },
    async (request, reply) => {
      const { from, to, siteId } = request.query as z.infer<typeof reportQuery>;
      const user = request.user as { userId: string };
      const userSiteIds = await getUserSiteIds(user.userId);

      if (userSiteIds != null && userSiteIds.length === 0) {
        void reply.header('Content-Type', 'text/csv');
        void reply.header(
          'Content-Disposition',
          'attachment; filename="sustainability-report.csv"',
        );
        return 'Month,Site,CO2 Avoided (kg),Energy (kWh),Sessions';
      }

      const conditions = [eq(chargingSessions.status, 'completed')];
      if (from != null) conditions.push(gte(chargingSessions.endedAt, new Date(from)));
      if (to != null)
        conditions.push(lte(chargingSessions.endedAt, new Date(`${to}T23:59:59.999Z`)));
      if (siteId != null) conditions.push(eq(chargingStations.siteId, siteId));
      if (userSiteIds != null) conditions.push(inArray(chargingStations.siteId, userSiteIds));

      const rows = await db
        .select({
          endedAt: chargingSessions.endedAt,
          siteName: sites.name,
          co2AvoidedKg: chargingSessions.co2AvoidedKg,
          energyWh: chargingSessions.energyDeliveredWh,
        })
        .from(chargingSessions)
        .innerJoin(chargingStations, eq(chargingStations.id, chargingSessions.stationId))
        .innerJoin(sites, eq(sites.id, chargingStations.siteId))
        .where(and(...conditions))
        .orderBy(desc(chargingSessions.endedAt));

      const filtered = rows.filter((r) => r.co2AvoidedKg != null);

      const csvLines = ['Month,Site,CO2 Avoided (kg),Energy (kWh),Sessions'];
      const grouped = new Map<string, { co2: number; energy: number; count: number }>();
      for (const row of filtered) {
        const month =
          row.endedAt != null ? new Date(row.endedAt).toISOString().slice(0, 7) : 'unknown';
        const site = row.siteName;
        const key = `${month}|${site}`;
        const existing = grouped.get(key) ?? { co2: 0, energy: 0, count: 0 };
        existing.co2 += Number(row.co2AvoidedKg ?? 0);
        existing.energy += Number(row.energyWh ?? 0);
        existing.count += 1;
        grouped.set(key, existing);
      }

      for (const [key, data] of grouped) {
        const [month, site] = key.split('|');
        csvLines.push(
          `${month ?? ''},"${site ?? ''}",${data.co2.toFixed(2)},${(data.energy / 1000).toFixed(2)},${String(data.count)}`,
        );
      }

      void reply.header('Content-Type', 'text/csv');
      void reply.header('Content-Disposition', 'attachment; filename="sustainability-report.csv"');
      return csvLines.join('\n');
    },
  );
}
