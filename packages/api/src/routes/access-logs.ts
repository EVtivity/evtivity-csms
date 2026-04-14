// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, or, ilike, sql, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { accessLogs, users, drivers } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { successResponse, paginatedResponse } from '../lib/response-schemas.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';

const accessLogItem = z
  .object({
    id: z.string(),
    userId: z.string().nullable(),
    driverId: z.string().nullable(),
    action: z.string(),
    category: z.string(),
    authType: z.string().nullable(),
    method: z.string().nullable(),
    path: z.string().nullable(),
    statusCode: z.number().nullable(),
    durationMs: z.number().nullable(),
    remoteAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable(),
    createdAt: z.coerce.date(),
    userEmail: z.string().nullable(),
    userFirstName: z.string().nullable(),
    userLastName: z.string().nullable(),
  })
  .passthrough();

const createLogBody = z.object({
  action: z.string().min(1).max(100).describe('Action name to log'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata for the log entry'),
});

const listLogsQuery = paginationQuery.extend({
  category: z.string().optional().describe('Filter by log category (browser, api, portal)'),
  method: z.string().optional().describe('Filter by HTTP method'),
});

const AUTH_ACTIONS = new Set(['login', 'logout']);

export function accessLogRoutes(app: FastifyInstance): void {
  app.post(
    '/access-logs',
    {
      onRequest: [authorize('logs:write')],
      schema: {
        tags: ['Access Logs'],
        summary: 'Create an operator access log entry',
        operationId: 'createAccessLog',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createLogBody),
        response: { 201: successResponse },
      },
    },
    async (request, reply) => {
      const { action, metadata } = request.body as z.infer<typeof createLogBody>;
      const { userId } = request.user as { userId: string };
      const category = AUTH_ACTIONS.has(action) ? 'auth' : 'action';

      await db.insert(accessLogs).values({
        userId,
        action,
        category,
        remoteAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        metadata: metadata ?? null,
      });

      await reply.status(201).send({ success: true });
    },
  );

  app.post(
    '/portal/access-logs',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Access Logs'],
        summary: 'Create a driver portal access log entry',
        operationId: 'createPortalAccessLog',
        security: [{ bearerAuth: [] }],
        body: zodSchema(createLogBody),
        response: { 201: successResponse },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as { driverId: string };
      const { action, metadata } = request.body as z.infer<typeof createLogBody>;

      await db.insert(accessLogs).values({
        userId: null,
        driverId,
        action,
        category: 'portal',
        remoteAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        metadata: metadata ?? null,
      });

      await reply.status(201).send({ success: true });
    },
  );

  app.get(
    '/access-logs',
    {
      onRequest: [authorize('logs:read')],
      schema: {
        tags: ['Access Logs'],
        summary: 'List access log entries',
        operationId: 'listAccessLogs',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(listLogsQuery),
        response: { 200: paginatedResponse(accessLogItem) },
      },
    },
    async (request) => {
      const { page, limit, search, category, method } = request.query as z.infer<
        typeof listLogsQuery
      >;
      const offset = (page - 1) * limit;

      const conditions = [];

      if (category === 'browser' || category === 'csms') {
        conditions.push(or(eq(accessLogs.category, 'auth'), eq(accessLogs.category, 'action')));
      } else if (category === 'api') {
        conditions.push(eq(accessLogs.category, 'api'));
        conditions.push(eq(accessLogs.authType, 'api_key'));
      } else if (category === 'portal') {
        conditions.push(eq(accessLogs.category, 'portal'));
      } else if (category) {
        conditions.push(eq(accessLogs.category, category));
      }

      if (method) {
        conditions.push(eq(accessLogs.method, method));
      }

      if (search) {
        const pattern = `%${search}%`;
        conditions.push(or(ilike(accessLogs.action, pattern), ilike(accessLogs.path, pattern)));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: accessLogs.id,
            userId: accessLogs.userId,
            driverId: accessLogs.driverId,
            action: accessLogs.action,
            category: accessLogs.category,
            authType: accessLogs.authType,
            apiKeyName: accessLogs.apiKeyName,
            method: accessLogs.method,
            path: accessLogs.path,
            statusCode: accessLogs.statusCode,
            durationMs: accessLogs.durationMs,
            remoteAddress: accessLogs.remoteAddress,
            userAgent: accessLogs.userAgent,
            metadata: accessLogs.metadata,
            createdAt: accessLogs.createdAt,
            userEmail: sql<string | null>`coalesce("users"."email", "drivers"."email")`.as(
              'user_email',
            ),
            userFirstName: sql<
              string | null
            >`coalesce("users"."first_name", "drivers"."first_name")`.as('user_first_name'),
            userLastName: sql<
              string | null
            >`coalesce("users"."last_name", "drivers"."last_name")`.as('user_last_name'),
          })
          .from(accessLogs)
          .leftJoin(users, eq(accessLogs.userId, users.id))
          .leftJoin(drivers, eq(accessLogs.driverId, drivers.id))
          .where(where)
          .orderBy(desc(accessLogs.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(accessLogs)
          .where(where),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );
}
