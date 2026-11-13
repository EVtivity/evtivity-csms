// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  users: [] as unknown[],
  conv: {
    appendMessage: vi.fn(async (_i: unknown) => 'msg_tool'),
    completeToolCall: vi.fn(async () => undefined),
    createPendingAction: vi.fn(async () => ({
      actionId: 'act_1',
      nonce: 'n',
      expiresAt: new Date(0),
    })),
    interruptConfirmedAction: vi.fn(async () => true),
    listMessages: vi.fn(async () => []),
    recordToolCall: vi.fn(async (_input: unknown, _actor?: unknown, _log?: unknown) => 'tc_row'),
    replaceToolResult: vi.fn(async () => undefined),
    setTitleIfEmpty: vi.fn(async () => undefined),
    supersedePendingActions: vi.fn(async () => [] as unknown[]),
    toAiMessages: vi.fn((_rows: unknown) => [] as unknown[]),
  },
  runTurn: vi.fn(),
  routeCategories: vi.fn(),
  checkAiBudgets: vi.fn(),
  recordAiUsage: vi.fn(async () => ({ notices: [] })),
  dispatchNotices: vi.fn(async () => undefined),
  providerGate: vi.fn(async () => 'open'),
  runToolCall: vi.fn(),
  prepareToolCall: vi.fn(),
  checkVersion: vi.fn(),
  surfaceOffers: vi.fn(() => true),
  buildSystemBlocks: vi.fn((_i: unknown) => [{ text: 'sys', cacheable: true }]),
  getModelEntry: vi.fn((_p: string, _m: string): { prices: { input: number } } | undefined => ({
    prices: { input: 1 },
  })),
}));

vi.mock('@evtivity/database', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where']) c[m] = vi.fn(() => c);
  c['limit'] = vi.fn(async () => h.users);
  return {
    db: { select: vi.fn(() => c) },
    users: {},
    checkAiBudgets: h.checkAiBudgets,
    getCompanyCurrency: vi.fn(async () => 'EUR'),
    recordAiUsage: h.recordAiUsage,
  };
});
vi.mock('@evtivity/services/ai-alerts', () => ({
  aiProviderGate: h.providerGate,
  dispatchAiBudgetNotices: h.dispatchNotices,
}));
vi.mock('@evtivity/lib/pricing-engine', () => ({ aiUsageCostMicros: vi.fn(() => 321) }));
vi.mock('@evtivity/ai/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/ai/core')>()),
  getModelEntry: h.getModelEntry,
  getProviderEntry: vi.fn(() => ({ routerModel: 'router-m' })),
}));
vi.mock('@evtivity/ai/redact', () => ({ redactToolValue: vi.fn(() => ({ value: 'REDACTED' })) }));
vi.mock('../services/ai/conversation.service.js', () => h.conv);
vi.mock('../services/ai/surfaces/toolsets.js', () => ({
  chatbotToolset: vi.fn((cats: string[]) => ({ definitions: [{ name: `chat:${cats.join()}` }] })),
  routerCategories: vi.fn(() => []),
  supportToolset: vi.fn(() => ({ definitions: [{ name: 'support' }] })),
}));
vi.mock('../services/ai/tools/catalog.js', () => ({
  AI_TOOL_CATEGORIES: [],
  AI_TOOL_CATALOG: [
    {
      name: 'reset_station',
      operationId: 'ocppv21_Reset',
      method: 'POST',
      description: 'Reset',
      parameters: {},
      strict: false,
      pathTemplate: '/v1/ocpp/commands/v21/Reset',
    },
  ],
}));
vi.mock('../services/ai/tools/execute.js', () => ({
  buildToolRequest: vi.fn(() => ({ url: '/v1/x' })),
  createToolset: vi.fn((entries: unknown[]) => ({ entries })),
  prepareToolCall: h.prepareToolCall,
  runToolCall: h.runToolCall,
}));
vi.mock('../services/ai/tools/policy.js', () => ({
  surfaceOffers: h.surfaceOffers,
  toolPolicy: vi.fn(() => ({ omit: [] })),
}));
vi.mock('../services/ai/engine/confirm-args.js', () => ({
  confirmationArguments: vi.fn(() => ({ displayArgs: { a: 1 } })),
}));
vi.mock('../services/ai/tools/ocpp-command-check.js', () => ({
  checkOcppCommandVersion: h.checkVersion,
}));
vi.mock('../services/ai/engine/providers.js', () => ({ createAdapterFor: vi.fn(() => ({})) }));
vi.mock('../services/ai/engine/prompt.js', () => ({ buildSystemBlocks: h.buildSystemBlocks }));
vi.mock('../services/ai/engine/explain-context.js', () => ({
  explainPromptBlock: vi.fn(() => 'EXPLAIN'),
}));
vi.mock('../services/ai/engine/attachments.js', () => ({
  attachmentParts: vi.fn(() => [{ type: 'image', attachmentId: 'att_1', mime: 'image/png' }]),
  attachmentResolverFor: vi.fn(() => vi.fn()),
}));
vi.mock('../services/ai/engine/router.js', () => ({ routeCategories: h.routeCategories }));
vi.mock('../services/ai/engine/turn-runner.js', () => ({
  TURN_DEADLINE_MS: 120_000,
  runTurn: h.runTurn,
  turnErrorCode: (err: unknown) =>
    err instanceof Error && err.message === 'quota' ? 'AI_PROVIDER_QUOTA_EXCEEDED' : 'AI_ERROR',
}));

import {
  failStream,
  runChatMessageTurn,
  runDecisionTurn,
  runSupportAssistTurn,
} from '../services/ai/engine/turn.js';
import type { TurnContext } from '../services/ai/engine/turn.js';
import type { AiConversationRow, AiPendingActionRow } from '../services/ai/conversation.service.js';
import type { AiSurfaceConfig } from '../services/ai/surfaces/config.js';

const log = { warn: vi.fn(), error: vi.fn() };
const ctx: TurnContext = {
  app: {} as never,
  userId: 'usr_1',
  authorization: 'Bearer t',
  accessScope: 'scope_A',
  isApiKey: false,
  hasPermission: vi.fn(async () => true),
  actor: { actor: 'operator', actorUserId: 'usr_1' },
  log: log as never,
};
const CHAT = { id: 'cnv_1', surface: 'chatbot' } as unknown as AiConversationRow;
const SUPPORT = { id: 'cnv_2', surface: 'support' } as unknown as AiConversationRow;
const CONFIG = {
  surface: 'chatbot',
  provider: 'anthropic',
  model: 'm1',
  effort: 'medium',
  systemPrompt: 'op',
  tone: 'formal',
  source: 'system',
} as unknown as AiSurfaceConfig;
const RESULT = { finish: 'stop', lastMessageId: 'msg_last', text: 'hi', usage: {} };

function stream(): { send: ReturnType<typeof vi.fn>; signal: AbortSignal; types: () => string[] } {
  const send = vi.fn();
  return {
    send,
    signal: new AbortController().signal,
    types: () => send.mock.calls.map((c) => (c[0] as { type: string }).type),
  };
}

const ENTRY = {
  tool: { name: 'reset_station', operationId: 'ocppv21_Reset', method: 'POST' },
};

/** A runTurn that exercises every hook the engine wires in. */
async function exerciseHooks(input: Record<string, unknown>): Promise<unknown> {
  const hooks = input['hooks'] as Record<string, (...a: unknown[]) => unknown>;
  const emit = input['emit'] as (e: unknown) => void;
  emit({ type: 'text_delta', text: 'x' });
  await hooks['recordUsage']?.({ messageId: 'm1', usage: { inputTokens: 1 }, costMicros: 5 });
  expect(await hooks['checkBudget']?.()).toBeNull();
  expect(await hooks['checkBudget']?.()).toBe('AI_BUDGET_EXCEEDED');
  await hooks['saveAssistantMessage']?.({
    id: 'm1',
    parts: [],
    providerState: undefined,
    usage: {},
    costMicros: 5,
    finishReason: 'stop',
  });
  const call = { id: 't1', name: 'reset_station', arguments: { stationId: 'CS-1' } };
  expect(await hooks['saveToolCall']?.({ messageId: 'm1', call, entry: ENTRY, status: 'ok' })).toBe(
    'tc_row',
  );
  await hooks['saveToolCall']?.({ messageId: 'm1', call, entry: null, status: 'refused' });
  await hooks['completeToolCall']?.('tc_row', { status: 'ok' });
  await hooks['saveToolMessage']?.([]);
  await hooks['runTool']?.({ entry: ENTRY, args: {} }, 'tc_row');
  expect(
    await hooks['createPendingAction']?.({
      toolCallRowId: 'tc_row',
      toolMessageId: 'msg_tool',
      call,
      entry: ENTRY,
      args: { stationId: 'CS-1' },
    }),
  ).toEqual({
    actionId: 'act_1',
    nonce: 'n',
    expiresAt: new Date(0),
    displayArgs: { a: 1 },
    path: '/v1/x',
  });
  await hooks['checkWrite']?.({ entry: ENTRY, args: {} });
  expect(typeof hooks['newMessageId']?.()).toBe('string');
  hooks['warn']?.(new Error('x'), 'reset_station');
  return RESULT;
}

beforeEach(() => {
  h.users = [{ firstName: 'Ada', lastName: null, language: 'de' }];
  h.checkAiBudgets.mockReset();
  h.runTurn.mockReset();
  h.checkAiBudgets
    .mockResolvedValueOnce({ allowed: true })
    .mockResolvedValueOnce({ allowed: false, code: 'AI_BUDGET_EXCEEDED' });
  h.routeCategories.mockResolvedValue({
    called: true,
    categories: ['stations'],
    usage: { inputTokens: 3 },
  });
  h.runTurn.mockImplementation(exerciseHooks);
  h.runToolCall.mockResolvedValue({
    status: 'ok',
    content: '{"ok":true}',
    httpStatus: 200,
    latencyMs: 9,
    redactionCounts: {},
    summary: 'done',
  });
  h.checkVersion.mockImplementation(
    async (_c: unknown, call: { entry: unknown; args: unknown }) => ({
      ok: true,
      entry: call.entry,
      args: call.args,
    }),
  );
  h.prepareToolCall.mockImplementation(() => ({
    ok: true,
    entry: ENTRY,
    args: { stationId: 'CS-1' },
  }));
});

describe('failStream', () => {
  it('sends an error and a done event', () => {
    const s = stream();
    failStream(s as never, 'msg_1');
    expect(s.send.mock.calls).toEqual([
      [{ type: 'error', code: 'AI_ERROR' }],
      [{ type: 'done', messageId: 'msg_1', finish: 'error' }],
    ]);
  });
});

describe('runChatMessageTurn', () => {
  it('stores the message, routes the tools, runs the loop and wires every hook', async () => {
    const s = stream();
    h.conv.supersedePendingActions.mockResolvedValueOnce([
      { toolMessageId: 'mt', toolCallId: 't9', toolCallRowId: 'tc9' },
    ]);
    const out = await runChatMessageTurn({
      ctx,
      conversation: CHAT,
      config: CONFIG,
      stream: s as never,
      text: '  Why   is CS-1\n offline? ',
      attachments: [],
      maxToolCalls: 5,
      explain: { kind: 'station', id: 'sta_1', resolution: { status: 'missing' } },
    });
    expect(out).toBe(RESULT);
    expect(s.types()).toEqual(['message_start', 'text_delta', 'done']);
    expect(s.send.mock.calls[2]?.[0]).toEqual({
      type: 'done',
      messageId: 'msg_last',
      finish: 'stop',
    });
    // The open action is closed as not run.
    expect(h.conv.replaceToolResult).toHaveBeenCalledWith(
      'mt',
      't9',
      expect.stringContaining('not_run'),
      true,
      'scope_A',
    );
    expect(h.conv.completeToolCall).toHaveBeenCalledWith('tc9', { status: 'rejected' });
    expect(h.conv.setTitleIfEmpty).toHaveBeenCalledWith('cnv_1', 'Why is CS-1 offline?');
    expect(h.conv.appendMessage.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      parts: [
        { type: 'text', text: '  Why   is CS-1\n offline? ' },
        { type: 'image', attachmentId: 'att_1', mime: 'image/png' },
      ],
    });
    // The system prompt carries the user, language, currency and Explain block.
    expect(h.buildSystemBlocks.mock.calls[0]?.[0]).toMatchObject({
      surface: 'chatbot',
      language: 'de',
      userName: 'Ada',
      companyCurrency: 'EUR',
      operatorPrompt: 'op',
      explainContext: 'EXPLAIN',
    });
    const loop = h.runTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(loop).toMatchObject({
      provider: 'anthropic',
      model: 'm1',
      usageSurface: 'chatbot',
      effort: 'medium',
      maxToolCalls: 5,
      prices: { input: 1 },
      companyCurrency: 'EUR',
      priorUsage: { inputTokens: 3 },
      toolset: { definitions: [{ name: 'chat:stations' }] },
    });
    expect(typeof loop['cacheKey']).toBe('string');
    // The router call and the loop's model call each write a ledger row.
    expect(h.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'router-m', aiMessageId: null, costMicros: 321 }),
    );
    expect(h.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'chatbot', model: 'm1', aiMessageId: 'm1', siteId: null }),
    );
    expect(h.conv.recordToolCall.mock.calls[0]?.[0]).toMatchObject({
      operationId: 'ocppv21_Reset',
      method: 'POST',
      path: '/v1/x',
      args: 'REDACTED',
    });
    expect(h.conv.recordToolCall.mock.calls[1]?.[0]).toMatchObject({
      operationId: null,
      method: null,
      path: null,
    });
    expect(h.runToolCall).toHaveBeenCalledWith(ctx.app, { entry: ENTRY, args: {} }, 'Bearer t', {
      surface: 'chatbot',
      userId: 'usr_1',
      via: { channel: 'chat', conversationId: 'cnv_1', toolCallId: 'tc_row' },
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'reset_station' }),
      'AI tool call failed',
    );
  });

  it('runs without the router usage and with no user name or prices', async () => {
    h.users = [];
    h.getModelEntry.mockReturnValue(undefined);
    h.routeCategories.mockResolvedValueOnce({ called: false, categories: [], usage: undefined });
    h.runTurn.mockResolvedValueOnce(RESULT);
    const s = stream();
    await runChatMessageTurn({
      ctx,
      conversation: CHAT,
      config: CONFIG,
      stream: s as never,
      text: 'hi',
      attachments: [],
      maxToolCalls: 1,
    });
    const loop = h.runTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(loop['prices']).toBeNull();
    expect(loop).not.toHaveProperty('priorUsage');
    expect(h.buildSystemBlocks.mock.calls[0]?.[0]).toMatchObject({ userName: '', language: 'en' });
    expect(h.buildSystemBlocks.mock.calls[0]?.[0]).not.toHaveProperty('explainContext');
    expect(h.recordAiUsage).not.toHaveBeenCalled();
    h.getModelEntry.mockImplementation(() => ({ prices: { input: 1 } }));
  });

  it('prices the router call at null when the router model has no prices', async () => {
    h.getModelEntry.mockImplementation((_p: string, m: string) =>
      m === 'router-m' ? undefined : { prices: { input: 1 } },
    );
    h.runTurn.mockResolvedValueOnce(RESULT);
    await runChatMessageTurn({
      ctx,
      conversation: CHAT,
      config: CONFIG,
      stream: stream() as never,
      text: 'hi',
      attachments: [],
      maxToolCalls: 1,
    });
    expect(h.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'router-m', costMicros: null }),
    );
    h.getModelEntry.mockImplementation(() => ({ prices: { input: 1 } }));
  });

  it('logs a failed ledger write and goes on', async () => {
    h.recordAiUsage.mockRejectedValueOnce(new Error('db'));
    h.runTurn.mockResolvedValueOnce(RESULT);
    expect(
      await runChatMessageTurn({
        ctx,
        conversation: CHAT,
        config: CONFIG,
        stream: stream() as never,
        text: 'hi',
        attachments: [],
        maxToolCalls: 1,
      }),
    ).toBe(RESULT);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cnv_1' }),
      'AI usage ledger write failed, the turn goes on',
    );
  });

  it('fails the stream with the error code when the turn throws', async () => {
    h.runTurn.mockRejectedValueOnce(new Error('quota'));
    const s = stream();
    expect(
      await runChatMessageTurn({
        ctx,
        conversation: CHAT,
        config: CONFIG,
        stream: s as never,
        text: 'hi',
        attachments: [],
        maxToolCalls: 1,
      }),
    ).toBeNull();
    expect(s.send).toHaveBeenCalledWith({ type: 'error', code: 'AI_PROVIDER_QUOTA_EXCEEDED' });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cnv_1' }),
      'AI chat turn failed',
    );
  });

  it('routes on the last non-empty user message', async () => {
    h.conv.toAiMessages.mockReturnValueOnce([
      { role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
      { role: 'user', parts: [{ type: 'image' }, { type: 'text', text: ' second ' }] },
      { role: 'user', parts: [{ type: 'image' }] },
    ]);
    h.runTurn.mockResolvedValueOnce(RESULT);
    await runChatMessageTurn({
      ctx,
      conversation: CHAT,
      config: CONFIG,
      stream: stream() as never,
      text: 'x',
      attachments: [],
      maxToolCalls: 1,
    });
    expect(h.routeCategories.mock.calls[0]?.[0]).toMatchObject({
      model: 'router-m',
      message: 'second',
      recentUserMessages: ['first'],
    });
  });
});

describe('runDecisionTurn', () => {
  const ACTION = {
    id: 'act_1',
    operationId: 'ocppv21_Reset',
    toolMessageId: 'msg_tool',
    toolCallId: 't1',
    toolCallRowId: 'tc_1',
    args: { stationId: 'CS-1' },
  } as unknown as AiPendingActionRow;

  function decide(
    decision: 'confirmed' | 'rejected',
    action: AiPendingActionRow = ACTION,
  ): { s: ReturnType<typeof stream>; run: Promise<unknown> } {
    const s = stream();
    h.runTurn.mockResolvedValueOnce(RESULT);
    return {
      s,
      run: runDecisionTurn({
        ctx,
        conversation: CHAT,
        config: CONFIG,
        stream: s as never,
        action,
        decision,
        maxToolCalls: 3,
      }),
    };
  }

  it('reports a rejection and continues the turn', async () => {
    const { s, run } = decide('rejected');
    expect(await run).toBe(RESULT);
    expect(h.conv.replaceToolResult).toHaveBeenCalledWith(
      'msg_tool',
      't1',
      expect.stringContaining('rejected'),
      false,
      'scope_A',
    );
    expect(h.conv.completeToolCall).toHaveBeenCalledWith('tc_1', { status: 'rejected' });
    expect(s.send).toHaveBeenCalledWith({
      type: 'tool_step',
      toolCallId: 'tc_1',
      name: 'reset_station',
      status: 'rejected',
    });
  });

  it('names an unknown operation by its id on a rejection', async () => {
    const { s, run } = decide('rejected', { ...ACTION, operationId: 'gone' });
    await run;
    expect(s.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'gone', status: 'rejected' }),
    );
  });

  it('runs a confirmed write once and records its outcome', async () => {
    const { s, run } = decide('confirmed');
    expect(await run).toBe(RESULT);
    expect(h.runToolCall).toHaveBeenCalledWith(
      ctx.app,
      { entry: ENTRY, args: { stationId: 'CS-1' } },
      'Bearer t',
      {
        surface: 'chatbot',
        userId: 'usr_1',
        via: { channel: 'chat', conversationId: 'cnv_1', toolCallId: 'tc_1' },
      },
    );
    expect(h.conv.replaceToolResult).toHaveBeenCalledWith(
      'msg_tool',
      't1',
      '{"ok":true}',
      false,
      'scope_A',
    );
    expect(h.conv.completeToolCall).toHaveBeenCalledWith('tc_1', {
      status: 'confirmed',
      httpStatus: 200,
      latencyMs: 9,
      redactionCounts: {},
    });
    expect(s.send).toHaveBeenCalledWith({
      type: 'tool_step',
      toolCallId: 'tc_1',
      name: 'reset_station',
      status: 'confirmed',
      summary: 'done',
      durationMs: 9,
    });
  });

  it('marks a failed write as an error and stops on 401', async () => {
    h.runToolCall.mockResolvedValueOnce({
      status: 'error',
      content: '{"error":"x"}',
      httpStatus: 401,
      latencyMs: 1,
      redactionCounts: {},
      summary: 'unauthorized',
    });
    const { s, run } = decide('confirmed');
    expect(await run).toBeNull();
    expect(h.conv.replaceToolResult).toHaveBeenCalledWith(
      'msg_tool',
      't1',
      '{"error":"x"}',
      true,
      'scope_A',
    );
    expect(s.send).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    expect(s.send).toHaveBeenCalledWith({ type: 'error', code: 'UNAUTHORIZED' });
  });

  it('refuses a write no longer offered or no longer in the catalog', async () => {
    h.surfaceOffers.mockReturnValueOnce(false);
    const first = decide('confirmed');
    await first.run;
    expect(first.s.send).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'refused', reason: 'no_longer_available' }),
    );
    expect(h.conv.completeToolCall).toHaveBeenCalledWith('tc_1', { status: 'refused' });
    const second = decide('confirmed', { ...ACTION, operationId: 'gone' });
    await second.run;
    expect(second.s.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'gone', reason: 'no_longer_available' }),
    );
    expect(h.runToolCall).not.toHaveBeenCalled();
  });

  it('refuses when the version check fails or maps to another command', async () => {
    h.checkVersion.mockResolvedValueOnce({
      ok: false,
      refusal: { reason: 'ocpp_unsupported', modelText: 'nope' },
    });
    const first = decide('confirmed');
    await first.run;
    expect(h.conv.replaceToolResult).toHaveBeenCalledWith(
      'msg_tool',
      't1',
      JSON.stringify({ error: 'nope' }),
      true,
      'scope_A',
    );
    h.checkVersion.mockResolvedValueOnce({
      ok: true,
      entry: { tool: { operationId: 'ocppv16_Reset' } },
      args: {},
    });
    const second = decide('confirmed');
    await second.run;
    expect(second.s.send).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'ocpp_version_mismatch' }),
    );
    expect(h.runToolCall).not.toHaveBeenCalled();
  });

  it('refuses when the arguments no longer fit the schema', async () => {
    h.prepareToolCall.mockReturnValueOnce({
      ok: false,
      refusal: { reason: 'invalid_arguments', modelText: 'bad' },
    });
    const { s, run } = decide('confirmed');
    await run;
    expect(s.send).toHaveBeenCalledWith(expect.objectContaining({ reason: 'invalid_arguments' }));
  });

  it('closes a confirmed action when the turn fails, and logs a failed close', async () => {
    h.runToolCall.mockRejectedValueOnce(new Error('boom'));
    const first = decide('confirmed');
    expect(await first.run).toBeNull();
    expect(h.conv.interruptConfirmedAction).toHaveBeenCalledWith(ACTION, 'scope_A');
    expect(first.s.send).toHaveBeenCalledWith({ type: 'error', code: 'AI_ERROR' });

    h.runToolCall.mockRejectedValueOnce(new Error('boom'));
    h.conv.interruptConfirmedAction.mockRejectedValueOnce(new Error('db'));
    await decide('confirmed').run;
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'act_1' }),
      'Interrupted AI action could not be closed',
    );
  });

  it('does not close anything when a rejection fails', async () => {
    h.conv.replaceToolResult.mockRejectedValueOnce(new Error('db'));
    expect(await decide('rejected').run).toBeNull();
    expect(h.conv.interruptConfirmedAction).not.toHaveBeenCalled();
  });
});

describe('runSupportAssistTurn', () => {
  const caseContext = { caseId: 'cas_1' } as never;

  function assist(over: Record<string, unknown> = {}): Promise<unknown> {
    return runSupportAssistTurn({
      ctx,
      conversation: SUPPORT,
      config: { ...CONFIG, surface: 'support' },
      stream: stream() as never,
      caseContext,
      siteId: 'site_1',
      caseNumber: 'SC-7',
      driverLanguage: 'es',
      isInternalNote: false,
      maxToolCalls: 4,
      ...over,
    });
  }

  it('drafts a customer reply charged to the case site', async () => {
    expect(await assist({ insightContext: '<untrusted>i</untrusted>' })).toBe(RESULT);
    expect(h.conv.appendMessage.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      parts: [
        {
          type: 'text',
          text: expect.stringContaining('Write a reply to the customer for support case SC-7'),
        },
        { type: 'text', text: '<untrusted>i</untrusted>' },
      ],
    });
    expect(h.buildSystemBlocks.mock.calls[0]?.[0]).toMatchObject({
      surface: 'support',
      tone: 'formal',
      isInternalNote: false,
      replyLanguage: 'es',
    });
    expect(h.runTurn.mock.calls[0]?.[0]).toMatchObject({
      usageSurface: 'support',
      toolset: { definitions: [{ name: 'support' }] },
    });
    expect(h.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'support', siteId: 'site_1' }),
    );
    expect(h.checkAiBudgets).toHaveBeenCalledWith({
      surface: 'support',
      userId: 'usr_1',
      siteId: 'site_1',
    });
  });

  it('writes an internal note request without an empty insight block', async () => {
    h.runTurn.mockResolvedValueOnce(RESULT);
    await assist({ isInternalNote: true, insightContext: '' });
    const parts = (h.conv.appendMessage.mock.calls[0]?.[0] as { parts: unknown[] }).parts;
    expect(parts).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('Write an internal note for support case SC-7'),
      },
    ]);
  });

  it('stops while the company provider account is paused', async () => {
    h.providerGate.mockResolvedValueOnce('paused');
    const s = stream();
    expect(
      await runSupportAssistTurn({
        ctx,
        conversation: SUPPORT,
        config: CONFIG,
        stream: s as never,
        caseContext,
        siteId: null,
        caseNumber: 'SC-7',
        driverLanguage: null,
        isInternalNote: false,
        maxToolCalls: 4,
      }),
    ).toBeNull();
    expect(s.send).toHaveBeenCalledWith({ type: 'error', code: 'AI_PROVIDER_QUOTA_EXCEEDED' });
    expect(h.conv.appendMessage).not.toHaveBeenCalled();
  });

  it('never pauses a personal key', async () => {
    h.runTurn.mockResolvedValueOnce(RESULT);
    expect(await assist({ config: { ...CONFIG, source: 'user' } })).toBe(RESULT);
    expect(h.providerGate).not.toHaveBeenCalled();
  });

  it('fails the stream when the turn throws', async () => {
    h.runTurn.mockRejectedValueOnce(new Error('x'));
    expect(await assist()).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cnv_2' }),
      'AI support assist turn failed',
    );
  });
});
