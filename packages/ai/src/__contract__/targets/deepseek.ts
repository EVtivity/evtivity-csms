// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * DeepSeek contract target. Fixtures follow the Chat Completions streaming
 * wire format with DeepSeek's `reasoning_content` deltas and cache usage
 * fields (https://api-docs.deepseek.com/api/create-chat-completion,
 * https://api-docs.deepseek.com/guides/thinking_mode).
 */

import assert from 'node:assert/strict';
import { createDeepSeekAdapter } from '../../providers/deepseek/adapter.js';
import type { AdapterContractTarget } from '../cases.js';
import {
  LEAKY_AUTH_TEXT,
  asArray,
  asRecord,
  jsonErrorFixture,
  samplingKeys,
  slowSseFixture,
  sseFixture,
} from './wire.js';

const MODEL = 'deepseek-flash';

const chunk = (delta: Record<string, unknown>, finish: string | null = null): unknown => ({
  id: 'chatcmpl-contract',
  object: 'chat.completion.chunk',
  created: 1_790_000_000,
  model: MODEL,
  choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
});

const usageChunk = (fields: Record<string, unknown> = {}): unknown => ({
  id: 'chatcmpl-contract',
  object: 'chat.completion.chunk',
  created: 1_790_000_000,
  model: MODEL,
  choices: [],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 20,
    ...fields,
  },
});

const toolDelta = (index: number, id: string | null, args: string): unknown =>
  chunk({
    tool_calls: [
      {
        index,
        ...(id !== null
          ? { id, type: 'function', function: { name: 'get_station_status', arguments: args } }
          : { function: { arguments: args } }),
      },
    ],
  });

const done = { done: true } as const;
const apiError = (message: string, type: string) => ({
  error: { message, type, param: null, code: null },
});

export const deepseekTarget: AdapterContractTarget = {
  provider: 'deepseek',
  model: MODEL,
  createAdapter: createDeepSeekAdapter,
  streamsToolArguments: true,
  expectedEffort: { low: 'low', medium: 'high', high: 'high' },
  expectedRetryAfterMs: 7000,
  expectedCachedUsage: {
    inputTokens: 1520,
    cachedReadTokens: 1200,
    cacheWriteTokens: 0,
    outputTokens: 40,
    reasoningTokens: 32,
  },
  fixtures: {
    text: sseFixture(
      [
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'Hello' }),
        chunk({ content: ' there!' }),
        chunk({}, 'stop'),
        usageChunk(),
      ],
      done,
    ),
    tool_call: sseFixture(
      [
        chunk({ role: 'assistant', content: null }),
        toolDelta(0, 'call_1', ''),
        toolDelta(0, null, '{"stationId"'),
        toolDelta(0, null, ':"CS-001"}'),
        chunk({}, 'tool_calls'),
        usageChunk(),
      ],
      done,
    ),
    // One call per response: DeepSeek documents no parallel tool calls.
    parallel_tool_calls: sseFixture(
      [toolDelta(0, 'call_1', '{"stationId":"CS-001"}'), chunk({}, 'tool_calls'), usageChunk()],
      done,
    ),
    tool_round: [
      sseFixture(
        [
          chunk({ role: 'assistant', content: null, reasoning_content: 'REASONING-' }),
          chunk({ reasoning_content: 'OPAQUE-1' }),
          toolDelta(0, 'call_1', '{"stationId":"CS-001"}'),
          chunk({}, 'tool_calls'),
          usageChunk(),
        ],
        done,
      ),
      sseFixture(
        [
          chunk({ content: 'CS-001 is ' }),
          chunk({ content: 'Available.' }),
          chunk({}, 'stop'),
          usageChunk(),
        ],
        done,
      ),
    ],
    // The model wrote its tool call as DSML markup in content (seen live
    // with thinking on), split across chunks, after some visible text.
    dsml_tool_call: sseFixture(
      [
        chunk({ role: 'assistant', content: '', reasoning_content: 'Need the station.' }),
        chunk({ content: 'Checking the station. <' }),
        chunk({ content: '｜DSML｜function_calls>\n<｜DSML｜invoke name="get_station_status">\n' }),
        chunk({
          content: '<｜DSML｜parameter name="stationId" string="true">CS-001</｜DSML｜parameter>\n',
        }),
        chunk({ content: '</｜DSML｜invoke>\n</｜DSML｜function_calls>' }),
        chunk({}, 'stop'),
        usageChunk(),
      ],
      done,
    ),
    malformed_args: sseFixture(
      [toolDelta(0, 'call_1', '{"stationId":'), chunk({}, 'tool_calls'), usageChunk()],
      done,
    ),
    error_auth: jsonErrorFixture(401, apiError(LEAKY_AUTH_TEXT, 'authentication_error')),
    error_rate_limited: jsonErrorFixture(429, apiError('Rate Limit Reached', 'rate_limit_error'), {
      'retry-after': '7',
    }),
    error_overloaded: jsonErrorFixture(503, apiError('Server Overloaded', 'server_error')),
    error_context: jsonErrorFixture(
      400,
      apiError(
        "This model's maximum context length is 1048576 tokens. However, you requested 1200000 tokens.",
        'invalid_request_error',
      ),
    ),
    refusal: sseFixture(
      [chunk({ content: 'I cannot' }), chunk({}, 'content_filter'), usageChunk()],
      done,
    ),
    slow_text: slowSseFixture(
      [chunk({ role: 'assistant', content: '' })],
      ['Hello', ' slow', ' world'].map((content) => chunk({ content })),
    ),
    cached_usage: sseFixture(
      [
        chunk({ content: 'Hello' }),
        chunk({}, 'stop'),
        usageChunk({
          prompt_tokens: 1520,
          completion_tokens: 40,
          total_tokens: 1560,
          prompt_cache_hit_tokens: 1200,
          prompt_cache_miss_tokens: 320,
          completion_tokens_details: { reasoning_tokens: 32 },
        }),
      ],
      done,
    ),
  },
  wire: {
    effort: (body) =>
      typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
    sampling: samplingKeys,
    strictTools: (body) =>
      Object.fromEntries(
        asArray(body.tools).map((t) => {
          const fn = asRecord(asRecord(t).function);
          return [String(fn.name), fn.strict === true];
        }),
      ),
    assertCaching(body) {
      // Automatic caching: no markers; the body must keep a stable prefix (system first).
      const first = asRecord(asArray(body.messages)[0]);
      assert.equal(first.role, 'system');
      assert.equal(body.stream_options !== undefined, true);
    },
    assertSequentialTools(body) {
      assert.equal('parallel_tool_calls' in body, false);
    },
  },
};
