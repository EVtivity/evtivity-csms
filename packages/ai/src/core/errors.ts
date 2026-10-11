// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Neutral provider errors. Adapters map every provider failure to one of
 * these codes and build the message with `sanitizeProviderMessage`, so no
 * API key, auth header or bearer token reaches a log, the database or the
 * client.
 */

import type { ProviderId } from './types.js';

export const AI_PROVIDER_ERROR_CODES = [
  'auth',
  'rate_limited',
  'overloaded',
  'invalid_request',
  'refusal',
  'context_exceeded',
  'model_unavailable',
  'unavailable',
  'aborted',
  'unknown',
] as const;
export type AiProviderErrorCode = (typeof AI_PROVIDER_ERROR_CODES)[number];

const MAX_MESSAGE_LENGTH = 500;

const REDACTED = '[redacted]';

/** Each pattern with its replacement (`$1` keeps a label or query prefix). */
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // Authorization-style headers and their values, in any casing.
  [
    /\b(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key)(\s*[:=]\s*)("[^"]*"|'[^']*'|(?:bearer\s+)?[^\s,;}]+)/gi,
    `$1$2${REDACTED}`,
  ],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED],
  // Query-string keys (`?key=...`, `&api_key=...`).
  [/([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, `$1${REDACTED}`],
  // Provider key shapes.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
];

/**
 * Strips credentials from a provider error message and bounds its length.
 * `knownSecrets` (the configured key) are removed verbatim as well.
 */
export function sanitizeProviderMessage(
  message: string,
  knownSecrets: readonly string[] = [],
): string {
  let out = message;
  for (const secret of knownSecrets) {
    if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.length > MAX_MESSAGE_LENGTH ? `${out.slice(0, MAX_MESSAGE_LENGTH)}...` : out;
}

export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly provider: ProviderId;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(options: {
    code: AiProviderErrorCode;
    provider: ProviderId;
    message: string;
    status?: number;
    retryAfterMs?: number;
    knownSecrets?: readonly string[];
  }) {
    super(sanitizeProviderMessage(options.message, options.knownSecrets));
    this.name = 'AiProviderError';
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isAiProviderError(err: unknown): err is AiProviderError {
  return err instanceof AiProviderError;
}

/**
 * Default HTTP status mapping, for adapters whose provider uses plain HTTP
 * semantics. Adapters refine it with the provider's error body (refusal,
 * context exceeded).
 */
export function providerErrorCodeForStatus(status: number): AiProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_unavailable';
  if (status === 408 || status === 504) return 'unavailable';
  if (status === 413) return 'context_exceeded';
  if (status === 429) return 'rate_limited';
  if (status === 529 || status === 503) return 'overloaded';
  if (status >= 400 && status < 500) return 'invalid_request';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}
