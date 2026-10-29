// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimProviderError } from '../../types.js';
import { OneNceClient, ONENCE_MAX_REPLY_BYTES, ONENCE_MAX_TOKEN_REPLY_BYTES } from '../client.js';

const CLIENT_ID = 'client-id-123';
const SECRET = 'very-secret-value';
const ICCID = '8988303000000000010';
const BASE = 'https://1nce.test/management-api';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function tokenReply(token: string, expiresIn: unknown = 3600): Response {
  return json({
    status_code: 200,
    access_token: token,
    token_type: 'bearer',
    expires_in: expiresIn,
    userId: 'u',
    scope: 'all',
  });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function stub(handler: Handler) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(handler(url, init ?? {})),
  );
  const client = new OneNceClient({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    baseUrl: `${BASE}/`,
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

function isToken(url: string): boolean {
  return url.endsWith('/oauth/token');
}

const GET_SIM = { method: 'GET' as const, path: `/v2/sims/${ICCID}`, label: '/v2/sims/{iccid}' };

async function caught(promise: Promise<unknown>): Promise<SimProviderError> {
  try {
    await promise;
  } catch (err: unknown) {
    if (err instanceof SimProviderError) return err;
    throw err;
  }
  throw new Error('expected a SimProviderError');
}

function expectNoSecrets(err: SimProviderError, token = 'tok-1'): void {
  const text = `${String(err)} ${JSON.stringify(err)} ${err.message}`;
  for (const value of [ICCID, CLIENT_ID, SECRET, token]) expect(text).not.toContain(value);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OneNceClient token', () => {
  it('asks for a client credentials token with HTTP Basic and refuses redirects', async () => {
    const { client, fetchMock } = stub((url) => (isToken(url) ? tokenReply('tok-1') : json({})));
    await client.request(GET_SIM);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] ?? [];
    expect(tokenUrl).toBe(`${BASE}/oauth/token`);
    expect(tokenInit?.method).toBe('POST');
    expect(tokenInit?.redirect).toBe('error');
    expect((tokenInit?.headers as Record<string, string>)['Authorization']).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`,
    );
    expect(JSON.parse(tokenInit?.body as string)).toEqual({ grant_type: 'client_credentials' });
    const [apiUrl, apiInit] = fetchMock.mock.calls[1] ?? [];
    expect(apiUrl).toBe(`${BASE}/v2/sims/${ICCID}`);
    expect(apiInit?.redirect).toBe('error');
    expect((apiInit?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-1');
  });

  it('fetches one token for two parallel calls and reuses it', async () => {
    const { client, fetchMock } = stub((url) => (isToken(url) ? tokenReply('tok-1') : json({})));
    await Promise.all([client.request(GET_SIM), client.request(GET_SIM)]);
    await client.request(GET_SIM);
    expect(fetchMock.mock.calls.filter(([url]) => isToken(url))).toHaveLength(1);
  });

  it('fetches a new token after the old one expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let n = 0;
    const { client, fetchMock } = stub((url) =>
      isToken(url) ? tokenReply(`tok-${String(++n)}`, 120) : json({}),
    );
    await client.request(GET_SIM);
    vi.setSystemTime(Date.now() + 59_000);
    await client.request(GET_SIM);
    expect(fetchMock.mock.calls.filter(([url]) => isToken(url))).toHaveLength(1);
    // Renewed 60 s before the stated expiry.
    vi.setSystemTime(Date.now() + 2_000);
    await client.request(GET_SIM);
    expect(fetchMock.mock.calls.filter(([url]) => isToken(url))).toHaveLength(2);
    const last = fetchMock.mock.calls.at(-1)?.[1];
    expect((last?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-2');
  });

  it('keeps a token with an unusable expires_in for 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const expiresIn of ['3600', 5, 999_999, null]) {
      const { client, fetchMock } = stub((url) =>
        isToken(url) ? tokenReply('tok-1', expiresIn) : json({}),
      );
      await client.request(GET_SIM);
      vi.setSystemTime(Date.now() + 230_000);
      await client.request(GET_SIM);
      vi.setSystemTime(Date.now() + 20_000);
      await client.request(GET_SIM);
      expect(fetchMock.mock.calls.filter(([url]) => isToken(url))).toHaveLength(2);
    }
  });

  it('maps wrong credentials to auth without naming them', async () => {
    const { client } = stub((url) =>
      isToken(url)
        ? json(
            {
              statusCode: 400,
              errorCode: 'BadCredentials',
              message: `Incorrect username or password for ${CLIENT_ID}`,
            },
            { status: 400 },
          )
        : json({}),
    );
    const err = await caught(client.request(GET_SIM));
    expect(err.kind).toBe('auth');
    expect(err.message).toBe('1NCE refused the client credentials');
    expectNoSecrets(err);
  });

  it('refuses a token reply without a usable token', async () => {
    for (const reply of [
      json({ token_type: 'bearer' }),
      json({ access_token: '' }),
      json({ access_token: 'x'.repeat(8193) }),
      new Response('not json'),
    ]) {
      const { client } = stub((url) => (isToken(url) ? reply.clone() : json({})));
      expect((await caught(client.request(GET_SIM))).kind).toBe('unavailable');
    }
  });

  it('refuses a token reply over 16 KB unread', async () => {
    const { client } = stub((url) =>
      isToken(url)
        ? new Response(JSON.stringify({ access_token: 'x'.repeat(ONENCE_MAX_TOKEN_REPLY_BYTES) }))
        : json({}),
    );
    const err = await caught(client.request(GET_SIM));
    expect(err.kind).toBe('unavailable');
    expect(err.message).toContain('too large');
  });

  it('maps a token 429 to rate_limited and a 5xx to unavailable', async () => {
    const limited = stub((url) =>
      isToken(url) ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : json({}),
    );
    const err = await caught(limited.client.request(GET_SIM));
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterSeconds).toBe(7);
    const down = stub((url) => (isToken(url) ? new Response('<html>', { status: 502 }) : json({})));
    expect((await caught(down.client.request(GET_SIM))).kind).toBe('unavailable');
  });
});

describe('OneNceClient requests', () => {
  it('drops a refused token, fetches a new one and retries once', async () => {
    let n = 0;
    let api = 0;
    const { client, fetchMock } = stub((url) => {
      if (isToken(url)) return tokenReply(`tok-${String(++n)}`);
      api += 1;
      return api === 1 ? json({ message: 'idtoken not found' }, { status: 401 }) : json({ ok: 1 });
    });
    const reply = await client.request(GET_SIM);
    expect(reply.body).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const last = fetchMock.mock.calls.at(-1)?.[1];
    expect((last?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-2');
  });

  it('answers auth when the new token is refused too', async () => {
    let n = 0;
    const { client } = stub((url) =>
      isToken(url)
        ? tokenReply(`tok-${String(++n)}`)
        : json({ message: 'Missing Authorization header' }, { status: 401 }),
    );
    const err = await caught(client.request(GET_SIM));
    expect(err.kind).toBe('auth');
    expectNoSecrets(err, 'tok-2');
  });

  it('maps the error statuses', async () => {
    const cases: [number, string][] = [
      [403, 'unsupported'],
      [404, 'not_found'],
      [409, 'unsupported'],
      [400, 'unavailable'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ];
    for (const [status, kind] of cases) {
      const { client } = stub((url) =>
        isToken(url)
          ? tokenReply('tok-1')
          : json(
              { error_code: status, error_token: 'x', message: `No sim found for ${ICCID}` },
              { status },
            ),
      );
      const err = await caught(client.request(GET_SIM));
      expect(err.kind).toBe(kind);
      expect(err.message).toBe(
        `1NCE GET /v2/sims/{iccid} answered ${String(status)}`.replace(
          ' answered 403',
          ' is not allowed for this client',
        ),
      );
      expectNoSecrets(err);
    }
  });

  it('maps a 400 by the request when it says so', async () => {
    const { client } = stub((url) =>
      isToken(url) ? tokenReply('tok-1') : json({}, { status: 400 }),
    );
    expect((await caught(client.request({ ...GET_SIM, badRequest: 'not_found' }))).kind).toBe(
      'not_found',
    );
  });

  it('reads the wait of a 429 from Retry-After, then ratelimit-reset, else 60 s', async () => {
    const cases: [Record<string, string>, number][] = [
      [{ 'retry-after': '7' }, 7],
      [{ 'ratelimit-reset': '1' }, 1],
      [{ 'retry-after': new Date(Date.now() + 30_000).toUTCString() }, 30],
      [{ 'retry-after': '999999' }, 3600],
      [{}, 60],
      [{ 'ratelimit-reset': '' }, 60],
    ];
    for (const [headers, wait] of cases) {
      const { client } = stub((url) =>
        isToken(url) ? tokenReply('tok-1') : new Response('', { status: 429, headers }),
      );
      const err = await caught(client.request(GET_SIM));
      expect(err.kind).toBe('rate_limited');
      expect(Math.abs((err.retryAfterSeconds ?? 0) - wait)).toBeLessThanOrEqual(1);
    }
  });

  it('refuses a reply over the size limit, declared or streamed', async () => {
    const declared = stub((url) =>
      isToken(url)
        ? tokenReply('tok-1')
        : new Response('[]', {
            headers: { 'content-length': String(ONENCE_MAX_REPLY_BYTES + 1) },
          }),
    );
    expect((await caught(declared.client.request(GET_SIM))).message).toContain('too large');
    const streamed = stub((url) =>
      isToken(url) ? tokenReply('tok-1') : new Response('x'.repeat(ONENCE_MAX_REPLY_BYTES + 1)),
    );
    expect((await caught(streamed.client.request(GET_SIM))).message).toContain('too large');
  });

  it('maps a non-JSON error by its status and a non-JSON 200 to unavailable', async () => {
    const proxy = stub((url) =>
      isToken(url) ? tokenReply('tok-1') : new Response('<html>Bad Gateway', { status: 502 }),
    );
    expect((await caught(proxy.client.request(GET_SIM))).message).toBe(
      '1NCE GET /v2/sims/{iccid} answered 502',
    );
    const garbled = stub((url) => (isToken(url) ? tokenReply('tok-1') : new Response('<html>')));
    expect((await caught(garbled.client.request(GET_SIM))).message).toContain('without valid JSON');
  });

  it('returns null for a 201 without a body and keeps the headers', async () => {
    const { client } = stub((url) =>
      isToken(url)
        ? tokenReply('tok-1')
        : new Response(null, { status: 201, headers: { 'x-total-count': '3' } }),
    );
    const reply = await client.request({ method: 'POST', path: '/x', label: '/x' });
    expect(reply.body).toBeNull();
    expect(reply.headers.get('x-total-count')).toBe('3');
  });

  it('sends the query and names no id when the network fails', async () => {
    const { client, fetchMock } = stub((url) => {
      if (isToken(url)) return tokenReply('tok-1');
      throw new TypeError(`fetch failed for ${url}`);
    });
    const err = await caught(
      client.request({ ...GET_SIM, query: { page: 2, pageSize: 1000, skip: undefined } }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${BASE}/v2/sims/${ICCID}?page=2&pageSize=1000`);
    expect(err.kind).toBe('unavailable');
    expect(err.message).toBe('1NCE GET /v2/sims/{iccid} failed: no reply');
  });

  it('waits for the rate limit window when a reply says no request is left', async () => {
    const sent: number[] = [];
    const { client } = stub((url) => {
      if (isToken(url)) return tokenReply('tok-1');
      sent.push(Date.now());
      return json({}, { headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': '0.08' } });
    });
    await client.request(GET_SIM);
    await client.request(GET_SIM);
    expect(sent).toHaveLength(2);
    expect((sent[1] ?? 0) - (sent[0] ?? 0)).toBeGreaterThanOrEqual(70);
  });

  it('sends at once while the window has requests left', async () => {
    const sent: number[] = [];
    const { client } = stub((url) => {
      if (isToken(url)) return tokenReply('tok-1');
      sent.push(Date.now());
      return json({}, { headers: { 'ratelimit-remaining': '5', 'ratelimit-reset': '1' } });
    });
    await client.request(GET_SIM);
    await client.request(GET_SIM);
    expect((sent[1] ?? 0) - (sent[0] ?? 0)).toBeLessThan(500);
  });
});
