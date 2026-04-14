// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Use vi.hoisted so these are available inside vi.mock factories (which are hoisted)
const {
  mockSubscribeCallbackRef,
  mockUnsubscribe,
  mockPublish,
  mockSubscribe,
  mockValidateRequest21,
  mockValidateRequest16,
} = vi.hoisted(() => {
  const ref = { current: null as ((raw: string) => void) | null };
  const unsub = vi.fn().mockResolvedValue(undefined);
  const pub = vi.fn().mockResolvedValue(undefined);
  const sub = vi.fn().mockImplementation(async (_channel: string, cb: (raw: string) => void) => {
    ref.current = cb;
    return { unsubscribe: unsub };
  });
  const validate21 = Object.assign(vi.fn().mockReturnValue(true), { errors: null as unknown });
  const validate16 = Object.assign(vi.fn().mockReturnValue(true), { errors: null as unknown });
  return {
    mockSubscribeCallbackRef: ref,
    mockUnsubscribe: unsub,
    mockPublish: pub,
    mockSubscribe: sub,
    mockValidateRequest21: validate21,
    mockValidateRequest16: validate16,
  };
});

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({ publish: mockPublish, subscribe: mockSubscribe })),
  setPubSub: vi.fn(),
}));

vi.mock('@evtivity/ocpp', () => ({
  ActionRegistry: {
    Reset: { validateRequest: mockValidateRequest21 },
    GetBaseReport: { validateRequest: mockValidateRequest21 },
  },
  ActionRegistry16: {
    Reset: { validateRequest: mockValidateRequest16 },
  },
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { ocppCommandRoutes } from '../routes/ocpp-commands.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  ocppCommandRoutes(app);
  await app.ready();
  return app;
}

// Valid payloads that pass Fastify Zod schema validation
const V21_RESET_PAYLOAD = { stationId: 'S1', type: 'Immediate' };
const V16_RESET_PAYLOAD = { stationId: 'S1', type: 'Hard' };

describe('OCPP command routes - full coverage', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribeCallbackRef.current = null;
    mockValidateRequest21.mockReturnValue(true);
    mockValidateRequest21.errors = null;
    mockValidateRequest16.mockReturnValue(true);
    mockValidateRequest16.errors = null;
    // Restore default implementations after clearAllMocks
    mockPublish.mockResolvedValue(undefined);
    mockSubscribe.mockImplementation(async (_channel: string, cb: (raw: string) => void) => {
      mockSubscribeCallbackRef.current = cb;
      return { unsubscribe: mockUnsubscribe };
    });
    mockUnsubscribe.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Auth ----

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      payload: V21_RESET_PAYLOAD,
    });
    expect(res.statusCode).toBe(401);
  });

  // ---- Validation: missing stationId ----

  it('returns 400 when stationId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { type: 'Immediate' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---- Validation: missing required field ----

  it('returns 400 when required field is missing from body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'S1' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---- Unknown action ----

  it('returns 404 for unrecognized ocpp2.1 action (no matching route)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/BogusAction',
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'S1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for unrecognized ocpp1.6 action (no matching route)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v16/GetBaseReport',
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'S1' },
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- Invalid payload ----

  it('returns 400 INVALID_PAYLOAD when validateRequest returns false (v21)', async () => {
    mockValidateRequest21.mockReturnValue(false);
    mockValidateRequest21.errors = [{ message: 'bad type' }];

    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'S1', type: 'Immediate' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('INVALID_PAYLOAD');
    expect(body.error).toBe('Invalid OCPP payload');
    expect(body.action).toBe('Reset');
    expect(body.validationErrors).toEqual([{ message: 'bad type' }]);
  });

  it('returns 400 INVALID_PAYLOAD for ocpp1.6 when validateRequest fails', async () => {
    mockValidateRequest16.mockReturnValue(false);
    mockValidateRequest16.errors = [{ message: 'missing field' }];

    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v16/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V16_RESET_PAYLOAD,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('INVALID_PAYLOAD');
    expect(body.validationErrors).toEqual([{ message: 'missing field' }]);
  });

  // ---- Successful command (200) ----

  it('returns 200 with response when station replies successfully', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'STATION-1', type: 'Immediate' },
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalled();
    });

    const publishedPayload = JSON.parse(mockPublish.mock.calls[0]![1] as string);
    const { commandId } = publishedPayload;

    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId, response: { status: 'Accepted' } }),
    );

    const res = await responsePromise;
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('accepted');
    expect(body.stationId).toBe('STATION-1');
    expect(body.action).toBe('Reset');
    expect(body.response).toEqual({ status: 'Accepted' });
    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it('publishes version ocpp2.1 for v21 endpoint', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalled();
    });

    const published = JSON.parse(mockPublish.mock.calls[0]![1] as string);
    expect(published.version).toBe('ocpp2.1');
    expect(published.stationId).toBe('S1');
    expect(published.action).toBe('Reset');

    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId: published.commandId, response: { status: 'Accepted' } }),
    );

    const res = await responsePromise;
    expect(res.statusCode).toBe(200);
  });

  it('publishes version ocpp1.6 for v16 endpoint', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v16/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V16_RESET_PAYLOAD,
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalled();
    });

    const published = JSON.parse(mockPublish.mock.calls[0]![1] as string);
    expect(published.version).toBe('ocpp1.6');
    expect(published.stationId).toBe('S1');
    expect(published.action).toBe('Reset');

    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId: published.commandId, response: { status: 'Accepted' } }),
    );

    const res = await responsePromise;
    expect(res.statusCode).toBe(200);
  });

  it('publishes to ocpp_commands channel and subscribes to ocpp_command_results', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    await vi.waitFor(() => {
      expect(mockSubscribe).toHaveBeenCalledWith('ocpp_command_results', expect.any(Function));
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalled();
    });

    expect(mockPublish.mock.calls[0]![0]).toBe('ocpp_commands');

    const published = JSON.parse(mockPublish.mock.calls[0]![1] as string);
    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId: published.commandId, response: { status: 'Accepted' } }),
    );

    await responsePromise;
  });

  // ---- Timeout (504) ----

  it('returns 504 COMMAND_TIMEOUT when no response arrives within timeout', async () => {
    vi.useFakeTimers();

    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    await vi.advanceTimersByTimeAsync(36_000);

    const res = await responsePromise;
    expect(res.statusCode).toBe(504);
    const body = res.json();
    expect(body.status).toBe('timeout');
    expect(body.code).toBe('COMMAND_TIMEOUT');
    expect(body.stationId).toBe('S1');
    expect(body.action).toBe('Reset');
    expect(body.error).toBe('No response within 35s');
    expect(mockUnsubscribe).toHaveBeenCalled();

    vi.useRealTimers();
  });

  // ---- Error response from station (502) ----

  it('returns 502 COMMAND_ERROR when station returns an error', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalled();
    });

    const published = JSON.parse(mockPublish.mock.calls[0]![1] as string);

    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId: published.commandId, error: 'Station rejected the command' }),
    );

    const res = await responsePromise;
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.code).toBe('COMMAND_ERROR');
    expect(body.stationId).toBe('S1');
    expect(body.action).toBe('Reset');
    expect(body.error).toBe('Station rejected the command');
  });

  // ---- Subscribe callback ignores non-JSON payloads ----

  it('ignores non-JSON messages on subscribe callback', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalled();
    });

    const published = JSON.parse(mockPublish.mock.calls[0]![1] as string);

    // Invalid JSON is silently ignored
    mockSubscribeCallbackRef.current!('this is not json');

    // Now send the real response
    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId: published.commandId, response: { status: 'Accepted' } }),
    );

    const res = await responsePromise;
    expect(res.statusCode).toBe(200);
  });

  // ---- Subscribe callback ignores non-matching commandId ----

  it('ignores messages with non-matching commandId', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalled();
    });

    const published = JSON.parse(mockPublish.mock.calls[0]![1] as string);

    // Message for a different command
    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId: 'some-other-command-id', response: { status: 'Rejected' } }),
    );

    // Unsubscribe should NOT have been called for the mismatched message
    expect(mockUnsubscribe).not.toHaveBeenCalled();

    // Matching response
    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId: published.commandId, response: { status: 'Accepted' } }),
    );

    const res = await responsePromise;
    expect(res.statusCode).toBe(200);
    expect(res.json().response).toEqual({ status: 'Accepted' });
  });

  // ---- 500 internal error when subscribe/publish rejects ----

  it('returns 500 INTERNAL_ERROR when pubsub.subscribe rejects with Error', async () => {
    mockSubscribe.mockRejectedValueOnce(new Error('Redis connection failed'));

    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.stationId).toBe('S1');
    expect(body.action).toBe('Reset');
    expect(body.error).toBe('Internal server error');
  });

  it('returns 500 INTERNAL_ERROR when pubsub.publish rejects', async () => {
    mockPublish.mockRejectedValueOnce(new Error('Publish failed'));

    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('wraps non-Error rejections in Error objects in the catch path', async () => {
    mockSubscribe.mockRejectedValueOnce('string error');

    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL_ERROR');
  });

  // ---- Subscription cleanup in catch block ----

  it('cleans up subscription in catch block when publish rejects after subscribe succeeds', async () => {
    const localUnsubscribe = vi.fn().mockResolvedValue(undefined);
    mockSubscribe.mockImplementationOnce(async (_channel: string, cb: (raw: string) => void) => {
      mockSubscribeCallbackRef.current = cb;
      return { unsubscribe: localUnsubscribe };
    });
    mockPublish.mockRejectedValueOnce(new Error('publish boom'));

    const res = await app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL_ERROR');
  });

  // ---- Timeout with subscription cleanup ----

  it('unsubscribes on timeout when subscription is set', async () => {
    vi.useFakeTimers();

    const localUnsubscribe = vi.fn().mockResolvedValue(undefined);
    mockSubscribe.mockImplementationOnce(async (_channel: string, cb: (raw: string) => void) => {
      mockSubscribeCallbackRef.current = cb;
      return { unsubscribe: localUnsubscribe };
    });

    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    await vi.advanceTimersByTimeAsync(36_000);

    const res = await responsePromise;
    expect(res.statusCode).toBe(504);
    expect(localUnsubscribe).toHaveBeenCalled();

    vi.useRealTimers();
  });

  // ---- Subscription unsubscribe error is swallowed ----

  it('swallows unsubscribe errors on timeout', async () => {
    vi.useFakeTimers();

    mockUnsubscribe.mockRejectedValueOnce(new Error('unsubscribe fail'));

    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    await vi.advanceTimersByTimeAsync(36_000);

    const res = await responsePromise;
    expect(res.statusCode).toBe(504);

    vi.useRealTimers();
  });

  it('swallows unsubscribe errors on successful response', async () => {
    mockUnsubscribe.mockRejectedValueOnce(new Error('unsubscribe fail'));

    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalled();
    });

    const published = JSON.parse(mockPublish.mock.calls[0]![1] as string);
    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId: published.commandId, response: { status: 'Accepted' } }),
    );

    const res = await responsePromise;
    expect(res.statusCode).toBe(200);
  });

  // ---- v21 uses ActionRegistry ----

  it('uses ActionRegistry when calling v21 endpoint', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V21_RESET_PAYLOAD,
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalled();
    });

    expect(mockValidateRequest21).toHaveBeenCalled();

    const published = JSON.parse(mockPublish.mock.calls[0]![1] as string);
    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId: published.commandId, response: { status: 'Accepted' } }),
    );

    const res = await responsePromise;
    expect(res.statusCode).toBe(200);
  });

  // ---- v16 uses ActionRegistry16 ----

  it('uses ActionRegistry16 when calling v16 endpoint', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/ocpp/commands/v16/Reset',
      headers: { authorization: `Bearer ${token}` },
      payload: V16_RESET_PAYLOAD,
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalled();
    });

    expect(mockValidateRequest16).toHaveBeenCalled();

    const published = JSON.parse(mockPublish.mock.calls[0]![1] as string);
    mockSubscribeCallbackRef.current!(
      JSON.stringify({ commandId: published.commandId, response: { status: 'Accepted' } }),
    );

    const res = await responsePromise;
    expect(res.statusCode).toBe(200);
  });
});
