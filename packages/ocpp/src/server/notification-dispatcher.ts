// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import postgres from 'postgres';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@evtivity/lib';
import type { DomainEvent, PubSubClient } from '@evtivity/lib';
import {
  getNotificationSettings,
  getCompanySettings,
  getSystemTimezoneCached,
  resolveRecipients,
  renderTemplate,
  sendEmail,
  sendWebhook,
  logNotification,
  wrapEmailHtml,
  dispatchDriverNotification as _dispatchDriverNotification,
  dispatchSystemNotification,
  formatDateVariables,
  recordNotificationAttempt,
} from '@evtivity/lib';

export { dispatchSystemNotification };

export function dispatchDriverNotification(
  sql: postgres.Sql,
  eventType: string,
  driverId: string,
  variables: Record<string, unknown>,
  templatesDir?: string | string[],
  pubsub?: PubSubClient,
): Promise<void> {
  return _dispatchDriverNotification(
    sql,
    eventType,
    driverId,
    variables,
    templatesDir ?? ALL_TEMPLATES_DIRS,
    pubsub,
  );
}

const logger = createLogger('notification-dispatcher');

const currentDir = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR =
  process.env['OCPP_TEMPLATES_DIR'] ?? resolve(currentDir, '..', 'templates');
const API_TEMPLATES_DIR =
  process.env['API_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'api', 'src', 'templates');
export const ALL_TEMPLATES_DIRS = [TEMPLATES_DIR, API_TEMPLATES_DIR];

// --- OCPP event settings cache (avoids per-event SQL query) ---

interface OcppEventSetting {
  recipient: string;
  channel: string;
  templateHtml: string | null;
  language: string | null;
}

// Cache keyed by "eventType:channel"
let settingsCache: Map<string, OcppEventSetting> | null = null;
let settingsCacheAt = 0;
const SETTINGS_CACHE_TTL_MS = 60_000;

export function clearOcppEventSettingsCache(): void {
  settingsCache = null;
  settingsCacheAt = 0;
}

// Subscribe to cross-process cache-invalidation events so an operator
// updating OCPP event settings via the API immediately clears this pod's
// in-memory cache instead of waiting up to 60s for natural TTL expiry. The
// API publishes on `cache_invalidate` after PUT/DELETE on
// /v1/ocpp-event-settings. Returns the subscription so the caller can
// close it on shutdown.
export const OCPP_CACHE_INVALIDATE_CHANNEL = 'cache_invalidate';

interface CacheInvalidateMessage {
  cache?: string;
}

export async function subscribeOcppEventSettingsInvalidation(
  pubsub: PubSubClient,
): Promise<{ unsubscribe: () => Promise<void> }> {
  const log = createLogger('ocpp-cache-invalidate');
  const sub = await pubsub.subscribe(OCPP_CACHE_INVALIDATE_CHANNEL, (payload: string) => {
    try {
      const msg = JSON.parse(payload) as CacheInvalidateMessage;
      if (msg.cache === 'ocppEventSettings') {
        clearOcppEventSettingsCache();
        log.info('OCPP event settings cache invalidated');
      }
    } catch (err: unknown) {
      log.warn({ err }, 'Bad cache_invalidate payload');
    }
  });
  return sub;
}

async function loadSettingsCache(sql: postgres.Sql): Promise<Map<string, OcppEventSetting>> {
  const now = Date.now();
  if (settingsCache != null && now - settingsCacheAt < SETTINGS_CACHE_TTL_MS) {
    return settingsCache;
  }
  try {
    const rows = await sql`
      SELECT event_type, recipient, channel, template_html, language
      FROM ocpp_event_settings
    `;
    const cache = new Map<string, OcppEventSetting>();
    for (const row of rows) {
      const key = `${row.event_type as string}:${row.channel as string}`;
      cache.set(key, {
        recipient: row.recipient as string,
        channel: row.channel as string,
        templateHtml: (row.template_html as string | null) ?? null,
        language: (row.language as string | null) ?? null,
      });
    }
    settingsCache = cache;
    settingsCacheAt = now;
    return cache;
  } catch (err) {
    logger.error({ err }, 'Failed to load OCPP event settings cache');
    return settingsCache ?? new Map();
  }
}

/** Get all enabled channel settings for an event type */
async function getEnabledChannels(
  sql: postgres.Sql,
  eventType: string,
): Promise<OcppEventSetting[]> {
  const cache = await loadSettingsCache(sql);
  const result: OcppEventSetting[] = [];
  for (const ch of ['email', 'webhook']) {
    const setting = cache.get(`${eventType}:${ch}`);
    if (setting != null) {
      result.push(setting);
    }
  }
  return result;
}

// --- OCPP notification dispatch (settings-based) ---

export async function dispatchOcppNotification(
  sql: postgres.Sql,
  event: DomainEvent,
): Promise<void> {
  try {
    const enabledSettings = await getEnabledChannels(sql, event.eventType);
    if (enabledSettings.length === 0) return;

    const notificationSettings = await getNotificationSettings(sql);

    // Both cached, 5-minute TTL — these used to be uncached SELECTs on
    // every projected event (200+ events/sec at peak).
    const [company, systemTimezone] = await Promise.all([
      getCompanySettings(sql),
      getSystemTimezoneCached(sql),
    ]);

    const variables: Record<string, unknown> = {
      ...company,
      ...event.payload,
      eventType: event.eventType,
      stationId: event.aggregateId,
      occurredAt: event.occurredAt?.toISOString(),
      isFaulted: event.payload['connectorStatus'] === 'Faulted',
    };

    const formattedVariables = formatDateVariables(variables, systemTimezone);

    // Dispatch to each enabled channel (email, webhook, or both)
    for (const setting of enabledSettings) {
      const recipients = resolveRecipients(sql, setting.recipient);
      const settingChannel = setting.channel;
      const settingLanguage = setting.language ?? '';

      for (const recipient of recipients) {
        try {
          const language = settingLanguage !== '' ? settingLanguage : recipient.language;
          let channel = settingChannel;

          if (channel === 'email' && notificationSettings.smtp == null) {
            channel = 'log';
          }

          const templateChannel = channel === 'log' || channel === 'webhook' ? 'email' : channel;
          const rendered = await renderTemplate(
            templateChannel,
            event.eventType,
            language,
            formattedVariables,
            sql,
            setting.templateHtml,
            TEMPLATES_DIR,
          );

          const wrappedHtml =
            rendered.html != null
              ? wrapEmailHtml(
                  rendered.html,
                  company.companyName,
                  notificationSettings.emailWrapperTemplate,
                  formattedVariables,
                )
              : undefined;
          let status: 'sent' | 'failed' = 'sent';
          let failureReason: string | null = null;

          if (channel === 'email') {
            if (notificationSettings.smtp == null) {
              status = 'failed';
              failureReason = 'smtp_not_configured';
            } else {
              const ok = await sendEmail(
                notificationSettings.smtp,
                recipient.address,
                rendered.subject,
                rendered.body,
                wrappedHtml,
              );
              if (!ok) {
                status = 'failed';
                failureReason =
                  notificationSettings.smtp.credentialError === 'decrypt_failed'
                    ? 'credentials_decrypt_failed'
                    : 'smtp_send_failed';
              }
            }
          } else if (channel === 'webhook') {
            const ok = await sendWebhook(
              recipient.address,
              rendered.subject,
              rendered.body,
              formattedVariables,
            );
            if (!ok) {
              status = 'failed';
              failureReason = 'webhook_send_failed';
            }
          } else {
            logNotification(channel, recipient.address, rendered.subject, rendered.body);
          }

          const storedBody =
            channel === 'email' && wrappedHtml != null ? wrappedHtml : rendered.body;
          const metadata: Record<string, string> = {};
          if (failureReason != null) metadata['failureReason'] = failureReason;
          await recordNotificationAttempt(sql, {
            channel: channel as 'email' | 'sms' | 'push' | 'webhook' | 'log',
            recipient: recipient.address,
            subject: rendered.subject,
            body: storedBody,
            status,
            eventType: event.eventType,
            metadata,
          });
        } catch (err) {
          logger.error(
            { err, eventType: event.eventType, recipient: recipient.address },
            'OCPP notification dispatch failed for recipient',
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err, eventType: event.eventType }, 'OCPP notification dispatch failed');
  }
}
