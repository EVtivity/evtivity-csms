// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProviderError } from '../core/errors.js';
import {
  describeSdkError,
  errorCodeFor,
  parseToolArguments,
  resolveAttachment,
  retryAfterMs,
  toProviderError,
  toolCallCut,
  usage,
} from '../providers/shared.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('shared provider helpers', () => {
  it('refuses an attachment without a resolver', async () => {
    await expect(
      resolveAttachment('anthropic', {} as never, { attachmentId: 'att_1' } as never),
    ).rejects.toMatchObject({ code: 'invalid_request', provider: 'anthropic' });
  });

  it('parses only JSON objects as tool arguments', () => {
    expect(parseToolArguments('  ')).toEqual({ ok: true, value: {} });
    expect(parseToolArguments('[1]')).toEqual({
      ok: false,
      error: 'Tool arguments are not a JSON object',
    });
    expect(parseToolArguments('{')).toMatchObject({ ok: false });
    expect(toolCallCut('t', 'f', '{"a')).toMatchObject({
      type: 'tool_call_error',
      rawArguments: '{"a',
    });
  });

  it('counts only positive finite token numbers, truncated', () => {
    expect(usage({ inputTokens: 3.9, outputTokens: -1, reasoningTokens: Number.NaN })).toEqual({
      inputTokens: 3,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('reads retry-after-ms, seconds or an HTTP date from Headers or a plain object', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '1500' }))).toBe(1500);
    expect(retryAfterMs({ 'retry-after': '2' })).toBe(2000);
    expect(retryAfterMs({ 'retry-after': 'Thu, 12 Nov 2026 12:00:05 GMT' })).toBe(5000);
    expect(retryAfterMs({ 'retry-after': 'later' })).toBeUndefined();
    expect(retryAfterMs({ 'retry-after': 3 })).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });

  it('refines the status code with overrides and context text', () => {
    expect(
      errorCodeFor(400, 'credit balance is too low', { 'credit balance': 'quota_exceeded' }),
    ).toBe('quota_exceeded');
    expect(errorCodeFor(400, 'prompt is too long')).toBe('context_exceeded');
    expect(errorCodeFor(undefined, 'boom')).toBe('unknown');
  });

  it('keeps a provider error, else builds one with the retry and without the key', () => {
    const existing = new AiProviderError({ code: 'auth', provider: 'openai', message: 'x' });
    expect(toProviderError('openai', existing, 'sk', () => ({ text: '' }))).toBe(existing);
    const built = toProviderError('openai', new Error('e'), 'sk-secret', () => ({
      status: 429,
      text: 'rate limited for sk-secret',
      headers: { 'retry-after': '1' },
    }));
    expect(built).toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 1000 });
    expect(built.message).not.toContain('sk-secret');
    const bare = toProviderError('openai', 'x', 'sk', () => ({ text: '' }));
    expect(bare.message).toContain('Provider request failed');
    expect(bare.status).toBeUndefined();
  });

  it('describes an SDK error with its body once', () => {
    expect(describeSdkError('plain')).toEqual({ text: 'plain' });
    expect(
      describeSdkError({ status: 400, message: 'Bad', error: { type: 'x' }, headers: {} }),
    ).toEqual({
      status: 400,
      text: 'Bad {"type":"x"}',
      headers: {},
    });
    expect(describeSdkError({ message: 'Bad {"type":"x"}', error: { type: 'x' } }).text).toBe(
      'Bad {"type":"x"}',
    );
  });
});
