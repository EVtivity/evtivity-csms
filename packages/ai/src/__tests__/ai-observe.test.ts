// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import { AiProviderError } from '../core/errors.js';
import { observeAdapter } from '../core/observe.js';
import type { AiAdapter, AiRequest, AiStreamEvent } from '../core/types.js';

const REQ: AiRequest = {
  model: 'm',
  system: [],
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
  tools: [],
  effort: 'low',
};

function scripted(run: () => AsyncIterable<AiStreamEvent>): AiAdapter {
  const adapter: AiAdapter = {
    provider: 'deepseek',
    capabilities: () => ({}) as ReturnType<AiAdapter['capabilities']>,
    stream: () => run(),
    complete: () => Promise.reject(new Error('unused')),
  };
  return adapter;
}

async function* ok(): AsyncIterable<AiStreamEvent> {
  yield { type: 'text_delta', text: 'Hello' };
  yield {
    type: 'finish',
    reason: 'end',
    usage: {
      inputTokens: 1,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
  } as AiStreamEvent;
}

// eslint-disable-next-line require-yield
async function* quota(): AsyncIterable<AiStreamEvent> {
  throw new AiProviderError({
    code: 'quota_exceeded',
    provider: 'deepseek',
    message: 'Insufficient Balance',
    status: 402,
  });
}

describe('observeAdapter', () => {
  it('reports a completed call as a success and returns the result unchanged', async () => {
    const onSuccess = vi.fn();
    const onProviderError = vi.fn();
    const adapter = observeAdapter(scripted(ok), { onSuccess, onProviderError });
    const result = await adapter.complete(REQ, new AbortController().signal);
    expect(result.text).toBe('Hello');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onProviderError).not.toHaveBeenCalled();
  });

  it('reports a provider error and rethrows it', async () => {
    const onSuccess = vi.fn();
    const onProviderError = vi.fn();
    const adapter = observeAdapter(scripted(quota), { onSuccess, onProviderError });
    await expect(adapter.complete(REQ, new AbortController().signal)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(onProviderError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'quota_exceeded' }),
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('never lets an observer failure reach the call', async () => {
    const adapter = observeAdapter(scripted(ok), {
      onSuccess: () => Promise.reject(new Error('database down')),
    });
    await expect(adapter.complete(REQ, new AbortController().signal)).resolves.toMatchObject({
      text: 'Hello',
    });
    const throwing = observeAdapter(scripted(quota), {
      onProviderError: () => {
        throw new Error('observer');
      },
    });
    await expect(throwing.complete(REQ, new AbortController().signal)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
  });

  it('reports no success for an aborted call', async () => {
    const onSuccess = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const adapter = observeAdapter(scripted(ok), { onSuccess });
    await adapter.complete(REQ, controller.signal);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
