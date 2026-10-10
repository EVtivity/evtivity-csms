// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The shared provider contract (TC-AI-P-*). Every adapter runs these cases
 * against its recorded wire fixtures (`fixtures/<provider>.ts`); the cases
 * marked `live` also run against the real endpoint when a key is given.
 *
 * Runner-agnostic: assertions use `node:assert/strict`. Fixture names every
 * target provides: `text`, `tool_call`, `parallel_tool_calls`, `tool_round`
 * (two responses), `malformed_args`, `error_auth`, `error_rate_limited`,
 * `error_overloaded`, `error_context`, `refusal`, `slow_text`, `cached_usage`.
 */

import assert from 'node:assert/strict';
import { isAiProviderError } from '../core/errors.js';
import type { AiProviderErrorCode } from '../core/errors.js';
import { getModelEntry, getProviderEntry } from '../core/model-registry.js';
import { PROVIDER_IDS } from '../core/types.js';
import type {
  AiAttachmentContent,
  AiAttachmentResolver,
  AiMessage,
  AiRequest,
  AiToolDefinition,
  AiUsage,
  Effort,
  ProviderId,
} from '../core/types.js';
import { CONTRACT_TEST_API_KEY, runAdapterStream, streamProblems } from './harness.js';
import type { ContractCase, ContractContext, ContractRun, ContractTarget } from './harness.js';

/** Provider-specific reads of a recorded request body (parsed JSON). */
export interface WireInspector {
  /** The effort value the body sends, or undefined. */
  effort(body: Record<string, unknown>): string | undefined;
  /** Names of sampling parameters present in the body. */
  sampling(body: Record<string, unknown>): string[];
  /** Strict flag per tool name. */
  strictTools(body: Record<string, unknown>): Record<string, boolean>;
  /** Asserts the caching markers for a request with tools, a cacheable system block and a cache key. */
  assertCaching(body: Record<string, unknown>, req: AiRequest): void;
  /** Asserts the body tells the provider to make one tool call at a time. */
  assertSequentialTools(body: Record<string, unknown>): void;
}

export interface AdapterContractTarget extends ContractTarget {
  wire: WireInspector;
  /** Provider value each neutral effort maps to. */
  expectedEffort: Readonly<Record<Effort, string>>;
  /** Usage the `cached_usage` fixture must produce. */
  expectedCachedUsage: AiUsage;
  /** The provider streams tool arguments in pieces (false: whole calls arrive at once). */
  streamsToolArguments: boolean;
  /** Expected `retryAfterMs` of `error_rate_limited`; null when the SDK hides headers. */
  expectedRetryAfterMs: number | null;
}

/** Facts a live run settles (tool-call counts, state presence). The live test reports them. */
export const contractObservations: Record<string, unknown> = {};

export const STATION_TOOL: AiToolDefinition = {
  name: 'get_station_status',
  description: 'Returns the status of one charging station.',
  parameters: {
    type: 'object',
    properties: { stationId: { type: 'string', description: 'Station id, such as CS-001' } },
    required: ['stationId'],
    additionalProperties: false,
  },
  strict: true,
};

const LOOSE_TOOL: AiToolDefinition = {
  name: 'list_sites',
  description: 'Lists sites.',
  parameters: { type: 'object', properties: { search: { type: 'string' } } },
  strict: false,
};

/** 1x1 red PNG. */
export const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const TINY_PDF = Uint8Array.from(Buffer.from('%PDF-1.4\n% contract test pdf\n%%EOF\n', 'utf8'));
const TEXT_DOC = 'station,status\nCS-001,Available\n';

const FOREIGN_MARKER = 'FOREIGN-STATE-MARKER';
const OWN_MARKER = 'OWN-STATE-MARKER';

/** Opaque state carrying a marker in every adapter's replay shape. */
function markerState(marker: string): unknown {
  return {
    content: [{ type: 'text', text: marker }],
    items: [{ role: 'assistant', content: marker }],
    parts: [{ text: marker }],
    reasoningContent: marker,
  };
}

const LIVE_MAX_TOKENS = 4096;

function target(ctx: ContractContext): AdapterContractTarget {
  return ctx.target as AdapterContractTarget;
}

function req(ctx: ContractContext, overrides: Partial<AiRequest> = {}): AiRequest {
  return ctx.request({ maxOutputTokens: LIVE_MAX_TOKENS, ...overrides });
}

function lastBody(ctx: ContractContext): Record<string, unknown> {
  const recorded = ctx.requests().at(-1);
  assert.ok(recorded, 'the adapter sent no request');
  return JSON.parse(recorded.body) as Record<string, unknown>;
}

function bodyAt(ctx: ContractContext, index: number): string {
  const recorded = ctx.requests()[index];
  assert.ok(recorded, `no request #${String(index)}`);
  return recorded.body;
}

function assertWellFormed(run: ContractRun): void {
  assert.equal(run.error, null, `stream failed: ${String(run.error)}`);
  assert.deepEqual(streamProblems(run.events), []);
}

function resolver(files: Record<string, AiAttachmentContent>): AiAttachmentResolver {
  return (id) => {
    const file = files[id];
    if (file === undefined) return Promise.reject(new Error(`no attachment ${id}`));
    return Promise.resolve(file);
  };
}

function toolTurn(ctx: ContractContext, text: string): AiRequest {
  return req(ctx, {
    tools: [STATION_TOOL],
    messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
  });
}

async function expectProviderError(ctx: ContractContext, code: AiProviderErrorCode): Promise<void> {
  const run = await ctx.run(req(ctx));
  assert.ok(isAiProviderError(run.error), `expected AiProviderError, got ${String(run.error)}`);
  assert.equal(run.error.code, code);
  assert.equal(run.error.provider, ctx.target.provider);
  assert.ok(!run.error.message.includes(CONTRACT_TEST_API_KEY), 'error message leaks the key');
  assert.ok(!/bearer\s+sk-/i.test(run.error.message), 'error message leaks a bearer token');
}

async function expectRefusedWithoutRequest(ctx: ContractContext, r: AiRequest): Promise<void> {
  const before = ctx.mode === 'fixture' ? ctx.requests().length : 0;
  const run = await ctx.run(r);
  assert.ok(isAiProviderError(run.error), `expected a refusal, got ${String(run.error)}`);
  assert.equal(run.error.code, 'invalid_request');
  if (ctx.mode === 'fixture') assert.equal(ctx.requests().length, before, 'a request was sent');
}

export const CONTRACT_CASES: readonly ContractCase[] = [
  {
    id: 'P-01',
    title: 'plain text stream: deltas concatenate, finish end, usage present',
    fixtures: ['text'],
    live: true,
    async run(ctx) {
      const run = await ctx.run(req(ctx));
      assertWellFormed(run);
      const deltas = run.events.filter((e) => e.type === 'text_delta');
      assert.ok(deltas.length >= 1, 'no text_delta');
      assert.equal(run.result.finishReason, 'end');
      assert.ok(run.result.usage.inputTokens > 0, 'no input tokens');
      assert.ok(run.result.usage.outputTokens > 0, 'no output tokens');
      if (ctx.mode === 'fixture') {
        assert.ok(deltas.length >= 2);
        assert.equal(run.result.text, 'Hello there!');
      } else {
        assert.ok(run.result.text.trim() !== '', 'empty text');
      }
    },
  },
  {
    id: 'P-02',
    title: 'single tool call streamed, arguments assembled, finish tool_use',
    fixtures: ['tool_call'],
    live: true,
    async run(ctx) {
      const run = await ctx.run(toolTurn(ctx, 'Call get_station_status for station CS-001.'));
      assertWellFormed(run);
      assert.equal(run.result.finishReason, 'tool_use');
      const call = run.result.toolCalls[0];
      assert.ok(call, 'no tool call');
      assert.equal(call.name, STATION_TOOL.name);
      assert.ok(call.id !== '', 'empty call id');
      assert.ok(String(call.arguments.stationId).includes('CS-001'));
      const start = run.events.findIndex((e) => e.type === 'tool_call_start');
      const done = run.events.findIndex((e) => e.type === 'tool_call_done');
      assert.ok(start >= 0 && done > start, 'start must precede done');
      if (ctx.mode === 'fixture') {
        assert.deepEqual(call.arguments, { stationId: 'CS-001' });
        if (target(ctx).streamsToolArguments) {
          assert.ok(
            run.events.some((e) => e.type === 'tool_call_delta'),
            'no tool_call_delta',
          );
        }
      }
    },
  },
  {
    id: 'P-03',
    title: 'parallel tool calls, or one at a time when parallelToolCalls is false',
    fixtures: ['parallel_tool_calls'],
    live: true,
    async run(ctx) {
      const run = await ctx.run(
        toolTurn(
          ctx,
          'Call get_station_status for station CS-001 and for station CS-002. Make both calls now.',
        ),
      );
      assertWellFormed(run);
      assert.equal(run.result.finishReason, 'tool_use');
      const ids = run.result.toolCalls.map((c) => c.id);
      assert.ok(ids.length >= 1);
      assert.equal(new Set(ids).size, ids.length, 'duplicate call ids');
      if (ctx.mode === 'live') {
        contractObservations[`${ctx.target.provider}.parallelToolCallsInOneResponse`] = ids.length;
        return;
      }
      if (ctx.capabilities.parallelToolCalls) {
        assert.equal(ids.length, 2);
        assert.deepEqual(
          run.result.toolCalls.map((c) => c.arguments.stationId),
          ['CS-001', 'CS-002'],
        );
      } else {
        target(ctx).wire.assertSequentialTools(lastBody(ctx));
      }
    },
  },
  {
    id: 'P-04',
    title: 'tool result round trip replays providerState unchanged',
    fixtures: ['tool_round'],
    live: true,
    async run(ctx) {
      const first = toolTurn(ctx, 'Call get_station_status for station CS-001.');
      const round1 = await ctx.run(first);
      assertWellFormed(round1);
      const call = round1.result.toolCalls[0];
      assert.ok(call, 'round 1 made no tool call');
      const state = round1.result.providerState;
      if (ctx.mode === 'live') {
        contractObservations[`${ctx.target.provider}.providerStateOnToolTurn`] =
          state !== undefined;
      } else {
        assert.ok(state, 'round 1 returned no providerState');
      }
      if (state !== undefined) {
        assert.equal(state.provider, ctx.target.provider);
        assert.equal(state.model, ctx.target.model);
      }
      const assistant: AiMessage = {
        role: 'assistant',
        parts: [
          ...(round1.result.text !== ''
            ? [{ type: 'text' as const, text: round1.result.text }]
            : []),
          ...round1.result.toolCalls,
        ],
        ...(state !== undefined ? { providerState: state } : {}),
      };
      const round2 = await ctx.run({
        ...first,
        messages: [
          ...first.messages,
          assistant,
          {
            role: 'tool',
            parts: round1.result.toolCalls.map((c) => ({
              type: 'tool_result' as const,
              toolCallId: c.id,
              name: c.name,
              content: '{"stationId":"CS-001","status":"Available"}',
              isError: false,
            })),
          },
        ],
      });
      assertWellFormed(round2);
      assert.equal(round2.result.finishReason, 'end');
      assert.ok(round2.result.text.trim() !== '', 'round 2 gave no answer');
      if (ctx.mode === 'fixture') {
        const opaque = JSON.stringify(state?.opaque);
        assert.ok(opaque.includes('OPAQUE-1'), 'fixture state has no opaque marker');
        assert.ok(bodyAt(ctx, 1).includes('OPAQUE-1'), 'round 2 did not replay the state');
        assert.ok(bodyAt(ctx, 1).includes('Available'), 'round 2 did not send the tool result');
      }
    },
  },
  {
    id: 'P-05',
    title: 'malformed tool arguments become a tool_call_error event, not a throw',
    fixtures: ['malformed_args'],
    async run(ctx) {
      const run = await ctx.run(toolTurn(ctx, 'Call get_station_status for station CS-001.'));
      assertWellFormed(run);
      assert.equal(run.result.toolCallErrors.length, 1);
      assert.equal(run.result.toolCalls.length, 0);
      assert.ok(run.events.some((e) => e.type === 'tool_call_error'));
    },
  },
  {
    id: 'P-06',
    title: 'image part sent when the model has vision',
    fixtures: ['text'],
    live: true,
    requires: (caps) => caps.vision !== false,
    async run(ctx) {
      const run = await ctx.run(
        req(ctx, {
          messages: [
            {
              role: 'user',
              parts: [
                { type: 'text', text: 'What color is this image? Answer in one word.' },
                { type: 'image', attachmentId: 'img-1', mime: 'image/png' },
              ],
            },
          ],
          resolveAttachment: resolver({ 'img-1': { mime: 'image/png', data: TINY_PNG } }),
        }),
      );
      assertWellFormed(run);
      assert.ok(run.result.text.trim() !== '');
      if (ctx.mode === 'live') {
        contractObservations[`${ctx.target.provider}.imageAnswer`] = run.result.text
          .trim()
          .slice(0, 40);
      } else {
        assert.ok(
          bodyAt(ctx, 0).includes(Buffer.from(TINY_PNG).toString('base64')),
          'image not sent',
        );
      }
    },
  },
  {
    id: 'P-06b',
    title: 'image part refused without a request when the model has no vision',
    async run(ctx) {
      const model = `${ctx.target.model}-unlisted`;
      assert.equal(ctx.adapter.capabilities(model).vision, false);
      await expectRefusedWithoutRequest(
        ctx,
        req(ctx, {
          model,
          messages: [
            { role: 'user', parts: [{ type: 'image', attachmentId: 'img-1', mime: 'image/png' }] },
          ],
          resolveAttachment: resolver({ 'img-1': { mime: 'image/png', data: TINY_PNG } }),
        }),
      );
    },
  },
  {
    id: 'P-07',
    title: 'PDF part sent natively or refused, by flag',
    fixtures: ['text'],
    async run(ctx) {
      const r = req(ctx, {
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'Summarize the file.' },
              { type: 'document', attachmentId: 'pdf-1', mime: 'application/pdf', name: 'a.pdf' },
            ],
          },
        ],
        resolveAttachment: resolver({ 'pdf-1': { mime: 'application/pdf', data: TINY_PDF } }),
      });
      if (ctx.capabilities.documents.pdf === false) {
        ctx.server?.reset();
        await expectRefusedWithoutRequest(ctx, r);
        return;
      }
      const run = await ctx.run(r);
      assertWellFormed(run);
      assert.ok(bodyAt(ctx, 0).includes(Buffer.from(TINY_PDF).toString('base64')), 'pdf not sent');
    },
  },
  {
    id: 'P-07b',
    title: 'text documents go to every model as fenced untrusted text',
    fixtures: ['text'],
    async run(ctx) {
      const run = await ctx.run(
        req(ctx, {
          messages: [
            {
              role: 'user',
              parts: [
                { type: 'text', text: 'Read the file.' },
                { type: 'document', attachmentId: 'csv-1', mime: 'text/csv', name: 'status.csv' },
              ],
            },
          ],
          resolveAttachment: resolver({
            'csv-1': { mime: 'text/csv', data: Uint8Array.from(Buffer.from(TEXT_DOC, 'utf8')) },
          }),
        }),
      );
      assertWellFormed(run);
      const body = bodyAt(ctx, 0);
      assert.ok(body.includes('CS-001,Available'), 'document text not sent');
      assert.ok(body.includes('untrusted_document'), 'document not fenced');
    },
  },
  {
    id: 'P-08',
    title: 'foreign providerState is dropped; matching state is replayed',
    fixtures: ['text'],
    async run(ctx) {
      const other: ProviderId = PROVIDER_IDS.find((p) => p !== ctx.target.provider) ?? 'openai';
      const assistant = (provider: ProviderId, model: string, marker: string): AiMessage => ({
        role: 'assistant',
        parts: [{ type: 'text', text: 'Earlier answer.' }],
        providerState: { provider, model, opaque: markerState(marker) },
      });
      const run = await ctx.run(
        req(ctx, {
          messages: [
            { role: 'user', parts: [{ type: 'text', text: 'First question.' }] },
            assistant(other, ctx.target.model, `${FOREIGN_MARKER}-provider`),
            { role: 'user', parts: [{ type: 'text', text: 'Second question.' }] },
            assistant(ctx.target.provider, 'some-other-model', `${FOREIGN_MARKER}-model`),
            { role: 'user', parts: [{ type: 'text', text: 'Third question.' }] },
            assistant(ctx.target.provider, ctx.target.model, OWN_MARKER),
            { role: 'user', parts: [{ type: 'text', text: 'Fourth question.' }] },
          ],
        }),
      );
      assertWellFormed(run);
      const body = bodyAt(ctx, 0);
      assert.ok(!body.includes(FOREIGN_MARKER), 'foreign state was replayed');
      assert.ok(body.includes('Earlier answer.'), 'foreign turn text was dropped');
      assert.ok(body.includes(OWN_MARKER), 'matching state was not replayed');
    },
  },
  {
    id: 'P-09',
    title: 'effort mapped per model; sampling parameters never sent',
    fixtures: ['text', 'text', 'text', 'text'],
    async run(ctx) {
      const t = target(ctx);
      for (const effort of ctx.capabilities.effort) {
        const run = await ctx.run(req(ctx, { effort }));
        assertWellFormed(run);
        const body = lastBody(ctx);
        assert.equal(t.wire.effort(body), t.expectedEffort[effort], `effort ${effort}`);
        assert.deepEqual(t.wire.sampling(body), []);
      }
      const unlisted = await ctx.run(req(ctx, { model: `${ctx.target.model}-unlisted` }));
      assertWellFormed(unlisted);
      assert.equal(t.wire.effort(lastBody(ctx)), undefined, 'effort sent to an unlisted model');
      assert.deepEqual(t.wire.sampling(lastBody(ctx)), []);
    },
  },
  {
    id: 'P-11',
    title: 'errors map to neutral codes without keys or headers in the message',
    fixtures: ['error_auth', 'error_rate_limited', 'error_overloaded', 'error_context', 'refusal'],
    async run(ctx) {
      await expectProviderError(ctx, 'auth');
      const limited = await ctx.run(req(ctx));
      assert.ok(isAiProviderError(limited.error));
      assert.equal(limited.error.code, 'rate_limited');
      const retry = target(ctx).expectedRetryAfterMs;
      if (retry !== null) assert.equal(limited.error.retryAfterMs, retry);
      await expectProviderError(ctx, 'overloaded');
      await expectProviderError(ctx, 'context_exceeded');
      const refusal = await ctx.run(req(ctx));
      assertWellFormed(refusal);
      assert.equal(refusal.result.finishReason, 'refusal');
    },
  },
  {
    id: 'P-11-live',
    title: 'an invalid key maps to auth and the key never appears in the message',
    live: true,
    async run(ctx) {
      if (ctx.mode === 'fixture') return;
      const badKey = 'sk-contract-invalid-key-000000000000';
      const run = await runAdapterStream(ctx.target.createAdapter({ apiKey: badKey }), req(ctx));
      assert.ok(isAiProviderError(run.error), `expected AiProviderError, got ${String(run.error)}`);
      assert.equal(run.error.code, 'auth');
      assert.ok(!run.error.message.includes(badKey), 'error message leaks the key');
    },
  },
  {
    id: 'P-12',
    title: 'abort stops the stream within 1 s with a partial result',
    fixtures: ['slow_text'],
    async run(ctx) {
      const run = await ctx.run(req(ctx), { abortAfterEvents: 1, timeoutMs: 5000 });
      assert.equal(run.error, null, `stream failed: ${String(run.error)}`);
      assert.ok(run.aborted && !run.timedOut);
      assert.ok((run.abortToEndMs ?? Infinity) < 1000, `took ${String(run.abortToEndMs)} ms`);
      assert.deepEqual(streamProblems(run.events), []);
      assert.equal(run.result.finishReason, 'stopped');
      assert.ok(run.result.text !== '', 'partial text lost');
      await ctx.server?.waitForAbort(0);
    },
  },
  {
    id: 'P-13',
    title: 'caching markers sent and cached-token usage mapped',
    fixtures: ['cached_usage'],
    async run(ctx) {
      const r = req(ctx, {
        tools: [STATION_TOOL, LOOSE_TOOL],
        cacheKey: 'contract-cache-key',
        system: [
          { text: 'Static instructions.', cacheable: true },
          { text: 'Dynamic context.', cacheable: false },
        ],
      });
      const run = await ctx.run(r);
      assertWellFormed(run);
      target(ctx).wire.assertCaching(lastBody(ctx), r);
      assert.deepEqual(run.result.usage, target(ctx).expectedCachedUsage);
    },
  },
  {
    id: 'P-14',
    title: 'strict tool schema only when the model supports it and the tool is strict',
    fixtures: ['text'],
    async run(ctx) {
      const run = await ctx.run(req(ctx, { tools: [STATION_TOOL, LOOSE_TOOL] }));
      assertWellFormed(run);
      assert.deepEqual(target(ctx).wire.strictTools(lastBody(ctx)), {
        [STATION_TOOL.name]: ctx.capabilities.strictTools,
        [LOOSE_TOOL.name]: false,
      });
    },
  },
  {
    id: 'P-15',
    title: 'the target model, default and router model are in the registry',
    run(ctx) {
      const entry = getProviderEntry(ctx.target.provider);
      for (const model of [ctx.target.model, entry.defaultModel, entry.routerModel]) {
        assert.ok(getModelEntry(ctx.target.provider, model), `${model} is not in the registry`);
      }
      assert.deepEqual(
        ctx.adapter.capabilities(ctx.target.model),
        getModelEntry(ctx.target.provider, ctx.target.model)?.capabilities,
      );
      return Promise.resolve();
    },
  },
];
