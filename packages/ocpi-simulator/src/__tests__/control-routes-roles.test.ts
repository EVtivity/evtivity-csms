// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { controlRoutes } from '../routes/control.js';
import { state, pushBounded, findPartnerEndpoint } from '../state.js';
import { ocpiGet, ocpiPost } from '../client.js';

type Call = [string, RequestInit | undefined];
const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
  Promise.resolve(
    new Response(
      JSON.stringify({ data: { result: 'ACCEPTED' }, status_code: 1000, status_message: 'OK' }),
    ),
  ),
);

const BASE = 'http://localhost:7104/ocpi/2.2.1';
const ENDPOINTS = [
  { identifier: 'tokens', role: 'RECEIVER' as const, url: `${BASE}/cpo/tokens` },
  { identifier: 'locations', role: 'SENDER' as const, url: `${BASE}/cpo/locations` },
  { identifier: 'commands', role: 'RECEIVER' as const, url: `${BASE}/cpo/commands` },
  { identifier: 'locations', role: 'RECEIVER' as const, url: `${BASE}/emsp/locations` },
  { identifier: 'sessions', role: 'RECEIVER' as const, url: `${BASE}/emsp/sessions` },
  { identifier: 'cdrs', role: 'RECEIVER' as const, url: `${BASE}/emsp/cdrs` },
];

async function build(role: 'emsp' | 'cpo'): Promise<FastifyInstance> {
  state.role = role;
  const app = Fastify();
  await app.register(controlRoutes);
  await app.ready();
  return app;
}

function sent(i = 0): { url: string; method: string; body: Record<string, unknown> | null } {
  const [url, init] = fetchMock.mock.calls[i] as Call;
  return {
    url,
    method: init?.method ?? 'GET',
    body:
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
  };
}

let emsp: FastifyInstance;
let cpo: FastifyInstance;

beforeAll(async () => {
  emsp = await build('emsp');
  cpo = await build('cpo');
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('OCPI_SIM_TARGET_ORIGIN', 'http://ocpi:7104');
  state.isRegistered = true;
  state.theirToken = 'their-token';
  state.partnerEndpoints = [...ENDPOINTS];
});

afterEach(() => {
  fetchMock.mockClear();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await emsp.close();
  await cpo.close();
});

const EMSP_ROUTES = [
  '/sim/push-token',
  '/sim/pull-locations',
  '/sim/start-session',
  '/sim/stop-session',
];
const CPO_ROUTES = ['/sim/push-location', '/sim/push-session', '/sim/push-cdr'];

describe('control routes by role', () => {
  it('registers only the routes of its role', async () => {
    for (const url of CPO_ROUTES) {
      expect((await emsp.inject({ method: 'POST', url })).statusCode).toBe(404);
    }
    for (const url of EMSP_ROUTES) {
      expect((await cpo.inject({ method: 'POST', url })).statusCode).toBe(404);
    }
  });

  it('refuses every action before registration, without a request', async () => {
    state.isRegistered = false;
    for (const [app, urls] of [
      [emsp, EMSP_ROUTES],
      [cpo, CPO_ROUTES],
    ] as const) {
      for (const url of urls) {
        const res = await app.inject({ method: 'POST', url, payload: {} });
        expect(res.statusCode).toBe(503);
        expect(res.json<{ error: string }>().error).toMatch(/Not registered/);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 503 naming the missing partner endpoint', async () => {
    state.partnerEndpoints = [];
    const cases: Array<[FastifyInstance, string, Record<string, unknown>, RegExp]> = [
      [emsp, '/sim/push-token', {}, /tokens receiver/],
      [emsp, '/sim/pull-locations', {}, /locations sender/],
      [emsp, '/sim/start-session', { location_id: 'L1' }, /commands receiver/],
      [emsp, '/sim/stop-session', { session_id: 'S1' }, /commands receiver/],
      [cpo, '/sim/push-location', {}, /locations receiver/],
      [cpo, '/sim/push-session', {}, /sessions receiver/],
      [cpo, '/sim/push-cdr', {}, /CDRs receiver/],
    ];
    for (const [app, url, payload, message] of cases) {
      const res = await app.inject({ method: 'POST', url, payload });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ error: string }>().error).toMatch(message);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dumps the state', async () => {
    state.receivedSessions = [];
    const res = await emsp.inject({ method: 'GET', url: '/sim/state' });
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      isRegistered: true,
      identity: { countryCode: 'NL', partyId: 'SIM' },
      testTokenUid: state.testTokenUid,
    });
    expect(body).not.toHaveProperty('theirToken');
    expect(body).not.toHaveProperty('ourToken');
  });
});

describe('eMSP controls', () => {
  it('pushes the test token to the CPO receiver path of our party', async () => {
    const res = await emsp.inject({ method: 'POST', url: '/sim/push-token' });
    expect(res.statusCode).toBe(200);
    const call = sent();
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`http://ocpi:7104/ocpi/2.2.1/cpo/tokens/NL/SIM/${state.testTokenUid}`);
    expect(call.body).toMatchObject({ uid: state.testTokenUid, valid: true, whitelist: 'ALLOWED' });
    const auth = (fetchMock.mock.calls[0] as Call)[1]?.headers as Record<string, string>;
    expect(auth['Authorization']).toBe(`Token ${Buffer.from('their-token').toString('base64')}`);
  });

  it('pulls the CPO locations and counts them', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: 'a' }, { id: 'b' }],
          status_code: 1000,
          status_message: 'OK',
        }),
      ),
    );
    const res = await emsp.inject({ method: 'POST', url: '/sim/pull-locations' });
    expect(res.json()).toEqual({ count: 2, locations: [{ id: 'a' }, { id: 'b' }] });
    expect(sent().method).toBe('GET');
  });

  it('needs a location id to start a session and sends the EVSE and connector only when given', async () => {
    expect(
      (await emsp.inject({ method: 'POST', url: '/sim/start-session', payload: {} })).statusCode,
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    await emsp.inject({
      method: 'POST',
      url: '/sim/start-session',
      payload: { location_id: 'LOC1' },
    });
    const bare = sent(0);
    expect(bare.url).toBe('http://ocpi:7104/ocpi/2.2.1/cpo/commands/START_SESSION');
    expect(bare.body).toMatchObject({
      location_id: 'LOC1',
      response_url: `${state.baseUrl}/ocpi/2.2.1/emsp/commands/START_SESSION/callback`,
    });
    expect(bare.body).not.toHaveProperty('evse_uid');
    expect(bare.body).not.toHaveProperty('connector_id');

    const res = await emsp.inject({
      method: 'POST',
      url: '/sim/start-session',
      payload: { location_id: 'LOC1', evse_uid: 'E1', connector_id: '2' },
    });
    expect(sent(1).body).toMatchObject({ evse_uid: 'E1', connector_id: '2' });
    expect(res.json<{ response: unknown }>().response).toEqual({ result: 'ACCEPTED' });
  });

  it('needs a session id to stop a session', async () => {
    expect(
      (await emsp.inject({ method: 'POST', url: '/sim/stop-session', payload: {} })).statusCode,
    ).toBe(400);
    await emsp.inject({ method: 'POST', url: '/sim/stop-session', payload: { session_id: 'S9' } });
    expect(sent()).toMatchObject({
      url: 'http://ocpi:7104/ocpi/2.2.1/cpo/commands/STOP_SESSION',
      method: 'POST',
      body: { session_id: 'S9' },
    });
  });
});

describe('CPO controls', () => {
  it('pushes a location to the eMSP receiver', async () => {
    const res = await cpo.inject({ method: 'POST', url: '/sim/push-location' });
    expect(res.statusCode).toBe(200);
    expect(sent()).toMatchObject({
      method: 'PUT',
      url: 'http://ocpi:7104/ocpi/2.2.1/emsp/locations/NL/SIM/NL-SIM-LOC001',
      body: { id: 'NL-SIM-LOC001', publish: true },
    });
  });

  it('pushes a session with a generated id and the sent energy', async () => {
    const res = await cpo.inject({
      method: 'POST',
      url: '/sim/push-session',
      payload: { kwh: 7.5 },
    });
    const pushed = res.json<{ pushed: { id: string; kwh: number } }>().pushed;
    expect(pushed.id).toMatch(/^SIM-SESSION-\d+$/);
    expect(pushed.kwh).toBe(7.5);
    expect(sent().url).toBe(`http://ocpi:7104/ocpi/2.2.1/emsp/sessions/NL/SIM/${pushed.id}`);
  });

  it('refuses a session id that is not a string', async () => {
    const res = await cpo.inject({
      method: 'POST',
      url: '/sim/push-session',
      payload: { session_id: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a CDR with the sent energy, else 10 kWh', async () => {
    await cpo.inject({ method: 'POST', url: '/sim/push-cdr', payload: { total_energy: 3 } });
    expect(sent(0)).toMatchObject({
      method: 'POST',
      url: 'http://ocpi:7104/ocpi/2.2.1/emsp/cdrs',
      body: { total_energy: 3, currency: 'USD' },
    });
    await cpo.inject({ method: 'POST', url: '/sim/push-cdr' });
    expect(sent(1).body).toMatchObject({ total_energy: 10 });
  });

  it('answers 500 when the partner replies with an OCPI error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: null, status_code: 2001, status_message: 'Invalid' })),
    );
    const res = await cpo.inject({ method: 'POST', url: '/sim/push-cdr' });
    expect(res.statusCode).toBe(500);
  });
});

describe('client', () => {
  it('needs a token from registration unless one is given', async () => {
    state.theirToken = null;
    await expect(ocpiGet(`${BASE}/x`)).rejects.toThrow(/theirToken is null/);
    await ocpiPost(`${BASE}/x`, { a: 1 }, 'explicit');
    const headers = (fetchMock.mock.calls[0] as Call)[1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Token ${Buffer.from('explicit').toString('base64')}`);
    expect(headers['OCPI-from-country-code']).toBe('NL');
  });

  it('names the status of an OCPI error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: null, status_code: 3000, status_message: 'Server' })),
    );
    await expect(ocpiGet(`${BASE}/x`)).rejects.toThrow(/OCPI error 3000 from .*: Server/);
  });

  it('refuses a URL off the target origin before any request', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('OCPI_SIM_TARGET_ORIGIN', '');
    vi.stubEnv('OCPI_TARGET_URL', 'http://ocpi:7104');
    await expect(ocpiGet('http://elsewhere.example/x')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a request that hangs past the timeout', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      );
      const pending = ocpiGet(`${BASE}/x`);
      const assertion = expect(pending).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('state helpers', () => {
  it('keeps at most the configured number of records, dropping the oldest', () => {
    const list: number[] = [];
    for (let i = 0; i < 600; i++) pushBounded(list, i);
    expect(list).toHaveLength(500);
    expect(list[0]).toBe(100);
  });

  it('finds a partner endpoint by module and role', () => {
    expect(findPartnerEndpoint('locations', 'SENDER')).toBe(`${BASE}/cpo/locations`);
    expect(findPartnerEndpoint('tariffs', 'SENDER')).toBeNull();
  });
});
