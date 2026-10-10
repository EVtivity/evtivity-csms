// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_STREAM_HEADERS,
  AI_STREAM_HEARTBEAT_FRAME,
  AI_STREAM_PROTOCOL_VERSION,
  createAiStreamParser,
  readAiStream,
} from '@evtivity/lib/ai-stream';
import type { AiStreamEvent as WireEvent } from '@evtivity/lib/ai-stream';
import { AiStreamAccumulator } from '../services/ai/core/collect.js';
import { openAiEventStream } from '../services/ai/core/sse.js';
import type { AiResult } from '../services/ai/core/types.js';
import { CONTRACT_TEST_API_KEY } from '../services/ai/__contract__/harness.js';
import {
  sseChunks,
  startMockProviderServer,
} from '../services/ai/__contract__/mock-provider-server.js';
import type { MockProviderServer } from '../services/ai/__contract__/mock-provider-server.js';
import { createWireTestAdapter } from './helpers/ai-wire-test-adapter.js';

class FakeResponse extends EventEmitter {
  status: number | null = null;
  headers: Record<string, unknown> = {};
  writes: string[] = [];
  flushed = false;
  ended = false;
  writableFinished = false;

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }
  flushHeaders(): void {
    this.flushed = true;
  }
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
    this.writableFinished = true;
    this.emit('close');
  }
  /** The client went away before the response ended. */
  disconnect(): void {
    this.emit('close');
  }
  asResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

function heartbeats(res: FakeResponse): number {
  return res.writes.filter((w) => w === AI_STREAM_HEARTBEAT_FRAME).length;
}

describe('openAiEventStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('TC-AI-S-01 writes the protocol headers and frames the client parser reads', () => {
    const res = new FakeResponse();
    const stream = openAiEventStream(res.asResponse(), { headers: { 'X-Test': '1' } });
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ ...AI_STREAM_HEADERS, 'X-Test': '1' });
    expect(res.flushed).toBe(true);

    const events: WireEvent[] = [
      {
        type: 'message_start',
        protocolVersion: AI_STREAM_PROTOCOL_VERSION,
        conversationId: 'c1',
        messageId: 'm1',
        provider: 'deepseek',
        model: 'deepseek-flash',
      },
      { type: 'text_delta', text: 'hi' },
      { type: 'done', messageId: 'm1', finish: 'end' },
    ];
    for (const event of events) expect(stream.send(event)).toBe(true);
    stream.close();

    const parser = createAiStreamParser();
    expect([...parser.feed(res.writes.join('')), ...parser.end()]).toEqual(events);
    expect(res.ended).toBe(true);
  });

  it('TC-AI-S-02 sends a heartbeat every 15 s until the stream closes', () => {
    const res = new FakeResponse();
    const stream = openAiEventStream(res.asResponse());
    vi.advanceTimersByTime(14_999);
    expect(heartbeats(res)).toBe(0);
    vi.advanceTimersByTime(1);
    expect(heartbeats(res)).toBe(1);
    stream.send({ type: 'text_delta', text: 'between beats' });
    vi.advanceTimersByTime(30_000);
    expect(heartbeats(res)).toBe(3);

    stream.close();
    vi.advanceTimersByTime(60_000);
    expect(heartbeats(res)).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('TC-AI-S-02 heartbeats do not break the event stream for the parser', () => {
    const res = new FakeResponse();
    const stream = openAiEventStream(res.asResponse(), { heartbeatIntervalMs: 1000 });
    stream.send({ type: 'text_delta', text: 'a' });
    vi.advanceTimersByTime(2000);
    stream.send({ type: 'text_delta', text: 'b' });
    stream.close();
    expect(heartbeats(res)).toBe(2);
    const parser = createAiStreamParser();
    expect(parser.feed(res.writes.join(''))).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
    ]);
  });

  it('TC-AI-S-03 a client disconnect aborts the signal, stops heartbeats and drops later writes', () => {
    const res = new FakeResponse();
    const stream = openAiEventStream(res.asResponse());
    expect(stream.signal.aborted).toBe(false);
    res.disconnect();
    expect(stream.signal.aborted).toBe(true);
    expect(stream.closed).toBe(true);
    expect(stream.send({ type: 'text_delta', text: 'late' })).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(res.writes).toEqual([]);
    expect(res.ended).toBe(false);
    // close() after a disconnect is a no-op.
    stream.close();
    expect(res.ended).toBe(false);
  });
});

describe('TC-AI-S-03 client abort over HTTP', () => {
  let provider: MockProviderServer;
  let app: Server;
  let appUrl: string;
  let saved: AiResult[];

  beforeEach(async () => {
    saved = [];
    provider = await startMockProviderServer();
    app = createServer((_req, res) => {
      const stream = openAiEventStream(res);
      const adapter = createWireTestAdapter({
        apiKey: CONTRACT_TEST_API_KEY,
        baseUrl: provider.baseUrl,
      });
      const acc = new AiStreamAccumulator();
      stream.send({
        type: 'message_start',
        protocolVersion: AI_STREAM_PROTOCOL_VERSION,
        conversationId: 'c1',
        messageId: 'm1',
        provider: adapter.provider,
        model: 'deepseek-flash',
      });
      void (async () => {
        const req = {
          model: 'deepseek-flash',
          system: [],
          messages: [],
          tools: [],
          effort: 'low' as const,
        };
        for await (const event of adapter.stream(req, stream.signal)) {
          acc.push(event);
          if (event.type === 'text_delta') stream.send({ type: 'text_delta', text: event.text });
        }
        // Stand-in for the L2 save of the (partial) assistant message.
        saved.push(acc.result());
        const result = acc.result();
        stream.send({
          type: 'done',
          messageId: 'm1',
          finish: result.finishReason === 'stopped' ? 'stopped' : 'end',
        });
        stream.close();
      })();
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    appUrl = `http://127.0.0.1:${String((app.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await provider.close();
  });

  async function readUntil(
    controller: AbortController,
    stopAfter: (events: WireEvent[]) => boolean,
  ): Promise<WireEvent[]> {
    const res = await fetch(`${appUrl}/turn`, { method: 'POST', signal: controller.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const events: WireEvent[] = [];
    try {
      for await (const event of readAiStream(res.body!)) {
        events.push(event);
        if (stopAfter(events)) controller.abort();
      }
    } catch (err) {
      if (!controller.signal.aborted) throw err;
    }
    return events;
  }

  it('TC-AI-S-03 stopping the client aborts the provider stream and keeps the partial text', async () => {
    provider.enqueue({
      headers: { 'content-type': 'text/event-stream' },
      body: [
        ...sseChunks([{ type: 'text_delta', text: 'Partial ' }]),
        ...sseChunks([{ type: 'text_delta', text: 'never sent' }], { delayMs: 5000 }),
      ],
      hang: true,
    });

    const started = Date.now();
    const events = await readUntil(new AbortController(), (evs) =>
      evs.some((e) => e.type === 'text_delta'),
    );
    expect(events.map((e) => e.type)).toEqual(['message_start', 'text_delta']);

    await provider.waitForAbort(0, 1000);
    expect(provider.requests[0]?.aborted).toBe(true);
    await vi.waitFor(() => expect(saved).toHaveLength(1), { timeout: 1000 });
    expect(saved[0]).toMatchObject({ text: 'Partial ', finishReason: 'stopped' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('TC-AI-S-03 without an abort the turn completes and the provider request ends normally', async () => {
    provider.enqueue({
      headers: { 'content-type': 'text/event-stream' },
      body: sseChunks(
        [
          { type: 'text_delta', text: 'Hello' },
          { type: 'finish', reason: 'end' },
        ],
        { delayMs: 5 },
      ),
    });
    const events = await readUntil(new AbortController(), () => false);
    expect(events.map((e) => e.type)).toEqual(['message_start', 'text_delta', 'done']);
    expect(events.at(-1)).toEqual({ type: 'done', messageId: 'm1', finish: 'end' });
    expect(provider.requests[0]?.aborted).toBe(false);
    expect(saved[0]).toMatchObject({ text: 'Hello', finishReason: 'end' });
    expect(provider.requests[0]?.headers.authorization).toBe(`Bearer ${CONTRACT_TEST_API_KEY}`);
  });
});
