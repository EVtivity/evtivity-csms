// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { tryParseJson } from '@evtivity/lib';
import { PaymentProviderUnavailableError, PaymentValidationError } from '../../errors.js';

/** Checkout API version (https://docs.adyen.com/api-explorer/Checkout/latest/overview). */
export const ADYEN_CHECKOUT_API_VERSION = 'v72';

export type AdyenEnvironment = 'test' | 'live';

/**
 * Live URL prefix: a hex random part and the company name, for example
 * `1797a841fbb37ca7-AdyenDemo` (https://docs.adyen.com/development-resources/live-endpoints).
 */
export const ADYEN_LIVE_URL_PREFIX_PATTERN = /^[a-z0-9]+-[A-Za-z0-9]+$/;

/** Adyen accepts idempotency keys of at most 64 characters. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 64;

/**
 * Test: `https://checkout-test.adyen.com/v72`. Live:
 * `https://{prefix}-checkout-live.adyenpayments.com/checkout/v72`. A live
 * environment without a valid prefix throws.
 */
export function adyenCheckoutBaseUrl(
  environment: AdyenEnvironment,
  liveUrlPrefix: string | null,
): string {
  if (environment === 'test')
    return `https://checkout-test.adyen.com/${ADYEN_CHECKOUT_API_VERSION}`;
  if (liveUrlPrefix == null || !ADYEN_LIVE_URL_PREFIX_PATTERN.test(liveUrlPrefix)) {
    throw new PaymentValidationError('A live Adyen environment needs a valid live URL prefix');
  }
  return `https://${liveUrlPrefix}-checkout-live.adyenpayments.com/checkout/${ADYEN_CHECKOUT_API_VERSION}`;
}

/** A 4xx answer Adyen will give again on retry (validation, state, auth). */
export class AdyenApiError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
  readonly errorType: string | null;
  readonly pspReference: string | null;

  constructor(
    status: number,
    body: {
      errorCode?: unknown;
      errorType?: unknown;
      message?: unknown;
      pspReference?: unknown;
      title?: unknown;
      detail?: unknown;
    },
  ) {
    // Checkout answers `message`; the Management API answers problem details (`detail`, `title`).
    const text = [body.message, body.detail, body.title].find(
      (v): v is string => typeof v === 'string' && v !== '',
    );
    const message = text ?? `Adyen HTTP ${String(status)}`;
    super(message);
    this.name = 'AdyenApiError';
    this.status = status;
    this.errorCode = typeof body.errorCode === 'string' ? body.errorCode : null;
    this.errorType = typeof body.errorType === 'string' ? body.errorType : null;
    this.pspReference = typeof body.pspReference === 'string' ? body.pspReference : null;
  }
}

export interface AdyenClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  /** Per attempt. Default 30 s. */
  timeoutMs?: number;
  /** Retries of a request that is safe to repeat. Default 2. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AdyenRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: object;
  idempotencyKey?: string;
}

class RetryableFailure extends Error {}

const INVALID_JSON = Symbol('invalid-json');

/** Undefined for an empty body; INVALID_JSON for one that does not parse (a proxy error page). */
function parseJson(text: string): unknown {
  if (text === '') return undefined;
  // JSON never parses to undefined, so undefined here means the text is not JSON.
  // The caller decides by status what that means.
  const parsed = tryParseJson(text);
  return parsed === undefined ? INVALID_JSON : parsed;
}

/**
 * A thin client over the Checkout API endpoints the provider uses (D-A4).
 * Authenticates with `X-API-Key`. A POST that carries an `Idempotency-Key`,
 * and any GET, is retried on a network error, a timeout, a 429, a 5xx, or a
 * 409/422 marked `transient-error: true` (a concurrent duplicate, code 704;
 * https://docs.adyen.com/development-resources/api-idempotency). Those
 * failures end as PaymentProviderUnavailableError; other 4xx answers throw
 * AdyenApiError.
 */
export class AdyenCheckoutClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AdyenClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T>(req: AdyenRequest): Promise<T> {
    if (req.idempotencyKey != null && req.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new PaymentValidationError('Adyen idempotency keys are at most 64 characters');
    }
    const repeatable = req.method === 'GET' || req.idempotencyKey != null;
    const attempts = repeatable ? this.maxRetries + 1 : 1;
    let last: RetryableFailure | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await this.sleep(500 * 2 ** (attempt - 1));
      try {
        return await this.once<T>(req);
      } catch (err) {
        if (!(err instanceof RetryableFailure)) throw err;
        last = err;
      }
    }
    throw new PaymentProviderUnavailableError(last?.message ?? 'Adyen request failed', {
      cause: last?.cause,
    });
  }

  private async once<T>(req: AdyenRequest): Promise<T> {
    const url = new URL(`${this.baseUrl}${req.path}`);
    for (const [key, value] of Object.entries(req.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      accept: 'application/json',
    };
    if (req.body != null) headers['content-type'] = 'application/json';
    if (req.idempotencyKey != null) headers['idempotency-key'] = req.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), {
        method: req.method,
        headers,
        ...(req.body != null ? { body: JSON.stringify(req.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RetryableFailure(
        `Adyen ${req.method} ${req.path} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const text = await response.text();
    const body = parseJson(text);
    if (response.ok) {
      if (body === INVALID_JSON) {
        throw new PaymentProviderUnavailableError(
          `Adyen ${req.method} ${req.path} returned a body that is not JSON`,
        );
      }
      return body as T;
    }

    const transient = response.headers.get('transient-error') === 'true';
    if (
      response.status >= 500 ||
      response.status === 429 ||
      ((response.status === 409 || response.status === 422) && transient)
    ) {
      const message =
        body != null && typeof (body as { message?: unknown }).message === 'string'
          ? (body as { message: string }).message
          : `HTTP ${String(response.status)}`;
      throw new RetryableFailure(`Adyen ${req.method} ${req.path} failed: ${message}`);
    }
    throw new AdyenApiError(response.status, body != null && typeof body === 'object' ? body : {});
  }
}
