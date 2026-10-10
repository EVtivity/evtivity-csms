// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  AiProviderError,
  AiStreamAccumulator,
  EFFORTS,
  PROVIDER_IDS,
  UNKNOWN_MODEL_CAPABILITIES,
  UnknownProviderError,
  addUsage,
  collectAiStream,
  createProviderRegistry,
  emptyUsage,
  findUnsupportedParts,
  getModelEntry,
  getProviderEntry,
  isEffort,
  isProviderId,
  listProviderEntries,
  providerErrorCodeForStatus,
  resolveModelCapabilities,
  resolveModelId,
  sanitizeProviderMessage,
  stripForeignProviderState,
} from '../services/ai/core/index.js';
import type {
  AiAdapter,
  AiMessage,
  AiStreamEvent,
  ModelCapabilities,
} from '../services/ai/core/index.js';

async function* fromArray(events: AiStreamEvent[]): AsyncGenerator<AiStreamEvent> {
  for (const e of events) {
    await Promise.resolve();
    yield e;
  }
}

describe('core type guards', () => {
  it('accepts only known provider ids and efforts', () => {
    for (const id of PROVIDER_IDS) expect(isProviderId(id)).toBe(true);
    expect(isProviderId('ollama')).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
    expect(EFFORTS).toEqual(['low', 'medium', 'high']);
    expect(isEffort('medium')).toBe(true);
    expect(isEffort('xhigh')).toBe(false);
  });
});

describe('model registry', () => {
  it('every provider has an entry whose default and router models are listed', () => {
    expect(listProviderEntries().map((p) => p.id)).toEqual([...PROVIDER_IDS]);
    for (const entry of listProviderEntries()) {
      expect(getModelEntry(entry.id, entry.defaultModel), entry.id).toBeDefined();
      expect(getModelEntry(entry.id, entry.routerModel), entry.id).toBeDefined();
      const ids = entry.models.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('capability flags are complete and consistent for every model', () => {
    const keys = Object.keys(UNKNOWN_MODEL_CAPABILITIES).sort();
    for (const entry of listProviderEntries()) {
      for (const model of entry.models) {
        const caps: ModelCapabilities = model.capabilities;
        expect(Object.keys(caps).sort(), model.id).toEqual(keys);
        expect(caps.streaming).toBe(true);
        expect(caps.documents.text).toBe(true);
        // O2: no model gets sampling parameters until a contract run proves them safe.
        expect(caps.samplingParams).toBe(false);
        for (const e of caps.effort) expect(EFFORTS).toContain(e);
        expect(caps.maxContextTokens).toBeGreaterThan(caps.maxOutputTokens);
        if (caps.vision !== false) {
          expect(caps.vision.formats.length).toBeGreaterThan(0);
          expect(caps.vision.maxBytes).toBeGreaterThan(0);
          expect(caps.vision.maxImages).toBeGreaterThan(0);
        }
        if (model.prices !== null) {
          expect(Number.isInteger(model.prices.inputPerMTok)).toBe(true);
          expect(Number.isInteger(model.prices.outputPerMTok)).toBe(true);
        }
      }
    }
  });

  it('retired defaults are gone (B1, B2)', () => {
    expect(getModelEntry('anthropic', 'claude-sonnet-4-20250514')).toBeUndefined();
    expect(getModelEntry('gemini', 'gemini-2.0-flash')).toBeUndefined();
  });

  it('capabilities are per model: DeepSeek flash has vision, v4-pro does not', () => {
    expect(resolveModelCapabilities('deepseek', 'deepseek-flash').vision).not.toBe(false);
    expect(resolveModelCapabilities('deepseek', 'deepseek-v4-pro').vision).toBe(false);
  });

  it('an unlisted model id gets the conservative capability set', () => {
    const caps = resolveModelCapabilities('openai', 'my-fine-tune');
    expect(caps).toBe(UNKNOWN_MODEL_CAPABILITIES);
    expect(caps.vision).toBe(false);
    expect(caps.effort).toEqual([]);
  });

  it('resolveModelId falls back to the provider default for an empty setting', () => {
    expect(resolveModelId('anthropic', '')).toBe(getProviderEntry('anthropic').defaultModel);
    expect(resolveModelId('anthropic', '   ')).toBe(getProviderEntry('anthropic').defaultModel);
    expect(resolveModelId('anthropic', null)).toBe(getProviderEntry('anthropic').defaultModel);
    expect(resolveModelId('openai', ' gpt-6-luna ')).toBe('gpt-6-luna');
  });
});

describe('provider registry', () => {
  const fake = (provider: AiAdapter['provider']): AiAdapter => ({
    provider,
    capabilities: () => UNKNOWN_MODEL_CAPABILITIES,
    stream: () => fromArray([{ type: 'finish', reason: 'end' }]),
    complete: () => collectAiStream(fromArray([{ type: 'finish', reason: 'end' }])),
  });

  it('creates adapters by id and lists the available ones in order', () => {
    const registry = createProviderRegistry({
      openai: () => fake('openai'),
      anthropic: () => fake('anthropic'),
    });
    expect(registry.available()).toEqual(['anthropic', 'openai']);
    expect(registry.has('gemini')).toBe(false);
    expect(registry.create('openai', { apiKey: 'k' }).provider).toBe('openai');
    expect(() => registry.create('gemini', { apiKey: 'k' })).toThrow(UnknownProviderError);
  });

  it('refuses a factory that returns another provider adapter', () => {
    const registry = createProviderRegistry({ gemini: () => fake('openai') });
    expect(() => registry.create('gemini', { apiKey: 'k' })).toThrow(/returned an adapter/);
  });

  it('passes the options to the factory', () => {
    let seen: unknown;
    const registry = createProviderRegistry({
      deepseek: (options) => {
        seen = options;
        return fake('deepseek');
      },
    });
    registry.create('deepseek', { apiKey: 'k', baseUrl: 'https://api.deepseek.com/beta' });
    expect(seen).toEqual({ apiKey: 'k', baseUrl: 'https://api.deepseek.com/beta' });
  });
});

describe('stream accumulation', () => {
  it('collects text, tool calls, errors, citations, last usage and provider state', async () => {
    const usage1 = { ...emptyUsage(), inputTokens: 10 };
    const usage2 = { ...emptyUsage(), inputTokens: 10, outputTokens: 4 };
    const result = await collectAiStream(
      fromArray([
        { type: 'text_delta', text: 'Hel' },
        { type: 'usage', usage: usage1 },
        { type: 'text_delta', text: 'lo' },
        { type: 'tool_call_start', index: 0, id: 't1', name: 'list_sites' },
        { type: 'tool_call_delta', id: 't1', argumentsDelta: '{"limit":' },
        { type: 'tool_call_delta', id: 't1', argumentsDelta: '5}' },
        { type: 'tool_call_done', id: 't1', name: 'list_sites', arguments: { limit: 5 } },
        { type: 'tool_call_start', index: 1, id: 't2', name: 'get_site' },
        { type: 'tool_call_error', id: 't2', name: 'get_site', rawArguments: '{', message: 'bad' },
        { type: 'citation', citation: { passageId: 'doc:1' } },
        { type: 'usage', usage: usage2 },
        {
          type: 'finish',
          reason: 'tool_use',
          providerState: { provider: 'anthropic', model: 'm', opaque: { sig: 'x' } },
        },
      ]),
    );
    expect(result).toEqual({
      text: 'Hello',
      toolCalls: [{ type: 'tool_call', id: 't1', name: 'list_sites', arguments: { limit: 5 } }],
      toolCallErrors: [{ id: 't2', name: 'get_site', rawArguments: '{', message: 'bad' }],
      citations: [{ passageId: 'doc:1' }],
      usage: usage2,
      finishReason: 'tool_use',
      providerState: { provider: 'anthropic', model: 'm', opaque: { sig: 'x' } },
    });
  });

  it('a stream cut off before finish counts as stopped with the partial text', () => {
    const acc = new AiStreamAccumulator();
    acc.push({ type: 'text_delta', text: 'partial' });
    expect(acc.finished).toBe(false);
    expect(acc.result()).toMatchObject({ text: 'partial', finishReason: 'stopped' });
    expect(acc.result()).not.toHaveProperty('providerState');
  });

  it('addUsage sums every field', () => {
    const a = {
      inputTokens: 1,
      cachedReadTokens: 2,
      cacheWriteTokens: 3,
      outputTokens: 4,
      reasoningTokens: 5,
    };
    expect(addUsage(a, a)).toEqual({
      inputTokens: 2,
      cachedReadTokens: 4,
      cacheWriteTokens: 6,
      outputTokens: 8,
      reasoningTokens: 10,
    });
  });
});

describe('message helpers', () => {
  const history: AiMessage[] = [
    { role: 'user', parts: [{ type: 'text', text: 'q' }] },
    {
      role: 'assistant',
      parts: [{ type: 'text', text: 'a1' }],
      providerState: { provider: 'anthropic', model: 'claude-sonnet-5-5', opaque: { t: 1 } },
    },
    {
      role: 'assistant',
      parts: [{ type: 'text', text: 'a2' }],
      providerState: { provider: 'deepseek', model: 'deepseek-flash', opaque: { r: 'x' } },
    },
  ];

  it('keeps provider state only for the same provider and model', () => {
    const out = stripForeignProviderState(history, 'anthropic', 'claude-sonnet-5-5');
    expect(out[1]?.providerState).toBeDefined();
    expect(out[2]).toEqual({ role: 'assistant', parts: [{ type: 'text', text: 'a2' }] });
    const otherModel = stripForeignProviderState(history, 'anthropic', 'claude-opus-5-5');
    expect(otherModel.some((m) => m.providerState !== undefined)).toBe(false);
    // The input is not mutated.
    expect(history[2]?.providerState).toBeDefined();
  });

  it('finds image and PDF parts a model cannot take', () => {
    const messages: AiMessage[] = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'look' },
          { type: 'image', attachmentId: 'a1', mime: 'image/png' },
          { type: 'document', attachmentId: 'a2', mime: 'application/pdf' },
          { type: 'document', attachmentId: 'a3', mime: 'text/csv' },
        ],
      },
    ];
    const pro = resolveModelCapabilities('deepseek', 'deepseek-v4-pro');
    expect(findUnsupportedParts({ messages }, pro).map((u) => u.reason)).toEqual(['vision', 'pdf']);
    const sonnet = resolveModelCapabilities('anthropic', 'claude-sonnet-5-5');
    expect(findUnsupportedParts({ messages }, sonnet)).toEqual([]);
  });

  it('flags unsupported image formats, too many images and tool parts on a tool-less model', () => {
    const base = resolveModelCapabilities('anthropic', 'claude-sonnet-5-5');
    const caps: ModelCapabilities = {
      ...base,
      tools: false,
      vision: { formats: ['image/png'], maxBytes: 1, maxLongEdgePx: 1, maxImages: 1 },
    };
    const messages: AiMessage[] = [
      {
        role: 'user',
        parts: [
          { type: 'image', attachmentId: 'a', mime: 'image/png' },
          { type: 'image', attachmentId: 'b', mime: 'image/png' },
          { type: 'image', attachmentId: 'c', mime: 'image/gif' },
        ],
      },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 't', name: 'x', arguments: {} }] },
    ];
    expect(findUnsupportedParts({ messages }, caps).map((u) => [u.messageIndex, u.reason])).toEqual(
      [
        [0, 'too_many_images'],
        [0, 'image_format'],
        [1, 'tools'],
      ],
    );
  });
});

describe('provider errors', () => {
  it('strips keys, auth headers, bearer tokens, query keys and JWTs', () => {
    const configured = 'my-configured-key-123';
    const msg = sanitizeProviderMessage(
      [
        `invalid key ${configured}`,
        'Authorization: Bearer abc.def-ghi',
        'x-api-key: sk-ant-api03-AAAABBBBCCCC',
        'headers {"x-goog-api-key":"AIzaSyA1234567890abcdefghij"}',
        'GET /v1/models?key=AIzaSecretSecretSecret12345&alt=sse',
        'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
        'openai sk-proj-0123456789abcdef',
      ].join('\n'),
      [configured],
    );
    for (const secret of [
      configured,
      'abc.def-ghi',
      'sk-ant-api03',
      'AIzaSyA1234567890',
      'AIzaSecret',
      'eyJhbGciOiJIUzI1NiJ9',
      'sk-proj-0123456789abcdef',
    ]) {
      expect(msg).not.toContain(secret);
    }
    expect(msg).toContain('?key=[redacted]&alt=sse');
    expect(msg).toContain('Authorization: [redacted]');
  });

  it('bounds the message length', () => {
    expect(sanitizeProviderMessage('x'.repeat(2000)).length).toBeLessThanOrEqual(503);
  });

  it('AiProviderError sanitizes its message and keeps the neutral code', () => {
    const err = new AiProviderError({
      code: 'auth',
      provider: 'openai',
      status: 401,
      message: 'Incorrect API key provided: sk-live-abcdefghijk',
    });
    expect(err.message).not.toContain('sk-live-abcdefghijk');
    expect(err).toMatchObject({ code: 'auth', provider: 'openai', status: 401 });
  });

  it('maps HTTP statuses to neutral codes', () => {
    expect(
      [401, 403, 404, 408, 413, 429, 400, 422, 500, 503, 504, 529, 302].map(
        providerErrorCodeForStatus,
      ),
    ).toEqual([
      'auth',
      'auth',
      'model_unavailable',
      'unavailable',
      'context_exceeded',
      'rate_limited',
      'invalid_request',
      'invalid_request',
      'unavailable',
      'overloaded',
      'unavailable',
      'overloaded',
      'unknown',
    ]);
  });
});
