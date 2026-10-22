// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { tryParseJson } from '@evtivity/lib/safe-json';
import { SimProviderError } from '../types.js';
import type { SimProviderErrorKind } from '../types.js';

export const HOLOGRAM_BASE_URL = 'https://dashboard.hologram.io/api/1';
export const HOLOGRAM_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** A provider that asks for a longer wait still gets asked again after an hour. */
export const HOLOGRAM_MAX_RETRY_AFTER_SECONDS = 3600;
/** Replies larger than this are refused unread; the largest real page is far smaller. */
export const HOLOGRAM_MAX_REPLY_BYTES = 2 * 1024 * 1024;
// Hologram answers a wrong or missing key with 403 and this error text.
const INVALID_KEY_ERROR = 'Invalid API Key';

export interface HologramClientOptions {
  apiKey: string;
  orgId: string;
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean | undefined;

export interface HologramRequest {
  method: 'GET' | 'POST';
  path: string;
  /** The path with its ids as placeholders (`/devices/{deviceId}`): errors name this, never the ids. */
  label: string;
  query?: Record<string, QueryValue>;
  /** The `orgid` to send: the stored one when unset, none when null. */
  orgId?: string | null;
  body?: unknown;
  /** What a 400 means for this call. */
  badRequest?: SimProviderErrorKind;
}

export interface HologramErrorReply {
  status: number;
  error: string | null;
}

/** A refused request whose error text the caller reads. */
export class HologramRequestError extends SimProviderError {
  declare readonly reply: HologramErrorReply;

  constructor(kind: SimProviderErrorKind, message: string, reply: HologramErrorReply) {
    super(kind, message);
    this.name = 'HologramRequestError';
    // Not enumerable, so an error serializer never logs the provider's text.
    Object.defineProperty(this, 'reply', { value: reply, enumerable: false });
  }
}

function retryAfterSeconds(header: string | null): number {
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
  return Math.min(wait, HOLOGRAM_MAX_RETRY_AFTER_SECONDS);
}

class ReplyTooLargeError extends Error {
  constructor() {
    super('The reply is larger than the limit');
    this.name = 'ReplyTooLargeError';
  }
}

/** The reply text, read up to the limit; a larger reply stops the read and throws. */
async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > HOLOGRAM_MAX_REPLY_BYTES) {
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
    if (total > HOLOGRAM_MAX_REPLY_BYTES) {
      await reader.cancel();
      throw new ReplyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorText(body: unknown): string | null {
  if (body == null || typeof body !== 'object') return null;
  const error = (body as Record<string, unknown>)['error'];
  return typeof error === 'string' ? error : null;
}

/**
 * HTTP calls to the Hologram REST API: Basic auth with user `apikey` and the
 * organization id on every call. Error messages name the method, the request
 * label and the status only, never the key, an id or the query.
 */
export class HologramClient {
  private readonly authorization: string;
  private readonly orgId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HologramClientOptions) {
    this.authorization = `Basic ${Buffer.from(`apikey:${options.apiKey}`).toString('base64')}`;
    this.orgId = options.orgId;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? HOLOGRAM_TIMEOUT_MS;
  }

  async request(req: HologramRequest): Promise<unknown> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) params.set(name, String(value));
    }
    const orgId = req.orgId === undefined ? this.orgId : req.orgId;
    if (orgId != null) params.set('orgid', orgId);
    const label = `Hologram ${req.method} ${req.label}`;
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      Accept: 'application/json',
    };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${req.path}?${params.toString()}`, {
        method: req.method,
        headers,
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      throw new SimProviderError('unavailable', `${label} failed: no reply`, { cause: err });
    }

    const status = response.status;
    let raw: string;
    try {
      raw = await readLimited(response);
    } catch (err: unknown) {
      if (err instanceof ReplyTooLargeError) {
        throw new SimProviderError('unavailable', `${label} answered a reply too large to read`);
      }
      throw new SimProviderError('unavailable', `${label} failed: reply not read`, { cause: err });
    }
    // A proxy or outage page is not JSON; an error status still maps by its code.
    const body = raw === '' ? null : tryParseJson(raw);
    if (status >= 200 && status < 300) {
      if (raw !== '' && body === undefined) {
        throw new SimProviderError(
          'unavailable',
          `${label} answered ${String(status)} without valid JSON`,
        );
      }
      if (body != null && typeof body === 'object' && 'success' in body && body.success === false) {
        throw new SimProviderError('unavailable', `${label} answered success false`);
      }
      return body;
    }
    const reply: HologramErrorReply = { status, error: errorText(body) };
    if (status === 401 || (status === 403 && reply.error === INVALID_KEY_ERROR)) {
      throw new HologramRequestError('auth', `${label} refused the API key`, reply);
    }
    if (status === 403) {
      throw new HologramRequestError('unsupported', `${label} is not allowed for this key`, reply);
    }
    if (status === 429) {
      throw new SimProviderError('rate_limited', `${label} answered 429`, {
        retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')),
      });
    }
    if (status === 404) {
      throw new HologramRequestError('not_found', `${label} answered 404`, reply);
    }
    if (status === 400) {
      throw new HologramRequestError(
        req.badRequest ?? 'unavailable',
        `${label} answered 400`,
        reply,
      );
    }
    throw new HologramRequestError('unavailable', `${label} answered ${String(status)}`, reply);
  }
}
