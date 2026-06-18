// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendExpoPush, isExpoPushToken } from '../push-send.js';

const VALID = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const VALID2 = 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

function mockFetchOnce(tickets: unknown[], ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => ({ data: tickets }),
      text: async () => JSON.stringify({ data: tickets }),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isExpoPushToken', () => {
  it('accepts Exponent and Expo prefixed tokens', () => {
    expect(isExpoPushToken(VALID)).toBe(true);
    expect(isExpoPushToken(VALID2)).toBe(true);
  });

  it('rejects malformed tokens', () => {
    expect(isExpoPushToken('not-a-token')).toBe(false);
    expect(isExpoPushToken('ExponentPushToken[]')).toBe(false);
    expect(isExpoPushToken('fcm-raw-token')).toBe(false);
  });
});

describe('sendExpoPush', () => {
  it('marks ok tickets as delivered', async () => {
    mockFetchOnce([{ status: 'ok', id: 'r1' }]);
    const [res] = await sendExpoPush([{ to: VALID, title: 'T', body: 'B' }]);
    expect(res?.ok).toBe(true);
    expect(res?.unregistered).toBe(false);
  });

  it('flags DeviceNotRegistered as unregistered for pruning', async () => {
    mockFetchOnce([
      { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
    ]);
    const [res] = await sendExpoPush([{ to: VALID, title: 'T', body: 'B' }]);
    expect(res?.ok).toBe(false);
    expect(res?.unregistered).toBe(true);
  });

  it('drops invalid-format tokens before the request without rejecting the batch', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ status: 'ok' }] }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const results = await sendExpoPush([
      { to: 'garbage', title: 'T', body: 'B' },
      { to: VALID, title: 'T', body: 'B' },
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as unknown[];
    expect(sentBody).toHaveLength(1);
    const bad = results.find((r) => r.token === 'garbage');
    expect(bad?.unregistered).toBe(true);
    expect(bad?.error).toBe('invalid_token_format');
  });

  it('fails soft (not unregistered) on a non-2xx Expo response', async () => {
    mockFetchOnce([], false, 503);
    const [res] = await sendExpoPush([{ to: VALID, title: 'T', body: 'B' }]);
    expect(res?.ok).toBe(false);
    expect(res?.unregistered).toBe(false);
  });

  it('fails soft when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const [res] = await sendExpoPush([{ to: VALID, title: 'T', body: 'B' }]);
    expect(res?.ok).toBe(false);
    expect(res?.unregistered).toBe(false);
  });

  it('returns one result per input message', async () => {
    mockFetchOnce([
      { status: 'ok' },
      { status: 'error', details: { error: 'MessageTooBig' }, message: 'too big' },
    ]);
    const results = await sendExpoPush([
      { to: VALID, title: 'T', body: 'B' },
      { to: VALID2, title: 'T', body: 'B' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.unregistered).toBe(false);
  });
});
