// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger } from './logger.js';

const logger = createLogger('notification-test-sink');

const SEND_TIMEOUT_MS = 10_000;

/** The only NODE_ENV values under which the allow flag is accepted. */
const SINK_NODE_ENVS: ReadonlySet<string> = new Set(['development', 'test']);

/**
 * The environment the notification test sink reads. The API, OCPP and worker
 * config schemas check it at startup, and the senders check it again on first
 * use (two layers in the process, P11).
 */
export interface NotificationTestSinkEnv {
  NODE_ENV?: string | undefined;
  NOTIFICATIONS_ALLOW_TEST_SINK?: string | undefined;
  NOTIFICATIONS_TEST_SINK_URL?: string | undefined;
}

/**
 * Returns the test sink base URL (no trailing slash), or null when the sink is
 * off. The sink is off by default: both variables are needed to turn it on.
 * Throws when:
 * - `NOTIFICATIONS_ALLOW_TEST_SINK` is not `true`, `false` or empty;
 * - `NOTIFICATIONS_ALLOW_TEST_SINK=true` and `NODE_ENV` is not `development` or
 *   `test` (an allow-list: unset, `production` and any other value are refused);
 * - `NOTIFICATIONS_TEST_SINK_URL` is set without `NOTIFICATIONS_ALLOW_TEST_SINK=true`;
 * - the URL is not http or https.
 */
export function resolveNotificationTestSinkUrl(env: NotificationTestSinkEnv): string | null {
  const allowRaw = (env.NOTIFICATIONS_ALLOW_TEST_SINK ?? '').trim();
  if (allowRaw !== '' && allowRaw !== 'true' && allowRaw !== 'false') {
    throw new Error('NOTIFICATIONS_ALLOW_TEST_SINK must be true or false');
  }
  const allow = allowRaw === 'true';
  if (allow && !SINK_NODE_ENVS.has(env.NODE_ENV ?? '')) {
    throw new Error(
      'NOTIFICATIONS_ALLOW_TEST_SINK=true needs NODE_ENV development or test: the notification test sink is for local development only',
    );
  }
  const url = (env.NOTIFICATIONS_TEST_SINK_URL ?? '').trim();
  if (url === '') return null;
  if (!allow) {
    throw new Error('NOTIFICATIONS_TEST_SINK_URL needs NOTIFICATIONS_ALLOW_TEST_SINK=true');
  }
  const parsed = URL.parse(url);
  if (parsed == null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error('NOTIFICATIONS_TEST_SINK_URL must be an http or https URL');
  }
  return url.replace(/\/+$/, '');
}

let cached: { url: string | null } | undefined;

/**
 * The sink URL of this process, read once from `process.env` (P6). Throws on
 * invalid settings, as the config schemas do at startup.
 */
export function getNotificationTestSinkUrl(): string | null {
  cached ??= { url: resolveNotificationTestSinkUrl(process.env) };
  return cached.url;
}

/** Drops the cached sink URL so the next read sees `process.env` again (tests). */
export function clearNotificationTestSinkCache(): void {
  cached = undefined;
}

/** One message as the sink stores it and `GET /messages` returns it. */
export interface NotificationTestSinkMessage {
  channel: 'sms' | 'push';
  /** Normalized E.164 phone number (sms) or Expo push token (push). */
  to: string;
  eventType: string | null;
  language: string | null;
  /** Push title. Null for SMS. */
  title: string | null;
  /** The full rendered text that would have gone to Twilio or Expo. */
  body: string;
  /** Push data payload. Null for SMS. */
  data: Record<string, unknown> | null;
}

/**
 * POSTs one message to `<sinkUrl>/messages`. No provider credentials are sent
 * (P12). Returns false on an error answer, a network error or a timeout,
 * logged at warn: an unreachable sink counts as a provider failure (P9).
 */
export async function postToNotificationTestSink(
  sinkUrl: string,
  message: NotificationTestSinkMessage,
): Promise<boolean> {
  try {
    const response = await fetch(`${sinkUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status, channel: message.channel },
        'Notification test sink refused the message',
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, channel: message.channel }, 'Notification test sink unreachable');
    return false;
  }
}
