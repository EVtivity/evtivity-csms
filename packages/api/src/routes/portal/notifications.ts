// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { notifications, drivers } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { successResponse, paginatedResponse, itemResponse } from '../../lib/response-schemas.js';
import { paginationQuery } from '../../lib/pagination.js';
import type { PaginatedResponse } from '../../lib/pagination.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const notificationItem = z
  .object({
    id: z.number(),
    channel: z.string(),
    subject: z.string().nullable(),
    eventType: z.string().nullable(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const unreadCountResponse = z
  .object({
    count: z.number(),
  })
  .passthrough();

export function portalNotificationRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/notifications',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Notifications'],
        summary: 'List notification history for the driver',
        operationId: 'portalListNotifications',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(paginationQuery),
        response: { 200: paginatedResponse(notificationItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { page, limit } = request.query as z.infer<typeof paginationQuery>;
      const offset = (page - 1) * limit;

      const [data, countRows] = await Promise.all([
        db
          .select({
            id: notifications.id,
            channel: notifications.channel,
            subject: notifications.subject,
            eventType: notifications.eventType,
            createdAt: notifications.createdAt,
          })
          .from(notifications)
          .where(
            sql`${notifications.metadata}->>'driverId' = ${driverId} AND ${notifications.channel} = 'push'`,
          )
          .orderBy(desc(notifications.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(notifications)
          .where(
            sql`${notifications.metadata}->>'driverId' = ${driverId} AND ${notifications.channel} = 'push'`,
          ),
      ]);

      return { data, total: countRows[0]?.count ?? 0 } satisfies PaginatedResponse<
        (typeof data)[number]
      >;
    },
  );

  app.get(
    '/portal/notifications/unread-count',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Notifications'],
        summary: 'Get unread notification count',
        operationId: 'portalGetUnreadNotificationCount',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(unreadCountResponse) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;

      const [driver] = await db
        .select({ lastNotificationReadAt: drivers.lastNotificationReadAt })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      const lastReadAt = driver?.lastNotificationReadAt;

      const whereClause =
        lastReadAt != null
          ? sql`${notifications.metadata}->>'driverId' = ${driverId} AND ${notifications.channel} = 'push' AND ${notifications.createdAt} > ${lastReadAt.toISOString()}`
          : sql`${notifications.metadata}->>'driverId' = ${driverId} AND ${notifications.channel} = 'push'`;

      const [result] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(whereClause);

      return { count: result?.count ?? 0 };
    },
  );

  app.post(
    '/portal/notifications/mark-read',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Notifications'],
        summary: 'Mark all notifications as read',
        operationId: 'portalMarkNotificationsRead',
        security: [{ bearerAuth: [] }],
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;

      await db
        .update(drivers)
        .set({ lastNotificationReadAt: new Date() })
        .where(eq(drivers.id, driverId));

      return { success: true as const };
    },
  );
}
