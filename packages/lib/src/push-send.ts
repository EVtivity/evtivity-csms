// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger } from './logger.js';

const logger = createLogger('push-send');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;
const SEND_TIMEOUT_MS = 10_000;

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface ExpoPushResult {
  token: string;
  ok: boolean;
  // Expo reports the device is no longer registered (app uninstalled, token
  // expired). The caller deletes the row so a dead token is not retried.
  unregistered: boolean;
  error?: string;
}

export function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
}

interface ExpoTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

async function sendBatch(messages: ExpoPushMessage[]): Promise<ExpoPushResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, SEND_TIMEOUT_MS);
  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text }, 'Expo push delivery failed');
      return messages.map((m) => ({ token: m.to, ok: false, unregistered: false }));
    }
    const json = (await response.json()) as { data?: ExpoTicket[] };
    const tickets = json.data ?? [];
    return messages.map((m, i) => {
      const ticket = tickets[i];
      if (ticket == null) return { token: m.to, ok: false, unregistered: false };
      if (ticket.status === 'ok') return { token: m.to, ok: true, unregistered: false };
      const errorCode = ticket.details?.error;
      return {
        token: m.to,
        ok: false,
        unregistered: errorCode === 'DeviceNotRegistered',
        ...(ticket.message != null ? { error: ticket.message } : {}),
      };
    });
  } catch (err) {
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));
    logger.error({ err }, isAbort ? 'Expo push timed out' : 'Failed to send Expo push');
    return messages.map((m) => ({ token: m.to, ok: false, unregistered: false }));
  } finally {
    clearTimeout(timer);
  }
}

// Sends native push notifications via the Expo push service. Invalid-format
// tokens are dropped before the request (Expo rejects the whole batch on one
// bad token). Returns one result per input message; the caller acts on
// `unregistered` to prune dead tokens. Never throws.
export async function sendExpoPush(messages: ExpoPushMessage[]): Promise<ExpoPushResult[]> {
  const valid: ExpoPushMessage[] = [];
  const results: ExpoPushResult[] = [];
  for (const m of messages) {
    if (isExpoPushToken(m.to)) {
      valid.push(m);
    } else {
      results.push({ token: m.to, ok: false, unregistered: true, error: 'invalid_token_format' });
    }
  }

  for (let i = 0; i < valid.length; i += EXPO_BATCH_SIZE) {
    const batch = valid.slice(i, i + EXPO_BATCH_SIZE);
    results.push(...(await sendBatch(batch)));
  }
  return results;
}
