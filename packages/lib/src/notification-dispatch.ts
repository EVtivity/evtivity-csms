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
import { sendExpoPush } from './push-send.js';
import type { PubSubClient } from './pubsub.js';

const logger = createLogger('notification-dispatch');

// --- Types ---

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  /** Set when the encrypted password could not be decrypted. The dispatcher
   * still attempts to send (with an empty password) so operators see a real
   * SMTP error in the history, but stamps this reason on the failed row so
   * the actual root cause is visible without log-trawling. */
  credentialError?: 'decrypt_failed';
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  credentialError?: 'decrypt_failed';
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

// --- Sensitive content redaction for notification history rows ---

// Notification bodies and subjects sometimes contain secrets that should
// not survive in the `notifications` table: MFA verification codes, reset
// password tokens, magic-link tokens, account verification links. The
// recipient still receives the real value via email/SMS/push -- we just
// don't keep a queryable copy in the DB after delivery.
//
// Event-type-scoped so a normal session receipt or station alert keeps its
// full body (the operator needs the rendered text for debugging). Add new
// event types here when their templates include credentials or tokens.
const SENSITIVE_EVENT_TYPES = new Set([
  'mfa.VerificationCode',
  'driver.ForgotPassword',
  'driver.AccountVerification',
  'driver.Welcome',
  'driver.PasswordChanged',
  'operator.ForgotPassword',
  'operator.AccountVerification',
  'operator.Welcome',
]);

// Replace 6-digit codes (OTP/MFA) and known token-bearing URL parameters
// with a fixed marker. Best-effort regex pass over an arbitrary HTML/text
// body; over-redaction in a sensitive event is preferable to leaking the
// real value into the audit-visible history table.
export function redactSensitiveNotificationContent(text: string, eventType: string): string {
  if (!SENSITIVE_EVENT_TYPES.has(eventType)) return text;
  return text
    .replace(
      /([?&](?:token|code|verifyToken|verificationToken|magicToken|resetToken|otp)=)[^&\s"'<>]+/gi,
      '$1<redacted>',
    )
    .replace(/\b\d{6}\b/g, '<redacted>');
}

// --- Date formatting for notifications ---

export const DATE_VARIABLE_NAMES = [
  'startedAt',
  'endedAt',
  'expiresAt',
  'occurredAt',
  'issuedAt',
  'dueAt',
];

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
  const customTemplate = wrapperTemplate != null && wrapperTemplate !== '' ? wrapperTemplate : null;
  if (customTemplate != null) {
    try {
      return compileTemplate(customTemplate, { ...variables, content: bodyHtml, companyName });
    } catch (err) {
      // A bad operator-edited wrapper template would otherwise throw and
      // bail out of the whole dispatch, swallowing every outbound email
      // (the failure record is also skipped because the throw happens
      // before the INSERT). Fall back to the default wrapper so mail keeps
      // flowing while the operator notices and fixes the syntax error.
      logger.warn({ err }, 'email.wrapperTemplate failed to compile; using default wrapper');
    }
  }
  return compileTemplate(DEFAULT_EMAIL_WRAPPER, {
    ...variables,
    content: bodyHtml,
    companyName,
  });
}

// --- Settings cache ---

// 60s matches PnC, roaming, free-vend, and the other site-level feature
// readers. The previous 5-minute window meant a multi-pod fleet served
// stale SMTP/Twilio creds for up to 5 minutes after the operator rotated
// them on another pod -- well outside what operators expect from a "save
// and test" loop.
const CACHE_TTL_MS = 60 * 1000;
let settingsCache: { settings: NotificationSettings; expiresAt: number } | null = null;

/**
 * Drop the cached SMTP/Twilio/wrapper, company, and system timezone settings
 * so the next dispatch reads fresh values from the database. Call this after
 * the API mutates any of `smtp.*`, `twilio.*`, `email.wrapperTemplate`,
 * `company.*`, or `system.timezone` so the change takes effect immediately
 * on the pod that handled the mutation instead of after the 60s TTL. Other
 * pods still wait the TTL, which is acceptable because these settings change
 * rarely.
 */
export function clearNotificationSettingsCache(): void {
  settingsCache = null;
  companyCache = null;
  systemTimezoneCache = null;
}

interface CompanySettings {
  companyName: string;
  companyCurrency: string;
  companyContactEmail: string;
  companySupportEmail: string;
  companySupportPhone: string;
  companyStreet: string;
  companyCity: string;
  companyState: string;
  companyZip: string;
  companyCountry: string;
}

let companyCache: { settings: CompanySettings; expiresAt: number } | null = null;

let systemTimezoneCache: { value: string; expiresAt: number } | null = null;

export async function getSystemTimezoneCached(sql: postgres.Sql): Promise<string> {
  if (systemTimezoneCache != null && systemTimezoneCache.expiresAt > Date.now()) {
    return systemTimezoneCache.value;
  }
  const rows = await sql`SELECT value FROM settings WHERE key = 'system.timezone' LIMIT 1`;
  const value = (rows[0]?.value as string | undefined) ?? 'America/New_York';
  systemTimezoneCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function getCompanySettings(sql: postgres.Sql): Promise<CompanySettings> {
  if (companyCache != null && companyCache.expiresAt > Date.now()) {
    return companyCache.settings;
  }
  const rows = await sql`SELECT key, value FROM settings WHERE key LIKE 'company.%'`;
  const map = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.value === 'string') map.set(row.key as string, row.value);
  }
  const settings: CompanySettings = {
    companyName: map.get('company.name') ?? 'EVtivity',
    companyCurrency: map.get('company.currency') ?? 'USD',
    companyContactEmail: map.get('company.contactEmail') ?? '',
    companySupportEmail: map.get('company.supportEmail') ?? '',
    companySupportPhone: map.get('company.supportPhone') ?? '',
    companyStreet: map.get('company.street') ?? '',
    companyCity: map.get('company.city') ?? '',
    companyState: map.get('company.state') ?? '',
    companyZip: map.get('company.zip') ?? '',
    companyCountry: map.get('company.country') ?? '',
  };
  companyCache = { settings, expiresAt: Date.now() + CACHE_TTL_MS };
  return settings;
}

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
    const rawPassword = map.get('smtp.passwordEnc') as string | undefined;
    let password = '';
    let smtpCredentialError: 'decrypt_failed' | undefined;
    if (rawPassword != null && rawPassword !== '' && encryptionKey != null) {
      try {
        password = decryptString(rawPassword, encryptionKey);
      } catch {
        logger.warn('Failed to decrypt SMTP password');
        smtpCredentialError = 'decrypt_failed';
      }
    }
    smtp = {
      host: smtpHost,
      port: Number(map.get('smtp.port') ?? 587),
      username: smtpUsername ?? '',
      password,
      from: (map.get('smtp.from') as string | undefined) ?? '',
      ...(smtpCredentialError != null ? { credentialError: smtpCredentialError } : {}),
    };
  }

  let twilio: TwilioConfig | null = null;
  const twilioSid = map.get('twilio.accountSid') as string | undefined;
  if (twilioSid != null && twilioSid !== '') {
    const encryptionKey = getEncryptionKey();
    const rawToken = map.get('twilio.authTokenEnc') as string | undefined;
    let authToken = '';
    let twilioCredentialError: 'decrypt_failed' | undefined;
    if (rawToken != null && rawToken !== '' && encryptionKey != null) {
      try {
        authToken = decryptString(rawToken, encryptionKey);
      } catch {
        logger.warn('Failed to decrypt Twilio auth token');
        twilioCredentialError = 'decrypt_failed';
      }
    }
    twilio = {
      accountSid: twilioSid,
      authToken,
      fromNumber: (map.get('twilio.fromNumber') as string | undefined) ?? '',
      ...(twilioCredentialError != null ? { credentialError: twilioCredentialError } : {}),
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
  'driver.MfaDisabled': '{{{companyName}}} - Two-factor authentication disabled',
  'driver.AccountVerification': '{{{companyName}}} - Verify your account',
  'payment.Complete': '{{{companyName}}} - Payment confirmation',
  'payment.Refunded': '{{{companyName}}} - Refund processed',
  'payment.PreAuthFailed': '{{{companyName}}} - Payment authorization failed',
  'payment.CaptureFailed': '{{{companyName}}} - Payment capture failed',
  'payment.MissingPaymentMethod': '{{{companyName}}} - Payment method required',
  'reservation.Created': '{{{companyName}}} - Reservation confirmed',
  'reservation.Cancelled': '{{{companyName}}} - Reservation cancelled',
  'reservation.Expiring': '{{{companyName}}} - Your reservation is expiring soon',
  'reservation.Expired': '{{{companyName}}} - Your reservation has expired',
  'reservation.StationFaulted': '{{{companyName}}} - Reserved station is unavailable',
  'invoice.Sent': '{{{companyName}}} - Invoice {{invoiceNumber}}',
  'watch.StationAvailable': '{{{companyName}}} - {{stationName}} is now available',
  'token.Added': '{{{companyName}}} - New RFID card added to your account',
  'token.Removed': '{{{companyName}}} - RFID card removed from your account',
  'token.Deactivated': '{{{companyName}}} - RFID card deactivated',
  'token.Reactivated': '{{{companyName}}} - RFID card reactivated',
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
    // Cap connect/greeting/send to 10s each so a black-holed SMTP server
    // can't stall the dispatcher chain. Matches the 10s timeout in
    // sendSms (Twilio) and sendWebhook so all three channels degrade
    // uniformly under upstream latency.
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: config.username !== '' ? { user: config.username, pass: config.password } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
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

/**
 * Best-effort E.164 normalization. Strips whitespace and punctuation
 * (`( ) - .`), keeps the leading `+` if present, and tags a US country code
 * onto bare 10-digit / `1`-prefixed 11-digit numbers (the operator's most
 * common formatting mistake on a US driver row). Anything else is returned
 * with just the cosmetic punctuation stripped, so an obviously international
 * number passes through untouched and Twilio can apply its own normalization.
 */
export function normalizeE164(phone: string): string {
  const cleaned = phone.replace(/[\s().-]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (/^[0-9]{10}$/.test(cleaned)) return `+1${cleaned}`;
  if (/^1[0-9]{10}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}

export async function sendSms(config: TwilioConfig, to: string, body: string): Promise<boolean> {
  const normalizedTo = normalizeE164(to);
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
    const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
    const params = new URLSearchParams({
      To: normalizedTo,
      From: config.fromNumber,
      Body: body,
    });
    // Cap each delivery at 10s so a hanging Twilio request does not stall the
    // notification dispatcher indefinitely.
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text, to: normalizedTo }, 'Twilio API error');
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, to: normalizedTo }, 'Failed to send SMS');
    return false;
  }
}

export type WebhookResult =
  | 'ok'
  | 'blocked_private_url'
  | 'http_error'
  | 'network_error'
  | 'timeout';

export async function sendWebhook(
  url: string,
  subject: string,
  body: string,
  variables: Record<string, unknown>,
): Promise<WebhookResult> {
  if (isPrivateUrl(url)) {
    logger.warn({ url }, 'Blocked webhook to private/internal URL');
    return 'blocked_private_url';
  }
  // Cap each delivery at 10s. Without an AbortController the fetch can hang
  // indefinitely on a slow or stalled webhook endpoint and starve subsequent
  // dispatches in the same dispatcher chain.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, body, ...variables }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text, url }, 'Webhook delivery failed');
      return 'http_error';
    }
    return 'ok';
  } catch (err) {
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
    logger.error({ err, url }, isAbort ? 'Webhook timed out' : 'Failed to send webhook');
    return isAbort ? 'timeout' : 'network_error';
  } finally {
    clearTimeout(timer);
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

    // Driver row, notification preferences, company settings, and SMTP/Twilio
    // settings are independent — fan them out so dispatch latency is bounded
    // by the slowest single query instead of the sum.
    const [driverRows, prefRows, company, notificationSettings] = await Promise.all([
      sql`
        SELECT first_name, last_name, email, phone, language, timezone FROM drivers WHERE id = ${driverId}
      `,
      sql`
        SELECT email_enabled, sms_enabled, push_enabled
        FROM driver_notification_preferences
        WHERE driver_id = ${driverId}
      `,
      getCompanySettings(sql),
      getNotificationSettings(sql),
    ]);
    const driver = driverRows[0];
    if (driver == null) return;

    const firstName = (driver.first_name as string | null) ?? '';
    const lastName = (driver.last_name as string | null) ?? '';
    const email = driver.email as string | null;
    const phone = driver.phone as string | null;
    const language = (driver.language as string | undefined) ?? 'en';
    const timezone = (driver.timezone as string | undefined) ?? 'America/New_York';

    const companyName = company.companyName;

    // Merge driver info into variables so all driver templates can use them
    const enrichedVariables: Record<string, unknown> = {
      ...company,
      firstName,
      lastName,
      email: email ?? '',
      ...variables,
    };

    const formattedVariables = formatDateVariables(enrichedVariables, timezone);

    const prefs = prefRows[0];
    const emailEnabled = prefs != null ? (prefs.email_enabled as boolean) : true;
    const smsEnabled = prefs != null ? (prefs.sms_enabled as boolean) : true;
    const pushEnabled = prefs != null ? (prefs.push_enabled as boolean) : true;

    // Email path. Records a row for every attempt the dispatcher could have
    // made -- including the "skipped because no address on file" and
    // "skipped because SMTP not configured" cases -- so the operator can
    // always answer "did the system try to email this driver?" from the
    // notifications table alone.
    if (emailEnabled) {
      let status: 'sent' | 'failed' = 'failed';
      let failureReason: string | null = null;
      let storedSubject = `[${eventType}]`;
      let storedBody = '';

      if (email == null || email === '') {
        failureReason = 'recipient_missing';
      } else if (notificationSettings.smtp == null) {
        failureReason = 'smtp_not_configured';
      } else {
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
        status = ok ? 'sent' : 'failed';
        if (!ok) {
          failureReason =
            notificationSettings.smtp.credentialError === 'decrypt_failed'
              ? 'credentials_decrypt_failed'
              : 'smtp_send_failed';
        }
        storedSubject = redactSensitiveNotificationContent(rendered.subject, eventType);
        storedBody = redactSensitiveNotificationContent(wrappedHtml ?? rendered.body, eventType);
      }

      const recipientForRow = email != null && email !== '' ? email : '';
      const metadata: Record<string, string> = { driverId };
      if (failureReason != null) metadata['failureReason'] = failureReason;
      await recordNotificationAttempt(sql, {
        channel: 'email',
        recipient: recipientForRow,
        subject: storedSubject,
        body: storedBody,
        status,
        eventType,
        metadata,
      });
    }

    // Render the SMS template once and reuse it for both the SMS send and
    // the push row below. The push row exists regardless of whether SMS is
    // enabled (it's the in-app bell), so the render always gets used.
    const smsRendered = await renderTemplate(
      'sms',
      eventType,
      language,
      formattedVariables,
      sql,
      undefined,
      templatesDir,
    );

    // SMS path. Same audit-completeness guarantee as the email path above.
    if (smsEnabled) {
      let status: 'sent' | 'failed' = 'failed';
      let failureReason: string | null = null;
      let storedSmsSubject = `[${eventType}]`;
      let storedSmsBody = '';

      if (phone == null || phone === '') {
        failureReason = 'recipient_missing';
      } else if (notificationSettings.twilio == null) {
        failureReason = 'twilio_not_configured';
      } else {
        const ok = await sendSms(notificationSettings.twilio, phone, smsRendered.body);
        status = ok ? 'sent' : 'failed';
        if (!ok) {
          failureReason =
            notificationSettings.twilio.credentialError === 'decrypt_failed'
              ? 'credentials_decrypt_failed'
              : 'twilio_send_failed';
        }
        storedSmsSubject = redactSensitiveNotificationContent(smsRendered.subject, eventType);
        storedSmsBody = redactSensitiveNotificationContent(smsRendered.body, eventType);
      }

      const recipientForRow = phone != null && phone !== '' ? phone : '';
      const metadata: Record<string, string> = { driverId };
      if (failureReason != null) metadata['failureReason'] = failureReason;
      await recordNotificationAttempt(sql, {
        channel: 'sms',
        recipient: recipientForRow,
        subject: storedSmsSubject,
        body: storedSmsBody,
        status,
        eventType,
        metadata,
      });
    }

    // Always insert a push notification for the in-app portal notification drawer.
    // Push stores a JSON body with title and plain-text message (rendered from SMS template).
    const pushBody = JSON.stringify({
      title: smsRendered.subject,
      message: redactSensitiveNotificationContent(smsRendered.body, eventType),
    });
    const pushSubject = redactSensitiveNotificationContent(smsRendered.subject, eventType);
    await recordNotificationAttempt(sql, {
      channel: 'push',
      recipient: driverId,
      subject: pushSubject,
      body: pushBody,
      status: 'sent',
      eventType,
      metadata: { driverId },
    });

    // Deliver native push to the driver's registered devices. The drawer row
    // above is the in-app record; this is the OS-level notification. Best-effort:
    // a failed send never blocks the dispatch, and Expo-reported dead tokens are
    // pruned so they are not retried.
    if (pushEnabled) {
      try {
        const tokenRows = await sql`
          SELECT token FROM driver_push_tokens WHERE driver_id = ${driverId}
        `;
        if (tokenRows.length > 0) {
          const pushTitle = redactSensitiveNotificationContent(smsRendered.subject, eventType);
          const pushMessage = redactSensitiveNotificationContent(smsRendered.body, eventType);
          // Carry stationId when present so the app can deep-link to the station
          // from the push (e.g. the station-watch availability alert).
          const stationIdVar = variables['stationId'];
          const pushData: Record<string, unknown> =
            typeof stationIdVar === 'string' || typeof stationIdVar === 'number'
              ? { eventType, stationId: String(stationIdVar) }
              : { eventType };
          const results = await sendExpoPush(
            tokenRows.map((r) => ({
              to: r.token as string,
              title: pushTitle,
              body: pushMessage,
              data: pushData,
            })),
          );
          const dead = results.filter((r) => r.unregistered).map((r) => r.token);
          const delivered = results.filter((r) => r.ok).map((r) => r.token);
          if (dead.length > 0) {
            await sql`DELETE FROM driver_push_tokens WHERE token = ANY(${dead})`;
          }
          if (delivered.length > 0) {
            await sql`
              UPDATE driver_push_tokens SET last_used_at = NOW() WHERE token = ANY(${delivered})
            `;
          }
        }
      } catch (err) {
        logger.warn({ err, eventType, driverId }, 'Native push delivery failed');
      }
    }

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

/**
 * Single INSERT shape shared by every dispatch path (driver email/SMS/push,
 * system email/SMS, operator forgot-password, OCPP email/webhook). Keeps the
 * `notifications` row contract in one place so a new metadata field can be
 * added without sweeping six call sites.
 */
export async function recordNotificationAttempt(
  sql: postgres.Sql,
  args: {
    channel: 'email' | 'sms' | 'push' | 'webhook' | 'log';
    recipient: string;
    subject: string;
    body: string;
    status: 'sent' | 'failed';
    eventType: string;
    metadata: Record<string, string>;
  },
): Promise<void> {
  await sql`
    INSERT INTO notifications (channel, recipient, subject, body, status, event_type, sent_at, metadata)
    VALUES (${args.channel}, ${args.recipient}, ${args.subject}, ${args.body}, ${args.status}, ${args.eventType}, NOW(), ${sql.json(args.metadata)})
  `;
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

    // Company settings and SMTP/Twilio config are independent — fan them
    // out so cold-cache dispatch isn't bottlenecked by sequential awaits
    // (matches the pattern in dispatchDriverNotification).
    const [company, notificationSettings] = await Promise.all([
      getCompanySettings(sql),
      getNotificationSettings(sql),
    ]);
    const companyName = company.companyName;

    const email = recipient.email ?? undefined;
    const phone = recipient.phone ?? undefined;
    const language = recipient.language ?? 'en';
    const timezone = recipient.timezone ?? 'America/New_York';

    const enrichedVariables: Record<string, unknown> = {
      ...company,
      firstName: recipient.firstName ?? '',
      lastName: recipient.lastName ?? '',
      email: email ?? '',
      ...variables,
    };

    const formattedVariables = formatDateVariables(enrichedVariables, timezone);

    // Email path. Always records a history row so operators can answer
    // "did the system try to email this recipient?" without trawling logs.
    {
      let status: 'sent' | 'failed' = 'failed';
      let failureReason: string | null = null;
      let storedSubject = `[${eventType}]`;
      let storedBody = '';

      if (email == null || email === '') {
        failureReason = 'recipient_missing';
      } else if (notificationSettings.smtp == null) {
        failureReason = 'smtp_not_configured';
      } else {
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
        status = ok ? 'sent' : 'failed';
        if (!ok) {
          failureReason =
            notificationSettings.smtp.credentialError === 'decrypt_failed'
              ? 'credentials_decrypt_failed'
              : 'smtp_send_failed';
        }
        storedSubject = redactSensitiveNotificationContent(rendered.subject, eventType);
        storedBody = redactSensitiveNotificationContent(wrappedHtml ?? rendered.body, eventType);
      }

      const recipientForRow = email != null && email !== '' ? email : '';
      const metadata: Record<string, string> = {};
      if (failureReason != null) metadata['failureReason'] = failureReason;
      await recordNotificationAttempt(sql, {
        channel: 'email',
        recipient: recipientForRow,
        subject: storedSubject,
        body: storedBody,
        status,
        eventType,
        metadata,
      });
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

    // SMS path. Skips writing a row only when the operator explicitly
    // opted out of SMS -- in that case there's no failure to audit, just a
    // preference. Otherwise records the attempt with a failure reason.
    if (smsEnabled) {
      let status: 'sent' | 'failed' = 'failed';
      let failureReason: string | null = null;
      let storedSmsSubject = `[${eventType}]`;
      let storedSmsBody = '';

      if (phone == null || phone === '') {
        failureReason = 'recipient_missing';
      } else if (notificationSettings.twilio == null) {
        failureReason = 'twilio_not_configured';
      } else {
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
        status = ok ? 'sent' : 'failed';
        if (!ok) {
          failureReason =
            notificationSettings.twilio.credentialError === 'decrypt_failed'
              ? 'credentials_decrypt_failed'
              : 'twilio_send_failed';
        }
        storedSmsSubject = redactSensitiveNotificationContent(rendered.subject, eventType);
        storedSmsBody = redactSensitiveNotificationContent(rendered.body, eventType);
      }

      const recipientForRow = phone != null && phone !== '' ? phone : '';
      const metadata: Record<string, string> = {};
      if (failureReason != null) metadata['failureReason'] = failureReason;
      await recordNotificationAttempt(sql, {
        channel: 'sms',
        recipient: recipientForRow,
        subject: storedSmsSubject,
        body: storedSmsBody,
        status,
        eventType,
        metadata,
      });
    }
  } catch (err) {
    logger.error({ err, eventType }, 'System notification dispatch failed');
  }
}
