// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * OpenAI Responses API adapter (streaming, stateless). Requests use
 * `store: false` and ask for `reasoning.encrypted_content`; the reasoning
 * items come back in `providerState` and are replayed in the next tool round.
 * Effort goes out as `reasoning.effort`; sampling parameters are never sent.
 */

import OpenAI from 'openai';
import { collectAiStream } from '../../core/collect.js';
import { resolveModelCapabilities } from '../../core/model-registry.js';
import type { AiAdapter, AiAdapterOptions, AiStreamEvent } from '../../core/types.js';
import { assertPartsSupported, describeSdkError, isAbort, toProviderError } from '../shared.js';
import { buildOpenAiParams } from './map-request.js';
import { OpenAiStreamMapper } from './map-stream.js';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** OpenAI error codes that decide the neutral code over the HTTP status. */
const ERROR_CODES = {
  context_length_exceeded: 'context_exceeded',
  model_not_found: 'model_unavailable',
  rate_limit_exceeded: 'rate_limited',
  server_is_overloaded: 'overloaded',
  stream_truncated: 'unavailable',
  server_error: 'unavailable',
  invalid_api_key: 'auth',
} as const;

export function createOpenAiAdapter(options: AiAdapterOptions): AiAdapter {
  const client = new OpenAI({
    apiKey: options.apiKey,
    // Explicit, so OPENAI_BASE_URL in the environment never redirects requests.
    baseURL:
      options.baseUrl !== undefined && options.baseUrl !== ''
        ? options.baseUrl
        : OPENAI_DEFAULT_BASE_URL,
    maxRetries: 0,
    logLevel: 'off',
    organization: null,
    project: null,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });

  const capabilities = (model: string) => resolveModelCapabilities('openai', model);

  const adapter: AiAdapter = {
    provider: 'openai',
    capabilities,
    async *stream(req, signal): AsyncIterable<AiStreamEvent> {
      const caps = capabilities(req.model);
      assertPartsSupported('openai', req, caps);
      const params = await buildOpenAiParams(req, caps);
      const mapper = new OpenAiStreamMapper(req.model);
      let aborted = false;
      try {
        const events = await client.responses.create(params, { signal });
        for await (const event of events) {
          yield* mapper.handle(event);
        }
      } catch (err) {
        if (!isAbort(err, signal)) {
          throw toProviderError('openai', err, options.apiKey, describeSdkError, ERROR_CODES);
        }
        aborted = true;
      }
      let closing: AiStreamEvent[];
      try {
        closing = mapper.end(aborted || signal.aborted);
      } catch (err) {
        throw toProviderError('openai', err, options.apiKey, describeSdkError, ERROR_CODES);
      }
      yield* closing;
    },
    complete(req, signal) {
      return collectAiStream(adapter.stream(req, signal));
    },
  };
  return adapter;
}
