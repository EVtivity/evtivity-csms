// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Anthropic Messages API adapter (streaming). Effort goes out as
 * `output_config.effort`; sampling parameters are never sent. Thinking
 * blocks come back in `providerState` and are replayed unchanged.
 */

import Anthropic from '@anthropic-ai/sdk';
import { collectAiStream } from '../../core/collect.js';
import { resolveModelCapabilities } from '../../core/model-registry.js';
import type { AiAdapter, AiAdapterOptions, AiStreamEvent } from '../../core/types.js';
import { assertPartsSupported, describeSdkError, isAbort, toProviderError } from '../shared.js';
import { buildAnthropicParams } from './map-request.js';
import { AnthropicStreamMapper } from './map-stream.js';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** Anthropic error `type` values that decide the neutral code over the HTTP status. */
const ERROR_TYPES = {
  overloaded_error: 'overloaded',
  rate_limit_error: 'rate_limited',
  authentication_error: 'auth',
  permission_error: 'auth',
  not_found_error: 'model_unavailable',
} as const;

export function createAnthropicAdapter(options: AiAdapterOptions): AiAdapter {
  const client = new Anthropic({
    apiKey: options.apiKey,
    // Explicit, so ANTHROPIC_BASE_URL in the environment never redirects requests.
    baseURL:
      options.baseUrl !== undefined && options.baseUrl !== ''
        ? options.baseUrl
        : ANTHROPIC_DEFAULT_BASE_URL,
    // Retries are the engine's decision; an SDK retry would replay a whole turn.
    maxRetries: 0,
    logLevel: 'off',
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });

  const capabilities = (model: string) => resolveModelCapabilities('anthropic', model);

  const adapter: AiAdapter = {
    provider: 'anthropic',
    capabilities,
    async *stream(req, signal): AsyncIterable<AiStreamEvent> {
      const caps = capabilities(req.model);
      assertPartsSupported('anthropic', req, caps);
      const params = await buildAnthropicParams(req, caps);
      const mapper = new AnthropicStreamMapper(req.model);
      let aborted = false;
      try {
        const events = await client.messages.create(params, { signal });
        for await (const event of events) {
          yield* mapper.handle(event);
        }
      } catch (err) {
        if (!isAbort(err, signal)) {
          throw toProviderError('anthropic', err, options.apiKey, describeSdkError, ERROR_TYPES);
        }
        aborted = true;
      }
      yield* mapper.end(aborted || signal.aborted);
    },
    complete(req, signal) {
      return collectAiStream(adapter.stream(req, signal));
    },
  };
  return adapter;
}
