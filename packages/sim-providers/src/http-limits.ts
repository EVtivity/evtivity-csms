// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Reply limits shared by the provider HTTP clients.

export const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** A provider that asks for a longer wait still gets asked again after an hour. */
export const MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * The wait a `Retry-After` header asks for (seconds or an HTTP date), capped at
 * one hour. Null when the header is missing, empty or unreadable.
 */
export function readRetryAfter(header: string | null): number | null {
  const value = header?.trim() ?? '';
  if (value === '') return null;
  const seconds = Number(value);
  let wait: number;
  if (Number.isFinite(seconds) && seconds >= 0) {
    wait = Math.ceil(seconds);
  } else {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return null;
    wait = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  return Math.min(wait, MAX_RETRY_AFTER_SECONDS);
}

/** `readRetryAfter`, else 60 seconds. */
export function retryAfterSeconds(header: string | null): number {
  return readRetryAfter(header) ?? DEFAULT_RETRY_AFTER_SECONDS;
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

// A backwards scan, linear in the length. The regex form /\/+$/ is quadratic
// on a value with many slashes that do not end it.
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}
