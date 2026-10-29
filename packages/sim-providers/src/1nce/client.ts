// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { tryParseJson } from '@evtivity/lib/safe-json';
import { SimProviderError } from '../types.js';
import type { SimProviderErrorKind } from '../types.js';
import {
  MAX_RETRY_AFTER_SECONDS,
  readLimited,
  readRetryAfter,
  ReplyTooLargeError,
  retryAfterSeconds,
  trimTrailingSlashes,
} from '../http-limits.js';

// The 1NCE Management API (https://help.1nce.com/specs/authorization.json and
// sim-management-v2.json): the token route and the v2 SIM routes share this base.
export const ONENCE_BASE_URL = 'https://api.1nce.com/management-api';
export const ONENCE_TIMEOUT_MS = 10_000;
/** Replies larger than this are refused unread; a 1000-event page is the largest. */
export const ONENCE_MAX_REPLY_BYTES = 2 * 1024 * 1024;
/** The token reply (a token of about 3 KB) is refused unread above this. */
export const ONENCE_MAX_TOKEN_REPLY_BYTES = 16 * 1024;
/** The longest access token accepted. */
export const ONENCE_MAX_TOKEN_LENGTH = 8192;
// A token is renewed this long before its stated expiry.
const TOKEN_SKEW_SECONDS = 60;
// `expires_in` outside 60 s to a day is not trusted; the token is then kept 5 minutes.
const TOKEN_FALLBACK_SECONDS = 300;
const TOKEN_MIN_SECONDS = 60;
const TOKEN_MAX_SECONDS = 86_400;
/**
 * The account allows 10 requests a second (`ratelimit-limit`, shared with the
 * customer's other 1NCE tools). When a reply says none is left in the window
 * (`ratelimit-remaining: 0`), the next request waits for the window to reset
 * (`ratelimit-reset` seconds, at most this long) instead of drawing a 429.
 */
export const ONENCE_MAX_PACE_WAIT_MS = 2_000;

export interface OneNceClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type QueryValue = string | number | undefined;

export interface OneNceRequest {
  method: 'GET' | 'POST';
  path: string;
  /** The path with its ids as placeholders (`/v2/sims/{iccid}`): errors name this, never the ids. */
  label: string;
  query?: Record<string, QueryValue>;
  /** What a 400 means for this call. */
  badRequest?: SimProviderErrorKind;
}

export interface OneNceReply {
  /** The parsed JSON body, or null for a reply without one (201, 204). */
  body: unknown;
  headers: Headers;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * HTTP calls to the 1NCE Management API: an OAuth2 client credentials token,
 * kept in this process only and dropped with the client when the settings
 * change. Error messages name the method, the request label and the status
 * only, never the client id, the secret, the token, an ICCID or the
 * provider's text (a 1NCE error message can echo the account's API login).
 * Redirects are refused, so no credential is sent to another host.
 */
export class OneNceClient {
  private readonly basic: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private token: CachedToken | null = null;
  private tokenRequest: Promise<string> | null = null;
  /** No request before this time (ms): the rate limit window has no request left. */
  private pausedUntil = 0;

  constructor(options: OneNceClientOptions) {
    this.basic = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`;
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? ONENCE_TIMEOUT_MS;
  }

  async request(req: OneNceRequest): Promise<OneNceReply> {
    const first = await this.bearer();
    const response = await this.send(req, first);
    if (response.status !== 401) return this.read(req, response);
    await response.body?.cancel();
    // An expired or revoked token: drop it, fetch one new token and retry once.
    if (this.token?.value === first) this.token = null;
    const second = await this.bearer();
    const retried = await this.send(req, second);
    if (retried.status === 401) {
      await retried.body?.cancel();
      this.token = null;
      throw new SimProviderError('auth', `1NCE ${req.method} ${req.label} refused the token`);
    }
    return this.read(req, retried);
  }

  /** The cached token while it is valid, else one shared token request. */
  private async bearer(): Promise<string> {
    if (this.token != null && Date.now() < this.token.expiresAt) return this.token.value;
    this.tokenRequest ??= this.fetchToken().finally(() => {
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const label = '1NCE POST /oauth/token';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          Authorization: this.basic,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ grant_type: 'client_credentials' }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      throw new SimProviderError('unavailable', `${label} failed: no reply`, { cause: err });
    }
    const status = response.status;
    if (status === 400 || status === 401 || status === 403) {
      await response.body?.cancel();
      // 400 BadCredentials, AuthValidationError and the other token errors.
      throw new SimProviderError('auth', '1NCE refused the client credentials');
    }
    if (status === 429) {
      await response.body?.cancel();
      throw rateLimited(label, response.headers);
    }
    let raw: string;
    try {
      raw = await readLimited(response, ONENCE_MAX_TOKEN_REPLY_BYTES);
    } catch (err: unknown) {
      if (err instanceof ReplyTooLargeError) {
        throw new SimProviderError('unavailable', `${label} answered a reply too large to read`);
      }
      throw new SimProviderError('unavailable', `${label} failed: reply not read`, { cause: err });
    }
    if (status < 200 || status >= 300) {
      throw new SimProviderError('unavailable', `${label} answered ${String(status)}`);
    }
    const body = raw === '' ? undefined : tryParseJson(raw);
    const fields =
      body != null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const value = fields?.['access_token'];
    if (typeof value !== 'string' || value === '' || value.length > ONENCE_MAX_TOKEN_LENGTH) {
      throw new SimProviderError('unavailable', `${label} answered without an access token`);
    }
    const expiresIn = fields?.['expires_in'];
    const lifetime =
      typeof expiresIn === 'number' &&
      Number.isFinite(expiresIn) &&
      expiresIn >= TOKEN_MIN_SECONDS &&
      expiresIn <= TOKEN_MAX_SECONDS
        ? expiresIn - TOKEN_SKEW_SECONDS
        : TOKEN_FALLBACK_SECONDS - TOKEN_SKEW_SECONDS;
    this.token = { value, expiresAt: Date.now() + lifetime * 1000 };
    return value;
  }

  private async send(req: OneNceRequest, token: string): Promise<Response> {
    const wait = this.pausedUntil - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(wait, ONENCE_MAX_PACE_WAIT_MS));
      });
    }
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) params.set(name, String(value));
    }
    const query = params.toString();
    try {
      return await this.fetchImpl(`${this.baseUrl}${req.path}${query === '' ? '' : `?${query}`}`, {
        method: req.method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      throw new SimProviderError(
        'unavailable',
        `1NCE ${req.method} ${req.label} failed: no reply`,
        {
          cause: err,
        },
      );
    }
  }

  /** Pauses the next request while the rate limit window has no request left. */
  private pace(headers: Headers): void {
    const remaining = headers.get('ratelimit-remaining')?.trim() ?? '';
    const reset = Number(headers.get('ratelimit-reset')?.trim() ?? '');
    if (remaining === '0' && Number.isFinite(reset) && reset > 0) {
      this.pausedUntil = Date.now() + Math.min(reset * 1000, ONENCE_MAX_PACE_WAIT_MS);
    }
  }

  private async read(req: OneNceRequest, response: Response): Promise<OneNceReply> {
    const label = `1NCE ${req.method} ${req.label}`;
    const status = response.status;
    this.pace(response.headers);
    let raw: string;
    try {
      raw = await readLimited(response, ONENCE_MAX_REPLY_BYTES);
    } catch (err: unknown) {
      if (err instanceof ReplyTooLargeError) {
        throw new SimProviderError('unavailable', `${label} answered a reply too large to read`);
      }
      throw new SimProviderError('unavailable', `${label} failed: reply not read`, { cause: err });
    }
    if (status >= 200 && status < 300) {
      if (raw === '') return { body: null, headers: response.headers };
      const body = tryParseJson(raw);
      if (body === undefined) {
        throw new SimProviderError(
          'unavailable',
          `${label} answered ${String(status)} without valid JSON`,
        );
      }
      return { body, headers: response.headers };
    }
    // The error body ({error_code, error_token, message}) is never read: its text is not shown.
    if (status === 429) throw rateLimited(label, response.headers);
    if (status === 403) {
      throw new SimProviderError('unsupported', `${label} is not allowed for this client`);
    }
    if (status === 404) throw new SimProviderError('not_found', `${label} answered 404`);
    if (status === 409) throw new SimProviderError('unsupported', `${label} answered 409`);
    if (status === 400) {
      throw new SimProviderError(req.badRequest ?? 'unavailable', `${label} answered 400`);
    }
    throw new SimProviderError('unavailable', `${label} answered ${String(status)}`);
  }
}

/** A 429: `Retry-After`, else the `ratelimit-reset` seconds, else 60 s, capped at an hour. */
function rateLimited(label: string, headers: Headers): SimProviderError {
  const retryAfter = readRetryAfter(headers.get('retry-after'));
  let wait: number;
  if (retryAfter != null) {
    wait = retryAfter;
  } else {
    // `ratelimit-reset` is the seconds until the window resets (1 for the per-second limit).
    const resetHeader = headers.get('ratelimit-reset')?.trim() ?? '';
    const reset = Number(resetHeader);
    wait =
      resetHeader !== '' && Number.isFinite(reset) && reset >= 0
        ? Math.min(Math.max(1, Math.ceil(reset)), MAX_RETRY_AFTER_SECONDS)
        : retryAfterSeconds(null);
  }
  return new SimProviderError('rate_limited', `${label} answered 429`, {
    retryAfterSeconds: wait,
  });
}
