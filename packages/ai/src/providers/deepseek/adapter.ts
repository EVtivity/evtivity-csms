// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * DeepSeek adapter: Chat Completions through the `openai` SDK with the
 * DeepSeek base URL. Thinking is on; effort maps to `reasoning_effort`, and
 * `reasoning_content` is kept in `providerState` and sent back in tool rounds.
 * Strict tools are used only on the `/beta` endpoint.
 */

import OpenAI from 'openai';
import { collectAiStream } from '../../core/collect.js';
import { resolveModelCapabilities } from '../../core/model-registry.js';
import type { AiAdapter, AiAdapterOptions, AiStreamEvent } from '../../core/types.js';
import { assertPartsSupported, describeSdkError, isAbort, toProviderError } from '../shared.js';
import { CitationStream } from '../citations.js';
import { buildDeepSeekParams } from './map-request.js';
import { DeepSeekStreamMapper } from './map-stream.js';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

/**
 * DeepSeek error texts that decide the neutral code over the HTTP status.
 * "Insufficient Balance" is HTTP 402, "You have run out of balance"
 * (https://api-docs.deepseek.com/quick_start/error_codes): the account needs
 * a top-up, so it is `quota_exceeded`, not the 429 "Rate Limit Reached".
 */
const ERROR_CODES = {
  insufficient_system_resource: 'overloaded',
  stream_truncated: 'unavailable',
  'Insufficient Balance': 'quota_exceeded',
  'Model Not Exist': 'model_unavailable',
} as const;

export function createDeepSeekAdapter(options: AiAdapterOptions): AiAdapter {
  const baseURL =
    options.baseUrl !== undefined && options.baseUrl !== ''
      ? options.baseUrl
      : DEEPSEEK_DEFAULT_BASE_URL;
  const strictEndpoint = /\/beta\/?$/.test(baseURL);
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL,
    maxRetries: 0,
    logLevel: 'off',
    organization: null,
    project: null,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });

  const capabilities = (model: string) => resolveModelCapabilities('deepseek', model);

  const adapter: AiAdapter = {
    provider: 'deepseek',
    capabilities,
    async *stream(req, signal): AsyncIterable<AiStreamEvent> {
      const caps = capabilities(req.model);
      assertPartsSupported('deepseek', req, caps);
      const params = await buildDeepSeekParams(req, caps, strictEndpoint);
      const mapper = new DeepSeekStreamMapper(req.model);
      const cite = new CitationStream(caps);
      let aborted = false;
      try {
        const chunks = await client.chat.completions.create(params, { signal });
        for await (const chunk of chunks) {
          yield* cite.map(mapper.handle(chunk));
        }
      } catch (err) {
        if (!isAbort(err, signal)) {
          throw toProviderError('deepseek', err, options.apiKey, describeSdkError, ERROR_CODES);
        }
        aborted = true;
      }
      let closing: AiStreamEvent[];
      try {
        closing = mapper.end(aborted || signal.aborted);
      } catch (err) {
        throw toProviderError('deepseek', err, options.apiKey, describeSdkError, ERROR_CODES);
      }
      yield* cite.map(closing);
    },
    complete(req, signal) {
      return collectAiStream(adapter.stream(req, signal));
    },
  };
  return adapter;
}
