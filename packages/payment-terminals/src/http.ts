// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Reply limits of the terminal provider HTTP clients (security cases 38 and 113).

export const TERMINAL_HTTP_TIMEOUT_MS = 10_000;
/** A reply larger than this is refused unread. */
export const TERMINAL_MAX_REPLY_BYTES = 1024 * 1024;
/** An error body is logged as a prefix of at most this many bytes. */
export const TERMINAL_ERROR_BODY_PREFIX_BYTES = 2048;
/** Every string a provider returns is cut to this many characters. */
export const TERMINAL_MAX_STRING_LENGTH = 200;
/** A webhook body larger than this is refused. */
export const TERMINAL_MAX_WEBHOOK_BYTES = 256 * 1024;

const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** A provider that asks for a longer wait still gets asked again after an hour. */
export const MAX_RETRY_AFTER_SECONDS = 3600;

/** The wait a `Retry-After` header asks for (seconds or an HTTP date), capped at one hour, else 60 s. */
export function retryAfterSeconds(header: string | null): number {
  const value = header?.trim() ?? '';
  if (value === '') return DEFAULT_RETRY_AFTER_SECONDS;
  const seconds = Number(value);
  let wait: number;
  if (Number.isFinite(seconds) && seconds >= 0) {
    wait = Math.ceil(seconds);
  } else {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return DEFAULT_RETRY_AFTER_SECONDS;
    wait = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  return Math.min(wait, MAX_RETRY_AFTER_SECONDS);
}

export class ReplyTooLargeError extends Error {
  constructor() {
    super('The reply is larger than the limit');
    this.name = 'ReplyTooLargeError';
  }
}

/** The reply text, read up to `maxBytes`; a larger reply stops the read and throws. */
export async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ReplyTooLargeError();
  }
  if (response.body == null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ReplyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A string field of a reply, cut to 200 characters; null for anything else or empty. */
export function cutString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, TERMINAL_MAX_STRING_LENGTH);
}

/** A whole number of cents in 0..1,000,000 from a reply, else null. */
export function centsField(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;
}

// A backwards scan, linear in the length (a regex would be quadratic on many slashes).
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}
