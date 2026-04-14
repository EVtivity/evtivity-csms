// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, desc, count, and, or, ilike } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@evtivity/database';
import {
  notifications,
  notificationTemplates,
  driverEventSettings,
  systemEventSettings,
  ocppEventSettings,
  settings,
} from '@evtivity/database';
import Handlebars from 'handlebars';
import { decryptString, wrapEmailHtml } from '@evtivity/lib';
import { zodSchema } from '../lib/zod-schema.js';
import { paginationQuery } from '../lib/pagination.js';
import nodemailer from 'nodemailer';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
  arrayResponse,
} from '../lib/response-schemas.js';
import { config as apiConfig } from '../lib/config.js';
import { authorize } from '../middleware/rbac.js';

const ocppEventSettingItem = z
  .object({
    id: z.string(),
    eventType: z.string(),
    recipient: z.string(),
    channel: z.string(),
    templateHtml: z.string().nullable(),
    language: z.string().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const driverEventSettingItem = z
  .object({
    id: z.string(),
    eventType: z.string(),
    isEnabled: z.boolean(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const notificationHistoryItem = z
  .object({
    id: z.string(),
    eventType: z.string(),
    channel: z.string(),
    recipient: z.string(),
    status: z.string(),
    metadata: z.record(z.unknown()).nullable(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const notificationTemplateItem = z
  .object({
    eventType: z.string(),
    channel: z.string(),
    language: z.string(),
    subject: z.string().nullable(),
    bodyHtml: z.string().nullable(),
    isCustomized: z.boolean(),
  })
  .passthrough();

const notificationTemplateDbItem = z
  .object({
    id: z.string(),
    eventType: z.string(),
    channel: z.string(),
    language: z.string(),
    subject: z.string().nullable(),
    bodyHtml: z.string().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .passthrough();

const templatePreviewResponse = z
  .object({ subject: z.string().nullable(), bodyHtml: z.string().nullable() })
  .passthrough();

const ocppEventTemplateResponse = z.object({ template: z.string() }).passthrough();

const OCPP_EVENT_TYPES = [
  'station.Connected',
  'station.Disconnected',
  'ocpp.Authorize',
  'ocpp.BatterySwap',
  'ocpp.BootNotification',
  'ocpp.ClearedChargingLimit',
  'ocpp.DataTransfer',
  'ocpp.FirmwareStatusNotification',
  'ocpp.Get15118EVCertificate',
  'ocpp.GetCertificateChainStatus',
  'ocpp.GetCertificateStatus',
  'ocpp.Heartbeat',
  'ocpp.LogStatusNotification',
  'ocpp.MeterValues',
  'ocpp.MessageLog',
  'ocpp.NotifyAllowedEnergyTransfer',
  'ocpp.NotifyChargingLimit',
  'ocpp.NotifyCustomerInformation',
  'ocpp.NotifyDERAlarm',
  'ocpp.NotifyDERStartStop',
  'ocpp.NotifyDisplayMessages',
  'ocpp.NotifyEVChargingNeeds',
  'ocpp.NotifyEVChargingSchedule',
  'ocpp.NotifyEvent',
  'ocpp.NotifyMonitoringReport',
  'ocpp.NotifyPeriodicEventStream',
  'ocpp.NotifyPriorityCharging',
  'ocpp.NotifyQRCodeScanned',
  'ocpp.NotifyReport',
  'ocpp.NotifySettlement',
  'ocpp.NotifyWebPaymentStarted',
  'ocpp.PublishFirmwareStatusNotification',
  'ocpp.PullDynamicScheduleUpdate',
  'ocpp.ReportChargingProfiles',
  'ocpp.ReportDERControl',
  'ocpp.ReservationStatusUpdate',
  'ocpp.SecurityEventNotification',
  'ocpp.SignCertificate',
  'ocpp.StatusNotification',
  'ocpp.TransactionEvent',
  'ocpp.VatNumberValidation',
];

const DRIVER_EVENT_TYPES = [
  'session.Started',
  'session.Updated',
  'session.Completed',
  'session.Faulted',
  'session.PaymentReceived',
  'session.IdlingStarted',
];

const SYSTEM_EVENT_TYPES = [
  'driver.Welcome',
  'driver.ForgotPassword',
  'driver.PasswordChanged',
  'driver.AccountVerification',
  'payment.Complete',
  'session.Receipt',
];

const ALL_EVENT_TYPES = [...OCPP_EVENT_TYPES, ...DRIVER_EVENT_TYPES, ...SYSTEM_EVENT_TYPES];

const driverEventSettingsBody = z.object({
  eventType: z.string().max(255).describe('Driver event type identifier'),
  isEnabled: z.boolean().describe('Whether notifications are enabled for this event type'),
});

const ocppEventSettingsBody = z.object({
  eventType: z.string().max(255).describe('OCPP event type identifier'),
  recipient: z.string().max(500).optional().describe('Recipient address or $admin'),
  channel: z.enum(['email', 'webhook']).optional().describe('Notification delivery channel'),
  templateHtml: z.string().nullable().optional(),
  language: z.string().max(10).nullable().optional().describe('ISO language code'),
});

const testBody = z.object({
  channel: z.enum(['email', 'sms']).describe('Notification delivery channel'),
  recipient: z.string().max(500).describe('Email address or phone number'),
});

const notificationChannelValues = ['email', 'sms', 'webhook', 'push', 'log'] as const;

const notificationListQuery = paginationQuery.merge(
  z.object({
    channel: z.enum(notificationChannelValues).optional(),
    status: z.enum(['pending', 'sent', 'failed']).optional(),
    eventType: z.string().optional().describe('Filter by event type'),
  }),
);

const templateCrudQuery = z.object({
  eventType: z.string().describe('Event type identifier'),
  channel: z.enum(notificationChannelValues).describe('Notification delivery channel'),
  language: z.string().describe('ISO language code'),
});

const templateUpsertBody = z.object({
  eventType: z.string().describe('Event type identifier'),
  channel: z.enum(notificationChannelValues).describe('Notification delivery channel'),
  language: z.string().describe('ISO language code'),
  subject: z.string().nullable().optional(),
  bodyHtml: z.string().nullable().optional(),
});

const templatePreviewBody = z.object({
  eventType: z.string().describe('Event type identifier'),
  channel: z.string().describe('Notification delivery channel'),
  language: z.string().describe('ISO language code'),
  subject: z.string().nullable().optional(),
  bodyHtml: z.string().nullable().optional(),
});

function getEncryptionKey(): string | null {
  const key = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (key === '') return null;
  return key;
}

const templateQuery = z.object({
  eventType: z.string().describe('Event type identifier'),
  channel: z.string().describe('Notification delivery channel'),
  language: z.string().default('en').describe('ISO language code'),
});

const TEMPLATE_VARIABLES: Record<string, string[]> = {
  'station.Connected': ['stationId', 'occurredAt'],
  'station.Disconnected': ['stationId', 'occurredAt'],
  'ocpp.BootNotification': ['stationId', 'occurredAt', 'firmwareVersion', 'model', 'serialNumber'],
  'ocpp.StatusNotification': [
    'stationId',
    'occurredAt',
    'connectorStatus',
    'evseId',
    'connectorId',
    'isFaulted',
  ],
  'ocpp.TransactionEvent': ['stationId', 'occurredAt', 'transactionId', 'evseId'],
  'ocpp.MeterValues': ['stationId', 'occurredAt', 'evseId'],
  'ocpp.FirmwareStatusNotification': ['stationId', 'occurredAt', 'status'],
  'ocpp.SecurityEventNotification': ['stationId', 'occurredAt', 'type'],
  'session.Started': [
    'firstName',
    'lastName',
    'email',
    'stationId',
    'transactionId',
    'startedAt',
    'stationName',
  ],
  'session.Updated': [
    'firstName',
    'lastName',
    'email',
    'stationId',
    'transactionId',
    'energyDeliveredWh',
    'currentCostCents',
    'currency',
    'durationMinutes',
  ],
  'session.Completed': [
    'firstName',
    'lastName',
    'email',
    'stationId',
    'transactionId',
    'energyDeliveredWh',
    'finalCostCents',
    'currency',
    'durationMinutes',
    'startedAt',
    'endedAt',
  ],
  'session.Faulted': ['firstName', 'lastName', 'email', 'stationId', 'reason'],
  'session.PaymentReceived': [
    'firstName',
    'lastName',
    'email',
    'stationId',
    'transactionId',
    'amountCents',
    'currency',
  ],
  'driver.Welcome': ['firstName', 'lastName', 'email'],
  'driver.ForgotPassword': ['firstName', 'lastName', 'email'],
  'driver.PasswordChanged': ['firstName', 'lastName'],
  'driver.AccountVerification': ['firstName', 'lastName', 'email'],
  'payment.Complete': [
    'firstName',
    'lastName',
    'email',
    'amountCents',
    'currency',
    'transactionId',
  ],
  'session.Receipt': [
    'firstName',
    'lastName',
    'email',
    'transactionId',
    'energyDeliveredWh',
    'finalCostCents',
    'currency',
    'durationMinutes',
    'startedAt',
    'endedAt',
    'stationName',
  ],
};

const FRIENDLY_SUBJECTS: Record<string, string> = {
  // Driver session events
  'session.Started': '{{companyName}} - Your charging session has started',
  'session.Updated': '{{companyName}} - Charging session update',
  'session.Completed': '{{companyName}} - Your charging session is complete',
  'session.Faulted': '{{companyName}} - Charging session failed to start',
  'session.PaymentReceived': '{{companyName}} - Payment received',
  'session.IdlingStarted': '{{companyName}} - Your vehicle has stopped charging',
  'session.Receipt': '{{companyName}} - Charging session receipt',
  // Driver account events
  'driver.Welcome': '{{companyName}} - Welcome',
  'driver.ForgotPassword': '{{companyName}} - Reset your password',
  'driver.PasswordChanged': '{{companyName}} - Password changed',
  'driver.AccountVerification': '{{companyName}} - Verify your account',
  // Payment events
  'payment.Complete': '{{companyName}} - Payment confirmation',
  'payment.Refunded': '{{companyName}} - Refund processed',
  'payment.PreAuthFailed': '{{companyName}} - Payment authorization failed',
  'payment.CaptureFailed': '{{companyName}} - Payment capture failed',
  'payment.MissingPaymentMethod': '{{companyName}} - Payment method required',
  // Reservation events
  'reservation.Created': '{{companyName}} - Reservation confirmed',
  'reservation.Cancelled': '{{companyName}} - Reservation cancelled',
  'reservation.Expiring': '{{companyName}} - Your reservation is expiring soon',
  'reservation.Expired': '{{companyName}} - Your reservation has expired',
  'reservation.StationFaulted': '{{companyName}} - Reserved station is unavailable',
  // Support case events (driver-facing)
  'supportCase.Created': '{{companyName}} - Your support case has been opened',
  'supportCase.OperatorReply': '{{companyName}} - New reply on your support case',
  'supportCase.Resolved': '{{companyName}} - Your support case has been resolved',
  // MFA
  'mfa.VerificationCode': '{{companyName}} - Verification code',
  // Operator events
  'operator.UserCreated': '{{companyName}} - New operator account created',
  'operator.ForgotPassword': '{{companyName}} - Reset your operator password',
  'operator.PasswordChanged': '{{companyName}} - Operator password changed',
  // Operator support events
  'supportCase.NewCaseFromDriver': '{{companyName}} - New support case from driver',
  'supportCase.DriverReply': '{{companyName}} - Driver replied to support case',
};

function getDefaultSubject(eventType: string, channel: string): string | null {
  if (channel !== 'email') return null;
  const friendly = FRIENDLY_SUBJECTS[eventType];
  if (friendly != null) return friendly;
  return `{{companyName}} - ${eventType} Notification`;
}

function generateDefaultTemplate(eventType: string, channel: string): string {
  const vars = TEMPLATE_VARIABLES[eventType] ?? ['stationId', 'occurredAt'];
  const varRows = vars.map((v) => `{{${v}}}`).join(', ');

  if (channel === 'email') {
    const displayVars = vars.filter((v) => v !== 'firstName' && v !== 'lastName' && v !== 'email');
    const varTableRows = displayVars
      .map(
        (v) =>
          `          <tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;font-weight:600;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;text-align:left;vertical-align:top;">${v}</td><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;text-align:left;vertical-align:top;">{{${v}}}</td></tr>`,
      )
      .join('\n');
    const greeting = vars.includes('firstName')
      ? '<p style="color:#4b5563;line-height:1.6;margin:0 0 16px 0;font-size:16px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;">Hi {{firstName}},</p>'
      : '';
    return `${greeting}<h2 style="color:#1a1a1a;margin:0 0 8px 0;font-size:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">${eventType}</h2>
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;border-spacing:0;margin-bottom:24px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <tbody>
${varTableRows}
    </tbody>
  </table>`;
  }

  return `{{companyName}} - ${eventType}: ${varRows}`;
}

export function notificationRoutes(app: FastifyInstance): void {
  // --- Event types and template loading ---

  app.get(
    '/ocpp-event-types',
    {
      onRequest: [authorize('notifications:read')],
      schema: {
        tags: ['Notifications'],
        summary: 'List all event types',
        operationId: 'listEventTypes',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(z.string()) },
      },
    },
    () => {
      return ALL_EVENT_TYPES;
    },
  );

  app.get(
    '/ocpp-event-template',
    {
      onRequest: [authorize('notifications:read')],
      schema: {
        tags: ['Notifications'],
        summary: 'Get default OCPP event template',
        operationId: 'getOcppEventTemplate',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(templateQuery),
        response: { 200: itemResponse(ocppEventTemplateResponse), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { eventType, channel, language } = request.query as z.infer<typeof templateQuery>;
      const eventDir = eventType.replace(/\./g, '/');
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const templatesDir =
        process.env['OCPP_TEMPLATES_DIR'] ??
        resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');
      const filePath = resolve(templatesDir, language, eventDir, `${channel}.hbs`);

      try {
        const content = await readFile(filePath, 'utf-8');
        return { template: content };
      } catch {
        const fallbackPath = resolve(templatesDir, 'en', eventDir, `${channel}.hbs`);
        try {
          const content = await readFile(fallbackPath, 'utf-8');
          return { template: content };
        } catch {
          await reply
            .status(404)
            .send({ error: 'No default template found', code: 'TEMPLATE_NOT_FOUND' });
          return;
        }
      }
    },
  );

  // --- OCPP Event Settings ---

  app.get(
    '/ocpp-event-settings',
    {
      onRequest: [authorize('notifications:read')],
      schema: {
        tags: ['Notifications'],
        summary: 'List OCPP event settings',
        operationId: 'getOcppEventSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(ocppEventSettingItem) },
      },
    },
    async () => {
      const rows = await db.select().from(ocppEventSettings);
      return rows;
    },
  );

  app.put(
    '/ocpp-event-settings',
    {
      onRequest: [authorize('notifications:write')],
      schema: {
        tags: ['Notifications'],
        summary: 'Create or update an OCPP event setting',
        operationId: 'updateOcppEventSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(ocppEventSettingsBody),
        response: { 200: itemResponse(ocppEventSettingItem) },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof ocppEventSettingsBody>;
      const channel = body.channel ?? 'email';
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.recipient !== undefined) updates['recipient'] = body.recipient;
      if (body.templateHtml !== undefined) updates['templateHtml'] = body.templateHtml;
      if (body.language !== undefined) updates['language'] = body.language;

      const [saved] = await db
        .insert(ocppEventSettings)
        .values({
          eventType: body.eventType,
          recipient: body.recipient ?? (channel === 'webhook' ? '' : ''),
          channel,
          templateHtml: body.templateHtml ?? null,
          language: body.language ?? null,
        })
        .onConflictDoUpdate({
          target: [ocppEventSettings.eventType, ocppEventSettings.channel],
          set: updates,
        })
        .returning();
      return saved;
    },
  );

  app.delete(
    '/ocpp-event-settings',
    {
      onRequest: [authorize('notifications:write')],
      schema: {
        tags: ['Notifications'],
        summary: 'Delete an OCPP event setting',
        operationId: 'deleteOcppEventSetting',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(
          z.object({
            eventType: z.string().describe('OCPP event type identifier'),
            channel: z.enum(['email', 'webhook']).describe('Notification delivery channel'),
          }),
        ),
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { eventType, channel } = request.query as { eventType: string; channel: string };
      const deleted = await db
        .delete(ocppEventSettings)
        .where(
          and(
            eq(ocppEventSettings.eventType, eventType),
            eq(ocppEventSettings.channel, channel as 'email' | 'webhook'),
          ),
        )
        .returning();
      if (deleted.length === 0) {
        await reply.status(404).send({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
        return;
      }
      return { success: true };
    },
  );

  // --- Notification history ---

  app.get(
    '/notifications',
    {
      onRequest: [authorize('notifications:read')],
      schema: {
        tags: ['Notifications'],
        summary: 'List notification history',
        operationId: 'listNotifications',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(notificationListQuery),
        response: { 200: paginatedResponse(notificationHistoryItem) },
      },
    },
    async (request) => {
      const params = request.query as z.infer<typeof notificationListQuery>;
      const offset = (params.page - 1) * params.limit;

      const conditions = [];
      if (params.search) {
        const pattern = `%${params.search}%`;
        conditions.push(
          or(
            ilike(notifications.recipient, pattern),
            ilike(notifications.eventType, pattern),
            ilike(notifications.channel, pattern),
            ilike(notifications.status, pattern),
          ),
        );
      }
      if (params.channel != null) {
        conditions.push(eq(notifications.channel, params.channel));
      }
      if (params.status != null) {
        conditions.push(eq(notifications.status, params.status));
      }
      if (params.eventType != null) {
        conditions.push(eq(notifications.eventType, params.eventType));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [data, [totalRow]] = await Promise.all([
        db
          .select()
          .from(notifications)
          .where(where)
          .orderBy(desc(notifications.createdAt))
          .limit(params.limit)
          .offset(offset),
        db.select({ count: count() }).from(notifications).where(where),
      ]);
      return { data, total: totalRow?.count ?? 0 };
    },
  );

  // --- Test notification ---

  app.post(
    '/notifications/test',
    {
      onRequest: [authorize('notifications:write')],
      schema: {
        tags: ['Notifications'],
        summary: 'Send a test notification',
        operationId: 'sendTestNotification',
        security: [{ bearerAuth: [] }],
        body: zodSchema(testBody),
        response: { 200: successResponse, 400: errorResponse, 500: errorResponse },
      },
    },
    async (request, reply) => {
      const { channel, recipient } = request.body as z.infer<typeof testBody>;

      const allSettings = await db.select().from(settings);
      const settingsMap = new Map<string, unknown>();
      for (const row of allSettings) {
        settingsMap.set(row.key, row.value);
      }

      if (channel === 'email') {
        const host = settingsMap.get('smtp.host') as string | undefined;
        if (host == null || host === '') {
          await reply
            .status(400)
            .send({ error: 'SMTP not configured', code: 'SMTP_NOT_CONFIGURED' });
          return;
        }

        const encryptionKey = getEncryptionKey();
        const rawPassword = settingsMap.get('smtp.password') as string | undefined;
        let password = '';
        if (rawPassword != null && rawPassword !== '' && encryptionKey != null) {
          try {
            password = decryptString(rawPassword, encryptionKey);
          } catch {
            // Use raw value if decryption fails
          }
        }

        const transport = nodemailer.createTransport({
          host,
          port: Number(settingsMap.get('smtp.port') ?? 587),
          secure: Number(settingsMap.get('smtp.port') ?? 587) === 465,
          auth: (settingsMap.get('smtp.username') as string | undefined)
            ? {
                user: settingsMap.get('smtp.username') as string,
                pass: password,
              }
            : undefined,
        });

        try {
          await transport.sendMail({
            from: (settingsMap.get('smtp.from') as string | undefined) ?? '',
            to: recipient,
            subject: 'EVtivity Test Notification',
            text: 'This is a test notification from EVtivity CSMS. If you received this, email notifications are working.',
          });
          return { success: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          await reply.status(500).send({ error: message, code: 'EMAIL_SEND_FAILED' });
          return;
        }
      }

      // channel === 'sms' (only remaining option after email branch)
      const accountSid = settingsMap.get('twilio.accountSid') as string | undefined;
      if (accountSid == null || accountSid === '') {
        await reply
          .status(400)
          .send({ error: 'Twilio not configured', code: 'TWILIO_NOT_CONFIGURED' });
        return;
      }

      const encryptionKey = getEncryptionKey();
      const rawToken = settingsMap.get('twilio.authToken') as string | undefined;
      let authToken = '';
      if (rawToken != null && rawToken !== '' && encryptionKey != null) {
        try {
          authToken = decryptString(rawToken, encryptionKey);
        } catch {
          // Use raw value if decryption fails
        }
      }

      const fromNumber = (settingsMap.get('twilio.fromNumber') as string | undefined) ?? '';
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const smsParams = new URLSearchParams({
        To: recipient,
        From: fromNumber,
        Body: 'EVtivity test notification. If you received this, SMS notifications are working.',
      });

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: smsParams.toString(),
        });
        if (!response.ok) {
          const text = await response.text();
          await reply.status(500).send({ error: text, code: 'SMS_SEND_FAILED' });
          return;
        }
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await reply.status(500).send({ error: message, code: 'SMS_SEND_FAILED' });
        return;
      }
    },
  );

  // --- Driver event settings ---

  app.get(
    '/driver-event-settings',
    {
      onRequest: [authorize('notifications:read')],
      schema: {
        tags: ['Notifications'],
        summary: 'List driver event settings',
        operationId: 'getDriverEventSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(driverEventSettingItem) },
      },
    },
    async () => {
      const rows = await db.select().from(driverEventSettings);
      return rows;
    },
  );

  app.put(
    '/driver-event-settings',
    {
      onRequest: [authorize('notifications:write')],
      schema: {
        tags: ['Notifications'],
        summary: 'Create or update a driver event setting',
        operationId: 'updateDriverEventSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(driverEventSettingsBody),
        response: { 200: itemResponse(driverEventSettingItem) },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof driverEventSettingsBody>;
      const [saved] = await db
        .insert(driverEventSettings)
        .values({
          eventType: body.eventType,
          isEnabled: body.isEnabled,
        })
        .onConflictDoUpdate({
          target: [driverEventSettings.eventType],
          set: {
            isEnabled: body.isEnabled,
            updatedAt: new Date(),
          },
        })
        .returning();
      return saved;
    },
  );

  // --- System Event Settings ---

  app.get(
    '/system-event-settings',
    {
      onRequest: [authorize('notifications:read')],
      schema: {
        tags: ['Notifications'],
        summary: 'List system event settings',
        operationId: 'getSystemEventSettings',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(driverEventSettingItem) },
      },
    },
    async () => {
      const rows = await db.select().from(systemEventSettings);
      return rows;
    },
  );

  app.put(
    '/system-event-settings',
    {
      onRequest: [authorize('notifications:write')],
      schema: {
        tags: ['Notifications'],
        summary: 'Create or update a system event setting',
        operationId: 'updateSystemEventSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(driverEventSettingsBody),
        response: { 200: itemResponse(driverEventSettingItem) },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof driverEventSettingsBody>;
      const [saved] = await db
        .insert(systemEventSettings)
        .values({
          eventType: body.eventType,
          isEnabled: body.isEnabled,
        })
        .onConflictDoUpdate({
          target: [systemEventSettings.eventType],
          set: {
            isEnabled: body.isEnabled,
            updatedAt: new Date(),
          },
        })
        .returning();
      return saved;
    },
  );

  // --- Template CRUD ---

  app.get(
    '/notification-templates',
    {
      onRequest: [authorize('notifications:read')],
      schema: {
        tags: ['Notifications'],
        summary: 'Get a notification template',
        operationId: 'getNotificationTemplate',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(templateCrudQuery),
        response: { 200: itemResponse(notificationTemplateItem) },
      },
    },
    async (request) => {
      const { eventType, channel, language } = request.query as z.infer<typeof templateCrudQuery>;

      const [row] = await db
        .select()
        .from(notificationTemplates)
        .where(
          and(
            eq(notificationTemplates.eventType, eventType),
            eq(notificationTemplates.channel, channel),
            eq(notificationTemplates.language, language),
          ),
        )
        .limit(1);

      if (row != null) {
        return {
          eventType: row.eventType,
          channel: row.channel,
          language: row.language,
          subject: row.subject,
          bodyHtml: row.bodyHtml,
          isCustomized: true,
        };
      }

      // Fall back to .hbs file for any channel
      const eventDir = eventType.replace(/\./g, '/');
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const ocppTemplatesDir =
        process.env['OCPP_TEMPLATES_DIR'] ??
        resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');
      const apiTemplatesDir =
        process.env['API_TEMPLATES_DIR'] ?? resolve(currentDir, '..', 'templates');

      const defaultSubject = getDefaultSubject(eventType, channel);

      const candidates = [
        resolve(ocppTemplatesDir, language, eventDir, `${channel}.hbs`),
        resolve(ocppTemplatesDir, 'en', eventDir, `${channel}.hbs`),
        resolve(apiTemplatesDir, language, eventDir, `${channel}.hbs`),
        resolve(apiTemplatesDir, 'en', eventDir, `${channel}.hbs`),
      ];

      for (const filePath of candidates) {
        try {
          const content = await readFile(filePath, 'utf-8');
          return {
            eventType,
            channel,
            language,
            subject: defaultSubject,
            bodyHtml: content,
            isCustomized: false,
          };
        } catch {
          // try next candidate
        }
      }
      const defaultBody = generateDefaultTemplate(eventType, channel);
      return {
        eventType,
        channel,
        language,
        subject: defaultSubject,
        bodyHtml: defaultBody,
        isCustomized: false,
      };
    },
  );

  app.put(
    '/notification-templates',
    {
      onRequest: [authorize('notifications:write')],
      schema: {
        tags: ['Notifications'],
        summary: 'Create or update a notification template',
        operationId: 'upsertNotificationTemplate',
        security: [{ bearerAuth: [] }],
        body: zodSchema(templateUpsertBody),
        response: { 200: itemResponse(notificationTemplateDbItem) },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof templateUpsertBody>;
      const [saved] = await db
        .insert(notificationTemplates)
        .values({
          eventType: body.eventType,
          channel: body.channel,
          language: body.language,
          subject: body.subject ?? null,
          bodyHtml: body.bodyHtml ?? null,
        })
        .onConflictDoUpdate({
          target: [
            notificationTemplates.eventType,
            notificationTemplates.channel,
            notificationTemplates.language,
          ],
          set: {
            subject: body.subject ?? null,
            bodyHtml: body.bodyHtml ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();
      return saved;
    },
  );

  app.delete(
    '/notification-templates',
    {
      onRequest: [authorize('notifications:write')],
      schema: {
        tags: ['Notifications'],
        summary: 'Delete a notification template',
        operationId: 'deleteNotificationTemplate',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(templateCrudQuery),
        response: { 200: successResponse },
      },
    },
    async (request) => {
      const { eventType, channel, language } = request.query as z.infer<typeof templateCrudQuery>;
      await db
        .delete(notificationTemplates)
        .where(
          and(
            eq(notificationTemplates.eventType, eventType),
            eq(notificationTemplates.channel, channel),
            eq(notificationTemplates.language, language),
          ),
        );

      return { success: true };
    },
  );

  app.post(
    '/notification-templates/preview',
    {
      onRequest: [authorize('notifications:write')],
      schema: {
        tags: ['Notifications'],
        summary: 'Preview a notification template with sample data',
        operationId: 'previewNotificationTemplate',
        security: [{ bearerAuth: [] }],
        body: zodSchema(templatePreviewBody),
        response: { 200: itemResponse(templatePreviewResponse) },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof templatePreviewBody>;

      const [[companyRow], [wrapperRow]] = await Promise.all([
        db.select().from(settings).where(eq(settings.key, 'company.name')).limit(1),
        db.select().from(settings).where(eq(settings.key, 'email.wrapperTemplate')).limit(1),
      ]);
      const companyName = (companyRow?.value as string | undefined) ?? 'EVtivity';
      const wrapperTemplate = (wrapperRow?.value as string | undefined) ?? null;

      const companySettings = await db
        .select()
        .from(settings)
        .where(eq(settings.key, 'company.currency'))
        .limit(1);
      const companyCurrency = (companySettings[0]?.value as string | undefined) ?? 'USD';

      const allCompanySettings = await db.select().from(settings);
      const companyMap = new Map<string, string>();
      for (const row of allCompanySettings) {
        if (typeof row.value === 'string') companyMap.set(row.key, row.value);
      }

      const sampleVariables = {
        companyName,
        companyCurrency,
        companyContactEmail: companyMap.get('company.contactEmail') ?? '',
        companySupportEmail: companyMap.get('company.supportEmail') ?? '',
        companySupportPhone: companyMap.get('company.supportPhone') ?? '',
        companyStreet: companyMap.get('company.street') ?? '',
        companyCity: companyMap.get('company.city') ?? '',
        companyState: companyMap.get('company.state') ?? '',
        companyZip: companyMap.get('company.zip') ?? '',
        companyCountry: companyMap.get('company.country') ?? '',
        siteName: 'Downtown Charging Hub',
        stationId: 'STATION-001',
        transactionId: 'TXN-12345',
        occurredAt: new Date().toISOString(),
        energyDeliveredWh: 15000,
        finalCostCents: 1250,
        currentCostCents: 800,
        currency: 'USD',
        durationMinutes: 45,
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        endedAt: new Date().toISOString(),
        amountCents: 1250,
        evseId: 1,
        connectorId: 1,
        stationName: 'Main Street Charger',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
      };

      const renderedSubject = body.subject
        ? Handlebars.compile(body.subject)(sampleVariables)
        : null;
      let renderedBodyHtml = body.bodyHtml
        ? Handlebars.compile(body.bodyHtml)(sampleVariables)
        : null;

      if (body.channel === 'email' && renderedBodyHtml != null) {
        renderedBodyHtml = wrapEmailHtml(
          renderedBodyHtml,
          companyName,
          wrapperTemplate,
          sampleVariables,
        );
      }

      return {
        subject: renderedSubject,
        bodyHtml: renderedBodyHtml,
      };
    },
  );
}
