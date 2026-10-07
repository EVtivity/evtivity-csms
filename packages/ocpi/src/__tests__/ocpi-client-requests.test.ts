// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  safeFetch: safeFetchMock,
}));

const { OcpiClient } = await import('../lib/ocpi-client.js');

interface FakeResponse {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  headers: { get: (h: string) => string | null };
  body: { cancel: () => Promise<void> } | null;
}

function respond(status: number, body: string, headers: Record<string, string> = {}): FakeResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body),
    headers: { get: (h: string) => lower[h.toLowerCase()] ?? null },
    body: { cancel: vi.fn(() => Promise.resolve()) },
  };
}

const ENVELOPE = { data: { id: 'x' }, status_code: 1000, timestamp: '2026-01-01T00:00:00Z' };

const client = new OcpiClient({
  token: 'secret-token',
  fromCountryCode: 'US',
  fromPartyId: 'EVT',
  toCountryCode: 'DE',
  toPartyId: 'ABC',
  allowPrivateNetwork: true,
});

interface CallInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: string;
  allowPrivateNetworks: boolean;
  signal: AbortSignal;
}
function call(i: number): [string, CallInit] {
  const c = safeFetchMock.mock.calls[i] as [string, CallInit] | undefined;
  if (c == null) throw new Error(`no call ${String(i)}`);
  return c;
}

beforeEach(() => {
  safeFetchMock.mockReset();
});

describe('OcpiClient verbs', () => {
  it('GET sends auth and routing headers and returns the parsed envelope', async () => {
    safeFetchMock.mockResolvedValue(respond(200, JSON.stringify(ENVELOPE)));

    const res = await client.get('https://p.example/ocpi/x', 'corr-1');

    expect(res).toEqual(ENVELOPE);
    const [url, init] = call(0);
    expect(url).toBe('https://p.example/ocpi/x');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('manual');
    expect(init.allowPrivateNetworks).toBe(true);
    expect(init.headers['Authorization']).toBe(
      `Token ${Buffer.from('secret-token').toString('base64')}`,
    );
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['OCPI-from-country-code']).toBe('US');
    expect(init.headers['OCPI-from-party-id']).toBe('EVT');
    expect(init.headers['OCPI-to-country-code']).toBe('DE');
    expect(init.headers['OCPI-to-party-id']).toBe('ABC');
    expect(init.headers['X-Correlation-ID']).toBe('corr-1');
  });

  it.each(['post', 'put', 'patch'] as const)('%s serializes the body', async (verb) => {
    safeFetchMock.mockResolvedValue(respond(200, JSON.stringify(ENVELOPE)));

    const res = await client[verb]('https://p.example/ocpi/x', { a: 1 });

    expect(res.status_code).toBe(1000);
    const [, init] = call(0);
    expect(init.method).toBe(verb.toUpperCase());
    expect(init.body).toBe('{"a":1}');
  });

  it('DELETE sends no body', async () => {
    safeFetchMock.mockResolvedValue(respond(200, JSON.stringify(ENVELOPE)));

    await client.delete('https://p.example/ocpi/x');

    const [, init] = call(0);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('returns the partner error envelope of a non-2xx reply', async () => {
    const err = { status_code: 2001, status_message: 'Invalid', timestamp: 't' };
    safeFetchMock.mockResolvedValue(respond(400, JSON.stringify(err)));

    await expect(client.get('https://p.example/ocpi/x')).resolves.toEqual(err);
  });

  it('throws with the HTTP status when the body is not JSON', async () => {
    safeFetchMock.mockResolvedValue(respond(502, '<html>Bad Gateway</html>'));

    await expect(client.put('https://p.example/ocpi/x', {})).rejects.toThrow(
      'Failed to parse OCPI response from https://p.example/ocpi/x: 502',
    );
  });

  it('keeps the parse error as the cause', async () => {
    safeFetchMock.mockResolvedValue(respond(502, '<html>Bad Gateway</html>'));

    await expect(client.put('https://p.example/ocpi/x', {})).rejects.toMatchObject({
      cause: expect.any(SyntaxError),
    });
  });
});

describe('OcpiClient redirects', () => {
  it('follows a relative redirect and resends the request', async () => {
    safeFetchMock
      .mockResolvedValueOnce(respond(307, '', { location: '/ocpi/moved' }))
      .mockResolvedValueOnce(respond(200, JSON.stringify(ENVELOPE)));

    const res = await client.post('https://p.example/ocpi/x', { a: 1 });

    expect(res).toEqual(ENVELOPE);
    expect(call(1)[0]).toBe('https://p.example/ocpi/moved');
    expect(call(1)[1].method).toBe('POST');
  });

  it('returns a 3xx reply without a Location header as is', async () => {
    safeFetchMock.mockResolvedValue(respond(304, JSON.stringify(ENVELOPE)));

    await expect(client.get('https://p.example/ocpi/x')).resolves.toEqual(ENVELOPE);
    expect(safeFetchMock).toHaveBeenCalledOnce();
  });

  it('gives up after five redirects', async () => {
    safeFetchMock.mockImplementation(() =>
      Promise.resolve(respond(302, '', { location: 'https://p.example/loop' })),
    );

    await expect(client.get('https://p.example/ocpi/x')).rejects.toThrow(
      'Too many redirects for OCPI target: https://p.example/ocpi/x',
    );
    // The first request plus five redirect hops.
    expect(safeFetchMock).toHaveBeenCalledTimes(6);
  });
});

describe('OcpiClient.getPaginated', () => {
  it('collects every page and skips empty or non-array data', async () => {
    safeFetchMock
      .mockResolvedValueOnce(
        respond(200, JSON.stringify({ data: [{ id: 1 }], status_code: 1000 }), {
          Link: '<https://p.example/p2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(
        respond(200, JSON.stringify({ data: [], status_code: 1000 }), {
          Link: '<https://p.example/p3>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(
        respond(200, JSON.stringify({ data: { id: 'obj' }, status_code: 1000 }), {
          Link: '<https://p.example/p4>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(respond(200, JSON.stringify({ data: [{ id: 2 }, { id: 3 }] })));

    const rows = await client.getPaginated<{ id: number }>('https://p.example/p1');

    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(safeFetchMock).toHaveBeenCalledTimes(4);
  });
});
