// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, desc, count, sql } from 'drizzle-orm';
import { db, reports, reportSchedules } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
} from '../lib/response-schemas.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { queueReport } from '../services/report.service.js';
import { authorize } from '../middleware/rbac.js';

const reportItem = z
  .object({
    id: z.string(),
    name: z.string(),
    reportType: z.string(),
    status: z.string(),
    format: z.string(),
    fileName: z.string().nullable(),
    fileSize: z.number().nullable(),
    error: z.string().nullable(),
    createdAt: z.coerce.date(),
    completedAt: z.coerce.date().nullable(),
  })
  .passthrough();

const reportDetail = reportItem
  .extend({ filters: z.record(z.unknown()).nullable(), generatedById: z.string().nullable() })
  .passthrough();

const reportQueuedResponse = z.object({ id: z.string(), status: z.string() }).passthrough();

const scheduleItem = z
  .object({
    id: z.string(),
    name: z.string(),
    reportType: z.string(),
    format: z.string(),
    frequency: z.string(),
    dayOfWeek: z.number().nullable(),
    dayOfMonth: z.number().nullable(),
    filters: z.record(z.unknown()).nullable(),
    recipientEmails: z.array(z.string()),
    isEnabled: z.boolean(),
    nextRunAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const generateBody = z.object({
  name: z.string().min(1).max(255),
  reportType: z
    .string()
    .min(1)
    .max(50)
    .describe('Report type identifier (e.g. sessions, energy, revenue)'),
  format: z.string().min(1).max(10).describe('Output file format (csv, pdf, xlsx)'),
  filters: z.record(z.unknown()).optional().describe('Key-value filter criteria for the report'),
});

const reportListQuery = paginationQuery.extend({
  reportType: z.string().optional().describe('Filter by report type'),
});

const createScheduleBody = z.object({
  name: z.string().min(1).max(255),
  reportType: z
    .string()
    .min(1)
    .max(50)
    .describe('Report type identifier (e.g. sessions, energy, revenue)'),
  format: z.string().min(1).max(10).describe('Output file format (csv, pdf, xlsx)'),
  frequency: z.enum(['daily', 'weekly', 'monthly']).describe('How often the report runs'),
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
          .orderBy(desc(reports.createdAt))
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
        response: { 200: itemResponse(reportDetail), 404: errorResponse },
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
        response: { 200: itemResponse(reportQueuedResponse) },
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
    async (request) => {
      const body = request.body as z.infer<typeof generateBody>;
      const user = request.user as { userId: string };

      const reportId = await queueReport({
        name: body.name,
        reportType: body.reportType,
        format: body.format,
        filters: body.filters ?? {},
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
        response: { 200: successResponse, 404: errorResponse },
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
      const rows = await db.select().from(reportSchedules).orderBy(desc(reportSchedules.createdAt));
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
        response: { 200: itemResponse(scheduleItem) },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof createScheduleBody>;
      const user = request.user as { userId: string };

      const nextRunAt = computeInitialNextRunAt(body.frequency, body.dayOfWeek, body.dayOfMonth);

      const [row] = await db
        .insert(reportSchedules)
        .values({
          name: body.name,
          reportType: body.reportType,
          format: body.format,
          frequency: body.frequency,
          dayOfWeek: body.dayOfWeek ?? null,
          dayOfMonth: body.dayOfMonth ?? null,
          filters: body.filters ?? {},
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
        response: { 200: itemResponse(scheduleItem), 404: errorResponse },
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
        updates['nextRunAt'] = computeInitialNextRunAt(
          body.frequency,
          body.dayOfWeek,
          body.dayOfMonth,
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
        response: { 200: successResponse, 404: errorResponse },
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
        response: { 200: itemResponse(reportQueuedResponse), 404: errorResponse },
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

function computeInitialNextRunAt(frequency: string, dayOfWeek?: number, dayOfMonth?: number): Date {
  const now = new Date();

  if (frequency === 'daily') {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(6, 0, 0, 0);
    return next;
  }

  if (frequency === 'weekly') {
    const dow = dayOfWeek ?? 1;
    const next = new Date(now);
    const currentDow = next.getDay();
    const daysUntil = (dow - currentDow + 7) % 7 || 7;
    next.setDate(next.getDate() + daysUntil);
    next.setHours(6, 0, 0, 0);
    return next;
  }

  if (frequency === 'monthly') {
    const dom = dayOfMonth ?? 1;
    const next = new Date(now);
    next.setMonth(next.getMonth() + 1);
    const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(dom, maxDay));
    next.setHours(6, 0, 0, 0);
    return next;
  }

  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(6, 0, 0, 0);
  return next;
}
