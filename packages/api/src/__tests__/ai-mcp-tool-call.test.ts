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
  // No stations:read: the OCPP version check looks nothing up in these unit tests.
  hasPermission: (permission: string) => Promise.resolve(permission !== 'stations:read'),
  log: { debug() {}, info() {}, warn() {}, error() {} },
};

const client = { name: 'unit', version: '1', protocolVersion: '2026-07-28' };

function deps(app: Partial<FastifyInstance>) {
  return { app: app as FastifyInstance };
}

const RESET = { name: 'ocppv21_reset', args: { stationId: 'CS-1', type: 'OnIdle' } };

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
      'disabled',
      { name: 'list_sites', args: {}, signal: abort.signal, callId: 'amc_000000000001' },
    );
    expect(inject).toHaveBeenCalledTimes(1);
    expect(seen).toBe(abort.signal);
    expect(seen?.aborted).toBe(true);
    expect(result).toMatchObject({ isError: true });
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
      'disabled',
      { name: 'list_sites', args: {}, signal: undefined, callId: 'amc_1' },
    );
    const opts = inject.mock.calls[0] as unknown as [{ headers: Record<string, string> }];
    expect(opts[0].headers['authorization']).toBe(caller.authorization);
    expect(result).toMatchObject({ isError: false });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(result.structuredContent['httpStatus']).toBe(200);
    expect(recorded).toEqual([{ status: 'ok', errorCode: null }]);
  });

  it('an unknown tool, or one outside the toolsets, is refused', async () => {
    const inject = vi.fn();
    const run = (name: string) =>
      runMcpToolCall(deps({ inject }), caller, client, mcpToolset(['sites']), 'allowed', {
        name,
        args: {},
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
    const result = await runMcpToolCall(
      deps({ inject }),
      caller,
      client,
      mcpToolset(['sites']),
      'disabled',
      { name: 'get_site', args: { id: '..' }, signal: undefined, callId: 'amc_3' },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: 'invalid_arguments' },
    });
    expect(inject).not.toHaveBeenCalled();
  });
});

describe('MCP writes (ai.mcp.allowWrites)', () => {
  const toolsets = ['ocpp-2-1-commands'];

  it('writes off: the write tool is not listed and a call is refused writes_disabled', async () => {
    const inject = vi.fn();
    const toolset = mcpToolset(toolsets, undefined, { writes: false });
    expect(toolset.byName.has(RESET.name)).toBe(false);
    const result = await runMcpToolCall(deps({ inject }), caller, client, toolset, 'disabled', {
      ...RESET,
      signal: undefined,
      callId: 'amc_4',
    });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'writes_disabled' } });
    expect(result.content[0]?.text).toContain('Allow Writes');
    expect(inject).not.toHaveBeenCalled();
    expect(recorded).toEqual([{ status: 'refused', errorCode: 'writes_disabled' }]);
  });

  it('a key without aiMcp:write is refused forbidden, writes on', async () => {
    const inject = vi.fn();
    const toolset = mcpToolset(toolsets, undefined, { writes: false });
    const result = await runMcpToolCall(deps({ inject }), caller, client, toolset, 'forbidden', {
      ...RESET,
      signal: undefined,
      callId: 'amc_5',
    });
    expect(result).toMatchObject({ isError: true, structuredContent: { code: 'forbidden' } });
    expect(inject).not.toHaveBeenCalled();
    expect(recorded).toEqual([{ status: 'refused', errorCode: 'forbidden' }]);
  });

  it('writes on: the write runs at once with the key authorization and the MCP audit context', async () => {
    const abort = new AbortController();
    const inject = vi.fn(() =>
      Promise.resolve({ statusCode: 200, body: JSON.stringify({ status: 'Accepted' }) }),
    );
    const toolset = mcpToolset(toolsets, undefined, { writes: true });
    const result = await runMcpToolCall(
      deps({ inject } as unknown as Partial<FastifyInstance>),
      caller,
      client,
      toolset,
      'allowed',
      { ...RESET, signal: abort.signal, callId: 'amc_6' },
    );
    expect(inject).toHaveBeenCalledTimes(1);
    const [opts] = inject.mock.calls[0] as unknown as [
      { method: string; url: string; headers: Record<string, string>; signal?: AbortSignal },
    ];
    expect(opts.method).toBe('POST');
    expect(opts.url).toBe('/v1/ocpp/commands/v21/Reset');
    expect(opts.headers['authorization']).toBe(caller.authorization);
    // A write runs to its end even when the client goes away.
    expect(opts.signal).toBeUndefined();
    expect(result).toMatchObject({
      isError: false,
      structuredContent: { httpStatus: 200, data: { status: 'Accepted' } },
    });
    expect(recorded).toEqual([{ status: 'ok', errorCode: null }]);
  });

  it("writes on: the route's 403 (no route permission or another site) comes back as an error", async () => {
    const inject = vi.fn(() =>
      Promise.resolve({
        statusCode: 403,
        body: JSON.stringify({ error: 'Forbidden', code: 'FORBIDDEN' }),
      }),
    );
    const result = await runMcpToolCall(
      deps({ inject } as unknown as Partial<FastifyInstance>),
      caller,
      client,
      mcpToolset(toolsets, undefined, { writes: true }),
      'allowed',
      { ...RESET, signal: undefined, callId: 'amc_7' },
    );
    expect(result).toMatchObject({ isError: true, structuredContent: { httpStatus: 403 } });
    expect(recorded).toEqual([{ status: 'error', errorCode: null }]);
  });
});

describe('MCP client info', () => {
  it('reads the client name, version and protocol, cut to the column size', () => {
    const envelope = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'x'.repeat(300), version: '1.0' },
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } },
    };
    expect(mcpClientInfo(envelope, undefined)).toEqual({
      name: 'x'.repeat(100),
      version: '1.0',
      protocolVersion: '2026-07-28',
    });
    expect(mcpClientInfo(undefined, '2025-11-25')).toEqual({
      name: null,
      version: null,
      protocolVersion: '2025-11-25',
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
