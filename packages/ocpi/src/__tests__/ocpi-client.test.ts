// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OcpiClient } from '../lib/ocpi-client.js';

// 127.0.0.1 is a literal IP, so the client's SSRF guard skips DNS and allows it
// (loopback is permitted), keeping these tests offline and deterministic.
const BASE = 'http://127.0.0.1';

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
