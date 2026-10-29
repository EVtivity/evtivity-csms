// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHmac, timingSafeEqual } from 'node:crypto';
import { TerminalProviderError } from './types.js';
import { TERMINAL_MAX_WEBHOOK_BYTES } from './http.js';

/** A webhook signed more than this long ago, or this far in the future, is refused (replay). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * The signature header value `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
 * The simulated provider signs with it, and the ID TECH adapter assumes the
 * same shape (contract.ts) until the PSG documentation says otherwise.
 */
export function signWebhookBody(secret: string, rawBody: string, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  const mac = createHmac('sha256', secret)
    .update(`${String(t)}.${rawBody}`)
    .digest('hex');
  return `t=${String(t)},v1=${mac}`;
}

function parseHeader(value: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name === 't' && /^\d{1,12}$/.test(val)) t = Number(val);
    else if (name === 'v1' && /^[0-9a-f]{64}$/.test(val)) v1.push(val);
  }
  return t == null || v1.length === 0 ? null : { t, v1 };
}

/**
 * Checks a signed webhook body: the body is at most 256 KiB, the header holds
 * a timestamp within five minutes of now and an HMAC-SHA256 that matches
 * (constant-time compare). Throws `TerminalProviderError('auth')` otherwise.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  now: Date = new Date(),
): void {
  if (secret === '') throw new TerminalProviderError('auth', 'No webhook secret is configured');
  if (rawBody.byteLength > TERMINAL_MAX_WEBHOOK_BYTES) {
    throw new TerminalProviderError('validation', 'The webhook body is too large');
  }
  const parsed = header != null && header.length <= 1024 ? parseHeader(header) : null;
  if (parsed == null) throw new TerminalProviderError('auth', 'The webhook signature is missing');
  const age = Math.abs(Math.floor(now.getTime() / 1000) - parsed.t);
  if (age > WEBHOOK_TOLERANCE_SECONDS) {
    throw new TerminalProviderError('auth', 'The webhook timestamp is outside the tolerance');
  }
  const expected = createHmac('sha256', secret)
    .update(`${String(parsed.t)}.`)
    .update(rawBody)
    .digest();
  const ok = parsed.v1.some((candidate) => {
    const given = Buffer.from(candidate, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new TerminalProviderError('auth', 'The webhook signature does not match');
}
