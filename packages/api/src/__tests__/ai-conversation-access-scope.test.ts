// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

const tx = vi.hoisted(() => ({
  row: undefined as { parts: unknown[]; accessScope: string | null } | undefined,
  set: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    for: () => Promise.resolve(tx.row === undefined ? [] : [tx.row]),
    update: () => ({
      set: (values: unknown) => {
        tx.set(values);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return {
    ...actual,
    db: { transaction: (fn: (t: typeof chain) => Promise<void>) => fn(chain) },
  };
});

import {
  HIDDEN_TOOL_RESULT,
  hideStaleToolResults,
  replaceToolResult,
} from '../services/ai/conversation.service.js';
import type { AiMessageRow } from '../services/ai/conversation.service.js';
import { buildScopeHash } from '../lib/access-scope.js';

function row(overrides: Partial<AiMessageRow>): AiMessageRow {
  return {
    id: 'aim_1',
    conversationId: 'aic_1',
    role: 'tool',
    parts: [],
    providerState: null,
    usage: null,
    costMicros: null,
    finishReason: null,
    accessScope: null,
    createdAt: new Date('2026-10-10T00:00:00Z'),
    ...overrides,
  };
}

const toolParts = [
  {
    type: 'tool_result',
    toolCallId: 'c1',
    name: 'list_sites',
    content: '{"name":"B"}',
    isError: false,
  },
  { type: 'text', text: 'note' },
];

describe('hideStaleToolResults', () => {
  const scope = buildScopeHash(['sit_a', 'sit_b'], ['sites:read']);

  it('keeps tool results stored under the same access', () => {
    const rows = [row({ parts: toolParts, accessScope: scope })];
    expect(hideStaleToolResults(rows, scope)).toEqual(rows);
  });

  it('hides tool results stored under another access, keeping other parts', () => {
    const narrower = buildScopeHash(['sit_a'], ['sites:read']);
    const [hidden] = hideStaleToolResults(
      [row({ parts: toolParts, accessScope: scope })],
      narrower,
    );
    expect(hidden?.parts).toEqual([
      { ...toolParts[0], content: HIDDEN_TOOL_RESULT, isError: false },
      toolParts[1],
    ]);
  });

  it('hides tool results of a row stored without a fingerprint', () => {
    const [hidden] = hideStaleToolResults([row({ parts: toolParts })], scope);
    expect(JSON.stringify(hidden?.parts)).not.toContain('"name":"B"');
  });

  it('leaves user and assistant messages without tool results alone', () => {
    const rows = [
      row({ role: 'user', parts: [{ type: 'text', text: 'hi' }] }),
      row({ role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }),
    ];
    expect(hideStaleToolResults(rows, scope)).toEqual(rows);
  });

  it('changes the fingerprint with the sites or the permissions, not their order', () => {
    expect(buildScopeHash(['sit_b', 'sit_a'], ['sites:read'])).toBe(scope);
    expect(buildScopeHash(null, ['sites:read'])).not.toBe(scope);
    expect(buildScopeHash(['sit_a', 'sit_b'], ['sites:read', 'sites:write'])).not.toBe(scope);
  });
});

describe('replaceToolResult', () => {
  const scope = buildScopeHash(['sit_a'], ['stations:write']);
  const other = {
    type: 'tool_result',
    toolCallId: 'c2',
    name: 'x',
    content: '{"site":"B"}',
    isError: false,
  };
  const pending = {
    type: 'tool_result',
    toolCallId: 'c1',
    name: 'y',
    content: '{}',
    isError: false,
  };

  it("stamps the confirming request's access scope and keeps results of the same access", async () => {
    tx.set.mockClear();
    tx.row = { parts: [pending, other], accessScope: scope };
    await replaceToolResult('aim_1', 'c1', '{"ok":true}', false, scope);
    expect(tx.set).toHaveBeenCalledWith({
      parts: [{ ...pending, content: '{"ok":true}' }, other],
      accessScope: scope,
    });
  });

  it('hides the other results of a message stored under another access', async () => {
    tx.set.mockClear();
    const wider = buildScopeHash(['sit_a', 'sit_b'], ['stations:write']);
    tx.row = { parts: [pending, other], accessScope: wider };
    await replaceToolResult('aim_1', 'c1', '{"ok":true}', false, scope);
    expect(tx.set).toHaveBeenCalledWith({
      parts: [
        { ...pending, content: '{"ok":true}' },
        { ...other, content: HIDDEN_TOOL_RESULT, isError: false },
      ],
      accessScope: scope,
    });
  });

  it('writes nothing for a missing message', async () => {
    tx.set.mockClear();
    tx.row = undefined;
    await replaceToolResult('aim_x', 'c1', '{}', false, scope);
    expect(tx.set).not.toHaveBeenCalled();
  });
});
