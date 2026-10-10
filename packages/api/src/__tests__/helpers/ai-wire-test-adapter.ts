// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A minimal HTTP adapter for L0 tests: POSTs the request to
 * `<baseUrl>/v1/stream` and reads SSE frames whose `data` is a neutral
 * `AiStreamEvent` JSON. It follows the adapter contract (abort ends the
 * stream with `finish: stopped`, HTTP errors become `AiProviderError`), so
 * the harness and transport tests run without a real provider adapter.
 */

import { collectAiStream } from '../../services/ai/core/collect.js';
import { AiProviderError, providerErrorCodeForStatus } from '../../services/ai/core/errors.js';
import { resolveModelCapabilities } from '../../services/ai/core/model-registry.js';
import type {
  AiAdapter,
  AiAdapterOptions,
  AiStreamEvent,
  ProviderId,
} from '../../services/ai/core/types.js';

export function createWireTestAdapter(
  options: AiAdapterOptions,
  provider: ProviderId = 'deepseek',
): AiAdapter {
  const doFetch = options.fetch ?? globalThis.fetch;
  const adapter: AiAdapter = {
    provider,
    capabilities: (model) => resolveModelCapabilities(provider, model),
    async *stream(req, signal): AsyncGenerator<AiStreamEvent> {
      let res: Response;
      try {
        res = await doFetch(`${options.baseUrl ?? ''}/v1/stream`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(req),
          signal,
        });
      } catch (err) {
        if (signal.aborted) {
          yield { type: 'finish', reason: 'stopped' };
          return;
        }
        throw err;
      }
      if (!res.ok || res.body === null) {
        const text = await res.text();
        throw new AiProviderError({
          code: providerErrorCodeForStatus(res.status),
          provider,
          status: res.status,
          message: `HTTP ${String(res.status)}: ${text}`,
          knownSecrets: [options.apiKey],
        });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = frame
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n');
            if (data === '') continue;
            const event = JSON.parse(data) as AiStreamEvent;
            if (event.type === 'finish') finished = true;
            yield event;
          }
        }
      } catch (err) {
        if (!signal.aborted) throw err;
      } finally {
        reader.releaseLock();
      }
      if (!finished) yield { type: 'finish', reason: 'stopped' };
    },
    complete: (req, signal) => collectAiStream(adapter.stream(req, signal)),
  };
  return adapter;
}
