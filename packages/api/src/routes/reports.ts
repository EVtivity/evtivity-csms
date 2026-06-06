// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, desc, count, sql } from 'drizzle-orm';
import {
  db,
  reports,
  reportSchedules,
  reportStatusEnum,
  reportFrequencyEnum,
} from '@evtivity/database';

// Report types are registered in `packages/api/src/index.ts` via
// `registerGenerator(name, fn)`. Keep this list in sync with that registration.
// Used for both the input filter (reportListQuery) and create-body validation
// so the docs surface the exact set of legal values.
const REPORT_TYPES = [
  'nevi',
  'revenue',
  'energy',
  'sessions',
  'utilization',
  'stationHealth',
  'sustainability',
  'driverActivity',
] as const;

const REPORT_FORMATS = ['csv', 'pdf', 'xlsx'] as const;
import { zodSchema } from '../lib/zod-schema.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  errorWith,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { queueReport, computeNextRunAtInTz } from '../services/report.service.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { authorize } from '../middleware/rbac.js';

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
        operationId: 'listReports',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(reportListQuery),
        response: { 200: paginatedResponse(reportItem) },
      },
    },
    async (request) => {
      const { page, limit, reportType } = request.query as z.infer<typeof reportListQuery>;
      const offset = (page - 1) * limit;

      const conditions = [];
      if (reportType) {
        conditions.push(eq(reports.reportType, reportType));
      }
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

  // Get single report metadata
  app.get(
    '/reports/:id',
    {
      onRequest: [authorize('reports:read')],
      schema: {
        tags: ['Reports'],
        summary: 'Get a report by ID',
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
          generatedById: reports.generatedById,
          createdAt: reports.createdAt,
          completedAt: reports.completedAt,
        })
        .from(reports)
        .where(eq(reports.id, id));

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
        operationId: 'downloadReport',
        security: [{ bearerAuth: [] }],
        response: { 404: errorWith('Report not found', [ERROR_CODES.REPORT_NOT_FOUND]) },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const [report] = await db
        .select({
          fileData: reports.fileData,
          fileName: reports.fileName,
          format: reports.format,
        })
        .from(reports)
        .where(eq(reports.id, id));

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
        operationId: 'generateReport',
        security: [{ bearerAuth: [] }],
        body: zodSchema(generateBody),
        response: {
          200: itemResponse(reportQueuedResponse),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
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

      // If the operator is restricted to specific sites, reject any
      // filters.siteId that targets a site they can't access. Without
      // this an operator with siteA-only access could pass
      // { filters: { siteId: 'sit_B' } } and generate a cross-site
      // report (reports themselves are unscoped per
      // site-access-control.md, but the *filter parameter* must respect
      // the caller's scope).
      const siteIds = await getUserSiteIds(user.userId);
      const filters = body.filters ?? {};
      const requestedSite = typeof filters['siteId'] === 'string' ? filters['siteId'] : null;
      if (siteIds != null && requestedSite != null && !siteIds.includes(requestedSite)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const reportId = await queueReport({
        name: body.name,
        reportType: body.reportType,
        format: body.format,
        filters,
        userId: user.userId,
      });

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

      const [existing] = await db
        .select({ id: reports.id })
        .from(reports)
        .where(eq(reports.id, id));

      if (existing == null) {
        await reply.status(404).send({ error: 'Report not found', code: 'REPORT_NOT_FOUND' });
        return;
      }

      await db.delete(reports).where(eq(reports.id, id));
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
        operationId: 'listReportSchedules',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(z.object({ data: z.array(scheduleItem) }).passthrough()) },
      },
    },
    async () => {
      const rows = await db
        .select()
        .from(reportSchedules)
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
        operationId: 'createReportSchedule',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createScheduleBody),
        response: {
          200: itemResponse(scheduleItem),
          404: errorWith('Site not found', [ERROR_CODES.SITE_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof createScheduleBody>;
      const user = request.user as { userId: string };

      // Mirror the generate-report site-access guard so a restricted
      // operator can't pre-load a schedule with a cross-site filter that
      // the cron would later run on their behalf.
      const siteIds = await getUserSiteIds(user.userId);
      const filters = body.filters ?? {};
      const requestedSite = typeof filters['siteId'] === 'string' ? filters['siteId'] : null;
      if (siteIds != null && requestedSite != null && !siteIds.includes(requestedSite)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
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
        operationId: 'updateReportSchedule',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateScheduleBody),
        response: {
          200: itemResponse(scheduleItem),
          404: errorWith('Resource not found', [
            ERROR_CODES.SCHEDULE_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const body = request.body as z.infer<typeof updateScheduleBody>;

      const [existing] = await db
        .select({ id: reportSchedules.id })
        .from(reportSchedules)
        .where(eq(reportSchedules.id, id));

      if (existing == null) {
        await reply.status(404).send({ error: 'Schedule not found', code: 'SCHEDULE_NOT_FOUND' });
        return;
      }

      // Same site-access guard as create — without it a restricted
      // operator could PATCH a schedule's filters to point at a site they
      // can't access.
      if (body.filters != null) {
        const user = request.user as { userId: string };
        const siteIds = await getUserSiteIds(user.userId);
        const filters = body.filters;
        const requestedSite = typeof filters['siteId'] === 'string' ? filters['siteId'] : null;
        if (siteIds != null && requestedSite != null && !siteIds.includes(requestedSite)) {
          await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
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

      const [updated] = await db
        .update(reportSchedules)
        .set(updates)
        .where(eq(reportSchedules.id, id))
        .returning();

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

      const [existing] = await db
        .select({ id: reportSchedules.id })
        .from(reportSchedules)
        .where(eq(reportSchedules.id, id));

      if (existing == null) {
        await reply.status(404).send({ error: 'Schedule not found', code: 'SCHEDULE_NOT_FOUND' });
        return;
      }

      await db.delete(reportSchedules).where(eq(reportSchedules.id, id));
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
        operationId: 'runReportScheduleNow',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(reportQueuedResponse),
          404: errorWith('Resource not found', [
            ERROR_CODES.SCHEDULE_NOT_FOUND,
            ERROR_CODES.SITE_NOT_FOUND,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const user = request.user as { userId: string };

      const [schedule] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, id));

      if (schedule == null) {
        await reply.status(404).send({ error: 'Schedule not found', code: 'SCHEDULE_NOT_FOUND' });
        return;
      }

      const filters = schedule.filters != null ? (schedule.filters as Record<string, unknown>) : {};

      // Same site-access guard as the create/PATCH paths — even though
      // the schedule was created with that check at the time, the
      // creator's access may have changed (or run-now may be invoked by
      // a different operator). Re-validate at run time.
      const siteIds = await getUserSiteIds(user.userId);
      const requestedSite = typeof filters['siteId'] === 'string' ? filters['siteId'] : null;
      if (siteIds != null && requestedSite != null && !siteIds.includes(requestedSite)) {
        await reply.status(404).send({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
        return;
      }

      const reportId = await queueReport({
        name: schedule.name,
        reportType: schedule.reportType,
        format: schedule.format,
        filters,
        userId: user.userId,
      });

      return { id: reportId, status: 'pending' };
    },
  );
}
