// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  applyDriverNotificationPreferences,
  client,
  db,
  driverAuditLog,
  listDriverEventSettings,
  readDriverNotificationState,
  writeAudit,
} from '@evtivity/database';
import { driverNotificationChannels, getNotificationSettings } from '@evtivity/lib';
import {
  DRIVER_NOTIFICATION_CHANNELS,
  DRIVER_PREFERENCE_EVENT_GROUPS,
  isDriverPreferenceEventType,
} from '@evtivity/lib/notification-events';
import { zodSchema } from '../../lib/zod-schema.js';
import { itemResponse, errorWith } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import { getAuditActor } from '../../lib/audit-actor.js';
import {
  buildNotificationPreferencesView,
  changedChannelSwitches,
  mandatoryOf,
  type NotificationPreferencesView,
} from '../../lib/driver-notification-preferences.js';

// Driver notification preferences (discussion 56). Three layers, in order: the
// operator's on/off switch per event (an event turned off is not listed), the
// operator's mandatory channels (listed on and locked, never turned off here),
// then the driver's event choices and channel switches.

const MAX_EVENT_CHOICES = 300;

const channelEnum = z.enum(DRIVER_NOTIFICATION_CHANNELS);

const eventChannelView = z
  .object({
    enabled: z
      .boolean()
      .describe('Whether the driver gets this event on the channel (always true when mandatory)'),
    mandatory: z
      .boolean()
      .describe('Whether the operator made the event mandatory on the channel (locked on)'),
  })
  .loose();

const preferencesView = z
  .object({
    emailEnabled: z
      .boolean()
      .describe(
        'Email channel switch: true while any optional event is on by email. Setting it turns every optional email event on or off.',
      ),
    smsEnabled: z.boolean().describe('SMS channel switch, as emailEnabled'),
    pushEnabled: z.boolean().describe('Native push channel switch (mobile app), as emailEnabled'),
    channels: z
      .object({
        email: z.boolean().describe('Email is configured by the operator (SMTP)'),
        sms: z.boolean().describe('SMS is configured by the operator (Twilio)'),
        push: z.boolean().describe('Native push is available (Expo, needs no configuration)'),
      })
      .loose()
      .describe('Channels the operator has configured. Clients show only these.'),
    events: z
      .array(
        z
          .object({
            eventType: z.string().describe('Driver notification event type'),
            group: z
              .enum(
                Object.keys(DRIVER_PREFERENCE_EVENT_GROUPS) as [
                  keyof typeof DRIVER_PREFERENCE_EVENT_GROUPS,
                  ...(keyof typeof DRIVER_PREFERENCE_EVENT_GROUPS)[],
                ],
              )
              .describe('Group the event is shown in'),
            email: eventChannelView,
            sms: eventChannelView,
            push: eventChannelView,
          })
          .loose(),
      )
      .describe(
        'Events the driver may choose. Account and security notices are always sent and not listed; events the operator turned off are not listed.',
      ),
  })
  .loose();

const preferencesBody = z.object({
  emailEnabled: z
    .boolean()
    .optional()
    .describe(
      'Turns every optional email event on or off. Applied only when it differs from the current emailEnabled, so a client sending the shown value back changes nothing.',
    ),
  smsEnabled: z.boolean().optional().describe('As emailEnabled, for SMS'),
  pushEnabled: z
    .boolean()
    .optional()
    .describe('As emailEnabled, for native push (omit to keep the current value)'),
  events: z
    .array(
      z.object({
        eventType: z.string().max(255).describe('A driver event listed in the GET reply'),
        channel: channelEnum.describe('email, sms or push'),
        enabled: z.boolean().describe('Whether to get the event on the channel'),
      }),
    )
    .max(MAX_EVENT_CHOICES)
    .optional()
    .describe(
      'Per-event choices, applied after the channel switches. Turning off a mandatory event returns 400 NOTIFICATION_EVENT_MANDATORY; an event that is no choice returns 400 VALIDATION_ERROR.',
    ),
});

async function loadView(driverId: string): Promise<NotificationPreferencesView> {
  const [state, settings, notificationSettings] = await Promise.all([
    readDriverNotificationState(driverId),
    listDriverEventSettings(),
    getNotificationSettings(client),
  ]);
  return buildNotificationPreferencesView(
    state,
    settings,
    driverNotificationChannels(notificationSettings),
  );
}

export function portalDriverNotificationPreferencesRoutes(app: FastifyInstance): void {
  app.get(
    '/portal/driver/notification-preferences',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Get driver notification preferences',
        description:
          'The channel switches, the channels the operator has configured and the per-event choices. A mandatory event is listed on and locked.',
        operationId: 'portalGetNotificationPreferences',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(preferencesView) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      return loadView(driverId);
    },
  );

  app.put(
    '/portal/driver/notification-preferences',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Update driver notification preferences',
        description:
          'Channel switches (all on or all off over the optional events of a channel) and per-event choices. The driver id comes from the session only.',
        operationId: 'portalUpdateNotificationPreferences',
        security: [{ bearerAuth: [] }],
        body: zodSchema(preferencesBody),
        response: {
          200: itemResponse(preferencesView),
          400: errorWith('An event that is no driver choice, or a mandatory event turned off', [
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.NOTIFICATION_EVENT_MANDATORY,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof preferencesBody>;
      const events = body.events ?? [];

      // Layer 2 wins over layer 3: read the operator's settings fresh, not cached.
      const settings = await listDriverEventSettings();
      const byEvent = new Map(settings.map((row) => [row.eventType, row]));
      for (const event of events) {
        if (!isDriverPreferenceEventType(event.eventType)) {
          await reply.status(400).send({
            error: `${event.eventType} is not a notification drivers can turn on or off`,
            code: 'VALIDATION_ERROR',
          });
          return;
        }
        if (!event.enabled && mandatoryOf(byEvent.get(event.eventType))[event.channel]) {
          await reply.status(400).send({
            error: 'Your operator requires this notification on this channel',
            code: 'NOTIFICATION_EVENT_MANDATORY',
            details: { eventType: event.eventType, channel: event.channel },
          });
          return;
        }
      }

      const before = await loadView(driverId);
      const switches = changedChannelSwitches(body, before);
      if (Object.keys(switches).length > 0 || events.length > 0) {
        await applyDriverNotificationPreferences(driverId, { switches, events });
      }
      const after = await loadView(driverId);

      // Audit only what changed: the shown switches and the per-event choices.
      const changedBefore: Record<string, boolean> = {};
      const changedAfter: Record<string, boolean> = {};
      for (const key of ['emailEnabled', 'smsEnabled', 'pushEnabled'] as const) {
        if (before[key] !== after[key]) {
          changedBefore[key] = before[key];
          changedAfter[key] = after[key];
        }
      }
      const beforeEvents = new Map(before.events.map((e) => [e.eventType, e]));
      for (const event of after.events) {
        const prev = beforeEvents.get(event.eventType);
        if (prev == null) continue;
        for (const channel of DRIVER_NOTIFICATION_CHANNELS) {
          if (prev[channel].enabled !== event[channel].enabled) {
            changedBefore[`${event.eventType}:${channel}`] = prev[channel].enabled;
            changedAfter[`${event.eventType}:${channel}`] = event[channel].enabled;
          }
        }
      }
      if (Object.keys(changedAfter).length > 0) {
        await writeAudit(
          { table: driverAuditLog, idColumn: 'driver_id' },
          {
            entityId: driverId,
            entityIdSnapshot: driverId,
            action: 'updated',
            ...getAuditActor(request),
            before: { notificationPreferences: changedBefore },
            after: { notificationPreferences: changedAfter },
            notes: 'Notification preferences updated in the driver portal',
          },
          db,
          request.log,
        );
      }
      return after;
    },
  );
}
