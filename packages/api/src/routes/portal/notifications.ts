// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { notifications, drivers, driverPushTokens } from '@evtivity/database';
import { zodSchema } from '../../lib/zod-schema.js';
import { successResponse, paginatedResponse, itemResponse } from '../../lib/response-schemas.js';
import { paginationQuery } from '../../lib/pagination.js';
import type { PaginatedResponse } from '../../lib/pagination.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';

const notificationItem = z
  .object({
    id: z.number().int().min(1).describe('Notification ID'),
    channel: z
      .enum(['email', 'webhook', 'sms', 'log', 'push'])
      .describe('Delivery channel used for this notification'),
    subject: z
      .string()
      .max(500)
      .nullable()
      .describe('Subject line (email) or summary text (other channels)'),
    eventType: z
      .string()
      .max(255)
      .nullable()
      .describe('Domain event type that triggered this notification'),
    createdAt: z.coerce.date().describe('Timestamp the notification was dispatched'),
  })
  .passthrough();

const unreadCountResponse = z
  .object({
    count: z.number().int().min(0).describe('Number of notifications since lastNotificationReadAt'),
  })
  .passthrough();

function driverPushFilter(driverId: string): ReturnType<typeof sql> {
  return sql`${notifications.metadata}->>'driverId' = ${driverId} AND ${notifications.channel} = 'push'`;
}

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

      const baseFilter = driverPushFilter(driverId);
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
          .where(baseFilter)
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(notifications)
          .where(baseFilter),
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

      const baseFilter = driverPushFilter(driverId);
      const whereClause =
        lastReadAt != null
          ? sql`${baseFilter} AND ${notifications.createdAt} > ${lastReadAt.toISOString()}`
          : baseFilter;

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

  const pushTokenBody = z.object({
    token: z.string().min(1).max(512).describe('Native push token (Expo / APNs / FCM)'),
    platform: z.enum(['ios', 'android']).describe('Device platform'),
  });
  const pushTokenQuery = z.object({
    token: z.string().min(1).max(512).describe('The push token to remove'),
  });

  app.post(
    '/portal/notifications/push-token',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Notifications'],
        summary: 'Register or refresh a native push token',
        operationId: 'portalRegisterPushToken',
        security: [{ bearerAuth: [] }],
        body: zodSchema(pushTokenBody),
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { token, platform } = request.body as z.infer<typeof pushTokenBody>;
      // Only the token's current owner may update it. A plain Bearer does not
      // prove device ownership, so an upsert that reassigned driver_id would let
      // any driver hijack another driver's token (silently stealing their push
      // delivery). The setWhere keeps a conflicting row owned by a different
      // driver untouched; a device handed to a new user unregisters on logout,
      // clearing the row so the next register inserts cleanly.
      await db
        .insert(driverPushTokens)
        .values({ driverId, token, platform, lastUsedAt: new Date() })
        .onConflictDoUpdate({
          target: driverPushTokens.token,
          set: { platform, lastUsedAt: new Date() },
          setWhere: eq(driverPushTokens.driverId, driverId),
        });
      return { success: true as const };
    },
  );

  app.delete(
    '/portal/notifications/push-token',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Notifications'],
        summary: 'Unregister a native push token',
        operationId: 'portalUnregisterPushToken',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(pushTokenQuery),
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { token } = request.query as z.infer<typeof pushTokenQuery>;
      await db
        .delete(driverPushTokens)
        .where(and(eq(driverPushTokens.token, token), eq(driverPushTokens.driverId, driverId)));
      return { success: true as const };
    },
  );
}
