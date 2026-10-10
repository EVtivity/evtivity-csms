// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import type { AiStreamEvent as ClientEvent } from '@evtivity/lib/ai-stream';
import { aiStreamEventSchema } from '@evtivity/lib/ai-stream';
import { createScriptedAdapter } from '../services/ai/__contract__/harness.js';
import { AiProviderError } from '../services/ai/core/errors.js';
import type {
  AiPart,
  AiStreamEvent,
  AiToolResultPart,
  AiUsage,
} from '../services/ai/core/types.js';
import { runTurn, PENDING_RESULT } from '../services/ai/engine/turn-runner.js';
import type { TurnHooks } from '../services/ai/engine/turn-runner.js';
import { createToolset } from '../services/ai/tools/execute.js';
import type { ToolOutcome, ToolsetEntry } from '../services/ai/tools/execute.js';
import type { AiCatalogTool } from '../services/ai/tools/catalog-types.js';
import { emptyRedactionCounts } from '../services/ai/tools/redact.js';

const MODEL = 'claude-sonnet-5-5';

function tool(name: string, method: AiCatalogTool['method']): AiCatalogTool {
  const schema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  };
  return {
    name,
    operationId: name,
    description: name,
    category: 'Stations',
    method,
    pathTemplate: '/v1/stations/{id}',
    pathParams: ['id'],
    queryParams: [],
    bodyParams: [],
    parameters: schema,
    strict: true,
    validation: schema,
    responseFields: [],
  };
}

function entry(t: AiCatalogTool): ToolsetEntry {
  return {
    tool: t,
    definition: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: true,
    },
    fixedArgs: {},
    allowedValues: {},
    omitted: [],
  };
}

const TOOLSET = createToolset([
  entry(tool('get_station', 'GET')),
  entry(tool('delete_station', 'DELETE')),
]);

function usage(input: number, output: number): AiUsage {
  return {
    inputTokens: input,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: output,
    reasoningTokens: 0,
  };
}

function call(
  id: string,
  name: string,
  args: Record<string, unknown> = { id: 'sta_000000000001' },
): AiStreamEvent[] {
  return [
    { type: 'tool_call_start', index: 0, id, name },
    { type: 'tool_call_done', id, name, arguments: args },
  ];
}

interface Recorder {
  hooks: TurnHooks;
  events: ClientEvent[];
  assistant: {
    id: string;
    parts: AiPart[];
    finishReason: string;
    usage: AiUsage;
    costMicros: number | null;
  }[];
  toolMessages: AiToolResultPart[][];
  toolCalls: { name: string; status: string }[];
  ran: string[];
  pending: { args: Record<string, unknown> }[];
}

function recorder(outcome: Partial<ToolOutcome> = {}): Recorder {
  const r: Recorder = {
    hooks: undefined as never,
    events: [],
    assistant: [],
    toolMessages: [],
    toolCalls: [],
    ran: [],
    pending: [],
  };
  let n = 0;
  r.hooks = {
    saveAssistantMessage: async (m) => {
      r.assistant.push(m);
    },
    saveToolCall: async ({ call: c, status }) => {
      r.toolCalls.push({ name: c.name, status });
      return `atc_${String(r.toolCalls.length)}`;
    },
    completeToolCall: async () => {},
    saveToolMessage: async (parts) => {
      r.toolMessages.push(parts);
      return `tool_${String(r.toolMessages.length)}`;
    },
    runTool: async (c) => {
      r.ran.push(c.entry.tool.name);
      return {
        status: 'ok',
        httpStatus: 200,
        content: '<untrusted source="tool_result" id="x">{"ok":true}</untrusted>',
        summary: 'GET /v1/stations/sta_000000000001 200',
        redactionCounts: emptyRedactionCounts(),
        latencyMs: 3,
        ...outcome,
      };
    },
    createPendingAction: async ({ args }) => {
      r.pending.push({ args });
      return {
        actionId: 'apa_1',
        nonce: 'n'.repeat(32),
        expiresAt: new Date(Date.now() + 300_000),
        displayArgs: args,
        path: '/v1/stations/sta_000000000001',
      };
    },
    newMessageId: () => `aim_${String(++n)}`,
    warn: () => {},
  };
  return r;
}

function baseInput(
  adapter: ReturnType<typeof createScriptedAdapter>,
  r: Recorder,
  overrides: Partial<Parameters<typeof runTurn>[0]> = {},
): Parameters<typeof runTurn>[0] {
  return {
    adapter,
    provider: 'anthropic',
    model: MODEL,
    system: [{ text: 'system', cacheable: true }],
    history: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    toolset: TOOLSET,
    effort: 'medium',
    maxToolCalls: 5,
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
    prices: { inputPerMTok: 3_000_000, cachedInputPerMTok: null, outputPerMTok: 15_000_000 },
    companyCurrency: 'USD',
    firstMessageId: 'aim_first',
    emit: (e) => r.events.push(e),
    hooks: r.hooks,
    ...overrides,
  };
}

describe('AI turn runner', () => {
  it('streams text and ends; every emitted event matches the stream protocol', async () => {
    const adapter = createScriptedAdapter([
      {
        events: [
          { type: 'text_delta', text: 'Hel' },
          { type: 'text_delta', text: 'lo' },
          { type: 'usage', usage: usage(10, 2) },
          { type: 'finish', reason: 'end' },
        ],
      },
    ]);
    const r = recorder();
    const result = await runTurn(baseInput(adapter, r));
    expect(result.finish).toBe('end');
    expect(result.text).toBe('Hello');
    expect(
      r.events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Hello');
    for (const e of [
      ...r.events,
      { type: 'done', messageId: result.lastMessageId, finish: result.finish },
    ]) {
      expect(aiStreamEventSchema.safeParse(e).success).toBe(true);
    }
  });

  it('TC-AI-L-05 stores usage and cost per assistant message', async () => {
    const adapter = createScriptedAdapter([
      {
        events: [
          ...call('c1', 'get_station'),
          { type: 'usage', usage: usage(1_000, 100) },
          { type: 'finish', reason: 'tool_use' },
        ],
      },
      {
        events: [
          { type: 'text_delta', text: 'done' },
          { type: 'usage', usage: usage(2_000, 50) },
          { type: 'finish', reason: 'end' },
        ],
      },
    ]);
    const r = recorder();
    const result = await runTurn(baseInput(adapter, r, { priorUsage: usage(100, 10) }));
    expect(r.assistant).toHaveLength(2);
    // The router call is counted in the first message.
    expect(r.assistant[0]?.usage.inputTokens).toBe(1_100);
    // 1100 * 3 + 110 * 15 = 4950 micro-USD; 2000 * 3 + 50 * 15 = 6750.
    expect(r.assistant[0]?.costMicros).toBe(4_950);
    expect(r.assistant[1]?.costMicros).toBe(6_750);
    expect(result.costMicros).toBe(11_700);
    const usageEvent = r.events.find((e) => e.type === 'usage');
    expect(usageEvent).toMatchObject({
      usage: { inputTokens: 3_100, outputTokens: 160, costMicros: 11_700 },
    });
  });

  it('shows tokens only when the company currency is not USD', async () => {
    const adapter = createScriptedAdapter([
      {
        events: [
          { type: 'usage', usage: usage(1_000, 100) },
          { type: 'finish', reason: 'end' },
        ],
      },
    ]);
    const r = recorder();
    const result = await runTurn(baseInput(adapter, r, { companyCurrency: 'EUR' }));
    expect(result.costMicros).toBe(4_500);
    const usageEvent = r.events.find((e) => e.type === 'usage') as {
      usage: Record<string, unknown>;
    };
    expect(usageEvent.usage['costMicros']).toBeUndefined();
    expect(usageEvent.usage['inputTokens']).toBe(1_000);
  });

  it('runs reads and sends their redacted results back to the model', async () => {
    const adapter = createScriptedAdapter([
      { events: [...call('c1', 'get_station'), { type: 'finish', reason: 'tool_use' }] },
      {
        events: [
          { type: 'text_delta', text: 'ok' },
          { type: 'finish', reason: 'end' },
        ],
      },
    ]);
    const r = recorder();
    await runTurn(baseInput(adapter, r));
    expect(r.ran).toEqual(['get_station']);
    const second = adapter.calls[1];
    const toolMessage = second?.messages[second.messages.length - 1];
    expect(toolMessage?.role).toBe('tool');
    expect((toolMessage?.parts[0] as AiToolResultPart).content).toContain('<untrusted');
    expect(r.events.map((e) => (e.type === 'tool_step' ? e.status : null)).filter(Boolean)).toEqual(
      ['running', 'ok'],
    );
  });

  it('TC-AI-T-03 stops at a write with confirmation_required and runs nothing', async () => {
    const adapter = createScriptedAdapter([
      { events: [...call('c1', 'delete_station'), { type: 'finish', reason: 'tool_use' }] },
    ]);
    const r = recorder();
    const result = await runTurn(baseInput(adapter, r));
    expect(result.finish).toBe('confirmation_required');
    expect(r.ran).toEqual([]);
    expect(r.pending).toHaveLength(1);
    expect(r.toolMessages[0]?.[0]?.content).toBe(PENDING_RESULT);
    const confirm = r.events.find((e) => e.type === 'confirmation_required');
    expect(confirm).toMatchObject({
      actionId: 'apa_1',
      method: 'DELETE',
      path: '/v1/stations/sta_000000000001',
      name: 'delete_station',
    });
    expect(adapter.calls).toHaveLength(1);
  });

  it('holds one write at a time and refuses a second one in the same response', async () => {
    const adapter = createScriptedAdapter([
      {
        events: [
          ...call('c1', 'delete_station'),
          ...call('c2', 'delete_station', { id: 'sta_000000000002' }),
          { type: 'finish', reason: 'tool_use' },
        ],
      },
    ]);
    const r = recorder();
    await runTurn(baseInput(adapter, r));
    expect(r.toolCalls.map((c) => c.status)).toEqual(['pending_confirmation', 'refused']);
    expect(r.events.find((e) => e.type === 'tool_step' && e.status === 'refused')).toMatchObject({
      reason: 'one_change_at_a_time',
    });
    expect(r.toolMessages[0]?.[1]?.isError).toBe(true);
  });

  it('TC-AI-T-07 counts refused and failed calls against the cap, so the loop ends', async () => {
    // The model keeps asking for a tool that does not exist.
    const finish: AiStreamEvent = { type: 'finish', reason: 'tool_use' };
    const steps = Array.from({ length: 10 }, (_, i) => ({
      events: [...call(`c${String(i)}`, 'list_settings'), finish],
    }));
    const adapter = createScriptedAdapter(steps);
    const r = recorder();
    const result = await runTurn(baseInput(adapter, r, { maxToolCalls: 3 }));
    expect(result.finish).toBe('error');
    expect(result.errorCode).toBe('AI_ERROR');
    expect(adapter.calls.length).toBeLessThanOrEqual(4);
    expect(r.events.some((e) => e.type === 'tool_step' && e.reason === 'limit_reached')).toBe(true);
    expect(r.toolCalls.every((c) => c.status === 'refused')).toBe(true);
    expect(r.ran).toEqual([]);
  });

  it('TC-AI-T-08 refuses invalid arguments before running the tool', async () => {
    const adapter = createScriptedAdapter([
      {
        events: [...call('c1', 'get_station', { id: 42 }), { type: 'finish', reason: 'tool_use' }],
      },
      {
        events: [
          { type: 'text_delta', text: 'sorry' },
          { type: 'finish', reason: 'end' },
        ],
      },
    ]);
    const r = recorder();
    await runTurn(baseInput(adapter, r));
    expect(r.ran).toEqual([]);
    expect(r.toolCalls[0]?.status).toBe('refused');
    expect(r.toolMessages[0]?.[0]?.content).toContain('Invalid arguments');
    expect(r.events.find((e) => e.type === 'tool_step' && e.status === 'refused')).toMatchObject({
      reason: 'invalid_arguments',
    });
  });

  it('answers a malformed tool call (tool_call_error, finish end) instead of dropping it', async () => {
    const adapter = createScriptedAdapter([
      {
        events: [
          {
            type: 'tool_call_error',
            id: 'malformed_0',
            name: 'get_station',
            rawArguments: '{',
            message: 'bad JSON',
          },
          { type: 'finish', reason: 'end' },
        ],
      },
      {
        events: [
          { type: 'text_delta', text: 'retrying' },
          { type: 'finish', reason: 'end' },
        ],
      },
    ]);
    const r = recorder();
    const result = await runTurn(baseInput(adapter, r));
    expect(result.finish).toBe('end');
    expect(r.toolMessages[0]?.[0]?.content).toContain('not valid JSON');
    expect(adapter.calls).toHaveLength(2);
  });

  it('TC-AI-S-03 keeps the partial text when the client stops the stream', async () => {
    const controller = new AbortController();
    const adapter = createScriptedAdapter([
      {
        delayMs: 20,
        events: [
          { type: 'text_delta', text: 'partial' },
          { type: 'text_delta', text: ' more' },
          { type: 'finish', reason: 'end' },
        ],
      },
    ]);
    const r = recorder();
    const run = runTurn(baseInput(adapter, r, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 30);
    const result = await run;
    expect(result.finish).toBe('stopped');
    expect(r.assistant[0]?.finishReason).toBe('stopped');
    expect(r.assistant[0]?.parts).toEqual([{ type: 'text', text: 'partial' }]);
  });

  it('TC-AI-S-04 maps a provider failure to a code without the provider message', async () => {
    const adapter = createScriptedAdapter([
      {
        events: [],
        error: new AiProviderError({
          code: 'auth',
          provider: 'anthropic',
          message: 'invalid x-api-key sk-ant-secret-0123456789',
          status: 401,
        }),
      },
    ]);
    const r = recorder();
    const result = await runTurn(baseInput(adapter, r));
    expect(result.errorCode).toBe('AI_PROVIDER_AUTH_FAILED');
    const error = r.events.find((e) => e.type === 'error');
    expect(JSON.stringify(error)).not.toContain('sk-ant');
    expect(JSON.stringify(error)).not.toContain('x-api-key');
  });

  it('TC-AI-S-06 ends the turn when a tool call comes back 401', async () => {
    const adapter = createScriptedAdapter([
      { events: [...call('c1', 'get_station'), { type: 'finish', reason: 'tool_use' }] },
      { events: [{ type: 'finish', reason: 'end' }] },
    ]);
    const r = recorder({ status: 'error', httpStatus: 401 });
    const result = await runTurn(baseInput(adapter, r));
    expect(result.finish).toBe('error');
    expect(result.errorCode).toBe('UNAUTHORIZED');
    expect(adapter.calls).toHaveLength(1);
  });

  it('refuses an image part the model cannot take before calling it', async () => {
    const adapter = createScriptedAdapter([], {
      capabilities: { ...createScriptedAdapter([]).capabilities(MODEL), vision: false },
    });
    const r = recorder();
    const result = await runTurn(
      baseInput(adapter, r, {
        history: [
          { role: 'user', parts: [{ type: 'image', attachmentId: 'a1', mime: 'image/png' }] },
        ],
      }),
    );
    expect(result.errorCode).toBe('AI_ATTACHMENT_UNSUPPORTED');
    expect(adapter.calls).toHaveLength(0);
  });

  it("drops another model's provider state from the history", async () => {
    const adapter = createScriptedAdapter([{ events: [{ type: 'finish', reason: 'end' }] }]);
    const r = recorder();
    await runTurn(
      baseInput(adapter, r, {
        history: [
          { role: 'user', parts: [{ type: 'text', text: 'a' }] },
          {
            role: 'assistant',
            parts: [{ type: 'text', text: 'b' }],
            providerState: { provider: 'openai', model: 'gpt-6.1-sol', opaque: { x: 1 } },
          },
          { role: 'user', parts: [{ type: 'text', text: 'c' }] },
        ],
      }),
    );
    expect(adapter.calls[0]?.messages[1]?.providerState).toBeUndefined();
  });

  it('proposes the call the write check returns: the card and the pending action carry it', async () => {
    const adapter = createScriptedAdapter([
      { events: [...call('c1', 'delete_station'), { type: 'finish', reason: 'tool_use' }] },
    ]);
    const r = recorder();
    const replacement = entry(tool('remove_station', 'DELETE'));
    r.hooks.checkWrite = async () => ({
      ok: true,
      entry: replacement,
      args: { id: 'sta_000000000009' },
      note: 'Mapped to remove_station.',
    });
    const result = await runTurn(baseInput(adapter, r));
    expect(result.finish).toBe('confirmation_required');
    expect(r.toolCalls).toEqual([{ name: 'remove_station', status: 'pending_confirmation' }]);
    expect(r.pending).toEqual([{ args: { id: 'sta_000000000009' } }]);
    expect(r.events.find((e) => e.type === 'confirmation_required')).toMatchObject({
      name: 'remove_station',
    });
    // The model's own call stays in the history; its result explains the change.
    const toolPart = r.toolMessages[0]?.[0];
    expect(toolPart?.name).toBe('delete_station');
    expect(toolPart?.content).toContain('Mapped to remove_station.');
    expect(toolPart?.content).toContain('pending_confirmation');
  });

  it('refuses a write the check refuses, with its reason, and proposes nothing', async () => {
    const adapter = createScriptedAdapter([
      { events: [...call('c1', 'delete_station'), { type: 'finish', reason: 'tool_use' }] },
      {
        events: [
          { type: 'text_delta', text: 'ok' },
          { type: 'finish', reason: 'end' },
        ],
      },
    ]);
    const r = recorder();
    r.hooks.checkWrite = async () => ({
      ok: false,
      refusal: { reason: 'ocpp_version_mismatch', modelText: 'Station uses OCPP 2.1.' },
    });
    const result = await runTurn(baseInput(adapter, r));
    expect(result.finish).toBe('end');
    expect(r.pending).toEqual([]);
    expect(r.toolCalls).toEqual([{ name: 'delete_station', status: 'refused' }]);
    expect(r.events.find((e) => e.type === 'tool_step' && e.status === 'refused')).toMatchObject({
      reason: 'ocpp_version_mismatch',
    });
    expect(r.toolMessages[0]?.[0]).toMatchObject({ isError: true });
    expect(r.toolMessages[0]?.[0]?.content).toContain('Station uses OCPP 2.1.');
  });

  it('does not check reads', async () => {
    const adapter = createScriptedAdapter([
      { events: [...call('c1', 'get_station'), { type: 'finish', reason: 'tool_use' }] },
      {
        events: [
          { type: 'text_delta', text: 'ok' },
          { type: 'finish', reason: 'end' },
        ],
      },
    ]);
    const r = recorder();
    let checked = 0;
    r.hooks.checkWrite = async (c) => {
      checked++;
      return { ok: true, entry: c.entry, args: c.args };
    };
    await runTurn(baseInput(adapter, r));
    expect(checked).toBe(0);
    expect(r.ran).toEqual(['get_station']);
  });
});
