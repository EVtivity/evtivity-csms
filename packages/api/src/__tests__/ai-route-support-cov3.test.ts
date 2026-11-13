// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolve: vi.fn(),
  hasAdapter: vi.fn(() => true),
  checkLimits: vi.fn(),
  claimTurn: vi.fn(),
  releaseTurn: vi.fn(),
  openStream: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  getAiSettings: vi.fn(async () => ({ limits: { userPerMinute: 5 } })),
}));
vi.mock('../services/ai/surfaces/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ai/surfaces/config.js')>()),
  resolveSurfaceConfig: h.resolve,
}));
vi.mock('../services/ai/engine/providers.js', () => ({ hasAiAdapter: h.hasAdapter }));
vi.mock('../services/ai/engine/limits.js', () => ({ checkAiLimits: h.checkLimits }));
vi.mock('../services/ai/conversation.service.js', () => ({
  claimTurn: h.claimTurn,
  releaseTurn: h.releaseTurn,
}));
vi.mock('@evtivity/ai/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/ai/core')>()),
  openAiEventStream: h.openStream,
}));

import { AiNotConfiguredError } from '../services/ai/surfaces/config.js';
import type { AiSurfaceConfig } from '../services/ai/surfaces/config.js';
import {
  callerAuthorization,
  claimTurnOrReply,
  limitsOrReply,
  streamTurn,
  surfaceConfigOrReply,
} from '../services/ai/engine/route-support.js';

const CONFIG = { provider: 'anthropic', model: 'm1', surface: 'chatbot' } as AiSurfaceConfig;
const warn = vi.fn();
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.get('/config', async (_req, reply) => {
    const config = await surfaceConfigOrReply('support', 'u1', reply);
    if (config != null) return { provider: config.provider };
    return reply;
  });
  app.get('/limits', async (_req, reply) => {
    const limits = await limitsOrReply('support', 'u1', 'site_1', reply);
    if (limits != null) return { limits };
    return reply;
  });
  app.get('/claim', async (_req, reply) => {
    if (await claimTurnOrReply('cnv_1', reply)) return { claimed: true };
    return reply;
  });
  app.get('/stream', async (request, reply) => {
    request.log.warn = warn as never;
    reply.header('x-num', 5).header('x-list', ['a', 'b']).header('x-str', 's');
    await streamTurn(request, reply, 'cnv_1', CONFIG, async (stream) => {
      (stream as unknown as { write: (s: string) => void }).write('turn ran');
      if (request.headers['x-fail'] === '1') throw new Error('turn failed');
    });
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('surfaceConfigOrReply', () => {
  it('returns the configuration when the provider has an adapter', async () => {
    h.resolve.mockResolvedValueOnce(CONFIG);
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.json()).toEqual({ provider: 'anthropic' });
    expect(h.resolve).toHaveBeenCalledWith('support', 'u1');
  });

  it('replies 400 for a provider without an adapter', async () => {
    h.resolve.mockResolvedValueOnce(CONFIG);
    h.hasAdapter.mockReturnValueOnce(false);
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'SUPPORT_AI_NOT_CONFIGURED' });
  });

  it('replies 400 with the error code of a bad base URL', async () => {
    h.resolve.mockRejectedValueOnce(new AiNotConfiguredError('chatbot', 'base_url'));
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string; error: string }>().code).toBe('AI_BASE_URL_INVALID');
  });

  it('rethrows any other error', async () => {
    h.resolve.mockRejectedValueOnce(new Error('db down'));
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(500);
  });
});

describe('limitsOrReply', () => {
  it('returns the limits when the turn is allowed', async () => {
    h.checkLimits.mockResolvedValueOnce(null);
    const res = await app.inject({ method: 'GET', url: '/limits' });
    expect(res.json()).toEqual({ limits: { userPerMinute: 5 } });
    expect(h.checkLimits).toHaveBeenCalledWith({
      surface: 'support',
      userId: 'u1',
      siteId: 'site_1',
      limits: { userPerMinute: 5 },
    });
  });

  it('replies 429 with the scope and Retry-After', async () => {
    h.checkLimits.mockResolvedValueOnce({
      code: 'AI_RATE_LIMITED',
      scope: 'user',
      retryAfterSeconds: 42,
    });
    const res = await app.inject({ method: 'GET', url: '/limits' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
    expect(res.json()).toMatchObject({
      code: 'AI_RATE_LIMITED',
      scope: 'user',
      retryAfterSeconds: 42,
    });
  });
});

describe('claimTurnOrReply', () => {
  it('passes when the lease is taken and replies 409 when busy', async () => {
    h.claimTurn.mockResolvedValueOnce(true);
    expect((await app.inject({ method: 'GET', url: '/claim' })).json()).toEqual({ claimed: true });
    h.claimTurn.mockResolvedValueOnce(false);
    const res = await app.inject({ method: 'GET', url: '/claim' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'AI_CONVERSATION_BUSY' });
  });
});

describe('streamTurn', () => {
  function fakeStream(raw: { write: (s: string) => void; end: () => void }): unknown {
    return { write: (s: string) => raw.write(s), close: vi.fn(() => raw.end()) };
  }

  it('opens the stream with the reply headers, runs the turn and releases the lease', async () => {
    h.openStream.mockImplementationOnce((raw: never) => fakeStream(raw));
    h.releaseTurn.mockResolvedValueOnce(undefined);
    const res = await app.inject({ method: 'GET', url: '/stream' });
    expect(res.body).toBe('turn ran');
    const headers = (h.openStream.mock.calls[0] as unknown[])[1] as {
      headers: Record<string, unknown>;
    };
    expect(headers.headers).toMatchObject({ 'x-num': '5', 'x-list': ['a', 'b'], 'x-str': 's' });
    expect(h.releaseTurn).toHaveBeenCalledWith('cnv_1', { provider: 'anthropic', model: 'm1' });
  });

  it('releases the lease and ends the stream when the turn throws or the release fails', async () => {
    h.openStream.mockImplementationOnce((raw: never) => fakeStream(raw));
    h.releaseTurn.mockRejectedValueOnce(new Error('redis down'));
    const res = await app.inject({ method: 'GET', url: '/stream', headers: { 'x-fail': '1' } });
    expect(res.body).toBe('turn ran');
    expect(h.releaseTurn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cnv_1' }),
      'AI turn lease release failed, it expires on its own',
    );
  });
});

describe('callerAuthorization', () => {
  function request(header: string | undefined, cookie: string | undefined): unknown {
    return {
      headers: header != null ? { authorization: header } : {},
      cookies: cookie != null ? { csms_token: cookie } : {},
      unsignCookie: (raw: string) =>
        raw.endsWith('.sig')
          ? { valid: true, renew: false, value: raw.slice(0, -4) }
          : { valid: false, renew: false, value: null },
    };
  }

  it('prefers the header, then a signed cookie, else nothing', () => {
    expect(callerAuthorization(request('Bearer k', 'j.sig') as never)).toBe('Bearer k');
    expect(callerAuthorization(request(undefined, 'j.sig') as never)).toBe('Bearer j');
    expect(callerAuthorization(request(undefined, 'forged') as never)).toBe('');
    expect(callerAuthorization(request(undefined, undefined) as never)).toBe('');
  });
});
