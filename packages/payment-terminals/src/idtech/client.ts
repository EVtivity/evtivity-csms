// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { tryParseJson } from '@evtivity/lib/safe-json';
import { TerminalProviderError } from '../types.js';
import {
  readLimited,
  ReplyTooLargeError,
  retryAfterSeconds,
  TERMINAL_ERROR_BODY_PREFIX_BYTES,
  TERMINAL_HTTP_TIMEOUT_MS,
  TERMINAL_MAX_REPLY_BYTES,
  trimTrailingSlashes,
} from '../http.js';
import { redactPanRuns } from '../card-fields.js';
import { IDTECH_ERROR_CODES, IDTECH_HEADERS, idtechStatusKind } from './contract.js';

export interface IdtechClientOptions {
  baseUrl: string;
  merchantId: string;
  apiKey: string;
  apiSecret: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

export interface IdtechRequest {
  method: 'GET' | 'POST';
  /** The path with its ids filled in (already encoded). */
  path: string;
  /** The path with placeholders: errors name this, never the ids. */
  label: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

/**
 * The HTTP client of the assumed PSG contract: Basic auth, a 10 s timeout,
 * replies read up to 1 MiB, errors mapped to TerminalProviderError kinds with
 * no reply text in the message (the body prefix goes to `cause` only).
 */
export class IdtechClient {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly merchantId: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: IdtechClientOptions) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.authorization = `Basic ${Buffer.from(`${options.apiKey}:${options.apiSecret}`).toString('base64')}`;
    this.merchantId = options.merchantId;
    this.fetchFn = options.fetch;
    this.timeoutMs = options.timeoutMs ?? TERMINAL_HTTP_TIMEOUT_MS;
  }

  async request(req: IdtechRequest): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${req.path}`);
    for (const [name, value] of Object.entries(req.query ?? {})) {
      if (value != null) url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = {
      authorization: this.authorization,
      accept: 'application/json',
      [IDTECH_HEADERS.merchant]: this.merchantId,
    };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    if (req.idempotencyKey != null) headers[IDTECH_HEADERS.idempotency] = req.idempotencyKey;
    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        method: req.method,
        headers,
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      throw new TerminalProviderError('unavailable', `ID TECH ${req.label} did not answer`, {
        cause: err,
      });
    }
    let text: string;
    try {
      text = await readLimited(response, TERMINAL_MAX_REPLY_BYTES);
    } catch (err: unknown) {
      if (err instanceof ReplyTooLargeError) {
        throw new TerminalProviderError('unavailable', `ID TECH ${req.label} reply is too large`);
      }
      throw new TerminalProviderError('unavailable', `ID TECH ${req.label} reply was cut off`, {
        cause: err,
      });
    }
    if (response.ok) return text === '' ? {} : (tryParseJson(text) ?? {});
    const body = tryParseJson(text) as { error?: { code?: unknown } } | null;
    const code = typeof body?.error?.code === 'string' ? body.error.code : null;
    const kind =
      (code != null ? IDTECH_ERROR_CODES[code] : undefined) ?? idtechStatusKind(response.status);
    throw new TerminalProviderError(
      kind,
      `ID TECH ${req.label} answered ${String(response.status)}${code != null ? ` ${code.slice(0, 40)}` : ''}`,
      {
        retryAfterSeconds:
          kind === 'rate_limited' ? retryAfterSeconds(response.headers.get('retry-after')) : null,
        cause: { bodyPrefix: redactPanRuns(text.slice(0, TERMINAL_ERROR_BODY_PREFIX_BYTES)) },
      },
    );
  }
}
