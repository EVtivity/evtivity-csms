// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * AI data handling, API surfaces (rule `features/ai-data-handling.md`): each
 * test runs the surface's real path (the route answer through `runToolCall`,
 * the turn runner, the system prompt) against a provider that records the
 * HTTP request body, and asserts on that body.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { AiAttachmentContent } from '@evtivity/ai/core';
import {
  SEEDED_PERSONAL,
  findLeaks,
  seededRecord,
  seededText,
  startRecordingProvider,
} from '@evtivity/ai/testing/harness';
import type { RecordedReply, RecordingProvider } from '@evtivity/ai/testing/harness';
import { emptyRedactionCounts } from '@evtivity/ai/redact';
import {
  createToolset,
  registerAiToolCallContext,
  runToolCall,
} from '../services/ai/tools/execute.js';
import type { AiToolCallContext, ToolsetEntry } from '../services/ai/tools/execute.js';
import type { AiCatalogTool } from '../services/ai/tools/catalog-types.js';
import { runTurn } from '../services/ai/engine/turn-runner.js';
import type { TurnHooks, TurnRunInput } from '../services/ai/engine/turn-runner.js';
import { buildSystemBlocks } from '../services/ai/engine/prompt.js';
import { explainPromptBlock } from '../services/ai/engine/explain-context.js';
import type { ExplainTurnContext } from '../services/ai/engine/explain-context.js';

const validation = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
  additionalProperties: false,
};

const TOOL: AiCatalogTool = {
  name: 'get_driver',
  operationId: 'getDriver',
  description: 'Get a driver',
  category: 'Drivers',
  method: 'GET',
  pathTemplate: '/v1/drivers/{id}',
  pathParams: ['id'],
  queryParams: [],
  bodyParams: [],
  parameters: validation,
  strict: false,
  validation,
  responseFields: [],
};

const ENTRY: ToolsetEntry = {
  tool: TOOL,
  definition: {
    name: TOOL.name,
    description: TOOL.description,
    parameters: TOOL.parameters,
    strict: false,
  },
  fixedArgs: {},
  allowedValues: {},
  omitted: [],
};

let app: FastifyInstance;
let provider: RecordingProvider | null = null;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerAiToolCallContext(app);
  // A route answer holding every seeded secret and personal value, plus a
  // driver-written message, as a driver or support case read would.
  app.get('/v1/drivers/:id', () => ({
    ...seededRecord(),
    messages: [{ author: 'driver', body: seededText() }],
  }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  await provider?.close();
  provider = null;
});

const ATTACHMENTS: Record<string, AiAttachmentContent> = {
  att_txt: { mime: 'text/plain', data: new TextEncoder().encode(seededText()), name: 'notes.txt' },
  att_json: {
    mime: 'application/json',
    data: new TextEncoder().encode(JSON.stringify(seededRecord())),
    name: 'export.json',
  },
};

function hooks(ctx: AiToolCallContext): TurnHooks {
  let n = 0;
  return {
    saveAssistantMessage: async () => {},
    recordUsage: async () => {},
    checkBudget: async () => null,
    saveToolCall: async () => `atc_${String(++n)}`,
    completeToolCall: async () => {},
    saveToolMessage: async () => `tool_${String(++n)}`,
    runTool: (call) => runToolCall(app, call, 'Bearer user-token', ctx),
    createPendingAction: () => Promise.reject(new Error('no writes in this test')),
    newMessageId: () => `aim_${String(++n)}`,
    warn: () => {},
  };
}

/** Runs one turn (a tool call, then an answer) and returns the request bodies. */
async function runRecordedTurn(input: {
  usageSurface: 'chatbot' | 'support';
  userParts: TurnRunInput['history'][number]['parts'];
  system?: TurnRunInput['system'];
}): Promise<string[]> {
  const replies: RecordedReply[] = [
    { toolCall: { name: 'get_driver', args: { id: 'drv_000000000001' } } },
    { text: 'done' },
  ];
  provider = await startRecordingProvider(replies);
  const ctx: AiToolCallContext = {
    surface: input.usageSurface,
    userId: 'usr_1',
    via: { channel: 'chat', conversationId: 'aic_1', toolCallId: 'atc_1' },
  };
  const result = await runTurn({
    adapter: provider.adapter,
    provider: 'anthropic',
    model: provider.model,
    usageSurface: input.usageSurface,
    system: input.system ?? [{ text: 'system', cacheable: true }],
    history: [{ role: 'user', parts: input.userParts }],
    toolset: createToolset([ENTRY]),
    effort: 'low',
    maxToolCalls: 5,
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
    prices: null,
    companyCurrency: 'EUR',
    firstMessageId: 'aim_first',
    resolveAttachment: (id) => Promise.resolve(ATTACHMENTS[id] as AiAttachmentContent),
    emit: () => {},
    hooks: hooks(ctx),
  });
  expect(result.finish).toBe('end');
  const bodies = provider.bodies();
  expect(bodies).toHaveLength(2);
  return bodies;
}

describe('AI data handling: API surfaces', () => {
  it('TC-AI-AD-01 chatbot: typed text and tool results carry no secret, cards and IBANs masked', async () => {
    const [first, second] = await runRecordedTurn({
      usageSurface: 'chatbot',
      userParts: [{ type: 'text', text: seededText() }],
    });
    for (const body of [first ?? '', second ?? '']) {
      expect(findLeaks(body, 'chatbot')).toEqual([]);
    }
    // The tool result reached the second call, with the operator-level data.
    expect(second).toContain('****4242');
    expect(second).toContain(SEEDED_PERSONAL.email);
    expect(second).toContain(SEEDED_PERSONAL.idToken);
    expect(second).toContain('[redacted]');
    // A numeric transaction id is not a card.
    expect(second).toContain('4111111111111111');
  });

  it('TC-AI-AD-02 chatbot attachments: text files reach the provider with keys and cards masked', async () => {
    const [first] = await runRecordedTurn({
      usageSurface: 'chatbot',
      userParts: [
        { type: 'text', text: 'Read the files' },
        { type: 'document', attachmentId: 'att_txt', mime: 'text/plain', name: 'notes.txt' },
        {
          type: 'document',
          attachmentId: 'att_json',
          mime: 'application/json',
          name: 'export.json',
        },
      ],
    });
    expect(first).toContain('notes.txt');
    expect(first).toContain('export.json');
    expect(findLeaks(first ?? '', 'chatbot')).toEqual([]);
    // Chatbot level: the email in the file is kept, the card is cut.
    expect(first).toContain(SEEDED_PERSONAL.email);
    expect(first).toContain('****4242');
  });

  it('TC-AI-AD-03 support drafts: emails and phones masked, idToken hashed, no secret', async () => {
    const bodies = await runRecordedTurn({
      usageSurface: 'support',
      userParts: [{ type: 'text', text: 'Write a reply to the customer for support case SC-1.' }],
    });
    for (const body of bodies) expect(findLeaks(body, 'support')).toEqual([]);
    const second = bodies[1] ?? '';
    expect(second).toContain('j***@example.com');
    expect(second).toMatch(/sha256:[0-9a-f]{12}/);
    expect(second).toContain('****6789');
  });

  it('TC-AI-AD-05 Explain: the framed block carries the record reference only, never its data', async () => {
    const context: ExplainTurnContext = {
      kind: 'station',
      id: 'sta_000000000001',
      resolution: {
        status: 'ok',
        subject: {
          kind: 'station',
          id: 'sta_000000000001',
          siteId: 'sit_1',
          label: 'CS-1',
          stationId: 'sta_000000000001',
          ocppStationId: 'CS-1',
          sessionId: null,
          authorizeAttemptId: null,
          reservationId: null,
          insightId: null,
        },
      },
    };
    const block = explainPromptBlock(context);
    const system = buildSystemBlocks({
      surface: 'chatbot',
      language: 'en',
      operatorPrompt: '',
      userName: 'Op Erator',
      companyCurrency: 'EUR',
      now: new Date('2026-10-11T00:00:00Z'),
      explainContext: block,
    });
    const [first] = await runRecordedTurn({
      usageSurface: 'chatbot',
      userParts: [{ type: 'text', text: 'Why is this station offline?' }],
      system,
    });
    expect(first).toContain('explain_context');
    // The request body is JSON, so the framed reference appears escaped.
    expect(first).toContain(String.raw`\"ocppStationId\":\"CS-1\"`);
    expect(findLeaks(first ?? '', 'support')).toEqual([]);
  });

  it('TC-AI-AD-08 MCP: tool results returned to the client carry no secret (the chatbot redactor)', async () => {
    const outcome = await runToolCall(
      app,
      { entry: ENTRY, args: { id: 'drv_000000000001' } },
      'Bearer api-key',
      { surface: 'chatbot', userId: 'usr_1', via: { channel: 'mcp', mcpCallId: 'mcp_1' } },
    );
    expect(outcome.redactionCounts).not.toEqual(emptyRedactionCounts());
    expect(findLeaks(JSON.stringify(outcome.value), 'chatbot')).toEqual([]);
    expect(findLeaks(outcome.content, 'chatbot')).toEqual([]);
    // The MCP read path runs tool calls on the chatbot surface.
    const source = readFileSync(
      resolve(import.meta.dirname, '../services/ai/mcp/tool-call.ts'),
      'utf8',
    );
    expect(source).toMatch(/runToolCall\([\s\S]{0,200}surface: 'chatbot'/);
  });
});
