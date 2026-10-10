// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  AI_STREAM_EVENT_TYPES,
  AI_STREAM_HEARTBEAT_FRAME,
  AI_STREAM_HEARTBEAT_INTERVAL_MS,
  AI_STREAM_PROTOCOL_VERSION,
  AiStreamProtocolError,
  aiStreamEventSchema,
  createAiStreamParser,
  formatAiStreamEvent,
  readAiStream,
} from '../ai-stream.js';
import type { AiStreamEvent } from '../ai-stream.js';

const SAMPLE_EVENTS: AiStreamEvent[] = [
  {
    type: 'message_start',
    protocolVersion: AI_STREAM_PROTOCOL_VERSION,
    conversationId: 'conv_1',
    messageId: 'msg_1',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
  },
  { type: 'text_delta', text: 'Hello, ' },
  { type: 'text_delta', text: 'line one\nline two "quoted" é中🚀' },
  {
    type: 'tool_step',
    toolCallId: 'call_1',
    name: 'list_stations',
    status: 'ok',
    summary: '3 stations',
    durationMs: 42,
  },
  {
    type: 'confirmation_required',
    actionId: 'act_1',
    toolCallId: 'call_2',
    name: 'update_station',
    nonce: 'n0nce-0123456789abcdef',
    method: 'POST',
    path: '/v1/stations/abc/reset',
    summary: 'Reset station abc',
    arguments: { type: 'Soft', nested: { a: [1, 2] } },
    expiresAt: '2026-10-09T12:00:00.000Z',
  },
  {
    type: 'citation',
    id: 'doc:1',
    title: 'Stations',
    url: 'https://evtivity.com/en/docs/csms/stations',
    anchor: 'reset',
  },
  {
    type: 'usage',
    usage: {
      inputTokens: 120,
      cachedReadTokens: 100,
      cacheWriteTokens: 0,
      outputTokens: 30,
      reasoningTokens: 5,
      costMicros: 812,
    },
  },
  { type: 'error', code: 'AI_ERROR', message: 'The AI request failed' },
  { type: 'done', messageId: 'msg_1', finish: 'end' },
];

function parseAll(text: string, chunkSize?: number): AiStreamEvent[] {
  const parser = createAiStreamParser();
  const out: AiStreamEvent[] = [];
  if (chunkSize === undefined) {
    out.push(...parser.feed(text));
  } else {
    for (let i = 0; i < text.length; i += chunkSize) {
      out.push(...parser.feed(text.slice(i, i + chunkSize)));
    }
  }
  out.push(...parser.end());
  return out;
}

describe('TC-AI-S-01 stream event schema round trip', () => {
  it('TC-AI-S-01 the samples cover every event type', () => {
    expect(new Set(SAMPLE_EVENTS.map((e) => e.type))).toEqual(new Set(AI_STREAM_EVENT_TYPES));
  });

  it('TC-AI-S-01 writer output parses back to the same events', () => {
    const wire = SAMPLE_EVENTS.map(formatAiStreamEvent).join('');
    expect(parseAll(wire)).toEqual(SAMPLE_EVENTS);
  });

  it('TC-AI-S-01 each frame is one event line, one data line and a blank line', () => {
    for (const event of SAMPLE_EVENTS) {
      const frame = formatAiStreamEvent(event);
      expect(frame.endsWith('\n\n')).toBe(true);
      const lines = frame.slice(0, -2).split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(`event: ${event.type}`);
      expect(lines[1]?.startsWith('data: ')).toBe(true);
    }
  });

  it('TC-AI-S-01 chunks split at any position parse the same', () => {
    const wire = SAMPLE_EVENTS.map(formatAiStreamEvent).join('');
    for (const size of [1, 2, 3, 7, 64]) {
      expect(parseAll(wire, size)).toEqual(SAMPLE_EVENTS);
    }
  });

  it('TC-AI-S-01 CRLF and CR line ends, including a CRLF split across chunks', () => {
    const lf = SAMPLE_EVENTS.map(formatAiStreamEvent).join('');
    expect(parseAll(lf.replace(/\n/g, '\r\n'))).toEqual(SAMPLE_EVENTS);
    expect(parseAll(lf.replace(/\n/g, '\r'))).toEqual(SAMPLE_EVENTS);
    expect(parseAll(lf.replace(/\n/g, '\r\n'), 1)).toEqual(SAMPLE_EVENTS);
  });

  it('TC-AI-S-01 heartbeats, comments, id and retry fields are skipped', () => {
    const wire =
      AI_STREAM_HEARTBEAT_FRAME +
      ': another comment\n\n' +
      'id: 7\nretry: 1000\n' +
      formatAiStreamEvent({ type: 'text_delta', text: 'x' }) +
      AI_STREAM_HEARTBEAT_FRAME;
    expect(parseAll(wire)).toEqual([{ type: 'text_delta', text: 'x' }]);
  });

  it('TC-AI-S-01 multi-line data is joined with a newline', () => {
    const wire = 'event: text_delta\ndata: {"type":"text_delta",\ndata: "text":"a"}\n\n';
    expect(parseAll(wire)).toEqual([{ type: 'text_delta', text: 'a' }]);
  });

  it('TC-AI-S-01 a final frame without a blank line is flushed by end()', () => {
    const frame = formatAiStreamEvent({ type: 'text_delta', text: 'tail' }).trimEnd();
    expect(parseAll(frame)).toEqual([{ type: 'text_delta', text: 'tail' }]);
  });

  it('TC-AI-S-01 invalid frames throw AiStreamProtocolError', () => {
    const bad = [
      'data: {not json}\n\n',
      'data: {"type":"nope"}\n\n',
      'data: {"type":"text_delta"}\n\n',
      'data: {"type":"text_delta","text":"a","extra":1}\n\n',
      'event: done\ndata: {"type":"text_delta","text":"a"}\n\n',
      'data: {"type":"error","code":"lower_case"}\n\n',
      'data: {"type":"citation","id":"1","title":"t","url":"http://evtivity.com/x"}\n\n',
    ];
    for (const frame of bad) {
      expect(() => parseAll(frame), frame).toThrow(AiStreamProtocolError);
    }
  });

  it('TC-AI-S-01 the writer refuses an event that is not valid protocol', () => {
    expect(() =>
      formatAiStreamEvent({ type: 'text_delta', text: 1 } as unknown as AiStreamEvent),
    ).toThrow();
    expect(() =>
      formatAiStreamEvent({
        type: 'confirmation_required',
        actionId: 'a',
        toolCallId: 'b',
        name: 'update_station',
        nonce: 'short',
        method: 'GET',
        path: '/x',
        summary: 's',
        arguments: {},
        expiresAt: 'tomorrow',
      } as unknown as AiStreamEvent),
    ).toThrow();
  });

  it('TC-AI-S-01 readAiStream decodes a byte stream with UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode(SAMPLE_EVENTS.map(formatAiStreamEvent).join(''));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // One byte per chunk splits every multi-byte character.
        for (const b of bytes) controller.enqueue(new Uint8Array([b]));
        controller.close();
      },
    });
    const events: AiStreamEvent[] = [];
    for await (const event of readAiStream(body)) events.push(event);
    expect(events).toEqual(SAMPLE_EVENTS);
  });

  it('TC-AI-S-02 heartbeat constants: comment frame, under a 60 s proxy idle timeout', () => {
    expect(AI_STREAM_HEARTBEAT_FRAME.startsWith(':')).toBe(true);
    expect(AI_STREAM_HEARTBEAT_FRAME.endsWith('\n\n')).toBe(true);
    expect(AI_STREAM_HEARTBEAT_INTERVAL_MS).toBe(15_000);
  });

  it('schema exposes the discriminated union for client-side narrowing', () => {
    const parsed = aiStreamEventSchema.parse({ type: 'done', messageId: 'm', finish: 'stopped' });
    expect(parsed.type).toBe('done');
  });
});
