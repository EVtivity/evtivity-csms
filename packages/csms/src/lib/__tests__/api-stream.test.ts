// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// postStream: the AI chat stream request. The same cookie, CSRF and refresh
// handling as api.post; errors before the stream opens throw ApiError.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let fetchMock: ReturnType<typeof vi.fn>;
let mod: typeof import('../api');

function response(init: { status: number; body?: ReadableStream | null; json?: unknown }) {
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    body: init.body ?? null,
    json: () =>
      init.json === undefined ? Promise.reject(new Error('not json')) : Promise.resolve(init.json),
  };
}

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  document.cookie = 'csms_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  mod = await import('../api');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('postStream', () => {
  it('posts the JSON body asking for an event stream, with the CSRF cookie, and returns the body', async () => {
    document.cookie = 'csms_csrf=abc123';
    const stream = new ReadableStream<Uint8Array>();
    fetchMock.mockResolvedValueOnce(response({ status: 200, body: stream }));
    const signal = new AbortController().signal;
    await expect(mod.postStream('/v1/ai/chat', { text: 'hi' }, signal)).resolves.toBe(stream);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/v1/ai/chat')).toBe(true);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"text":"hi"}');
    expect(init.credentials).toBe('include');
    expect(init.signal).toBe(signal);
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-CSRF-Token': 'abc123',
    });
  });

  it('sends no CSRF header without the cookie', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200, body: new ReadableStream() }));
    await mod.postStream('/v1/ai/chat', {}, new AbortController().signal);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('X-CSRF-Token');
  });

  it('renews an expired session once and sends the request again', async () => {
    const stream = new ReadableStream<Uint8Array>();
    fetchMock
      .mockResolvedValueOnce(response({ status: 401 }))
      .mockResolvedValueOnce(response({ status: 200 }))
      .mockResolvedValueOnce(response({ status: 200, body: stream }));
    await expect(mod.postStream('/v1/ai/chat', {}, new AbortController().signal)).resolves.toBe(
      stream,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/auth/refresh');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws the error body of a refused request, and a null body when it is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ status: 403, json: { error: 'no', code: 'INSUFFICIENT_PERMISSIONS' } }),
    );
    const err = await mod
      .postStream('/v1/ai/chat', {}, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.ApiError);
    expect((err as InstanceType<typeof mod.ApiError>).status).toBe(403);
    expect(mod.getApiErrorCode(err)).toBe('INSUFFICIENT_PERMISSIONS');
    fetchMock.mockResolvedValueOnce(response({ status: 502 }));
    const bad = await mod
      .postStream('/v1/ai/chat', {}, new AbortController().signal)
      .catch((e: unknown) => e);
    expect((bad as InstanceType<typeof mod.ApiError>).body).toBeNull();
  });

  it('keeps the 401 when the renewal fails', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: 401, json: { code: 'UNAUTHORIZED' } }))
      .mockResolvedValueOnce(response({ status: 401 }));
    const err = await mod
      .postStream('/v1/ai/chat', {}, new AbortController().signal)
      .catch((e: unknown) => e);
    expect((err as InstanceType<typeof mod.ApiError>).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when a successful answer has no body to stream', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 200, body: null }));
    const err = await mod
      .postStream('/v1/ai/chat', {}, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.ApiError);
    expect((err as InstanceType<typeof mod.ApiError>).status).toBe(200);
  });
});
