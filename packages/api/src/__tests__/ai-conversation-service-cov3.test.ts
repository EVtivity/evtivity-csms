// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiArgsHash } from '@evtivity/lib';

const h = vi.hoisted(() => ({
  selects: [] as unknown[][],
  updates: [] as unknown[][],
  inserts: [] as unknown[][],
  sets: [] as Record<string, unknown>[],
  values: [] as Record<string, unknown>[],
  calls: [] as { method: string; args: unknown[] }[],
  writeAudit: vi.fn(),
}));

function chain(queue: () => unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'returning', 'for']) {
    c[m] = vi.fn((...args: unknown[]) => {
      h.calls.push({ method: m, args });
      return c;
    });
  }
  c['set'] = vi.fn((v: Record<string, unknown>) => {
    h.sets.push(v);
    return c;
  });
  c['values'] = vi.fn((v: Record<string, unknown>) => {
    h.values.push(v);
    return c;
  });
  c['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve(queue()).then(resolve, reject);
  return c;
}

vi.mock('@evtivity/database', () => {
  const db = {
    select: vi.fn(() => chain(() => h.selects.shift() ?? [])),
    insert: vi.fn(() => chain(() => h.inserts.shift() ?? [])),
    update: vi.fn(() => chain(() => h.updates.shift() ?? [])),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return {
    db,
    aiConversations: {},
    aiMessages: {},
    aiToolCalls: {},
    aiPendingActions: {},
    aiConversationAuditLog: { name: 'audit' },
    writeAudit: h.writeAudit,
  };
});

import {
  HIDDEN_ASSISTANT_TEXT,
  HIDDEN_TOOL_RESULT,
  INTERRUPTED_ACTION_RESULT,
  MAX_TITLE_LENGTH,
  PENDING_ACTION_TTL_MS,
  appendMessage,
  auditAttachmentsAdded,
  auditDecision,
  claimTurn,
  completeToolCall,
  createConversation,
  createPendingAction,
  decidePendingAction,
  deleteConversation,
  getConversation,
  interruptConfirmedAction,
  listConversations,
  listMessages,
  recordToolCall,
  releaseTurn,
  renameConversation,
  replaceToolResult,
  setTitleIfEmpty,
  supersedePendingActions,
  toAiMessages,
} from '../services/ai/conversation.service.js';
import type {
  AiConversationRow,
  AiMessageRow,
  AiPendingActionRow,
} from '../services/ai/conversation.service.js';

const ACTOR = { actor: 'operator' as const, actorUserId: 'usr_1' };
const log = { warn: vi.fn() };

beforeEach(() => {
  h.selects = [];
  h.updates = [];
  h.inserts = [];
  h.sets = [];
  h.values = [];
  h.calls = [];
});

function auditCall(i = 0): Record<string, unknown> {
  return (h.writeAudit.mock.calls[i] as unknown[])[1] as Record<string, unknown>;
}

const CONV = {
  id: 'cnv_1',
  userId: 'usr_1',
  surface: 'chatbot',
  supportCaseId: null,
  title: 'Old',
  contextKind: null,
  contextId: null,
} as unknown as AiConversationRow;

describe('conversations', () => {
  it('creates a conversation with a capped title and audits it', async () => {
    h.inserts = [[{ ...CONV, title: 'x'.repeat(MAX_TITLE_LENGTH) }]];
    const row = await createConversation(
      { userId: 'usr_1', surface: 'chatbot', provider: 'p', model: 'm', title: 'x'.repeat(300) },
      ACTOR,
      log,
    );
    expect(row.id).toBe('cnv_1');
    expect(h.values[0]).toMatchObject({
      userId: 'usr_1',
      surface: 'chatbot',
      supportCaseId: null,
      provider: 'p',
      model: 'm',
      title: 'x'.repeat(MAX_TITLE_LENGTH),
      contextKind: null,
      contextId: null,
    });
    expect(auditCall()).toMatchObject({
      entityId: 'cnv_1',
      action: 'created',
      actor: 'operator',
      actorUserId: 'usr_1',
      after: { surface: 'chatbot', supportCaseId: null, title: 'x'.repeat(MAX_TITLE_LENGTH) },
      notes: null,
      viaAi: null,
    });
    expect(h.writeAudit.mock.calls[0]?.[3]).toBe(log);
  });

  it('stores and audits the Explain context', async () => {
    h.inserts = [[{ ...CONV, title: '', contextKind: 'station', contextId: 'sta_1' }]];
    await createConversation(
      {
        userId: 'usr_1',
        surface: 'chatbot',
        provider: 'p',
        model: 'm',
        context: { kind: 'station', id: 'sta_1' },
      },
      ACTOR,
    );
    expect(h.values[0]).toMatchObject({ title: '', contextKind: 'station', contextId: 'sta_1' });
    expect(auditCall()['after']).toMatchObject({ contextKind: 'station', contextId: 'sta_1' });
  });

  it('throws when the insert returns no row', async () => {
    await expect(
      createConversation({ userId: 'u', surface: 'chatbot', provider: 'p', model: 'm' }, ACTOR),
    ).rejects.toThrow('ai_conversations insert returned no row');
  });

  it("gets the user's conversation or null", async () => {
    h.selects = [[CONV]];
    expect(await getConversation('usr_1', 'cnv_1', 'chatbot')).toBe(CONV);
    expect(await getConversation('usr_1', 'cnv_2', 'chatbot')).toBeNull();
  });

  it('lists a page with its total, with and without a search', async () => {
    h.selects = [[CONV], [{ total: 7 }]];
    expect(await listConversations('usr_1', { page: 3, limit: 10, search: ' 50%_ ' })).toEqual({
      data: [CONV],
      total: 7,
    });
    const offset = h.calls.find((c) => c.method === 'offset');
    expect(offset?.args).toEqual([20]);
    h.selects = [[], []];
    expect(await listConversations('usr_1', { page: 1, limit: 10, search: '  ' })).toEqual({
      data: [],
      total: 0,
    });
  });

  it('renames and audits before and after, keeping the row when the update returns none', async () => {
    h.updates = [[{ ...CONV, title: 'New' }]];
    expect((await renameConversation(CONV, 'New', ACTOR)).title).toBe('New');
    expect(auditCall()).toMatchObject({
      action: 'renamed',
      before: { title: 'Old' },
      after: { title: 'New' },
    });
    expect(await renameConversation(CONV, 'y'.repeat(300), ACTOR)).toBe(CONV);
    expect(h.sets[1]?.['title']).toHaveLength(MAX_TITLE_LENGTH);
  });

  it('hides a deleted conversation and audits it', async () => {
    await deleteConversation(CONV, ACTOR);
    expect(h.sets[0]?.['deletedAt']).toBeInstanceOf(Date);
    expect(auditCall()).toMatchObject({ action: 'deleted', before: { title: 'Old' } });
  });
});

describe('turn lease', () => {
  it('claims when the update matches and refuses otherwise', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    h.updates = [[{ id: 'cnv_1' }], []];
    expect(await claimTurn('cnv_1', now)).toBe(true);
    expect(h.sets[0]).toEqual({ turnStartedAt: now });
    expect(await claimTurn('cnv_1', now)).toBe(false);
  });

  it('releases the lease with or without the provider and model', async () => {
    await releaseTurn('cnv_1', { provider: 'p', model: 'm' });
    expect(h.sets[0]).toMatchObject({ turnStartedAt: null, provider: 'p', model: 'm' });
    await releaseTurn('cnv_1', null);
    expect(h.sets[1]).not.toHaveProperty('provider');
  });

  it('sets a capped title', async () => {
    await setTitleIfEmpty('cnv_1', 'z'.repeat(250));
    expect(h.sets[0]?.['title']).toHaveLength(MAX_TITLE_LENGTH);
  });
});

function msg(over: Partial<AiMessageRow>): AiMessageRow {
  return {
    id: 'm',
    conversationId: 'cnv_1',
    role: 'tool',
    parts: [],
    providerState: null,
    accessScope: 'A',
    ...over,
  } as unknown as AiMessageRow;
}

describe('messages', () => {
  const toolMsg = msg({
    id: 'm1',
    role: 'tool',
    accessScope: 'B',
    parts: [
      { type: 'tool_result', toolCallId: 't1', name: 'n', content: 'secret', isError: false },
      { type: 'text', text: 'note' },
    ],
  });
  const assistant = msg({
    id: 'm2',
    role: 'assistant',
    accessScope: 'B',
    providerState: { x: 1 },
    parts: [
      { type: 'text', text: 'quote' },
      { type: 'tool_call', toolCallId: 't1', name: 'n', args: {} },
    ],
  });
  const plainUser = msg({
    id: 'm3',
    role: 'user',
    accessScope: null,
    parts: [{ type: 'text', text: 'hi' }],
  });
  const sameScope = msg({
    id: 'm4',
    role: 'assistant',
    accessScope: 'A',
    parts: [{ type: 'text', text: 'ok' }],
  });
  const otherToolNoResults = msg({ id: 'm5', role: 'assistant', accessScope: 'B', parts: [] });

  it('hides tool results of another access for a session reader', async () => {
    h.selects = [[toolMsg, assistant, plainUser, sameScope]];
    const rows = await listMessages('cnv_1', 'A');
    expect(rows[0]?.parts).toEqual([
      {
        type: 'tool_result',
        toolCallId: 't1',
        name: 'n',
        content: HIDDEN_TOOL_RESULT,
        isError: false,
      },
      { type: 'text', text: 'note' },
    ]);
    expect(rows[1]).toBe(assistant);
    expect(rows[2]).toBe(plainUser);
    expect(rows[3]).toBe(sameScope);
  });

  it('also hides assistant text of another access for an API key', async () => {
    h.selects = [[assistant, sameScope, otherToolNoResults, toolMsg]];
    const rows = await listMessages('cnv_1', 'A', { isApiKey: true });
    expect(rows[0]?.parts).toEqual([
      { type: 'text', text: HIDDEN_ASSISTANT_TEXT },
      { type: 'tool_call', toolCallId: 't1', name: 'n', args: {} },
    ]);
    expect(rows[0]?.providerState).toBeNull();
    expect(rows[1]).toBe(sameScope);
    expect(rows[2]).toBe(otherToolNoResults);
    expect(rows[3]?.role).toBe('tool');
  });

  it('converts rows to model messages with their provider state', () => {
    expect(toAiMessages([assistant, plainUser])).toEqual([
      { role: 'assistant', parts: assistant.parts, providerState: { x: 1 } },
      { role: 'user', parts: plainUser.parts },
    ]);
  });

  it('appends a message with defaults and a given id', async () => {
    const id = await appendMessage({ conversationId: 'cnv_1', role: 'user', parts: [] });
    expect(typeof id).toBe('string');
    expect(h.values[0]).toMatchObject({
      id,
      conversationId: 'cnv_1',
      role: 'user',
      providerState: null,
      usage: null,
      costMicros: null,
      finishReason: null,
      accessScope: null,
    });
    expect(
      await appendMessage({
        id: 'msg_x',
        conversationId: 'cnv_1',
        role: 'assistant',
        parts: [],
        usage: { inputTokens: 1, outputTokens: 2 } as never,
        costMicros: 5,
        finishReason: 'stop',
        accessScope: 'A',
      }),
    ).toBe('msg_x');
    expect(h.values[1]).toMatchObject({ costMicros: 5, finishReason: 'stop', accessScope: 'A' });
  });

  it('replaces one tool result and keeps the others under the same access', async () => {
    h.selects = [
      [
        {
          accessScope: 'A',
          parts: [
            { type: 'tool_result', toolCallId: 't1', name: 'n', content: 'old', isError: false },
            { type: 'tool_result', toolCallId: 't2', name: 'n', content: 'keep', isError: false },
            { type: 'text', text: 'x' },
          ],
        },
      ],
    ];
    await replaceToolResult('m1', 't1', 'new', true, 'A');
    expect(h.sets[0]).toEqual({
      accessScope: 'A',
      parts: [
        { type: 'tool_result', toolCallId: 't1', name: 'n', content: 'new', isError: true },
        { type: 'tool_result', toolCallId: 't2', name: 'n', content: 'keep', isError: false },
        { type: 'text', text: 'x' },
      ],
    });
  });

  it('hides the other tool results when the access changed', async () => {
    h.selects = [
      [
        {
          accessScope: 'B',
          parts: [
            { type: 'tool_result', toolCallId: 't1', name: 'n', content: 'old', isError: false },
            { type: 'tool_result', toolCallId: 't2', name: 'n', content: 'other', isError: false },
          ],
        },
      ],
    ];
    await replaceToolResult('m1', 't1', 'new', false, 'A');
    const parts = h.sets[0]?.['parts'] as { content: string }[];
    expect(parts.map((p) => p.content)).toEqual(['new', HIDDEN_TOOL_RESULT]);
  });

  it('does nothing for a missing tool message', async () => {
    await replaceToolResult('gone', 't1', 'new', false, 'A');
    expect(h.sets).toHaveLength(0);
  });
});

describe('tool calls', () => {
  it('records a tool call and audits it via AI', async () => {
    const id = await recordToolCall(
      {
        conversationId: 'cnv_1',
        messageId: 'm1',
        toolCallId: 't1',
        name: 'getStation',
        operationId: 'getStation',
        method: 'GET',
        path: '/v1/stations/x',
        args: { id: 'x' },
        status: 'ok',
      },
      ACTOR,
    );
    expect(h.values[0]).toMatchObject({ id, toolCallId: 't1', status: 'ok' });
    expect(auditCall()).toMatchObject({
      action: 'tool_called',
      after: { name: 'getStation', method: 'GET', status: 'ok', args: { id: 'x' } },
      viaAi: { channel: 'chat', conversationId: 'cnv_1', toolCallId: id },
    });
  });

  it('completes a tool call with defaults', async () => {
    await completeToolCall('tc_1', { status: 'error' });
    expect(h.sets[0]).toEqual({
      status: 'error',
      httpStatus: null,
      latencyMs: null,
      redactionCounts: null,
    });
    await completeToolCall('tc_1', { status: 'ok', httpStatus: 200, latencyMs: 12 });
    expect(h.sets[1]).toMatchObject({ httpStatus: 200, latencyMs: 12 });
  });
});

describe('pending actions', () => {
  const NOW = new Date('2026-01-01T00:00:00Z');
  const ARGS = { stationId: 'CS-1' };

  function action(nonce: string, over: Partial<AiPendingActionRow> = {}): AiPendingActionRow {
    return {
      id: 'act_1',
      conversationId: 'cnv_1',
      toolCallRowId: 'tc_1',
      toolMessageId: 'm1',
      toolCallId: 't1',
      operationId: 'ocppv21_Reset',
      args: ARGS,
      argsHash: aiArgsHash(ARGS),
      nonceHash: createHash('sha256').update(nonce).digest('hex'),
      status: 'pending',
      expiresAt: new Date(NOW.getTime() + 1000),
      ...over,
    } as unknown as AiPendingActionRow;
  }

  it('creates an action with a hashed nonce and its expiry', async () => {
    const out = await createPendingAction({
      conversationId: 'cnv_1',
      toolCallRowId: 'tc_1',
      toolMessageId: 'm1',
      toolCallId: 't1',
      operationId: 'op',
      args: ARGS,
      now: NOW,
    });
    expect(out.expiresAt).toEqual(new Date(NOW.getTime() + PENDING_ACTION_TTL_MS));
    expect(h.values[0]).toMatchObject({
      id: out.actionId,
      argsHash: aiArgsHash(ARGS),
      nonceHash: createHash('sha256').update(out.nonce).digest('hex'),
      expiresAt: out.expiresAt,
    });
    const later = await createPendingAction({
      conversationId: 'c',
      toolCallRowId: 't',
      toolMessageId: 'm',
      toolCallId: 't',
      operationId: 'op',
      args: {},
    });
    expect(later.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  function decide(nonce: string): ReturnType<typeof decidePendingAction> {
    return decidePendingAction({
      conversationId: 'cnv_1',
      actionId: 'act_1',
      nonce,
      decision: 'confirmed',
      now: NOW,
    });
  }

  it('is not found for an unknown action or a wrong nonce', async () => {
    expect(await decide('n')).toEqual({ kind: 'not_found' });
    h.selects = [[action('right')]];
    expect(await decide('wrong')).toEqual({ kind: 'not_found' });
    h.selects = [[{ ...action('n'), nonceHash: 'abcd' }]];
    expect(await decide('n')).toEqual({ kind: 'not_found' });
  });

  it('answers already, expired or invalid from the stored status', async () => {
    h.selects = [[action('n', { status: 'confirmed' })]];
    expect((await decide('n')).kind).toBe('already');
    h.selects = [[action('n', { status: 'expired' })]];
    expect((await decide('n')).kind).toBe('expired');
    h.selects = [[action('n', { status: 'superseded' })]];
    expect(await decide('n')).toEqual({ kind: 'invalid' });
  });

  it('expires an action past its time', async () => {
    h.selects = [[action('n', { expiresAt: NOW })]];
    expect((await decide('n')).kind).toBe('expired');
    expect(h.sets[0]).toEqual({ status: 'expired', decidedAt: NOW });
  });

  it('refuses an action whose stored arguments changed', async () => {
    h.selects = [[action('n', { args: { stationId: 'OTHER' } })]];
    expect(await decide('n')).toEqual({ kind: 'invalid' });
  });

  it('decides a pending action', async () => {
    const decided = action('n', { status: 'confirmed' });
    h.selects = [[action('n')]];
    h.updates = [[decided]];
    expect(await decide('n')).toEqual({ kind: 'decided', action: decided });
    expect(h.sets[0]).toEqual({ status: 'confirmed', decidedAt: NOW });
  });

  it('reads the winner when another request decided first', async () => {
    h.selects = [[action('n')], [action('n', { status: 'confirmed' })]];
    h.updates = [[]];
    expect((await decide('n')).kind).toBe('already');
    h.selects = [[action('n')], [action('n', { status: 'rejected' })]];
    h.updates = [[]];
    expect(await decide('n')).toEqual({ kind: 'invalid' });
  });

  it('supersedes the open actions', async () => {
    h.updates = [[action('n', { status: 'superseded' })]];
    expect(await supersedePendingActions('cnv_1')).toHaveLength(1);
    expect(h.sets[0]?.['status']).toBe('superseded');
  });

  it('interrupts a confirmed action once', async () => {
    h.updates = [[]];
    expect(await interruptConfirmedAction(action('n'), 'A')).toBe(false);
    h.updates = [[{ id: 'tc_1' }]];
    h.selects = [
      [
        {
          accessScope: 'A',
          parts: [
            { type: 'tool_result', toolCallId: 't1', name: 'n', content: 'p', isError: false },
          ],
        },
      ],
    ];
    expect(await interruptConfirmedAction(action('n'), 'A')).toBe(true);
    expect(h.sets[1]).toEqual({ status: 'error' });
    expect(h.sets[2]?.['parts']).toEqual([
      {
        type: 'tool_result',
        toolCallId: 't1',
        name: 'n',
        content: INTERRUPTED_ACTION_RESULT,
        isError: true,
      },
    ]);
  });

  it('audits decisions and attachments', async () => {
    await auditDecision(action('n'), 'confirmed', ACTOR);
    await auditDecision(action('n'), 'rejected', ACTOR);
    expect(auditCall(0)).toMatchObject({
      action: 'action_confirmed',
      after: { actionId: 'act_1', operationId: 'ocppv21_Reset' },
      viaAi: { channel: 'chat', conversationId: 'cnv_1', toolCallId: 'tc_1' },
    });
    expect(auditCall(1)['action']).toBe('action_rejected');
    await auditAttachmentsAdded(
      'cnv_1',
      [
        { id: 'a1', fileName: 'f', contentType: 'image/png' },
        { id: 'a2', fileName: 'g', contentType: 'text/plain' },
      ],
      ACTOR,
    );
    expect(auditCall(2)).toMatchObject({
      action: 'attachment_added',
      after: { attachmentId: 'a1', fileName: 'f', contentType: 'image/png' },
    });
    expect(auditCall(3)['after']).toMatchObject({ attachmentId: 'a2' });
  });
});
