// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db, operatorStationSql } from '@evtivity/database';
import { DASHBOARD_SITE_ID_MAX_LENGTH } from '@evtivity/lib/dashboard-layout';
import {
  SECURITY_SEVERITIES,
  isSecuritySeverity,
  type SecuritySeverity,
} from '@evtivity/lib/security-severity';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { zodSchema } from '../lib/zod-schema.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { securityEventWindows } from '../lib/security-event-scope.js';
import type { JwtPayload } from '../plugins/auth.js';
import { authorize } from '../middleware/rbac.js';
import { DASHBOARD_RATE_LIMIT } from '../lib/dashboard-rate-limit.js';

/** The most station rows the card lists. */
export const SECURITY_EVENTS_STATION_LIMIT = 50;

export const SECURITY_EVENT_RANGES = ['24h', '7d', '30d'] as const;
export type SecurityEventRange = (typeof SECURITY_EVENT_RANGES)[number];

const RANGE_MS: Record<SecurityEventRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const query = z.object({
  range: z
    .enum(SECURITY_EVENT_RANGES)
    .default('7d')
    .describe('Events received in the last 24 hours, 7 days (default) or 30 days'),
  siteId: z
    .string()
    .min(1)
    .max(DASHBOARD_SITE_ID_MAX_LENGTH)
    .optional()
    .describe('Only stations of this site; a site outside the caller scope answers 404'),
  severity: z
    .enum(SECURITY_SEVERITIES)
    .optional()
    .describe(
      'Only stations with events of this severity in the station list; counts always cover every severity',
    ),
});

const severityCounts = z
  .object({
    critical: z.number().int().min(0).describe('Critical events'),
    high: z.number().int().min(0).describe('High events'),
    medium: z.number().int().min(0).describe('Medium events'),
    low: z.number().int().min(0).describe('Low events'),
    info: z.number().int().min(0).describe('Info events'),
  })
  .loose()
  .describe('Events per severity');

const stationRow = z
  .object({
    id: z.string().describe('Station record ID'),
    stationId: z.string().describe('OCPP station ID'),
    siteId: z.string().nullable().describe('Site ID, null for a station without a site'),
    siteName: z.string().nullable().describe('Site name, null for a station without a site'),
    worstSeverity: z.enum(SECURITY_SEVERITIES).describe('The worst severity of its events'),
    counts: severityCounts,
    total: z
      .number()
      .int()
      .min(0)
      .describe('Events of the station; only the filtered severity when severity is set'),
    lastEventAt: z.iso.datetime().describe('Receipt time of its newest event'),
  })
  .loose();

const response = z
  .object({
    range: z.enum(SECURITY_EVENT_RANGES).describe('The range of the reply'),
    since: z.iso.datetime().describe('Start of the range (receipt time)'),
    counts: severityCounts,
    total: z.number().int().min(0).describe('Events in the range, every severity'),
    stations: z
      .array(stationRow)
      .describe(
        `Stations with events, worst severity first, then most events, newest event and station ID; at most ${String(SECURITY_EVENTS_STATION_LIMIT)}`,
      ),
    stationTotal: z.number().int().min(0).describe('Stations that match before the list limit'),
  })
  .loose();

type Counts = Record<SecuritySeverity, number>;

function emptyCounts(): Counts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

/** SQL: the rank of a severity column, 0 the worst (the order of SECURITY_SEVERITIES). */
function rankSql(column: string): SQL {
  const cases = SECURITY_SEVERITIES.map((s, i) => `WHEN '${s}' THEN ${String(i)}`).join(' ');
  return sql.raw(`CASE ${column} ${cases} ELSE ${String(SECURITY_SEVERITIES.length - 1)} END`);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function dashboardSecurityEventsRoutes(app: FastifyInstance): void {
  app.get(
    '/dashboard/security-events',
    {
      onRequest: [authorize('securityEvents:read')],
      schema: {
        tags: ['Dashboard'],
        summary: 'Get station security events by severity and by station',
        description:
          'OCPP station security events of the caller stations received in the range, by severity and by station. Site-restricted callers see a moved station only from its time at their site.',
        operationId: 'getDashboardSecurityEvents',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(query),
        response: {
          200: itemResponse(response),
          400: errorWith('Validation error', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
      config: DASHBOARD_RATE_LIMIT,
    },
    async (request, reply) => {
      const { userId } = request.user as JwtPayload;
      const { range, siteId, severity } = request.query as z.infer<typeof query>;
      const since = new Date(Date.now() - RANGE_MS[range]);
      const empty = {
        range,
        since: since.toISOString(),
        counts: emptyCounts(),
        total: 0,
        stations: [],
        stationTotal: 0,
      };

      const siteIds = await getUserSiteIds(userId);
      if (siteId != null) {
        // A site outside the scope answers like an unknown one.
        const known =
          siteIds == null
            ? ((await db.execute(sql`SELECT 1 FROM sites WHERE id = ${siteId}`)) as unknown[])
                .length > 0
            : siteIds.includes(siteId);
        if (!known) {
          return reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        }
      }
      if (siteIds != null && siteIds.length === 0) return empty;

      // The events the caller may read: by receipt time (created_at), never the
      // station-reported timestamp (security case 284).
      let events: SQL;
      if (siteIds == null) {
        events = sql`
          SELECT e.station_id, e.severity, e.created_at FROM security_events e
          JOIN charging_stations s ON s.id = e.station_id
          WHERE e.created_at >= ${since.toISOString()}::timestamptz AND ${sql.raw(operatorStationSql('s'))}
            ${siteId != null ? sql`AND s.site_id = ${siteId}` : sql``}`;
      } else {
        const windows = await securityEventWindows(siteIds, since, siteId);
        if (windows.length === 0) return empty;
        const values = sql.join(
          windows.map((w) => sql`(${w.id}, ${w.since.toISOString()}::timestamptz)`),
          sql`, `,
        );
        events = sql`
          SELECT e.station_id, e.severity, e.created_at FROM security_events e
          JOIN (VALUES ${values}) AS w(id, since) ON w.id = e.station_id
          WHERE e.created_at >= w.since`;
      }

      const countRows = (await db.execute(sql`
        WITH ev AS (${events})
        SELECT severity, count(*)::int AS n FROM ev GROUP BY severity
      `)) as unknown as Array<{ severity: string; n: number }>;
      const counts = emptyCounts();
      for (const row of countRows) {
        counts[isSecuritySeverity(row.severity) ? row.severity : 'info'] += row.n;
      }
      const total = SECURITY_SEVERITIES.reduce((sum, s) => sum + counts[s], 0);

      const perSeverity = sql.raw(
        SECURITY_SEVERITIES.map(
          (s) => `count(*) FILTER (WHERE ev.severity = '${s}')::int AS "${s}"`,
        ).join(', '),
      );
      const stationTotalSql =
        severity != null
          ? sql`count(*) FILTER (WHERE ev.severity = ${severity})::int`
          : sql`count(*)::int`;
      const stationRows = (await db.execute(sql`
        WITH ev AS (${events})
        SELECT ev.station_id AS id, s.station_id AS ocpp_id, s.site_id, si.name AS site_name,
          ${perSeverity},
          min(${rankSql('ev.severity')}) AS worst_rank,
          ${stationTotalSql} AS total,
          max(ev.created_at) AS last_event_at,
          count(*) OVER ()::int AS station_total
        FROM ev
        JOIN charging_stations s ON s.id = ev.station_id
        LEFT JOIN sites si ON si.id = s.site_id
        GROUP BY ev.station_id, s.station_id, s.site_id, si.name
        ${severity != null ? sql`HAVING count(*) FILTER (WHERE ev.severity = ${severity}) > 0` : sql``}
        ORDER BY worst_rank ASC, total DESC, last_event_at DESC, s.station_id ASC
        LIMIT ${SECURITY_EVENTS_STATION_LIMIT}
      `)) as unknown as Array<
        Record<SecuritySeverity, number> & {
          id: string;
          ocpp_id: string;
          site_id: string | null;
          site_name: string | null;
          worst_rank: number;
          total: number;
          last_event_at: unknown;
          station_total: number;
        }
      >;

      return {
        range,
        since: since.toISOString(),
        counts,
        total,
        stations: stationRows.map((row) => ({
          id: row.id,
          stationId: row.ocpp_id,
          siteId: row.site_id,
          siteName: row.site_name,
          worstSeverity:
            SECURITY_SEVERITIES[row.worst_rank] ??
            SECURITY_SEVERITIES[SECURITY_SEVERITIES.length - 1],
          counts: {
            critical: row.critical,
            high: row.high,
            medium: row.medium,
            low: row.low,
            info: row.info,
          },
          total: row.total,
          lastEventAt: toIso(row.last_event_at),
        })),
        stationTotal: stationRows[0]?.station_total ?? 0,
      };
    },
  );
}
