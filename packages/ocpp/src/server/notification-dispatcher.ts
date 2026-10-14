// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import postgres from 'postgres';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_INVALIDATE_CHANNEL, createLogger } from '@evtivity/lib';
import type {
  DomainEvent,
  DriverNotificationOptions,
  NotificationDispatchResult,
  PubSubClient,
} from '@evtivity/lib';
import { getWebhookAllowedPrivateHosts, pgConnectionErrorKind } from '@evtivity/database';
import type { ProjectionAttempt } from './projection-retry.js';
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
  clearNotificationSettingsCache,
  clearStationMessageCache,
} from '@evtivity/lib';
import { clearAutochargeCache, clearStationMessageSettingsCache } from '@evtivity/database';
import { clearContractValidationCaCache } from '../services/pki/contract-certificate-validation.js';
import { clearLocalContractCaCache } from '../services/pki/local-ca-store.js';
import { clearOemTrustCache } from '../services/pki/local-contract-provider.js';

export { dispatchSystemNotification };

export function dispatchDriverNotification(
  sql: postgres.Sql,
  eventType: string,
  driverId: string,
  variables: Record<string, unknown>,
  templatesDir?: string | string[],
  pubsub?: PubSubClient,
  options?: DriverNotificationOptions,
): Promise<NotificationDispatchResult> {
  return _dispatchDriverNotification(
    sql,
    eventType,
    driverId,
    variables,
    templatesDir ?? ALL_TEMPLATES_DIRS,
    pubsub,
    options,
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
export const OCPP_CACHE_INVALIDATE_CHANNEL = CACHE_INVALIDATE_CHANNEL;

interface CacheInvalidateMessage {
  cache?: string;
  kind?: string;
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
      if (msg.cache === 'pkiCaCertificates') {
        clearContractValidationCaCache();
        clearLocalContractCaCache();
        clearOemTrustCache();
        log.info('CA certificate cache invalidated');
      }
      if (msg.kind === 'notification_settings') {
        clearNotificationSettingsCache();
        log.info('Notification settings cache invalidated');
      }
      if (msg.kind === 'autocharge') {
        // The autocharge.enabled setting or a site override changed.
        clearAutochargeCache();
      }
      if (msg.kind === 'station_message') {
        // One-shot station messages render here.
        clearStationMessageCache();
        clearStationMessageSettingsCache();
      }
    } catch (err: unknown) {
      log.warn({ err }, 'Bad cache_invalidate payload');
    }
  });
  return sub;
}

// `rethrowConnectionErrors`: a lost connection with no cache to fall back on is
// thrown, so a retried projection runs again instead of sending nothing.
async function loadSettingsCache(
  sql: postgres.Sql,
  rethrowConnectionErrors: boolean,
): Promise<Map<string, OcppEventSetting>> {
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
    if (settingsCache == null && rethrowConnectionErrors && pgConnectionErrorKind(err) != null) {
      throw err;
    }
    logger.error({ err }, 'Failed to load OCPP event settings cache');
    return settingsCache ?? new Map();
  }
}

/** Get all enabled channel settings for an event type */
async function getEnabledChannels(
  sql: postgres.Sql,
  eventType: string,
  rethrowConnectionErrors: boolean,
): Promise<OcppEventSetting[]> {
  const cache = await loadSettingsCache(sql, rethrowConnectionErrors);
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

interface SendOutcome {
  status: 'sent' | 'failed';
  failureReason: string | null;
}

/**
 * Sends an OCPP event to the operator channels enabled for it. Fail-open: an
 * error is logged, never thrown, except that with `attempt` (a projection
 * retried on a lost connection) a lost connection before the last run is
 * thrown so the retry runs it again. Each recipient's send and its
 * notifications row are `once` steps, so a rerun never sends twice; the reads
 * before them run again.
 */
export async function dispatchOcppNotification(
  sql: postgres.Sql,
  event: DomainEvent,
  attempt?: ProjectionAttempt,
): Promise<void> {
  const retrying = attempt != null && !attempt.isLast;
  const once = <T>(key: string, step: () => Promise<T>): Promise<T> =>
    attempt != null ? attempt.once(key, step) : step();
  try {
    const enabledSettings = await getEnabledChannels(sql, event.eventType, retrying);
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

    // Dispatch to each enabled channel (email, webhook, or both)
    for (const setting of enabledSettings) {
      const recipients = resolveRecipients(sql, setting.recipient);
      const settingChannel = setting.channel;
      const settingLanguage = setting.language ?? '';

      for (const [index, recipient] of recipients.entries()) {
        const stepKey = `notify:${settingChannel}:${String(index)}:${recipient.address}`;
        // True while the notifications INSERT runs: a connection lost there
        // may have committed it, so it is never retried.
        let recording = false;
        try {
          const language = settingLanguage !== '' ? settingLanguage : recipient.language;
          const formattedVariables = formatDateVariables(variables, systemTimezone, language);
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
          const allowedPrivateHosts =
            channel === 'webhook' ? await getWebhookAllowedPrivateHosts() : [];
          const sent = await once(`${stepKey}:send`, async (): Promise<SendOutcome> => {
            if (channel === 'email') {
              if (notificationSettings.smtp == null) {
                return { status: 'failed', failureReason: 'smtp_not_configured' };
              }
              const ok = await sendEmail(
                notificationSettings.smtp,
                recipient.address,
                rendered.subject,
                rendered.body,
                wrappedHtml,
              );
              if (!ok) {
                return {
                  status: 'failed',
                  failureReason:
                    notificationSettings.smtp.credentialError === 'decrypt_failed'
                      ? 'credentials_decrypt_failed'
                      : 'smtp_send_failed',
                };
              }
            } else if (channel === 'webhook') {
              const result = await sendWebhook(
                recipient.address,
                rendered.subject,
                rendered.body,
                formattedVariables,
                allowedPrivateHosts,
              );
              if (result !== 'ok') {
                return { status: 'failed', failureReason: `webhook_${result}` };
              }
            } else {
              logNotification(channel, recipient.address, rendered.subject, rendered.body);
            }
            return { status: 'sent', failureReason: null };
          });
          const { status, failureReason } = sent;

          const storedBody =
            channel === 'email' && wrappedHtml != null ? wrappedHtml : rendered.body;
          const metadata: Record<string, string> = {};
          if (failureReason != null) metadata['failureReason'] = failureReason;
          recording = true;
          await once(`${stepKey}:record`, () =>
            recordNotificationAttempt(sql, {
              channel: channel as 'email' | 'sms' | 'push' | 'webhook' | 'log',
              recipient: recipient.address,
              subject: rendered.subject,
              body: storedBody,
              status,
              eventType: event.eventType,
              metadata,
            }),
          );
        } catch (err) {
          const kind = pgConnectionErrorKind(err);
          if (retrying && kind != null && !(recording && kind === 'interrupted')) throw err;
          logger.error(
            { err, eventType: event.eventType, recipient: recipient.address },
            'OCPP notification dispatch failed for recipient',
          );
        }
      }
    }
  } catch (err) {
    if (retrying && pgConnectionErrorKind(err) != null) throw err;
    logger.error({ err, eventType: event.eventType }, 'OCPP notification dispatch failed');
  }
}
