// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The provider stream mappers fed event by event: cut and malformed tool
// calls, usage, finish reasons, stream errors and the replay state.

import { describe, expect, it } from 'vitest';
import { AnthropicStreamMapper } from '../providers/anthropic/map-stream.js';
import { OpenAiStreamError, OpenAiStreamMapper } from '../providers/openai/map-stream.js';
import { DeepSeekStreamError, DeepSeekStreamMapper } from '../providers/deepseek/map-stream.js';

type AnyEvent = Record<string, unknown>;
const feed = (m: { handle: (e: never) => unknown[] }, events: AnyEvent[]) =>
  events.flatMap((e) => m.handle(e as never) as AnyEvent[]);

describe('AnthropicStreamMapper', () => {
  it('keeps start usage the delta leaves out and takes the fields it sends', () => {
    const m = new AnthropicStreamMapper('claude');
    const out = feed(m, [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
            output_tokens: 1,
          },
        },
      },
      {
        type: 'message_delta',
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
          output_tokens: 20,
          output_tokens_details: { thinking_tokens: 7 },
        },
        delta: { stop_reason: 'max_tokens' },
      },
      { type: 'message_stop' },
    ]);
    expect(out).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 19,
          cachedReadTokens: 3,
          cacheWriteTokens: 4,
          outputTokens: 20,
          reasoningTokens: 7,
        },
      },
    ]);
    expect(m.end(false)).toEqual([{ type: 'finish', reason: 'max_tokens' }]);
  });

  it('replays thinking, redacted thinking, text and tool input in block order', () => {
    const m = new AnthropicStreamMapper('claude');
    const out = feed(m, [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'a', signature: 's' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'b' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'g' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'x' },
      },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'Hi' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '' } },
      { type: 'content_block_start', index: 3, content_block: { type: 'server_tool_use' } },
      {
        type: 'content_block_start',
        index: 4,
        content_block: { type: 'tool_use', id: 't1', name: 'f' },
      },
      {
        type: 'content_block_delta',
        index: 4,
        delta: { type: 'input_json_delta', partial_json: '' },
      },
      {
        type: 'content_block_delta',
        index: 4,
        delta: { type: 'input_json_delta', partial_json: '{"a"' },
      },
      {
        type: 'content_block_delta',
        index: 9,
        delta: { type: 'input_json_delta', partial_json: 'x' },
      },
      { type: 'content_block_stop', index: 4 },
      { type: 'content_block_stop', index: 4 },
      { type: 'content_block_start', index: 5, content_block: { type: 'text', text: '' } },
      { type: 'message_delta', usage: {}, delta: { stop_reason: 'tool_use' } },
    ]);
    expect(out.filter((e) => e['type'] === 'tool_call_error')).toHaveLength(1);
    expect(out.filter((e) => e['type'] === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Hi' },
    ]);
    const [finish] = m.end(false);
    expect(finish).toEqual({
      type: 'finish',
      reason: 'tool_use',
      providerState: {
        provider: 'anthropic',
        model: 'claude',
        opaque: {
          content: [
            { type: 'thinking', thinking: 'ab', signature: 'sg' },
            { type: 'redacted_thinking', data: 'x' },
            { type: 'text', text: 'Hi' },
            { type: 'tool_use', id: 't1', name: 'f', input: {} },
          ],
        },
      },
    });
  });

  it('maps citations of search results only, and cuts an open tool call on abort', () => {
    const m = new AnthropicStreamMapper('claude');
    const out = feed(m, [
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'citations_delta',
          citation: { type: 'search_result_location', source: 'p1', cited_text: 'q' },
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'citations_delta', citation: { type: 'char_location' } },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't', name: 'f' },
      },
    ]);
    expect(out).toContainEqual({ type: 'citation', citation: { passageId: 'p1', citedText: 'q' } });
    expect(out.filter((e) => e['type'] === 'citation')).toHaveLength(1);
    const end = m.end(true);
    expect(end[0]).toMatchObject({ type: 'tool_call_error', id: 't' });
    expect(end[1]).toEqual({ type: 'finish', reason: 'stopped' });
  });

  it('finishes as end without a stop reason', () => {
    expect(new AnthropicStreamMapper('claude').end(false)).toEqual([
      { type: 'finish', reason: 'end' },
    ]);
  });
});

describe('OpenAiStreamMapper', () => {
  it('ignores argument deltas of unknown calls and closes a call once', () => {
    const m = new OpenAiStreamMapper('gpt');
    const out = feed(m, [
      { type: 'response.output_item.added', item: { type: 'message' } },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'i1', call_id: 'c1', name: 'f' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'nope', delta: 'x' },
      { type: 'response.function_call_arguments.delta', item_id: 'i1', delta: '' },
      { type: 'response.function_call_arguments.delta', item_id: 'i1', delta: '{}' },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'i1', call_id: 'c1', name: 'f', arguments: '{}' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'i1', call_id: 'c1', name: 'f', arguments: '{}' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'i9', call_id: 'c9', name: 'g', arguments: '{}' },
      },
      { type: 'response.output_text.delta', delta: '' },
      { type: 'response.completed', response: { usage: null } },
      { type: 'response.created' },
    ]);
    expect(out.map((e) => e['type'])).toEqual([
      'tool_call_start',
      'tool_call_delta',
      'tool_call_done',
    ]);
    expect(m.end(false)).toEqual([{ type: 'finish', reason: 'tool_use' }]);
  });

  it('marks a refusal and an incomplete response, with usage', () => {
    const refused = new OpenAiStreamMapper('gpt');
    feed(refused, [
      { type: 'response.refusal.delta', delta: '' },
      { type: 'response.completed', response: { usage: null } },
    ]);
    expect(refused.end(false)).toEqual([{ type: 'finish', reason: 'refusal' }]);

    for (const [reason, expected] of [
      ['content_filter', 'refusal'],
      ['max_output_tokens', 'max_tokens'],
    ] as const) {
      const m = new OpenAiStreamMapper('gpt');
      const out = feed(m, [
        {
          type: 'response.incomplete',
          response: {
            incomplete_details: { reason },
            usage: {
              input_tokens: 5,
              input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 },
              output_tokens: 2,
              output_tokens_details: { reasoning_tokens: 1 },
            },
          },
        },
      ]);
      expect(out[0]).toMatchObject({ type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } });
      expect(m.end(false)).toEqual([{ type: 'finish', reason: expected }]);
    }
  });

  it('throws the stream failures and a truncated stream', () => {
    expect(() =>
      new OpenAiStreamMapper('gpt').handle({
        type: 'response.failed',
        response: { error: null },
      } as never),
    ).toThrow(/server_error: The response failed/);
    expect(() =>
      new OpenAiStreamMapper('gpt').handle({
        type: 'response.failed',
        response: { error: { code: 'rate_limit_exceeded', message: 'slow down' } },
      } as never),
    ).toThrow(OpenAiStreamError);
    expect(() =>
      new OpenAiStreamMapper('gpt').handle({ type: 'error', code: null, message: 'boom' } as never),
    ).toThrow(/error: boom/);
    expect(() => new OpenAiStreamMapper('gpt').end(false)).toThrow(/stream_truncated/);
  });

  it('cuts an open call on abort', () => {
    const m = new OpenAiStreamMapper('gpt');
    feed(m, [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'c1', name: 'f' },
      },
    ]);
    const out = m.end(true);
    expect(out[0]).toMatchObject({ type: 'tool_call_error', id: 'c1' });
    expect(out[1]).toEqual({ type: 'finish', reason: 'stopped' });
  });
});

describe('DeepSeekStreamMapper', () => {
  const chunk = (delta: AnyEvent, finish: string | null = null, usage: AnyEvent | null = null) => ({
    choices: [{ delta, finish_reason: finish }],
    usage,
  });

  it('names a call without an id by its index and reads cache hits from either field', () => {
    const m = new DeepSeekStreamMapper('deepseek-chat');
    const out = feed(m, [
      chunk({ tool_calls: [{ index: 0, function: {} }] }),
      chunk({ tool_calls: [{ index: 0 }] }),
      {
        choices: [],
        usage: {
          prompt_tokens: 9,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens: 1,
        },
      },
      chunk({}, 'tool_calls', {
        prompt_tokens: 9,
        prompt_cache_hit_tokens: 6,
        completion_tokens: 2,
      }),
    ]);
    expect(out[0]).toEqual({ type: 'tool_call_start', index: 0, id: 'call_0', name: '' });
    expect(
      out
        .filter((e) => e['type'] === 'usage')
        .map((e) => (e['usage'] as AnyEvent)['cachedReadTokens']),
    ).toEqual([4, 6]);
    expect(m.end(false)).toEqual([{ type: 'finish', reason: 'tool_use' }]);
  });

  it('throws a truncated stream and a capacity stop, finishes others by their reason', () => {
    expect(() => new DeepSeekStreamMapper('m').end(false)).toThrow(DeepSeekStreamError);
    const busy = new DeepSeekStreamMapper('m');
    feed(busy, [chunk({}, 'insufficient_system_resource')]);
    expect(() => busy.end(false)).toThrow(/insufficient_system_resource/);
    const cut = new DeepSeekStreamMapper('m');
    feed(cut, [chunk({}, 'length')]);
    expect(cut.end(false)).toEqual([{ type: 'finish', reason: 'max_tokens' }]);
    const odd = new DeepSeekStreamMapper('m');
    feed(odd, [chunk({}, 'something_new')]);
    expect(odd.end(false)).toEqual([{ type: 'finish', reason: 'end' }]);
  });

  it('keeps the reasoning for the replay and cuts open calls on abort', () => {
    const m = new DeepSeekStreamMapper('deepseek-reasoner');
    feed(m, [chunk({ reasoning_content: 'think', content: 'ok' }, 'stop')]);
    expect(m.end(false).at(-1)).toEqual({
      type: 'finish',
      reason: 'end',
      providerState: {
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        opaque: { reasoningContent: 'think' },
      },
    });
    const aborted = new DeepSeekStreamMapper('m');
    feed(aborted, [
      chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"a' } }] }),
    ]);
    const out = aborted.end(true);
    expect(out[0]).toMatchObject({ type: 'tool_call_error', id: 'c' });
    expect(out.at(-1)).toEqual({ type: 'finish', reason: 'stopped' });
  });
});
