// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, desc, count, sql } from 'drizzle-orm';
import {
  db,
  reports,
  reportSchedules,
  reportStatusEnum,
  reportFrequencyEnum,
  chargingStations,
} from '@evtivity/database';

// The worker generates the report; the API only announces it.
async function announceReport(reportId: string): Promise<void> {
  await getPubSub().publish(REPORT_GENERATE_CHANNEL, JSON.stringify({ reportId }));
}

// A report whose filters cannot produce it is refused now, not failed later in the job.
function assertReportFilters(reportType: string, filters: Record<string, unknown>): void {
  const error = reportFiltersError(reportType, filters);
  if (error != null) throw new ValidationError(error);
}

interface NotFoundBody {
  error: string;
  code: 'SITE_NOT_FOUND' | 'STATION_NOT_FOUND';
}

/**
 * The 404 for a site or station filter outside `scope` (null: all sites), or
 * null when the filters fit. A restricted scope never covers an unsited
 * station, and a station filter must name an existing station.
 */
async function filterScopeError(
  filters: Record<string, unknown>,
  scope: ReportSiteScope,
): Promise<NotFoundBody | null> {
  const siteId = typeof filters['siteId'] === 'string' ? filters['siteId'] : null;
  if (siteId != null && !siteInScope(scope, siteId)) {
    return { error: 'Site not found', code: 'SITE_NOT_FOUND' };
  }
  const stationId = typeof filters['stationId'] === 'string' ? filters['stationId'] : null;
  if (stationId != null) {
    const [station] = await db
      .select({ siteId: chargingStations.siteId })
      .from(chargingStations)
      .where(eq(chargingStations.id, stationId));
    if (station == null || !siteInScope(scope, station.siteId)) {
      return { error: 'Station not found', code: 'STATION_NOT_FOUND' };
    }
  }
  return null;
}
import { zodSchema } from '../lib/zod-schema.js';
import {
  arrayResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import {
  queueReport,
  computeNextRunAtInTz,
  listReportTypes,
  reportFiltersError,
  REPORT_GENERATE_CHANNEL,
  REPORT_TYPES,
} from '@evtivity/services/report.service';
import { REPORT_FORMATS } from '@evtivity/services/report-registry';
import {
  intersectSiteScopes,
  siteScopeVisibleTo,
  type ReportSiteScope,
} from '@evtivity/services/report-scope';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { ValidationError } from '@evtivity/lib';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';
import { siteInScope } from '../lib/site-scope.js';

const reportTypeItem = z
  .object({
    type: z.string().describe('Report type identifier'),
    formats: z
      .array(z.enum(REPORT_FORMATS))
      .describe('File formats the report is written in; another requested format gets the first'),
    generateFromUi: z
      .boolean()
      .describe('Whether the dashboard Generate and Schedules tabs offer this type'),
  })
  .passthrough();

const reportItem = z
  .object({
    id: z.string().describe('Identifier'),
    name: z.string().describe('Display name for the report'),
    reportType: z.enum(REPORT_TYPES).describe('Report type'),
    status: z.enum(reportStatusEnum.enumValues).describe('Generation lifecycle status'),
    format: z.enum(REPORT_FORMATS).describe('Output file format'),
    fileName: z.string().nullable().describe('Generated file name when ready'),
    fileSize: z.number().nullable().describe('Generated file size in bytes'),
    error: z.string().nullable().describe('Error message when generation failed'),
    siteScope: z
      .array(z.string())
      .nullable()
      .describe(
        'Site IDs the report covers (null: all sites). Site-restricted users see only reports whose scope is within their sites',
      ),
    createdAt: z.coerce.date().describe('Timestamp when the report was queued'),
    completedAt: z.coerce.date().nullable().describe('Timestamp when generation finished'),
  })
  .passthrough();

const reportDetail = reportItem
  .extend({
    filters: z
      .record(z.unknown())
      .nullable()
      .describe('Filter criteria the report was generated with'),
    generatedById: z.string().nullable().describe('User ID that requested the report'),
  })
  .passthrough();

const reportQueuedResponse = z
  .object({
    id: z.string().describe('Identifier of the queued report'),
    status: z.string().describe('Initial status (typically "pending")'),
  })
  .passthrough();

const scheduleItem = z
  .object({
    id: z.string().describe('Identifier'),
    name: z.string().describe('Display name'),
    reportType: z.enum(REPORT_TYPES).describe('Report type to generate'),
    format: z.enum(REPORT_FORMATS).describe('Output file format'),
    frequency: z.enum(reportFrequencyEnum.enumValues).describe('How often the report runs'),
    dayOfWeek: z
      .number()
      .nullable()
      .describe('Day of week for weekly schedules (0=Sunday, 6=Saturday)'),
    dayOfMonth: z.number().nullable().describe('Day of month for monthly schedules (1-31)'),
    filters: z.record(z.unknown()).nullable().describe('Filter criteria applied each run'),
    recipientEmails: z
      .array(z.string())
      .describe('Email addresses that receive the generated report'),
    isEnabled: z.boolean().describe('Whether the schedule is active'),
    siteScope: z
      .array(z.string())
      .nullable()
      .describe(
        "Site IDs the scheduled reports cover (null: all sites), set from the creator's site access and never changed by an update. Site-restricted users see only schedules whose scope is within their sites",
      ),
    nextRunAt: z.coerce.date().nullable().describe('Timestamp of the next scheduled run'),
    createdAt: z.coerce.date().describe('Timestamp when created'),
    updatedAt: z.coerce.date().describe('Timestamp when last modified'),
  })
  .passthrough();

const generateBody = z.object({
  name: z.string().min(1).max(255),
  reportType: z.enum(REPORT_TYPES).describe('Report type identifier'),
  format: z.enum(REPORT_FORMATS).describe('Output file format'),
  filters: z.record(z.unknown()).optional().describe('Key-value filter criteria for the report'),
});

const reportListQuery = paginationQuery.extend({
  reportType: z.enum(REPORT_TYPES).optional().describe('Filter by report type'),
});

const createScheduleBody = z.object({
  name: z.string().min(1).max(255),
  reportType: z.enum(REPORT_TYPES).describe('Report type identifier'),
  format: z.enum(REPORT_FORMATS).describe('Output file format'),
  frequency: z.enum(reportFrequencyEnum.enumValues).describe('How often the report runs'),
  dayOfWeek: z
    .number()
    .int()
    .min(0)
    .max(6)
    .optional()
    .describe('Day of week for weekly schedules (0=Sunday, 6=Saturday)'),
  dayOfMonth: z
    .number()
    .int()
    .min(1)
    .max(31)
    .optional()
    .describe('Day of month for monthly schedules (1-31)'),
  filters: z.record(z.unknown()).optional().describe('Key-value filter criteria for the report'),
  recipientEmails: z
    .array(z.string().email())
    .max(50)
    .optional()
    .describe('Email addresses to receive the generated report'),
});

const updateScheduleBody = createScheduleBody.partial().extend({
  isEnabled: z.boolean().optional().describe('Whether the schedule is active'),
});

export function reportRoutes(app: FastifyInstance): void {
  // List reports
  app.get(
    '/reports',
    {
      onRequest: [authorize('reports:read')],
      schema: {
        tags: ['Reports'],
        summary: 'List reports',
        description:
          'Site-restricted users see only reports generated within their sites; all-site users see every report.',
        operationId: 'listReports',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(reportListQuery),
        response: { 200: paginatedResponse(reportItem) },
      },
    },
    async (request) => {
      const { page, limit, reportType } = request.query as z.infer<typeof reportListQuery>;
      const offset = (page - 1) * limit;
      const user = request.user as { userId: string };
      const userScope = await getUserSiteIds(user.userId);

      const conditions = [];
      if (reportType) {
        conditions.push(eq(reports.reportType, reportType));
      }
      const visible = siteScopeVisibleTo(reports.siteScope, userScope);
      if (visible != null) conditions.push(visible);
      const whereClause =
        conditions.length > 0 ? sql`${sql.join(conditions, sql` AND `)}` : undefined;

      const [dataResult, countResult] = await Promise.all([
        db
          .select({
            id: reports.id,
            name: reports.name,
            reportType: reports.reportType,
            status: reports.status,
            format: reports.format,
            fileName: reports.fileName,
            fileSize: reports.fileSize,
            error: reports.error,
            siteScope: reports.siteScope,
            createdAt: reports.createdAt,
            completedAt: reports.completedAt,
          })
          .from(reports)
          .where(whereClause)
          .orderBy(desc(reports.createdAt), desc(reports.id))
          .limit(limit)
          .offset(offset),
        db.select({ count: count() }).from(reports).where(whereClause),
      ]);

      return {
        data: dataResult,
        total: countResult[0]?.count ?? 0,
      } satisfies PaginatedResponse<(typeof dataResult)[number]>;
    },
  );

  app.get(
    '/reports/types',
    {
      onRequest: [authorize('reports:read')],
      schema: {
        tags: ['Reports'],
        summary: 'List report types',
        operationId: 'listReportTypes',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(reportTypeItem) },
      },
    },
    () => listReportTypes(),
  );

  // Get single report metadata
  app.get(
    '/reports/:id',
    {
      onRequest: [authorize('reports:read')],
      schema: {
        tags: ['Reports'],
        summary: 'Get a report by ID',
        description:
          "Returns 404 REPORT_NOT_FOUND for a report outside the site-restricted user's sites.",
        operationId: 'getReport',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(reportDetail),
          404: errorWith('Report not found', [ERROR_CODES.REPORT_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user as { userId: string };
      const userScope = await getUserSiteIds(user.userId);

      const [report] = await db
        .select({
          id: reports.id,
          name: reports.name,
          reportType: reports.reportType,
          status: reports.status,
          format: reports.format,
          filters: reports.filters,
          fileName: reports.fileName,
          fileSize: reports.fileSize,
          error: reports.error,
          siteScope: reports.siteScope,
          generatedById: reports.generatedById,
          createdAt: reports.createdAt,
          completedAt: reports.completedAt,
        })
        .from(reports)
        .where(and(eq(reports.id, id), siteScopeVisibleTo(reports.siteScope, userScope)));

      if (report == null) {
        await reply.status(404).send({ error: 'Report not found', code: 'REPORT_NOT_FOUND' });
        return;
      }

      return report;
    },
  );

  // Download report file
  app.get(
    '/reports/:id/download',
    {
      onRequest: [authorize('reports:read')],
      schema: {
        tags: ['Reports'],
        summary: 'Download a report file',
        description:
          "Returns 404 REPORT_NOT_FOUND for a report outside the site-restricted user's sites.",
        operationId: 'downloadReport',
        security: [{ bearerAuth: [] }],
        response: { 404: errorWith('Report not found', [ERROR_CODES.REPORT_NOT_FOUND]) },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user as { userId: string };
      const userScope = await getUserSiteIds(user.userId);

      const [report] = await db
        .select({
          fileData: reports.fileData,
          fileName: reports.fileName,
          format: reports.format,
        })
        .from(reports)
        .where(and(eq(reports.id, id), siteScopeVisibleTo(reports.siteScope, userScope)));

      if (report?.fileData == null) {
        await reply.status(404).send({ error: 'Report file not found', code: 'REPORT_NOT_FOUND' });
        return;
      }

      const contentTypes: Record<string, string> = {
        csv: 'text/csv',
        pdf: 'application/pdf',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };

      const contentType = contentTypes[report.format] ?? 'application/octet-stream';

      await reply
        .header('Content-Type', contentType)
        .header('Content-Disposition', `attachment; filename="${report.fileName ?? 'report'}"`)
        .send(report.fileData);
    },
  );

  // Generate report
  app.post(
    '/reports/generate',
    {
      onRequest: [authorize('reports:write')],
      schema: {
        tags: ['Reports'],
        summary: 'Queue a new report for generation',
        description:
          "The report covers the requesting user's sites (all sites for an all-site user). A site or station filter outside them returns 404.",
        operationId: 'generateReport',
        security: [{ bearerAuth: [] }],
        body: zodSchema(generateBody),
        response: {
          200: itemResponse(reportQueuedResponse),
          400: errorWith('Invalid report filters', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Site or station not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => {
            const user = request.user as { userId?: string } | undefined;
            return user?.userId ?? request.ip;
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof generateBody>;
      const user = request.user as { userId: string };

      // The report covers the operator's sites: the generator reads only
      // stations at them, and only users with those sites see the report. A
      // site or station filter outside them is refused as not found.
      const siteIds = await getUserSiteIds(user.userId);
      const filters = body.filters ?? {};
      assertReportFilters(body.reportType, filters);
      const scopeError = await filterScopeError(filters, siteIds);
      if (scopeError != null) {
        await reply.status(404).send(scopeError);
        return;
      }

      const reportId = await queueReport(
        {
          name: body.name,
          reportType: body.reportType,
          format: body.format,
          filters,
          userId: user.userId,
          siteScope: siteIds,
        },
        announceReport,
      );

      return { id: reportId, status: 'pending' };
    },
  );

  // Delete report
  app.delete(
    '/reports/:id',
    {
      onRequest: [authorize('reports:write')],
      schema: {
        tags: ['Reports'],
        summary: 'Delete a report',
        description:
          "Returns 404 REPORT_NOT_FOUND for a report outside the site-restricted user's sites.",
        operationId: 'deleteReport',
        security: [{ bearerAuth: [] }],
        response: {
          200: successResponse,
          404: errorWith('Report not found', [ERROR_CODES.REPORT_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user as { userId: string };
      const userScope = await getUserSiteIds(user.userId);

      const removed = await db
        .delete(reports)
        .where(and(eq(reports.id, id), siteScopeVisibleTo(reports.siteScope, userScope)))
        .returning({ id: reports.id });

      if (removed.length === 0) {
        await reply.status(404).send({ error: 'Report not found', code: 'REPORT_NOT_FOUND' });
        return;
      }

      return { success: true };
    },
  );

  // --- Report Schedules ---

  // List schedules
  app.get(
    '/report-schedules',
    {
      onRequest: [authorize('reports:read')],
      schema: {
        tags: ['Reports'],
        summary: 'List report schedules',
        description:
          'Site-restricted users see only schedules within their sites; all-site users see every schedule.',
        operationId: 'listReportSchedules',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(z.object({ data: z.array(scheduleItem) }).passthrough()) },
      },
    },
    async (request) => {
      const user = request.user as { userId: string };
      const userScope = await getUserSiteIds(user.userId);
      const rows = await db
        .select()
        .from(reportSchedules)
        .where(siteScopeVisibleTo(reportSchedules.siteScope, userScope))
        .orderBy(desc(reportSchedules.createdAt), desc(reportSchedules.id));
      return { data: rows };
    },
  );

  // Create schedule
  app.post(
    '/report-schedules',
    {
      onRequest: [authorize('reports:write')],
      schema: {
        tags: ['Reports'],
        summary: 'Create a report schedule',
        description:
          "The schedule's reports cover the creating user's sites (all sites for an all-site user), narrowed at each run to the creator's current sites. A site or station filter outside them returns 404.",
        operationId: 'createReportSchedule',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createScheduleBody),
        response: {
          200: itemResponse(scheduleItem),
          400: errorWith('Invalid report filters', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Site or station not found', [
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createScheduleBody>;
      const user = request.user as { userId: string };

      // Mirror the generate-report site-access guard so a restricted
      // operator can't pre-load a schedule with a cross-site filter that
      // the cron would later run on their behalf. The schedule keeps the
      // creator's sites as its scope.
      const siteIds = await getUserSiteIds(user.userId);
      const filters = body.filters ?? {};
      assertReportFilters(body.reportType, filters);
      const scopeError = await filterScopeError(filters, siteIds);
      if (scopeError != null) {
        await reply.status(404).send(scopeError);
        return;
      }

      const nextRunAt = await computeNextRunAtInTz(
        body.frequency,
        body.dayOfWeek ?? null,
        body.dayOfMonth ?? null,
      );

      const [row] = await db
        .insert(reportSchedules)
        .values({
          name: body.name,
          reportType: body.reportType,
          format: body.format,
          frequency: body.frequency,
          dayOfWeek: body.dayOfWeek ?? null,
          dayOfMonth: body.dayOfMonth ?? null,
          filters,
          recipientEmails: body.recipientEmails ?? [],
          createdById: user.userId,
          siteScope: siteIds,
          nextRunAt,
        })
        .returning();

      return row;
    },
  );

  // Update schedule
  app.patch(
    '/report-schedules/:id',
    {
      onRequest: [authorize('reports:write')],
      schema: {
        tags: ['Reports'],
        summary: 'Update a report schedule',
        description:
          "Returns 404 SCHEDULE_NOT_FOUND for a schedule outside the site-restricted user's sites. The schedule's site scope never changes. A site or station filter outside the schedule's and the user's sites returns 404.",
        operationId: 'updateReportSchedule',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateScheduleBody),
        response: {
          200: itemResponse(scheduleItem),
          400: errorWith('Invalid report filters', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Resource not found', [
            ERROR_CODES.SCHEDULE_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const body = request.body as z.infer<typeof updateScheduleBody>;
      const user = request.user as { userId: string };
      const userScope = await getUserSiteIds(user.userId);
      const visible = and(
        eq(reportSchedules.id, id),
        siteScopeVisibleTo(reportSchedules.siteScope, userScope),
      );

      const [existing] = await db
        .select({
          id: reportSchedules.id,
          reportType: reportSchedules.reportType,
          filters: reportSchedules.filters,
          siteScope: reportSchedules.siteScope,
        })
        .from(reportSchedules)
        .where(visible);

      if (existing == null) {
        await reply.status(404).send({ error: 'Schedule not found', code: 'SCHEDULE_NOT_FOUND' });
        return;
      }

      if (body.reportType != null || body.filters != null) {
        assertReportFilters(
          body.reportType ?? existing.reportType,
          body.filters ?? (existing.filters as Record<string, unknown> | null) ?? {},
        );
      }

      // Same site-access guard as create — without it a restricted
      // operator could PATCH a schedule's filters to point at a site they
      // can't access. The filters must fit both the schedule's scope and the
      // caller's sites; the scope itself is never changed here.
      if (body.filters != null) {
        const scopeError = await filterScopeError(
          body.filters,
          intersectSiteScopes(existing.siteScope, userScope),
        );
        if (scopeError != null) {
          await reply.status(404).send(scopeError);
          return;
        }
      }

      const updates: Record<string, unknown> = { updatedAt: sql`now()` };
      if (body.name != null) updates['name'] = body.name;
      if (body.reportType != null) updates['reportType'] = body.reportType;
      if (body.format != null) updates['format'] = body.format;
      if (body.frequency != null) updates['frequency'] = body.frequency;
      if (body.dayOfWeek !== undefined) updates['dayOfWeek'] = body.dayOfWeek ?? null;
      if (body.dayOfMonth !== undefined) updates['dayOfMonth'] = body.dayOfMonth ?? null;
      if (body.filters != null) updates['filters'] = body.filters;
      if (body.recipientEmails != null) updates['recipientEmails'] = body.recipientEmails;
      if (body.isEnabled != null) updates['isEnabled'] = body.isEnabled;

      if (body.frequency != null) {
        updates['nextRunAt'] = await computeNextRunAtInTz(
          body.frequency,
          body.dayOfWeek ?? null,
          body.dayOfMonth ?? null,
        );
      }

      const [updated] = await db.update(reportSchedules).set(updates).where(visible).returning();

      if (updated == null) {
        await reply.status(404).send({ error: 'Schedule not found', code: 'SCHEDULE_NOT_FOUND' });
        return;
      }
      return updated;
    },
  );

  // Delete schedule
  app.delete(
    '/report-schedules/:id',
    {
      onRequest: [authorize('reports:write')],
      schema: {
        tags: ['Reports'],
        summary: 'Delete a report schedule',
        description:
          "Returns 404 SCHEDULE_NOT_FOUND for a schedule outside the site-restricted user's sites.",
        operationId: 'deleteReportSchedule',
        security: [{ bearerAuth: [] }],
        response: {
          200: successResponse,
          404: errorWith('Schedule not found', [ERROR_CODES.SCHEDULE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const user = request.user as { userId: string };
      const userScope = await getUserSiteIds(user.userId);

      const removed = await db
        .delete(reportSchedules)
        .where(
          and(eq(reportSchedules.id, id), siteScopeVisibleTo(reportSchedules.siteScope, userScope)),
        )
        .returning({ id: reportSchedules.id });

      if (removed.length === 0) {
        await reply.status(404).send({ error: 'Schedule not found', code: 'SCHEDULE_NOT_FOUND' });
        return;
      }

      return { success: true };
    },
  );

  // Run schedule now
  app.post(
    '/report-schedules/:id/run-now',
    {
      onRequest: [authorize('reports:write')],
      schema: {
        tags: ['Reports'],
        summary: 'Run a report schedule immediately',
        description:
          "Queues a report covering the sites both the schedule and the user cover. Returns 404 SCHEDULE_NOT_FOUND for a schedule outside the site-restricted user's sites.",
        operationId: 'runReportScheduleNow',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(reportQueuedResponse),
          404: errorWith('Resource not found', [
            ERROR_CODES.SCHEDULE_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
            ERROR_CODES.STATION_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const user = request.user as { userId: string };

      const userScope = await getUserSiteIds(user.userId);

      const [schedule] = await db
        .select()
        .from(reportSchedules)
        .where(
          and(eq(reportSchedules.id, id), siteScopeVisibleTo(reportSchedules.siteScope, userScope)),
        );

      if (schedule == null) {
        await reply.status(404).send({ error: 'Schedule not found', code: 'SCHEDULE_NOT_FOUND' });
        return;
      }

      const filters = schedule.filters != null ? (schedule.filters as Record<string, unknown>) : {};

      // The report covers the sites both the schedule and the caller cover.
      // Same site-access guard as the create/PATCH paths — even though the
      // schedule was created with that check at the time, the caller's
      // access may differ. Re-validate at run time.
      const runScope = intersectSiteScopes(schedule.siteScope, userScope);
      const scopeError = await filterScopeError(filters, runScope);
      if (scopeError != null) {
        await reply.status(404).send(scopeError);
        return;
      }

      const reportId = await queueReport(
        {
          name: schedule.name,
          reportType: schedule.reportType,
          format: schedule.format,
          filters,
          userId: user.userId,
          siteScope: runScope,
        },
        announceReport,
      );

      return { id: reportId, status: 'pending' };
    },
  );
}
