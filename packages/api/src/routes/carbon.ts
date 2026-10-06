// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, asc } from 'drizzle-orm';
import { db, carbonIntensityFactors } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { arrayResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { buildCsv } from '@evtivity/lib';

const carbonFactorItem = z
  .object({
    id: z.number().int().min(1).describe('Identifier'),
    regionCode: z
      .string()
      .max(20)
      .describe('Carbon intensity region code (e.g., EPA eGRID subregion)'),
    regionName: z.string().max(255).describe('Human-readable region name'),
    countryCode: z.string().length(2).describe('ISO 3166-1 alpha-2 country code'),
    carbonIntensityKgPerKwh: z.string().describe('Grid carbon intensity in kg CO2 per kWh'),
    source: z.string().max(255).describe('Data source (e.g., EPA eGRID, Ember)'),
    updatedAt: z.string().describe('Timestamp when the factor was last updated'),
  })
  .passthrough();

const reportMonthlySummary = z
  .object({
    month: z.string().describe('Month in YYYY-MM format'),
    co2AvoidedKg: z.number().describe('CO2 avoided this month, in kilograms'),
    energyWh: z.number().min(0).describe('Energy delivered this month, in watt-hours'),
    sessionCount: z.number().int().min(0).describe('Number of completed sessions this month'),
  })
  .passthrough();

const reportSiteBreakdown = z
  .object({
    siteId: z.string().describe('Site identifier'),
    siteName: z.string().max(255).describe('Site display name'),
    co2AvoidedKg: z.number().describe('CO2 avoided at this site, in kilograms'),
    energyWh: z.number().min(0).describe('Energy delivered at this site, in watt-hours'),
    sessionCount: z.number().int().min(0).describe('Number of completed sessions at this site'),
  })
  .passthrough();

const reportResponse = z
  .object({
    monthlySummary: z
      .array(reportMonthlySummary)
      .describe('Per-month aggregates over the reporting window'),
    siteBreakdown: z
      .array(reportSiteBreakdown)
      .describe('Per-site aggregates over the reporting window'),
    cumulativeTotal: z
      .object({
        co2AvoidedKg: z
          .number()
          .describe('Total CO2 avoided across the reporting window, in kilograms'),
        energyWh: z.number().min(0).describe('Total energy delivered, in watt-hours'),
        sessionCount: z.number().int().min(0).describe('Total number of completed sessions'),
        treesEquivalent: z
          .number()
          .min(0)
          .describe('Equivalent number of trees absorbing the CO2 for one year (EPA estimate)'),
      })
      .passthrough()
      .describe('Cumulative totals across the reporting window'),
  })
  .passthrough();

const countryQuery = z.object({
  country: z.string().length(2).optional().describe('Filter by ISO 3166-1 country code'),
});

const regionCodeParams = z.object({
  regionCode: z.string().max(20).describe('Carbon intensity region code'),
});

const reportQuery = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Start date (YYYY-MM-DD)'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('End date (YYYY-MM-DD)'),
  siteId: z.string().optional().describe('Filter to a specific site'),
});

const TREES_KG_CO2_PER_YEAR = 21.77;

// Shared WHERE-clause builder for the carbon report + CSV export. Both
// endpoints aggregate against the same predicate set against
// charging_sessions cs / charging_stations st, so duplicating the fragment
// list would let the two drift apart silently.
function buildCarbonWhereClause(opts: {
  from?: string | undefined;
  to?: string | undefined;
  siteId?: string | undefined;
  userSiteIds: string[] | null;
}): ReturnType<typeof sql.join> {
  const fragments = [sql`cs.status = 'completed' AND cs.co2_avoided_kg IS NOT NULL`];
  if (opts.from != null) {
    fragments.push(sql`cs.ended_at >= ${opts.from}::timestamptz`);
  }
  if (opts.to != null) {
    fragments.push(sql`cs.ended_at <= ${`${opts.to}T23:59:59.999Z`}::timestamptz`);
  }
  if (opts.siteId != null) {
    fragments.push(sql`st.site_id = ${opts.siteId}`);
  }
  if (opts.userSiteIds != null) {
    fragments.push(
      sql`st.site_id IN (${sql.join(
        opts.userSiteIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
  return sql.join(fragments, sql` AND `);
}

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
        response: {
          200: itemResponse(carbonFactorItem),
          404: errorWith('Region not found', [ERROR_CODES.REGION_NOT_FOUND]),
        },
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
        response: {
          200: itemResponse(reportResponse),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
    },
    async (request, reply) => {
      const { from, to, siteId } = request.query as z.infer<typeof reportQuery>;
      // from > to silently returns empty rows from the SQL aggregation,
      // which looks identical to "no carbon data exists" in the UI. Surface
      // the swapped input as a 400 so the operator sees the cause. (Cannot
      // use Zod .refine() here because zod-to-json-schema strips refines
      // when converting to the JSON Schema Fastify actually validates.)
      if (from != null && to != null && from > to) {
        await reply.status(400).send({
          error: '"from" date must be on or before "to" date',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      const user = request.user as { userId: string };
      const userSiteIds = await getUserSiteIds(user.userId);

      if (userSiteIds != null && userSiteIds.length === 0) {
        return {
          monthlySummary: [],
          siteBreakdown: [],
          cumulativeTotal: { co2AvoidedKg: 0, energyWh: 0, sessionCount: 0, treesEquivalent: 0 },
        };
      }

      // Parameterized fragments via buildCarbonWhereClause prevent the
      // SQL injection that the prior sql.raw() string-interpolation
      // approach was vulnerable to (siteId is a bare z.string() with no
      // format check at the body layer).
      const whereClause = buildCarbonWhereClause({ from, to, siteId, userSiteIds });

      // Monthly summary and site breakdown share the WHERE clause but
      // are independent aggregations - fetch in parallel to halve the
      // wall-clock on the report page.
      const [monthlyRows, siteRows] = await Promise.all([
        db.execute(sql`
          SELECT to_char(cs.ended_at, 'YYYY-MM') AS month,
                 COALESCE(SUM(cs.co2_avoided_kg::numeric), 0) AS co2_avoided_kg,
                 COALESCE(SUM(cs.energy_delivered_wh::numeric), 0) AS energy_wh,
                 COUNT(*)::int AS session_count
          FROM charging_sessions cs
          JOIN charging_stations st ON st.id = cs.station_id
          WHERE ${whereClause}
          GROUP BY to_char(cs.ended_at, 'YYYY-MM')
          ORDER BY month
        `),
        db.execute(sql`
          SELECT st.site_id, s.name AS site_name,
                 COALESCE(SUM(cs.co2_avoided_kg::numeric), 0) AS co2_avoided_kg,
                 COALESCE(SUM(cs.energy_delivered_wh::numeric), 0) AS energy_wh,
                 COUNT(*)::int AS session_count
          FROM charging_sessions cs
          JOIN charging_stations st ON st.id = cs.station_id
          JOIN sites s ON s.id = st.site_id
          WHERE ${whereClause}
          GROUP BY st.site_id, s.name
          ORDER BY co2_avoided_kg DESC
        `),
      ]);

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
        return buildCsv(['Month', 'Site', 'CO₂ Avoided (kg)', 'Energy (kWh)', 'Sessions'], []);
      }

      // Aggregate in SQL instead of pulling every session into JS. A
      // multi-year export could otherwise transfer 100k+ rows and hold
      // them all in API memory just to group by (month, site).
      const whereClause = buildCarbonWhereClause({ from, to, siteId, userSiteIds });

      const groupedRows = await db.execute(sql`
        SELECT to_char(cs.ended_at, 'YYYY-MM') AS month,
               s.name AS site_name,
               COALESCE(SUM(cs.co2_avoided_kg::numeric), 0) AS co2_kg,
               COALESCE(SUM(cs.energy_delivered_wh::numeric), 0) AS energy_wh,
               COUNT(*)::int AS session_count
        FROM charging_sessions cs
        JOIN charging_stations st ON st.id = cs.station_id
        JOIN sites s ON s.id = st.site_id
        WHERE ${whereClause}
        GROUP BY month, s.name
        ORDER BY month, s.name
      `);

      // Use the shared buildCsv helper so formula-trigger characters at
      // the start of a site name (=, +, -, @, tab, CR) get prefixed with
      // a single quote. Without this, a malicious site name like
      // "=cmd|'/c calc'!A0" executes when an operator opens the export
      // in Excel/Sheets.
      const rowsForCsv: unknown[][] = (groupedRows as unknown as Record<string, unknown>[]).map(
        (r) => [
          r.month as string,
          r.site_name as string,
          Number(r.co2_kg).toFixed(2),
          (Number(r.energy_wh) / 1000).toFixed(2),
          Number(r.session_count),
        ],
      );

      void reply.header('Content-Type', 'text/csv');
      void reply.header('Content-Disposition', 'attachment; filename="sustainability-report.csv"');
      return buildCsv(
        ['Month', 'Site', 'CO₂ Avoided (kg)', 'Energy (kWh)', 'Sessions'],
        rowsForCsv,
      );
    },
  );
}
