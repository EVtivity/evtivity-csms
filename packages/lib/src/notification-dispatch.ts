// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import postgres from 'postgres';
import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import { readFile } from 'node:fs/promises';
import { createLogger } from './logger.js';
import { decryptString } from './encryption.js';
import { formatDateTime } from './timezone.js';
import { isPrivateUrl } from './url-validation.js';
import type { PubSubClient } from './pubsub.js';

const logger = createLogger('notification-dispatch');

// --- Types ---

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export interface NotificationSettings {
  smtp: SmtpConfig | null;
  twilio: TwilioConfig | null;
  emailWrapperTemplate: string | null;
}

export interface Recipient {
  address: string;
  language: string;
}

export interface RenderedTemplate {
  subject: string;
  body: string;
  html?: string;
}

// --- Date formatting for notifications ---

export const DATE_VARIABLE_NAMES = ['startedAt', 'endedAt', 'expiresAt', 'occurredAt'];

export function formatDateVariables(
  variables: Record<string, unknown>,
  timezone: string,
): Record<string, unknown> {
  const result = { ...variables };
  for (const key of DATE_VARIABLE_NAMES) {
    const val = result[key];
    if (typeof val === 'string' && val.length > 0) {
      result[key] = formatDateTime(val, timezone);
    }
  }
  return result;
}

// --- Default email wrapper ---

export const DEFAULT_EMAIL_WRAPPER = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!--[if mso]>
<style type="text/css">
  table { border-collapse: collapse; border-spacing: 0; margin: 0; }
  td, th { font-family: Arial, sans-serif; }
</style>
<![endif]-->
</head>
<body style="margin:0;padding:16px;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1a1a1a;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border-spacing:0;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <tr>
      <td align="center" style="padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;border-collapse:collapse;border-spacing:0;background-color:#ffffff;border-radius:8px;overflow:hidden;mso-table-lspace:0pt;mso-table-rspace:0pt;">
          <tr>
            <td align="center" style="background-color:#2563eb;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">{{companyName}}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 24px;color:#1a1a1a;font-size:16px;line-height:1.6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              {{{content}}}
            </td>
          </tr>
          <tr>
            <td align="center" style="background-color:#f9fafb;padding:16px 24px;border-top:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              <p style="color:#9ca3af;font-size:12px;margin:0 0 4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">{{companyName}}</p>
              <p style="color:#9ca3af;font-size:11px;margin:0 0 4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">{{companyStreet}}{{#if companyCity}}, {{companyCity}}{{/if}}{{#if companyState}}, {{companyState}}{{/if}} {{companyZip}}{{#if companyCountry}}, {{companyCountry}}{{/if}}</p>
              <p style="color:#9ca3af;font-size:11px;margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">{{#if companyContactEmail}}{{companyContactEmail}}{{/if}}{{#if companySupportPhone}} | {{companySupportPhone}}{{/if}}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

export function wrapEmailHtml(
  bodyHtml: string,
  companyName: string,
  wrapperTemplate?: string | null,
  variables?: Record<string, unknown>,
): string {
  const template =
    wrapperTemplate != null && wrapperTemplate !== '' ? wrapperTemplate : DEFAULT_EMAIL_WRAPPER;
  return compileTemplate(template, { content: bodyHtml, companyName, ...variables });
}

// --- Settings cache ---

const CACHE_TTL_MS = 5 * 60 * 1000;
let settingsCache: { settings: NotificationSettings; expiresAt: number } | null = null;

function getEncryptionKey(): string | null {
  const key = process.env['SETTINGS_ENCRYPTION_KEY'];
  if (key == null || key === '') return null;
  return key;
}

export async function getNotificationSettings(sql: postgres.Sql): Promise<NotificationSettings> {
  if (settingsCache != null && settingsCache.expiresAt > Date.now()) {
    return settingsCache.settings;
  }

  const rows = await sql`
    SELECT key, value FROM settings
    WHERE key LIKE 'smtp.%' OR key LIKE 'twilio.%' OR key = 'email.wrapperTemplate'
  `;

  const map = new Map<string, unknown>();
  for (const row of rows) {
    map.set(row.key as string, row.value);
  }

  let smtp: SmtpConfig | null = null;
  const smtpHost = process.env['SMTP_HOST'] ?? (map.get('smtp.host') as string | undefined);
  const smtpUsername = map.get('smtp.username') as string | undefined;
  if (smtpHost != null && smtpHost !== '') {
    const encryptionKey = getEncryptionKey();
    const rawPassword = map.get('smtp.password') as string | undefined;
    let password = '';
    if (rawPassword != null && rawPassword !== '' && encryptionKey != null) {
      try {
        password = decryptString(rawPassword, encryptionKey);
      } catch {
        logger.warn('Failed to decrypt SMTP password');
      }
    }
    smtp = {
      host: smtpHost,
      port: Number(map.get('smtp.port') ?? 587),
      username: smtpUsername ?? '',
      password,
      from: (map.get('smtp.from') as string | undefined) ?? '',
    };
  }

  let twilio: TwilioConfig | null = null;
  const twilioSid = map.get('twilio.accountSid') as string | undefined;
  if (twilioSid != null && twilioSid !== '') {
    const encryptionKey = getEncryptionKey();
    const rawToken = map.get('twilio.authToken') as string | undefined;
    let authToken = '';
    if (rawToken != null && rawToken !== '' && encryptionKey != null) {
      try {
        authToken = decryptString(rawToken, encryptionKey);
      } catch {
        logger.warn('Failed to decrypt Twilio auth token');
      }
    }
    twilio = {
      accountSid: twilioSid,
      authToken,
      fromNumber: (map.get('twilio.fromNumber') as string | undefined) ?? '',
    };
  }

  const emailWrapperTemplate = (map.get('email.wrapperTemplate') as string | undefined) ?? null;
  const settings: NotificationSettings = { smtp, twilio, emailWrapperTemplate };
  settingsCache = { settings, expiresAt: Date.now() + CACHE_TTL_MS };
  return settings;
}

// --- Recipients ---

export function resolveRecipients(_sql: postgres.Sql, recipientSpec: string): Recipient[] {
  if (recipientSpec.trim() === '') return [];
  return [{ address: recipientSpec, language: 'en' }];
}

// --- Templates ---

const TEMPLATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const compiledTemplateCache = new Map<
  string,
  { compiled: HandlebarsTemplateDelegate; cachedAt: number }
>();

const fileContentCache = new Map<string, { content: string; cachedAt: number }>();

export async function loadTemplateFile(filePath: string): Promise<string | null> {
  const now = Date.now();
  const cached = fileContentCache.get(filePath);
  if (cached != null && now - cached.cachedAt < TEMPLATE_CACHE_TTL_MS) {
    return cached.content;
  }
  try {
    const content = await readFile(filePath, 'utf-8');
    fileContentCache.set(filePath, { content, cachedAt: now });
    return content;
  } catch {
    return null;
  }
}

export async function loadDbTemplate(
  sql: postgres.Sql,
  eventType: string,
  channel: string,
  language: string,
): Promise<{ subject: string | null; bodyHtml: string | null } | null> {
  const rows = await sql`
    SELECT subject, body_html
    FROM notification_templates
    WHERE event_type = ${eventType} AND channel = ${channel} AND language = ${language}
    LIMIT 1
  `;
  const row = rows[0];
  if (row == null) return null;
  return {
    subject: (row.subject as string | null) ?? null,
    bodyHtml: (row.body_html as string | null) ?? null,
  };
}

export function compileTemplate(source: string, variables: Record<string, unknown>): string {
  const now = Date.now();
  const cached = compiledTemplateCache.get(source);
  if (cached != null && now - cached.cachedAt < TEMPLATE_CACHE_TTL_MS) {
    return cached.compiled(variables);
  }
  const compiled = Handlebars.compile(source);
  compiledTemplateCache.set(source, { compiled, cachedAt: now });
  return compiled(variables);
}

const FRIENDLY_SUBJECTS: Record<string, string> = {
  'session.Started': '{{{companyName}}} - Your charging session has started',
  'session.Updated': '{{{companyName}}} - Charging session update',
  'session.Completed': '{{{companyName}}} - Your charging session is complete',
  'session.PaymentReceived': '{{{companyName}}} - Payment received',
  'session.Faulted': '{{{companyName}}} - Charging session failed to start',
  'driver.Welcome': '{{{companyName}}} - Welcome',
  'driver.ForgotPassword': '{{{companyName}}} - Reset your password',
  'driver.PasswordChanged': '{{{companyName}}} - Password changed',
  'driver.AccountVerification': '{{{companyName}}} - Verify your account',
  'payment.Complete': '{{{companyName}}} - Payment confirmation',
  'payment.Refunded': '{{{companyName}}} - Refund processed',
  'payment.PreAuthFailed': '{{{companyName}}} - Payment authorization failed',
  'payment.CaptureFailed': '{{{companyName}}} - Payment capture failed',
  'payment.MissingPaymentMethod': '{{{companyName}}} - Payment method required',
  'reservation.Expiring': '{{{companyName}}} - Your reservation is expiring soon',
  'reservation.Expired': '{{{companyName}}} - Your reservation has expired',
  'session.Receipt': '{{{companyName}}} - Charging session receipt',
  'session.IdlingStarted': '{{{companyName}}} - Your vehicle has stopped charging',
  'supportCase.Created': '{{{companyName}}} - Your support case has been opened',
  'supportCase.OperatorReply': '{{{companyName}}} - New reply on your support case',
  'supportCase.Resolved': '{{{companyName}}} - Your support case has been resolved',
  'mfa.VerificationCode': '{{{companyName}}} - Your verification code',
  'operator.ForgotPassword': '{{{companyName}}} - Reset your password',
  'operator.UserCreated': '{{{companyName}}} - Set your password to get started',
  'operator.PasswordChanged': '{{{companyName}}} - Password changed',
  'report.Scheduled': '{{{companyName}}} - Scheduled report',
};

function defaultSubject(eventType: string, variables: Record<string, unknown>): string {
  const friendly = FRIENDLY_SUBJECTS[eventType];
  if (friendly != null) return compileTemplate(friendly, variables);
  return compileTemplate('{{companyName}} - {{eventType}} Notification', {
    ...variables,
    eventType,
  });
}

export async function renderTemplate(
  channel: string,
  eventType: string,
  language: string,
  variables: Record<string, unknown>,
  sql?: postgres.Sql,
  templateHtmlOverride?: string | null,
  templatesDir?: string | string[],
): Promise<RenderedTemplate> {
  // Priority 1: Rule-level HTML override (OCPP rules only)
  if (templateHtmlOverride != null && templateHtmlOverride !== '') {
    const rendered = compileTemplate(templateHtmlOverride, variables);
    const result: RenderedTemplate = {
      subject: defaultSubject(eventType, variables),
      body: rendered,
    };
    if (channel === 'email') result.html = rendered;
    return result;
  }

  // Priority 2: Check DB for custom template
  if (sql != null) {
    let dbTemplate = await loadDbTemplate(sql, eventType, channel, language);
    if (dbTemplate == null && language !== 'en') {
      dbTemplate = await loadDbTemplate(sql, eventType, channel, 'en');
    }
    if (dbTemplate != null && dbTemplate.bodyHtml != null) {
      const subject =
        dbTemplate.subject != null
          ? compileTemplate(dbTemplate.subject, variables)
          : defaultSubject(eventType, variables);
      const rendered = compileTemplate(dbTemplate.bodyHtml, variables);
      const result: RenderedTemplate = { subject, body: rendered };
      if (channel === 'email') result.html = rendered;
      return result;
    }
  }

  // Priority 3: File-based .hbs template
  if (templatesDir != null) {
    const { resolve } = await import('node:path');
    const dirs = Array.isArray(templatesDir) ? templatesDir : [templatesDir];
    const eventDir = eventType.replace(/\./g, '/');

    for (const dir of dirs) {
      let content = await loadTemplateFile(resolve(dir, language, eventDir, `${channel}.hbs`));

      if (content == null && language !== 'en') {
        content = await loadTemplateFile(resolve(dir, 'en', eventDir, `${channel}.hbs`));
      }

      if (content != null) {
        const rendered = compileTemplate(content, variables);
        const result: RenderedTemplate = {
          subject: defaultSubject(eventType, variables),
          body: rendered.trim(),
        };
        if (channel === 'email') result.html = rendered;
        return result;
      }
    }
  }

  // Fallback: JSON dump
  return {
    subject: defaultSubject(eventType, variables),
    body: JSON.stringify(variables, null, 2),
  };
}

// --- Channels ---

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export async function sendEmail(
  config: SmtpConfig,
  to: string,
  subject: string,
  body: string,
  html?: string,
  attachments?: EmailAttachment[],
): Promise<boolean> {
  try {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: config.username !== '' ? { user: config.username, pass: config.password } : undefined,
    });
    await transport.sendMail({
      from: config.from,
      to,
      subject,
      text: body,
      html: html ?? undefined,
      attachments: attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
    return true;
  } catch (err) {
    logger.error({ err, to, subject }, 'Failed to send email');
    return false;
  }
}

export async function sendSms(config: TwilioConfig, to: string, body: string): Promise<boolean> {
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
    const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
    const params = new URLSearchParams({
      To: to,
      From: config.fromNumber,
      Body: body,
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text, to }, 'Twilio API error');
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, to }, 'Failed to send SMS');
    return false;
  }
}

export async function sendWebhook(
  url: string,
  subject: string,
  body: string,
  variables: Record<string, unknown>,
): Promise<boolean> {
  if (isPrivateUrl(url)) {
    logger.warn({ url }, 'Blocked webhook to private/internal URL');
    return false;
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, body, ...variables }),
    });
    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text, url }, 'Webhook delivery failed');
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, url }, 'Failed to send webhook');
    return false;
  }
}

export function logNotification(
  channel: string,
  recipient: string,
  subject: string,
  body: string,
): void {
  logger.info({ channel, recipient, subject }, body);
}

// --- Driver notification dispatch ---

export async function dispatchDriverNotification(
  sql: postgres.Sql,
  eventType: string,
  driverId: string,
  variables: Record<string, unknown>,
  templatesDir?: string | string[],
  pubsub?: PubSubClient,
): Promise<void> {
  try {
    // Check if this driver event type is enabled globally
    const settingRows = await sql`
      SELECT is_enabled FROM driver_event_settings
      WHERE event_type = ${eventType}
      LIMIT 1
    `;
    const setting = settingRows[0];
    if (setting != null && !(setting.is_enabled as boolean)) {
      logger.debug({ eventType }, 'Driver event type disabled, skipping');
      return;
    }

    const driverRows = await sql`
      SELECT first_name, last_name, email, phone, language, timezone FROM drivers WHERE id = ${driverId}
    `;
    const driver = driverRows[0];
    if (driver == null) return;

    const firstName = (driver.first_name as string | null) ?? '';
    const lastName = (driver.last_name as string | null) ?? '';
    const email = driver.email as string | null;
    const phone = driver.phone as string | null;
    const language = (driver.language as string | undefined) ?? 'en';
    const timezone = (driver.timezone as string | undefined) ?? 'America/New_York';

    // Resolve company settings
    const companyRows = await sql`
      SELECT key, value FROM settings WHERE key LIKE 'company.%'
    `;
    const companyMap = new Map<string, string>();
    for (const row of companyRows) {
      if (typeof row.value === 'string') companyMap.set(row.key as string, row.value);
    }
    const companyName = companyMap.get('company.name') ?? 'EVtivity';

    // Merge driver info into variables so all driver templates can use them
    const enrichedVariables: Record<string, unknown> = {
      companyName,
      companyCurrency: companyMap.get('company.currency') ?? 'USD',
      companyContactEmail: companyMap.get('company.contactEmail') ?? '',
      companySupportEmail: companyMap.get('company.supportEmail') ?? '',
      companySupportPhone: companyMap.get('company.supportPhone') ?? '',
      companyStreet: companyMap.get('company.street') ?? '',
      companyCity: companyMap.get('company.city') ?? '',
      companyState: companyMap.get('company.state') ?? '',
      companyZip: companyMap.get('company.zip') ?? '',
      companyCountry: companyMap.get('company.country') ?? '',
      firstName,
      lastName,
      email: email ?? '',
      ...variables,
    };

    const formattedVariables = formatDateVariables(enrichedVariables, timezone);

    // Check driver notification preferences
    const prefRows = await sql`
      SELECT email_enabled, sms_enabled
      FROM driver_notification_preferences
      WHERE driver_id = ${driverId}
    `;
    const prefs = prefRows[0];
    const emailEnabled = prefs != null ? (prefs.email_enabled as boolean) : true;
    const smsEnabled = prefs != null ? (prefs.sms_enabled as boolean) : true;

    const notificationSettings = await getNotificationSettings(sql);

    // Send email (only when SMTP is configured)
    if (emailEnabled && email != null && email !== '' && notificationSettings.smtp != null) {
      const rendered = await renderTemplate(
        'email',
        eventType,
        language,
        formattedVariables,
        sql,
        undefined,
        templatesDir,
      );
      const wrappedHtml =
        rendered.html != null
          ? wrapEmailHtml(
              rendered.html,
              companyName,
              notificationSettings.emailWrapperTemplate,
              formattedVariables,
            )
          : undefined;

      const ok = await sendEmail(
        notificationSettings.smtp,
        email,
        rendered.subject,
        rendered.body,
        wrappedHtml,
      );
      const status = ok ? 'sent' : 'failed';
      const storedBody = wrappedHtml ?? rendered.body;
      await sql`
        INSERT INTO notifications (channel, recipient, subject, body, status, event_type, sent_at, metadata)
        VALUES ('email', ${email}, ${rendered.subject}, ${storedBody}, ${status}, ${eventType}, NOW(), ${sql.json({ driverId })})
      `;
    }

    // Send SMS (only when Twilio is configured)
    if (smsEnabled && phone != null && phone !== '' && notificationSettings.twilio != null) {
      const rendered = await renderTemplate(
        'sms',
        eventType,
        language,
        formattedVariables,
        sql,
        undefined,
        templatesDir,
      );

      const ok = await sendSms(notificationSettings.twilio, phone, rendered.body);
      const status = ok ? 'sent' : 'failed';
      await sql`
        INSERT INTO notifications (channel, recipient, subject, body, status, event_type, sent_at, metadata)
        VALUES ('sms', ${phone}, ${rendered.subject}, ${rendered.body}, ${status}, ${eventType}, NOW(), ${sql.json({ driverId })})
      `;
    }

    // Always insert a push notification for the in-app portal notification drawer.
    // This is independent of email/SMS availability.
    // Push stores a JSON body with title and plain-text message (rendered from SMS template).
    const pushRendered = await renderTemplate(
      'sms',
      eventType,
      language,
      formattedVariables,
      sql,
      undefined,
      templatesDir,
    );
    const pushBody = JSON.stringify({
      title: pushRendered.subject,
      message: pushRendered.body,
    });
    await sql`
      INSERT INTO notifications (channel, recipient, subject, body, status, event_type, sent_at, metadata)
      VALUES ('push', ${driverId}, ${pushRendered.subject}, ${pushBody}, 'sent', ${eventType}, NOW(), ${sql.json({ driverId })})
    `;

    // Notify the portal SSE channel so the bell icon updates in real time
    if (pubsub != null) {
      try {
        await pubsub.publish(
          'portal_events',
          JSON.stringify({ type: 'notification.created', driverId }),
        );
      } catch {
        // Non-critical: bell icon will update on next poll
      }
    }
  } catch (err) {
    logger.error({ err, eventType, driverId }, 'Driver notification dispatch failed');
  }
}

// --- System notification dispatch ---

export async function dispatchSystemNotification(
  sql: postgres.Sql,
  eventType: string,
  recipient: {
    email?: string | undefined;
    phone?: string | undefined;
    firstName?: string | undefined;
    lastName?: string | undefined;
    language?: string | undefined;
    timezone?: string | undefined;
    userId?: string | undefined;
  },
  variables: Record<string, unknown>,
  templatesDir?: string | string[],
): Promise<void> {
  try {
    // Check if this system event type is enabled
    const settingRows = await sql`
      SELECT is_enabled FROM system_event_settings
      WHERE event_type = ${eventType}
      LIMIT 1
    `;
    const setting = settingRows[0];
    if (setting != null && !(setting.is_enabled as boolean)) {
      logger.debug({ eventType }, 'System event type disabled, skipping');
      return;
    }

    // Resolve company settings
    const companyRows = await sql`
      SELECT key, value FROM settings WHERE key LIKE 'company.%'
    `;
    const companyMap = new Map<string, string>();
    for (const row of companyRows) {
      if (typeof row.value === 'string') companyMap.set(row.key as string, row.value);
    }
    const companyName = companyMap.get('company.name') ?? 'EVtivity';

    const email = recipient.email ?? undefined;
    const phone = recipient.phone ?? undefined;
    const language = recipient.language ?? 'en';
    const timezone = recipient.timezone ?? 'America/New_York';

    const enrichedVariables: Record<string, unknown> = {
      companyName,
      companyCurrency: companyMap.get('company.currency') ?? 'USD',
      companyContactEmail: companyMap.get('company.contactEmail') ?? '',
      companySupportEmail: companyMap.get('company.supportEmail') ?? '',
      companySupportPhone: companyMap.get('company.supportPhone') ?? '',
      companyStreet: companyMap.get('company.street') ?? '',
      companyCity: companyMap.get('company.city') ?? '',
      companyState: companyMap.get('company.state') ?? '',
      companyZip: companyMap.get('company.zip') ?? '',
      companyCountry: companyMap.get('company.country') ?? '',
      firstName: recipient.firstName ?? '',
      lastName: recipient.lastName ?? '',
      email: email ?? '',
      ...variables,
    };

    const formattedVariables = formatDateVariables(enrichedVariables, timezone);

    const notificationSettings = await getNotificationSettings(sql);

    // Send email (only when SMTP is configured)
    if (email != null && email !== '' && notificationSettings.smtp != null) {
      const rendered = await renderTemplate(
        'email',
        eventType,
        language,
        formattedVariables,
        sql,
        undefined,
        templatesDir,
      );
      const wrappedHtml =
        rendered.html != null
          ? wrapEmailHtml(
              rendered.html,
              companyName,
              notificationSettings.emailWrapperTemplate,
              formattedVariables,
            )
          : undefined;

      const ok = await sendEmail(
        notificationSettings.smtp,
        email,
        rendered.subject,
        rendered.body,
        wrappedHtml,
      );
      const status = ok ? 'sent' : 'failed';
      const storedBody = wrappedHtml ?? rendered.body;
      await sql`
        INSERT INTO notifications (channel, recipient, subject, body, status, event_type, sent_at, metadata)
        VALUES ('email', ${email}, ${rendered.subject}, ${storedBody}, ${status}, ${eventType}, NOW(), ${sql.json({})})
      `;
    }

    // Check operator SMS preferences (opt-out)
    let smsEnabled = true;
    if (recipient.userId != null) {
      const prefRows = await sql`
        SELECT sms_enabled FROM user_notification_preferences
        WHERE user_id = ${recipient.userId}
        LIMIT 1
      `;
      if (prefRows[0] != null) {
        smsEnabled = prefRows[0].sms_enabled as boolean;
      }
    }

    // Send SMS (only when Twilio is configured and SMS not opted out)
    if (smsEnabled && phone != null && phone !== '' && notificationSettings.twilio != null) {
      const rendered = await renderTemplate(
        'sms',
        eventType,
        language,
        formattedVariables,
        sql,
        undefined,
        templatesDir,
      );

      const ok = await sendSms(notificationSettings.twilio, phone, rendered.body);
      const status = ok ? 'sent' : 'failed';
      await sql`
        INSERT INTO notifications (channel, recipient, subject, body, status, event_type, sent_at, metadata)
        VALUES ('sms', ${phone}, ${rendered.subject}, ${rendered.body}, ${status}, ${eventType}, NOW(), ${sql.json({})})
      `;
    }
  } catch (err) {
    logger.error({ err, eventType }, 'System notification dispatch failed');
  }
}
