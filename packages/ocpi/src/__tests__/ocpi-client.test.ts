// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';

// safeFetch (the connect-time SSRF guard, tested in @evtivity/lib) is routed to
// the stubbed global fetch so these tests stay offline and deterministic.
vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  safeFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
}));

const { OcpiClient } = await import('../lib/ocpi-client.js');

const BASE = 'https://partner.example.com';

function makeResponse(data: unknown[], nextUrl: string | null): Response {
  const link = nextUrl != null ? `<${nextUrl}>; rel="next"` : null;
  return {
    status: 200,
    ok: true,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          data,
          status_code: 1000,
          status_message: 'Success',
          timestamp: '2026-01-01T00:00:00Z',
        }),
      ),
    headers: { get: (h: string) => (h.toLowerCase() === 'link' ? link : null) },
  } as unknown as Response;
}

const client = new OcpiClient({
  token: 'tok',
  fromCountryCode: 'US',
  fromPartyId: 'EVT',
  toCountryCode: 'DE',
  toPartyId: 'ABC',
  allowPrivateNetwork: false,
});

describe('OcpiClient.getPaginatedEach', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows rel="next" Link headers and delivers each page in order', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse([{ id: 'a' }, { id: 'b' }], `${BASE}/p2`))
      .mockResolvedValueOnce(makeResponse([{ id: 'c' }], null));
    vi.stubGlobal('fetch', fetchMock);

    const pages: unknown[][] = [];
    await client.getPaginatedEach(`${BASE}/p1`, (page) => {
      pages.push(page);
      return Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pages).toEqual([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]]);
  });

  it('stops when the next URL repeats a visited page (loop guard)', async () => {
    // The endpoint keeps pointing rel="next" back at the same URL.
    const fetchMock = vi.fn().mockResolvedValue(makeResponse([{ id: 'a' }], `${BASE}/p1`));
    vi.stubGlobal('fetch', fetchMock);

    const pages: unknown[][] = [];
    await client.getPaginatedEach(`${BASE}/p1`, (page) => {
      pages.push(page);
      return Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pages).toHaveLength(1);
  });

  it('does not invoke the callback for an empty page but keeps paginating', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse([], `${BASE}/p2`))
      .mockResolvedValueOnce(makeResponse([{ id: 'x' }], null));
    vi.stubGlobal('fetch', fetchMock);

    const pages: unknown[][] = [];
    await client.getPaginatedEach(`${BASE}/p1`, (page) => {
      pages.push(page);
      return Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pages).toEqual([[{ id: 'x' }]]);
  });

  it('getPaginated accumulates every page into one array', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse([{ id: 'a' }], `${BASE}/p2`))
      .mockResolvedValueOnce(makeResponse([{ id: 'b' }], null));
    vi.stubGlobal('fetch', fetchMock);

    const all = await client.getPaginated<{ id: string }>(`${BASE}/p1`);

    expect(all).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

describe('OcpiClient SSRF policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends every request through safeFetch with the partner private-network flag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse([], null));
    vi.stubGlobal('fetch', fetchMock);

    await client.get(`${BASE}/a`);
    const privatePeer = new OcpiClient({
      token: 'tok',
      fromCountryCode: 'US',
      fromPartyId: 'EVT',
      toCountryCode: 'NL',
      toPartyId: 'SIM',
      allowPrivateNetwork: true,
    });
    await privatePeer.get('http://ocpi-simulator:7105/b');

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'manual',
      allowPrivateNetworks: false,
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ allowPrivateNetworks: true });
  });

  it('follows a redirect manually, keeping the method and body for the next hop', async () => {
    const redirect = {
      status: 307,
      ok: false,
      headers: { get: (h: string) => (h.toLowerCase() === 'location' ? '/moved' : null) },
      body: null,
    } as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(makeResponse([], null));
    vi.stubGlobal('fetch', fetchMock);

    await client.post(`${BASE}/cmd`, { a: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${BASE}/moved`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{"a":1}' });
  });
});
