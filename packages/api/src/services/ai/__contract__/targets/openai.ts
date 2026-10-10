// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * OpenAI contract target. Fixtures follow the Responses API streaming wire
 * format (https://developers.openai.com/api/docs/guides/streaming-responses):
 * `response.*` events, encrypted reasoning items before function calls.
 */

import assert from 'node:assert/strict';
import { createOpenAiAdapter } from '../../providers/openai/adapter.js';
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

const MODEL = 'gpt-6.1-sol';

let seq = 0;
const ev = (type: string, fields: Record<string, unknown>): unknown => ({
  type,
  sequence_number: seq++,
  ...fields,
});

const created = (): unknown =>
  ev('response.created', {
    response: { id: 'resp_1', object: 'response', status: 'in_progress', output: [] },
  });

const completed = (usage: Record<string, unknown> = {}): unknown =>
  ev('response.completed', {
    response: {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 25,
        ...usage,
      },
    },
  });

function message(id: string, pieces: readonly string[], index = 0): unknown[] {
  const text = pieces.join('');
  return [
    ev('response.output_item.added', {
      output_index: index,
      item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] },
    }),
    ...pieces.map((delta) =>
      ev('response.output_text.delta', {
        item_id: id,
        output_index: index,
        content_index: 0,
        delta,
      }),
    ),
    ev('response.output_item.done', {
      output_index: index,
      item: {
        type: 'message',
        id,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    }),
  ];
}

function functionCall(
  id: string,
  callId: string,
  pieces: readonly string[],
  index: number,
): unknown[] {
  const item = { type: 'function_call', id, call_id: callId, name: 'get_station_status' };
  return [
    ev('response.output_item.added', {
      output_index: index,
      item: { ...item, arguments: '', status: 'in_progress' },
    }),
    ...pieces.map((delta) =>
      ev('response.function_call_arguments.delta', { item_id: id, output_index: index, delta }),
    ),
    ev('response.function_call_arguments.done', {
      item_id: id,
      output_index: index,
      arguments: pieces.join(''),
    }),
    ev('response.output_item.done', {
      output_index: index,
      item: { ...item, arguments: pieces.join(''), status: 'completed' },
    }),
  ];
}

const reasoning = (encrypted: string): unknown[] => {
  const item = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: encrypted };
  return [
    ev('response.output_item.added', { output_index: 0, item }),
    ev('response.output_item.done', { output_index: 0, item }),
  ];
};

const named = { named: true } as const;
const apiError = (message: string, type: string, code: string | null) => ({
  error: { message, type, param: null, code },
});

export const openaiTarget: AdapterContractTarget = {
  provider: 'openai',
  model: MODEL,
  createAdapter: createOpenAiAdapter,
  streamsToolArguments: true,
  expectedEffort: { low: 'low', medium: 'medium', high: 'high' },
  expectedRetryAfterMs: 7000,
  expectedCachedUsage: {
    inputTokens: 1520,
    cachedReadTokens: 1200,
    cacheWriteTokens: 0,
    outputTokens: 40,
    reasoningTokens: 32,
  },
  fixtures: {
    text: sseFixture([created(), ...message('msg_1', ['Hello', ' there!']), completed()], named),
    tool_call: sseFixture(
      [
        created(),
        ...functionCall('fc_1', 'call_1', ['{"stationId"', ':"CS-001"}'], 0),
        completed(),
      ],
      named,
    ),
    parallel_tool_calls: sseFixture(
      [
        created(),
        ...functionCall('fc_1', 'call_1', ['{"stationId":"CS-001"}'], 0),
        ...functionCall('fc_2', 'call_2', ['{"stationId":"CS-002"}'], 1),
        completed(),
      ],
      named,
    ),
    tool_round: [
      sseFixture(
        [
          created(),
          ...reasoning('ENC-OPAQUE-1'),
          ...functionCall('fc_1', 'call_1', ['{"stationId":"CS-001"}'], 1),
          completed(),
        ],
        named,
      ),
      sseFixture(
        [created(), ...message('msg_2', ['CS-001 is ', 'Available.']), completed()],
        named,
      ),
    ],
    malformed_args: sseFixture(
      [created(), ...functionCall('fc_1', 'call_1', ['{"stationId":'], 0), completed()],
      named,
    ),
    error_auth: jsonErrorFixture(
      401,
      apiError(LEAKY_AUTH_TEXT, 'invalid_request_error', 'invalid_api_key'),
    ),
    error_rate_limited: jsonErrorFixture(
      429,
      apiError('Rate limit reached', 'requests', 'rate_limit_exceeded'),
      { 'retry-after': '7' },
    ),
    error_overloaded: jsonErrorFixture(
      503,
      apiError('The server is overloaded', 'server_error', 'server_is_overloaded'),
    ),
    error_context: jsonErrorFixture(
      400,
      apiError(
        'Your input exceeds the context window of this model.',
        'invalid_request_error',
        'context_length_exceeded',
      ),
    ),
    refusal: sseFixture(
      [
        created(),
        ev('response.refusal.delta', {
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta: 'I cannot help.',
        }),
        completed(),
      ],
      named,
    ),
    slow_text: slowSseFixture(
      [created()],
      ['Hello', ' slow', ' world'].map((delta) =>
        ev('response.output_text.delta', {
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta,
        }),
      ),
      named,
    ),
    cached_usage: sseFixture(
      [
        created(),
        ...message('msg_1', ['Hello']),
        completed({
          input_tokens: 1520,
          input_tokens_details: { cached_tokens: 1200 },
          output_tokens: 40,
          output_tokens_details: { reasoning_tokens: 32 },
          total_tokens: 1560,
        }),
      ],
      named,
    ),
  },
  wire: {
    effort: (body) => {
      const effort = asRecord(body.reasoning).effort;
      return typeof effort === 'string' ? effort : undefined;
    },
    sampling: samplingKeys,
    strictTools: (body) =>
      Object.fromEntries(
        asArray(body.tools).map((t) => [String(asRecord(t).name), asRecord(t).strict === true]),
      ),
    assertCaching(body, req) {
      assert.equal(body.prompt_cache_key, req.cacheKey);
      assert.equal(body.store, false);
      assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    },
    assertSequentialTools(body) {
      assert.equal(body.parallel_tool_calls, false);
    },
  },
};
