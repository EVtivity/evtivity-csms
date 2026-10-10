// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Anthropic contract target. Fixtures follow the Messages streaming wire
 * format (https://platform.claude.com/docs/en/build-with-claude/streaming):
 * named SSE events, thinking blocks with signatures before tool use.
 */

import assert from 'node:assert/strict';
import { createAnthropicAdapter } from '../../providers/anthropic/adapter.js';
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

const MODEL = 'claude-sonnet-5-5';

function messageStart(usage: Record<string, number> = {}): unknown {
  return {
    type: 'message_start',
    message: {
      id: 'msg_contract',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 20,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        ...usage,
      },
    },
  };
}

const textBlock = (index: number, pieces: readonly string[]): unknown[] => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  ...pieces.map((text) => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  })),
  { type: 'content_block_stop', index },
];

const thinkingBlock = (index: number, signature: string): unknown[] => [
  {
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  },
  {
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking: 'Need the tool.' },
  },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
  { type: 'content_block_stop', index },
];

const toolBlock = (index: number, id: string, json: readonly string[]): unknown[] => [
  {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name: 'get_station_status', input: {} },
  },
  ...json.map((partial_json) => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json },
  })),
  { type: 'content_block_stop', index },
];

const messageEnd = (stopReason: string, outputTokens = 5): unknown[] => [
  {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  },
  { type: 'message_stop' },
];

const named = { named: true } as const;

const errorBody = (type: string, message: string) => ({ type: 'error', error: { type, message } });

export const anthropicTarget: AdapterContractTarget = {
  provider: 'anthropic',
  model: MODEL,
  createAdapter: createAnthropicAdapter,
  streamsToolArguments: true,
  expectedEffort: { low: 'low', medium: 'medium', high: 'high' },
  expectedRetryAfterMs: 7000,
  expectedCachedUsage: {
    inputTokens: 1520,
    cachedReadTokens: 1200,
    cacheWriteTokens: 300,
    outputTokens: 5,
    reasoningTokens: 0,
  },
  fixtures: {
    text: sseFixture(
      [messageStart(), ...textBlock(0, ['Hello', ' there!']), ...messageEnd('end_turn')],
      named,
    ),
    tool_call: sseFixture(
      [
        messageStart(),
        ...toolBlock(0, 'toolu_1', ['{"stationId"', ': "CS-001"}']),
        ...messageEnd('tool_use'),
      ],
      named,
    ),
    parallel_tool_calls: sseFixture(
      [
        messageStart(),
        ...toolBlock(0, 'toolu_1', ['{"stationId": "CS-001"}']),
        ...toolBlock(1, 'toolu_2', ['{"stationId": "CS-002"}']),
        ...messageEnd('tool_use'),
      ],
      named,
    ),
    tool_round: [
      sseFixture(
        [
          messageStart(),
          ...thinkingBlock(0, 'SIG-OPAQUE-1'),
          ...toolBlock(1, 'toolu_1', ['{"stationId": "CS-001"}']),
          ...messageEnd('tool_use'),
        ],
        named,
      ),
      sseFixture(
        [messageStart(), ...textBlock(0, ['CS-001 is ', 'Available.']), ...messageEnd('end_turn')],
        named,
      ),
    ],
    malformed_args: sseFixture(
      [messageStart(), ...toolBlock(0, 'toolu_1', ['{"stationId": ']), ...messageEnd('tool_use')],
      named,
    ),
    error_auth: jsonErrorFixture(401, errorBody('authentication_error', LEAKY_AUTH_TEXT)),
    error_rate_limited: jsonErrorFixture(429, errorBody('rate_limit_error', 'Rate limited'), {
      'retry-after': '7',
    }),
    error_overloaded: jsonErrorFixture(529, errorBody('overloaded_error', 'Overloaded')),
    error_context: jsonErrorFixture(
      400,
      errorBody('invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum'),
    ),
    refusal: sseFixture(
      [messageStart(), ...textBlock(0, ['I cannot']), ...messageEnd('refusal')],
      named,
    ),
    slow_text: slowSseFixture(
      [
        messageStart(),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ],
      ['Hello', ' slow', ' world'].map((text) => ({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })),
      named,
    ),
    cached_usage: sseFixture(
      [
        messageStart({
          input_tokens: 20,
          cache_read_input_tokens: 1200,
          cache_creation_input_tokens: 300,
        }),
        ...textBlock(0, ['Hello']),
        ...messageEnd('end_turn'),
      ],
      named,
    ),
  },
  wire: {
    effort: (body) => {
      const effort = asRecord(body.output_config).effort;
      return typeof effort === 'string' ? effort : undefined;
    },
    sampling: samplingKeys,
    strictTools: (body) =>
      Object.fromEntries(
        asArray(body.tools).map((t) => [String(asRecord(t).name), asRecord(t).strict === true]),
      ),
    assertCaching(body, req) {
      const tools = asArray(body.tools).map(asRecord);
      assert.deepEqual(
        tools.at(-1)?.cache_control,
        { type: 'ephemeral' },
        'no breakpoint on the last tool',
      );
      assert.ok(tools.slice(0, -1).every((t) => t.cache_control === undefined));
      const system = asArray(body.system).map(asRecord);
      const lastCacheable = req.system.map((b) => b.cacheable).lastIndexOf(true);
      system.forEach((block, i) => {
        assert.equal(
          block.cache_control !== undefined,
          i === lastCacheable,
          `system block ${String(i)} breakpoint`,
        );
      });
      assert.deepEqual(body.cache_control, { type: 'ephemeral' }, 'no automatic message caching');
    },
    assertSequentialTools(body) {
      assert.equal(asRecord(body.tool_choice).disable_parallel_tool_use, true);
    },
  },
};
