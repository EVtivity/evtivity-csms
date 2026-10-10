// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import type { AiStreamEvent } from '@evtivity/lib/ai-stream';
import {
  applyAiStreamEvent,
  emptyAssistantMessage,
  finishInterrupted,
  messagesFromHistory,
} from '../ai-turn';

function apply(events: AiStreamEvent[]) {
  return events.reduce(applyAiStreamEvent, emptyAssistantMessage());
}

describe('ai-turn', () => {
  it('builds an assistant message from a stream and keeps its key', () => {
    const start = emptyAssistantMessage();
    const msg = [
      {
        type: 'message_start',
        protocolVersion: 1,
        conversationId: 'c1',
        messageId: 'm1',
        provider: 'deepseek',
        model: 'deepseek-v4',
      },
      { type: 'text_delta', text: 'Let me check.' },
      { type: 'tool_step', toolCallId: 't1', name: 'get_station', status: 'running' },
      { type: 'tool_step', toolCallId: 't1', name: 'get_station', status: 'ok', durationMs: 42 },
      { type: 'text_delta', text: 'CS-1 is faulted.' },
      { type: 'citation', id: 'd1', title: 'Stations', url: 'https://evtivity.com/en/docs/csms' },
      { type: 'citation', id: 'd1', title: 'Stations', url: 'https://evtivity.com/en/docs/csms' },
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          cachedReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 5,
          reasoningTokens: 0,
        },
      },
      { type: 'done', messageId: 'm1', finish: 'end' },
    ].reduce((m, e) => applyAiStreamEvent(m, e as AiStreamEvent), start);
    expect(msg.key).toBe(start.key);
    expect(msg.id).toBe('m1');
    // Text after the tool steps starts a new paragraph.
    expect(msg.text).toBe('Let me check.\n\nCS-1 is faulted.');
    expect(msg.toolSteps).toEqual([
      { toolCallId: 't1', name: 'get_station', status: 'ok', durationMs: 42 },
    ]);
    expect(msg.citations).toHaveLength(1);
    expect(msg.usage?.outputTokens).toBe(5);
    expect(msg.finish).toBe('end');
  });

  it('keeps the confirmation event and the error code', () => {
    const msg = apply([
      {
        type: 'confirmation_required',
        actionId: 'a1',
        toolCallId: 't2',
        name: 'update_station',
        nonce: 'n'.repeat(32),
        method: 'POST',
        path: '/v1/stations/CS-1/reset',
        summary: 'Reset CS-1',
        arguments: { type: 'Soft' },
        expiresAt: '2030-01-01T00:00:00Z',
      },
      { type: 'error', code: 'AI_RATE_LIMITED' },
    ]);
    expect(msg.confirmation?.state).toBe('pending');
    expect(msg.confirmation?.event.nonce).toBe('n'.repeat(32));
    expect(msg.errorCode).toBe('AI_RATE_LIMITED');
  });

  it('marks an interrupted stream as stopped or failed', () => {
    const running = apply([
      { type: 'tool_step', toolCallId: 't1', name: 'list_sessions', status: 'running' },
    ]);
    expect(finishInterrupted(running, true).finish).toBe('stopped');
    const failed = finishInterrupted(running, false);
    expect(failed.finish).toBe('error');
    expect(failed.errorCode).toBe('AI_ERROR');
    expect(failed.toolSteps[0]?.status).toBe('error');
    const done = { ...running, finish: 'end' as const };
    expect(finishInterrupted(done, true)).toBe(done);
  });

  it('rebuilds history with tool results folded into their steps', () => {
    const views = messagesFromHistory([
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', text: 'Why is CS-1 down?' },
          { type: 'image', attachmentId: 'att1', name: 'screen.jpg' },
        ],
        finishReason: null,
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 't1', name: 'get_station' }],
        finishReason: 'tool_use',
      },
      {
        id: 'tool1',
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 't1', isError: true }],
        finishReason: null,
      },
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'It reports a fault.' }],
        finishReason: 'end',
      },
    ]);
    expect(views.map((v) => v.id)).toEqual(['u1', 'a1', 'a2']);
    expect(views[0]?.attachments).toEqual([{ id: 'att1', name: 'screen.jpg', kind: 'image' }]);
    expect(views[1]?.toolSteps[0]?.status).toBe('error');
    expect(views[1]?.finish).toBe('end');
    expect(views[2]?.text).toBe('It reports a fault.');
  });
});
