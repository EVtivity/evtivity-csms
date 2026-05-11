// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, ilike, sql, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { workerJobLogs, workerJobStatusEnum } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { paginatedResponse } from '../lib/response-schemas.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';

const workerJobLogItem = z
  .object({
    id: z.number().describe('Identifier'),
    jobName: z.string().describe('Worker job name'),
    queue: z.string().describe('BullMQ queue the job ran in'),
    status: z.enum(workerJobStatusEnum.enumValues).describe('Final job status'),
    durationMs: z.number().nullable().describe('Job duration in milliseconds'),
    error: z.string().nullable().describe('Error message when the job failed'),
    startedAt: z.coerce.date().describe('Timestamp when the job started'),
    completedAt: z.coerce
      .date()
      .nullable()
      .describe('Timestamp when the job finished, or null if still running'),
  })
  .passthrough();

const listWorkerLogsQuery = paginationQuery.extend({
  status: z.enum(workerJobStatusEnum.enumValues).optional().describe('Filter by job status'),
  queue: z.string().optional().describe('Filter by queue name'),
});

export function workerLogRoutes(app: FastifyInstance): void {
  app.get(
    '/worker-logs',
    {
      onRequest: [authorize('logs:read')],
      schema: {
        tags: ['Access Logs'],
        summary: 'List worker job logs',
        operationId: 'listWorkerLogs',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listWorkerLogsQuery),
        response: { 200: paginatedResponse(workerJobLogItem) },
      },
    },
    async (request) => {
      const { page, limit, search, status, queue } = request.query as z.infer<
        typeof listWorkerLogsQuery
      >;
      const offset = (page - 1) * limit;

      const conditions = [];

      if (status) {
        conditions.push(eq(workerJobLogs.status, status));
      }

      if (queue) {
        conditions.push(eq(workerJobLogs.queue, queue));
      }

      if (search) {
        const pattern = `%${search}%`;
        conditions.push(ilike(workerJobLogs.jobName, pattern));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: workerJobLogs.id,
            jobName: workerJobLogs.jobName,
            queue: workerJobLogs.queue,
            status: workerJobLogs.status,
            durationMs: workerJobLogs.durationMs,
            error: workerJobLogs.error,
            startedAt: workerJobLogs.startedAt,
            completedAt: workerJobLogs.completedAt,
          })
          .from(workerJobLogs)
          .where(where)
          .orderBy(desc(workerJobLogs.startedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(workerJobLogs)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );
}
