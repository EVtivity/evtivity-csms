// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Google Gemini adapter (`@google/genai`, `generateContentStream`). Effort
 * maps to `thinkingConfig.thinkingLevel`; sampling parameters are never
 * sent. Thought signatures come back in `providerState` and are replayed in
 * order. Tool results go out wrapped as `{ result }` and are never parsed.
 */

import { GoogleGenAI } from '@google/genai';
import { collectAiStream } from '../../core/collect.js';
import { resolveModelCapabilities } from '../../core/model-registry.js';
import type { AiAdapter, AiAdapterOptions, AiStreamEvent } from '../../core/types.js';
import { assertPartsSupported, isAbort, toProviderError } from '../shared.js';
import { CitationStream } from '../citations.js';
import { buildGeminiParams } from './map-request.js';
import { GeminiStreamMapper } from './map-stream.js';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/**
 * Google status names and texts in the error body that decide the neutral
 * code over the HTTP status, checked in order. Quota and credit replies come
 * before `RESOURCE_EXHAUSTED`, which also answers per-minute limits
 * (https://ai.google.dev/gemini-api/docs/api-errors): `quota_exceeded`
 * ("You have exceeded your daily quota"), a `google.rpc.QuotaFailure`
 * violation whose `quotaId` is a per-day quota (such as
 * `GenerateRequestsPerDayPerProjectPerModel-FreeTier`), "Your project has
 * exceeded its monthly spending cap", and 402 `payment_required` ("Your
 * prepayment credits are depleted").
 */
const ERROR_CODES = {
  API_KEY_INVALID: 'auth',
  PERMISSION_DENIED: 'auth',
  UNAUTHENTICATED: 'auth',
  payment_required: 'quota_exceeded',
  'prepayment credits are depleted': 'quota_exceeded',
  'spending cap': 'quota_exceeded',
  quota_exceeded: 'quota_exceeded',
  PerDay: 'quota_exceeded',
  RESOURCE_EXHAUSTED: 'rate_limited',
  stream_truncated: 'unavailable',
} as const;

/** The SDK's `ApiError` carries `status` and the JSON error body as its message. */
function describeGeminiError(err: unknown): { status?: number; text: string } {
  if (typeof err !== 'object' || err === null) return { text: String(err) };
  const e = err as { status?: unknown; message?: unknown };
  return {
    ...(typeof e.status === 'number' ? { status: e.status } : {}),
    text: typeof e.message === 'string' ? e.message : '',
  };
}

export function createGeminiAdapter(options: AiAdapterOptions): AiAdapter {
  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    // Explicit, so environment variables never switch to Vertex AI or another endpoint.
    vertexai: false,
    httpOptions: {
      baseUrl:
        options.baseUrl !== undefined && options.baseUrl !== ''
          ? options.baseUrl
          : GEMINI_DEFAULT_BASE_URL,
      // No retryOptions: the SDK then never retries (the engine decides).
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    },
  });

  const capabilities = (model: string) => resolveModelCapabilities('gemini', model);

  const adapter: AiAdapter = {
    provider: 'gemini',
    capabilities,
    async *stream(req, signal): AsyncIterable<AiStreamEvent> {
      const caps = capabilities(req.model);
      assertPartsSupported('gemini', req, caps);
      const params = await buildGeminiParams(req, caps, signal);
      const mapper = new GeminiStreamMapper(req.model);
      const cite = new CitationStream(caps);
      let aborted = false;
      try {
        const chunks = await client.models.generateContentStream(params);
        for await (const chunk of chunks) {
          yield* cite.map(mapper.handle(chunk));
        }
      } catch (err) {
        if (!isAbort(err, signal)) {
          throw toProviderError('gemini', err, options.apiKey, describeGeminiError, ERROR_CODES);
        }
        aborted = true;
      }
      let closing: AiStreamEvent[];
      try {
        closing = mapper.end(aborted || signal.aborted);
      } catch (err) {
        throw toProviderError('gemini', err, options.apiKey, describeGeminiError, ERROR_CODES);
      }
      yield* cite.map(closing);
    },
    complete(req, signal) {
      return collectAiStream(adapter.stream(req, signal));
    },
  };
  return adapter;
}
