// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Gemini contract target. Fixtures follow the `streamGenerateContent?alt=sse`
 * wire format (https://ai.google.dev/api/generate-content): whole function
 * calls with ids and a thought signature on the first call.
 */

import assert from 'node:assert/strict';
import { createGeminiAdapter } from '../../providers/gemini/adapter.js';
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

const MODEL = 'gemini-3.8-flash';

const chunk = (
  parts: readonly Record<string, unknown>[],
  finishReason?: string,
  usage?: Record<string, number>,
): unknown => ({
  candidates: [
    {
      content: { role: 'model', parts },
      index: 0,
      ...(finishReason !== undefined ? { finishReason } : {}),
    },
  ],
  modelVersion: MODEL,
  ...(usage !== undefined ? { usageMetadata: usage } : {}),
});

const USAGE = { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 };

const call = (id: string, stationId: string, signature?: string): Record<string, unknown> => ({
  functionCall: { id, name: 'get_station_status', args: { stationId } },
  ...(signature !== undefined ? { thoughtSignature: signature } : {}),
});

const googleError = (code: number, status: string, message: string, reason?: string) => ({
  error: {
    code,
    message,
    status,
    ...(reason !== undefined
      ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] }
      : {}),
  },
});

export const geminiTarget: AdapterContractTarget = {
  provider: 'gemini',
  model: MODEL,
  createAdapter: createGeminiAdapter,
  streamsToolArguments: false,
  expectedEffort: { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' },
  // The SDK's ApiError carries no response headers.
  expectedRetryAfterMs: null,
  expectedCachedUsage: {
    inputTokens: 1520,
    cachedReadTokens: 1200,
    cacheWriteTokens: 0,
    outputTokens: 40,
    reasoningTokens: 32,
  },
  fixtures: {
    text: sseFixture([chunk([{ text: 'Hello' }]), chunk([{ text: ' there!' }], 'STOP', USAGE)]),
    tool_call: sseFixture([chunk([call('fc_1', 'CS-001', 'SIG-1')], 'STOP', USAGE)]),
    parallel_tool_calls: sseFixture([
      chunk([call('fc_1', 'CS-001', 'SIG-1'), call('fc_2', 'CS-002')], 'STOP', USAGE),
    ]),
    tool_round: [
      sseFixture([chunk([call('fc_1', 'CS-001', 'SIG-OPAQUE-1')], 'STOP', USAGE)]),
      sseFixture([
        chunk([{ text: 'CS-001 is ' }]),
        chunk([{ text: 'Available.' }]),
        // Signatures can arrive on a final empty text part.
        chunk([{ text: '', thoughtSignature: 'SIG-2' }], 'STOP', USAGE),
      ]),
    ],
    malformed_args: sseFixture([chunk([], 'MALFORMED_FUNCTION_CALL', USAGE)]),
    error_auth: jsonErrorFixture(
      400,
      googleError(
        400,
        'INVALID_ARGUMENT',
        `API key not valid. ${LEAKY_AUTH_TEXT}`,
        'API_KEY_INVALID',
      ),
    ),
    error_rate_limited: jsonErrorFixture(
      429,
      googleError(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted'),
    ),
    error_overloaded: jsonErrorFixture(
      503,
      googleError(503, 'UNAVAILABLE', 'The model is overloaded.'),
    ),
    error_context: jsonErrorFixture(
      400,
      googleError(
        400,
        'INVALID_ARGUMENT',
        'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      ),
    ),
    refusal: sseFixture([chunk([], 'SAFETY', USAGE)]),
    slow_text: slowSseFixture(
      [],
      ['Hello', ' slow', ' world'].map((text) => chunk([{ text }])),
    ),
    cached_usage: sseFixture([
      chunk([{ text: 'Hello' }], 'STOP', {
        promptTokenCount: 1520,
        cachedContentTokenCount: 1200,
        candidatesTokenCount: 8,
        thoughtsTokenCount: 32,
        totalTokenCount: 1560,
      }),
    ]),
  },
  wire: {
    effort: (body) => {
      const level = asRecord(asRecord(body.generationConfig).thinkingConfig).thinkingLevel;
      return typeof level === 'string' ? level : undefined;
    },
    sampling: samplingKeys,
    strictTools: (body) =>
      Object.fromEntries(
        asArray(body.tools)
          .flatMap((t) => asArray(asRecord(t).functionDeclarations))
          .map((d) => [String(asRecord(d).name), false]),
      ),
    assertCaching(body) {
      // Implicit caching: no markers; the static prefix is the system instruction.
      assert.ok(body.systemInstruction !== undefined, 'no systemInstruction');
      assert.ok(!('cachedContent' in body));
    },
    assertSequentialTools() {
      assert.fail('Gemini models run parallel tool calls');
    },
  },
};
