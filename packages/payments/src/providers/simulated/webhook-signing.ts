// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { NormalizedPaymentEvent } from '../../types.js';

export const SIMULATED_SIGNATURE_HEADER = 'x-simulated-signature';

/**
 * The webhook signing key: HKDF-SHA256 of SETTINGS_ENCRYPTION_KEY with info
 * 'simulated-webhook', so no setting is needed and every process of one
 * installation signs and verifies with the same key.
 */
export function simulatedWebhookKey(encryptionKey: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', encryptionKey, '', 'simulated-webhook', 32));
}

function hmac(key: Buffer, rawBody: string): string {
  return crypto.createHmac('sha256', key).update(rawBody).digest('hex');
}

export interface SignedSimulatedWebhook {
  rawBody: string;
  headers: Record<string, string>;
}

/** Signs events the way the simulated provider does (integration tests post these). */
export function signSimulatedWebhook(
  events: NormalizedPaymentEvent[],
  encryptionKey: string,
): SignedSimulatedWebhook {
  const rawBody = JSON.stringify({ events });
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      [SIMULATED_SIGNATURE_HEADER]: hmac(simulatedWebhookKey(encryptionKey), rawBody),
    },
  };
}

/** True when `signature` is the HMAC of the body (constant-time compare). */
export function isValidSimulatedSignature(
  rawBody: string,
  signature: string,
  key: Buffer,
): boolean {
  const expected = Buffer.from(hmac(key, rawBody), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Parses a verified body; occurredAt comes back as a Date. */
export function parseSimulatedEvents(rawBody: string): NormalizedPaymentEvent[] {
  const body = JSON.parse(rawBody) as { events?: unknown };
  if (!Array.isArray(body.events)) throw new Error('Simulated webhook body has no events array');
  return (body.events as Array<Record<string, unknown>>).map(
    (e) => ({ ...e, occurredAt: new Date(String(e['occurredAt'])) }) as NormalizedPaymentEvent,
  );
}
