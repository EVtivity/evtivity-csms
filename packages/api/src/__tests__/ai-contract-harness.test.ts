// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTRACT_TEST_API_KEY,
  contractCaseApplies,
  contractTestName,
  createScriptedAdapter,
  runAdapterStream,
  runContractCase,
  streamProblems,
} from '../services/ai/__contract__/harness.js';
import type { ContractCase, ContractTarget } from '../services/ai/__contract__/harness.js';
import {
  loadWireFixture,
  sseChunks,
  startMockProviderServer,
} from '../services/ai/__contract__/mock-provider-server.js';
import type {
  MockProviderServer,
  WireFixture,
} from '../services/ai/__contract__/mock-provider-server.js';
import { AiProviderError } from '../services/ai/core/errors.js';
import type { AiStreamEvent } from '../services/ai/core/types.js';
import { createWireTestAdapter } from './helpers/ai-wire-test-adapter.js';

const TEXT_STREAM: AiStreamEvent[] = [
  { type: 'text_delta', text: 'Hi' },
  {
    type: 'usage',
    usage: {
      inputTokens: 5,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
  },
  { type: 'finish', reason: 'end' },
];

const target: ContractTarget = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  createAdapter: (options) => createWireTestAdapter(options),
  fixtures: {
    text: { headers: { 'content-type': 'text/event-stream' }, body: sseChunks(TEXT_STREAM) },
    twoTurns: [
      { body: sseChunks(TEXT_STREAM) },
      {
        body: sseChunks([
          { type: 'text_delta', text: 'again' },
          { type: 'finish', reason: 'end' },
        ]),
      },
    ],
    slow: {
      body: [
        ...sseChunks([{ type: 'text_delta', text: 'a' }]),
        ...sseChunks([{ type: 'text_delta', text: 'b' }], { delayMs: 5000 }),
      ],
      hang: true,
    },
    unauthorized: {
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: `invalid key ${CONTRACT_TEST_API_KEY}` }),
    },
  },
};

describe('mock provider server', () => {
  let server: MockProviderServer;
  beforeEach(async () => {
    server = await startMockProviderServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it('serves queued fixtures in order and records requests', async () => {
    server.enqueue({ body: 'one' }, { status: 201, headers: { 'x-a': 'b' }, body: 'two' });
    const r1 = await fetch(`${server.baseUrl}/v1/x?y=1`, {
      method: 'POST',
      headers: { 'X-Api-Key': 'k' },
      body: '{"a":1}',
    });
    expect(await r1.text()).toBe('one');
    const r2 = await fetch(`${server.baseUrl}/v1/z`);
    expect(r2.status).toBe(201);
    expect(r2.headers.get('x-a')).toBe('b');
    expect(await r2.text()).toBe('two');
    expect(server.requests.map((r) => [r.method, r.url, r.path])).toEqual([
      ['POST', '/v1/x?y=1', '/v1/x'],
      ['GET', '/v1/z', '/v1/z'],
    ]);
    expect(server.requests[0]?.headers['x-api-key']).toBe('k');
    expect(server.requests[0]?.body).toBe('{"a":1}');
    expect(server.lastRequest().path).toBe('/v1/z');
  });

  it('answers 500 when nothing is queued', async () => {
    const res = await fetch(`${server.baseUrl}/v1/x`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('no fixture queued');
  });

  it('a handler overrides the queue; reset clears everything', async () => {
    server.enqueue({ body: 'queued' });
    server.setHandler((req) => ({ body: `echo ${req.path}` }));
    expect(await (await fetch(`${server.baseUrl}/p`)).text()).toBe('echo /p');
    server.reset();
    expect(server.requests).toHaveLength(0);
    expect((await fetch(`${server.baseUrl}/p`)).status).toBe(500);
  });

  it('streams chunks with delays and notices a client abort', async () => {
    server.enqueue(target.fixtures.slow as WireFixture);
    const controller = new AbortController();
    const res = await fetch(`${server.baseUrl}/s`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"a"');
    controller.abort();
    await server.waitForAbort();
    expect(server.requests[0]?.aborted).toBe(true);
  });

  it('waitForAbort rejects when the request is not aborted in time', async () => {
    server.enqueue({ body: 'done' });
    await (await fetch(`${server.baseUrl}/x`)).text();
    await expect(server.waitForAbort(0, 50)).rejects.toThrow(/not aborted/);
  });

  it('loads a recorded fixture file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-fixture-'));
    try {
      const file = path.join(dir, 'f.json');
      await writeFile(file, JSON.stringify({ status: 200, body: [{ data: 'x' }] }));
      expect(await loadWireFixture(file)).toEqual({ status: 200, body: [{ data: 'x' }] });
      await writeFile(file, JSON.stringify({ status: 200 }));
      await expect(loadWireFixture(file)).rejects.toThrow(/no body/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sseChunks builds data frames with optional event names and delays', () => {
    expect(sseChunks([{ a: 1 }, 'raw'], { delayMs: 3, event: () => 'e' })).toEqual([
      { data: 'event: e\ndata: {"a":1}\n\n', delayMs: 3 },
      { data: 'event: e\ndata: raw\n\n', delayMs: 3 },
    ]);
  });
});

describe('contract harness', () => {
  it('names tests with the TC-AI- case id', () => {
    expect(contractTestName({ id: 'P-01', title: 'plain text', run: async () => {} })).toBe(
      'TC-AI-P-01 plain text',
    );
  });

  it('runs a case against the mock server with the queued fixtures and the test key', async () => {
    let ran = false;
    const c: ContractCase = {
      id: 'P-01',
      title: 'plain text',
      fixtures: ['text'],
      async run(ctx) {
        expect(ctx.mode).toBe('fixture');
        expect(ctx.capabilities.vision).not.toBe(false);
        const run = await ctx.run(ctx.request());
        expect(run.error).toBeNull();
        expect(streamProblems(run.events)).toEqual([]);
        expect(run.result).toMatchObject({ text: 'Hi', finishReason: 'end' });
        const [req] = ctx.requests();
        expect(req?.headers.authorization).toBe(`Bearer ${CONTRACT_TEST_API_KEY}`);
        expect(JSON.parse(req!.body)).toMatchObject({ model: 'deepseek-flash', effort: 'low' });
        ran = true;
      },
    };
    await runContractCase(target, c);
    expect(ran).toBe(true);
  });

  it('serves a fixture list one response per request', async () => {
    await runContractCase(target, {
      id: 'P-04',
      title: 'two turns',
      fixtures: ['twoTurns'],
      async run(ctx) {
        expect((await ctx.complete(ctx.request())).text).toBe('Hi');
        expect((await ctx.complete(ctx.request())).text).toBe('again');
        expect(ctx.requests()).toHaveLength(2);
      },
    });
  });

  it('measures abort-to-end and returns the partial result', async () => {
    await runContractCase(target, {
      id: 'P-12',
      title: 'abort',
      fixtures: ['slow'],
      async run(ctx) {
        const run = await ctx.run(ctx.request(), { abortAfterEvents: 1 });
        expect(run.aborted).toBe(true);
        expect(run.timedOut).toBe(false);
        expect(run.abortToEndMs).toBeLessThan(1000);
        expect(run.result).toMatchObject({ text: 'a', finishReason: 'stopped' });
        expect(streamProblems(run.events)).toEqual([]);
        await ctx.server!.waitForAbort(0, 1000);
      },
    });
  });

  it('times out a stream that never ends', async () => {
    await runContractCase(target, {
      id: 'X',
      title: 'timeout',
      fixtures: ['slow'],
      async run(ctx) {
        const run = await ctx.run(ctx.request(), { timeoutMs: 100 });
        expect(run.timedOut).toBe(true);
        expect(run.aborted).toBe(true);
      },
    });
  });

  it('records a provider error in the run instead of throwing, without the key', async () => {
    await runContractCase(target, {
      id: 'P-11',
      title: 'auth error',
      fixtures: ['unauthorized'],
      async run(ctx) {
        const run = await ctx.run(ctx.request());
        expect(run.error).toBeInstanceOf(AiProviderError);
        expect((run.error as AiProviderError).code).toBe('auth');
        expect((run.error as AiProviderError).message).not.toContain(CONTRACT_TEST_API_KEY);
      },
    });
  });

  it('fails a case that names an unknown fixture', async () => {
    await expect(
      runContractCase(target, { id: 'X', title: 'x', fixtures: ['nope'], run: async () => {} }),
    ).rejects.toThrow(/no contract fixture named "nope"/);
  });

  it('skips cases by capability and in live mode unless marked live', async () => {
    const needsPdf: ContractCase = {
      id: 'P-07',
      title: 'pdf',
      requires: (caps) => caps.documents.pdf !== false,
      run: () => Promise.reject(new Error('must not run')),
    };
    expect(contractCaseApplies(target, needsPdf)).toBe(false);
    await runContractCase(target, needsPdf);

    const fixtureOnly: ContractCase = { id: 'P-13', title: 'cache', run: async () => {} };
    expect(contractCaseApplies(target, fixtureOnly, { live: { apiKey: 'k' } })).toBe(false);
    expect(
      contractCaseApplies(target, { ...fixtureOnly, live: true }, { live: { apiKey: 'k' } }),
    ).toBe(true);
  });

  it('live mode creates the adapter with the given key and endpoint, without a mock server', async () => {
    const server = await startMockProviderServer();
    try {
      server.enqueue({ body: sseChunks(TEXT_STREAM) });
      await runContractCase(
        target,
        {
          id: 'P-01',
          title: 'live',
          live: true,
          async run(ctx) {
            expect(ctx.mode).toBe('live');
            expect(ctx.server).toBeNull();
            expect(() => ctx.requests()).toThrow(/live mode/);
            expect((await ctx.complete(ctx.request())).text).toBe('Hi');
          },
        },
        { live: { apiKey: 'live-key-value', baseUrl: server.baseUrl } },
      );
      expect(server.lastRequest().headers.authorization).toBe('Bearer live-key-value');
    } finally {
      await server.close();
    }
  });
});

describe('streamProblems', () => {
  it('accepts a well-formed tool call stream', () => {
    expect(
      streamProblems([
        { type: 'tool_call_start', index: 0, id: 't', name: 'n' },
        { type: 'tool_call_delta', id: 't', argumentsDelta: '{}' },
        { type: 'tool_call_done', id: 't', name: 'n', arguments: {} },
        { type: 'finish', reason: 'tool_use' },
      ]),
    ).toEqual([]);
  });

  it('reports order violations', () => {
    const problems = streamProblems([
      { type: 'tool_call_delta', id: 'x', argumentsDelta: '{' },
      { type: 'tool_call_start', index: 0, id: 't', name: 'n' },
      { type: 'tool_call_start', index: 1, id: 't', name: 'n' },
      { type: 'tool_call_done', id: 't', name: 'other', arguments: {} },
      { type: 'tool_call_done', id: 't', name: 'n', arguments: {} },
      {
        type: 'usage',
        usage: {
          inputTokens: -1,
          cachedReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0.5,
          reasoningTokens: 0,
        },
      },
      { type: 'tool_call_start', index: 2, id: 'u', name: 'n' },
      { type: 'finish', reason: 'end' },
      { type: 'finish', reason: 'end' },
      { type: 'text_delta', text: 'after' },
    ]);
    expect(problems).toEqual([
      'expected exactly one finish event, got 2',
      'finish is not the last event',
      '#0: delta for tool call x before its start',
      '#2: tool call t started twice',
      '#3: tool call t changed name',
      '#4: tool call t ended twice',
      '#5: usage.inputTokens is -1',
      '#5: usage.outputTokens is 0.5',
      'tool call u started but never ended',
    ]);
  });
});

describe('scripted adapter', () => {
  it('answers each call with its step and records the requests', async () => {
    const adapter = createScriptedAdapter([
      { events: TEXT_STREAM },
      {
        events: [
          { type: 'tool_call_done', id: 't', name: 'list_sites', arguments: {} },
          { type: 'finish', reason: 'tool_use' },
        ],
      },
    ]);
    const signal = new AbortController().signal;
    const req = { model: 'm', system: [], messages: [], tools: [], effort: 'low' as const };
    expect((await adapter.complete(req, signal)).text).toBe('Hi');
    expect((await adapter.complete(req, signal)).finishReason).toBe('tool_use');
    expect(adapter.calls).toHaveLength(2);
    await expect(adapter.complete(req, signal)).rejects.toThrow(/no step for call 3/);
  });

  it('ends with finish stopped when aborted between events', async () => {
    const adapter = createScriptedAdapter([
      {
        events: [
          { type: 'text_delta', text: 'one' },
          { type: 'text_delta', text: 'two' },
          { type: 'finish', reason: 'end' },
        ],
        delayMs: 20,
      },
    ]);
    const run = await runAdapterStream(
      adapter,
      { model: 'm', system: [], messages: [], tools: [], effort: 'low' },
      { abortAfterEvents: 1 },
    );
    expect(run.events.map((e) => e.type)).toEqual(['text_delta', 'finish']);
    expect(run.result).toMatchObject({ text: 'one', finishReason: 'stopped' });
    expect(adapter.abortedCalls).toBe(1);
  });

  it('throws a scripted mid-stream error after its events', async () => {
    const adapter = createScriptedAdapter([
      {
        events: [{ type: 'text_delta', text: 'x' }],
        error: new AiProviderError({ code: 'overloaded', provider: 'anthropic', message: 'busy' }),
      },
    ]);
    const run = await runAdapterStream(adapter, {
      model: 'm',
      system: [],
      messages: [],
      tools: [],
      effort: 'low',
    });
    expect((run.error as AiProviderError).code).toBe('overloaded');
    expect(run.result.text).toBe('x');
  });
});
