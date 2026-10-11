// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recorded: { status: string; errorCode: string | null }[] = [];

vi.mock('../services/ai/mcp/mcp-call.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ai/mcp/mcp-call.service.js')>();
  return {
    ...actual,
    recordMcpCall: vi.fn((record: { status: string; errorCode: string | null }) => {
      recorded.push({ status: record.status, errorCode: record.errorCode });
      return Promise.resolve();
    }),
  };
});

const { runMcpToolCall } = await import('../services/ai/mcp/tool-call.js');
const { mcpToolset } = await import('../services/ai/mcp/exposure.js');
const { mcpClientInfo } = await import('../services/ai/mcp/server.js');
const { checkMcpRateLimit, setMcpCounterStore } = await import('../services/ai/mcp/rate-limit.js');

const caller = {
  userId: 'usr_000000000001',
  apiKeyId: '7',
  authorization: `Bearer ${'a'.repeat(64)}`,
  language: 'en',
  hasPermission: () => Promise.resolve(true),
  log: { debug() {}, info() {}, warn() {}, error() {} },
};

const client = { name: 'unit', version: '1', protocolVersion: '2026-07-28', urlElicitation: false };

function deps(app: Partial<FastifyInstance>) {
  return {
    app: app as FastifyInstance,
    secret: 'test-secret-0123456789',
    csmsUrl: 'https://csms.example',
    proposalTtlMinutes: () => Promise.resolve(30),
    invalidRequestState: () => new Error('invalid request state'),
  };
}

beforeEach(() => {
  recorded.length = 0;
});

describe('MCP tool calls', () => {
  it('TC-AI-MCP-16: closing the response aborts the in-flight inject', async () => {
    const abort = new AbortController();
    let seen: AbortSignal | undefined;
    const inject = vi.fn((opts: { signal?: AbortSignal }) => {
      seen = opts.signal;
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted'));
        });
        // The client goes away while the route runs.
        setTimeout(() => {
          abort.abort();
        }, 5);
      });
    });
    const result = await runMcpToolCall(
      deps({ inject } as unknown as Partial<FastifyInstance>),
      caller,
      client,
      mcpToolset(['sites']),
      {
        name: 'list_sites',
        args: {},
        requestState: undefined,
        signal: abort.signal,
        callId: 'amc_000000000001',
      },
    );
    expect(inject).toHaveBeenCalledTimes(1);
    expect(seen).toBe(abort.signal);
    expect(seen?.aborted).toBe(true);
    expect(result).toMatchObject({ kind: 'result', isError: true });
    expect(recorded).toEqual([{ status: 'error', errorCode: 'tool_failed' }]);
  });

  it('a read runs as the key user and returns structured, redacted content', async () => {
    const inject = vi.fn(() =>
      Promise.resolve({
        statusCode: 200,
        body: JSON.stringify({ data: [{ id: 'sit_1', apiKey: 'secret-value' }], total: 1 }),
      }),
    );
    const result = await runMcpToolCall(
      deps({ inject } as unknown as Partial<FastifyInstance>),
      caller,
      client,
      mcpToolset(['sites']),
      { name: 'list_sites', args: {}, requestState: undefined, signal: undefined, callId: 'amc_1' },
    );
    const opts = inject.mock.calls[0] as unknown as [{ headers: Record<string, string> }];
    expect(opts[0].headers['authorization']).toBe(caller.authorization);
    expect(result).toMatchObject({ kind: 'result', isError: false });
    if (result.kind !== 'result') throw new Error('expected a result');
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(result.structuredContent['httpStatus']).toBe(200);
    expect(recorded).toEqual([{ status: 'ok', errorCode: null }]);
  });

  it('an unknown tool, or one outside the toolsets, is refused', async () => {
    const inject = vi.fn();
    const run = (name: string) =>
      runMcpToolCall(deps({ inject }), caller, client, mcpToolset(['sites']), {
        name,
        args: {},
        requestState: undefined,
        signal: undefined,
        callId: 'amc_2',
      });
    expect(await run('list_settings')).toMatchObject({ isError: true });
    expect(await run('list_stations')).toMatchObject({ isError: true });
    expect(inject).not.toHaveBeenCalled();
    expect(recorded.map((r) => r.errorCode)).toEqual(['unavailable', 'unavailable']);
  });

  it('invalid arguments are refused before anything runs', async () => {
    const inject = vi.fn();
    const result = await runMcpToolCall(deps({ inject }), caller, client, mcpToolset(['sites']), {
      name: 'get_site',
      args: { id: '..' },
      requestState: undefined,
      signal: undefined,
      callId: 'amc_3',
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: 'invalid_arguments' },
    });
    expect(inject).not.toHaveBeenCalled();
  });
});

describe('MCP client info', () => {
  it('URL elicitation counts only on a 2026-07-28 request that declares it', () => {
    const envelope = (caps: unknown, version = '2026-07-28') => ({
      'io.modelcontextprotocol/protocolVersion': version,
      'io.modelcontextprotocol/clientInfo': { name: 'x'.repeat(300), version: '1.0' },
      'io.modelcontextprotocol/clientCapabilities': caps,
    });
    expect(mcpClientInfo(envelope({ elicitation: { url: {} } }), undefined)).toEqual({
      name: 'x'.repeat(100),
      version: '1.0',
      protocolVersion: '2026-07-28',
      urlElicitation: true,
    });
    expect(mcpClientInfo(envelope({ elicitation: { form: {} } }), undefined).urlElicitation).toBe(
      false,
    );
    expect(mcpClientInfo(envelope({ elicitation: {} }), undefined).urlElicitation).toBe(false);
    expect(mcpClientInfo(undefined, '2025-11-25')).toEqual({
      name: null,
      version: null,
      protocolVersion: '2025-11-25',
      urlElicitation: false,
    });
  });
});

describe('MCP rate limit', () => {
  it('counts per key, per minute and per day', async () => {
    const counts = new Map<string, number>();
    setMcpCounterStore({
      increment: (key) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return Promise.resolve(next);
      },
    });
    const now = new Date('2026-10-10T12:00:30Z');
    const settings = { rateLimitPerMinute: 2, dailyCallsPerKey: 2 };
    expect(await checkMcpRateLimit({ apiKeyId: '1', settings, now })).toBeNull();
    expect(await checkMcpRateLimit({ apiKeyId: '1', settings, now })).toBeNull();
    expect(await checkMcpRateLimit({ apiKeyId: '1', settings, now })).toEqual({
      code: 'AI_MCP_RATE_LIMITED',
      scope: 'minute',
      retryAfterSeconds: 30,
    });
    // Another key has its own window.
    expect(await checkMcpRateLimit({ apiKeyId: '2', settings, now })).toBeNull();
    const later = new Date('2026-10-10T12:01:10Z');
    expect(await checkMcpRateLimit({ apiKeyId: '1', settings, now: later })).toMatchObject({
      scope: 'day',
    });
    expect([...counts.keys()].every((k) => k.startsWith('ai:rl:mcp:'))).toBe(true);
    setMcpCounterStore(null);
  });

  it('a counter failure lets the request run', async () => {
    setMcpCounterStore({ increment: () => Promise.reject(new Error('NOPERM')) });
    expect(
      await checkMcpRateLimit({
        apiKeyId: '1',
        settings: { rateLimitPerMinute: 1, dailyCallsPerKey: 1 },
      }),
    ).toBeNull();
    setMcpCounterStore(null);
  });
});
