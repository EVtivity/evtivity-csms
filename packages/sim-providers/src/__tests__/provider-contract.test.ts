// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The cases every SIM provider adapter must pass, run over real HTTP against a
// small stub server with a few canned replies per case. A new adapter adds one
// entry to SUBJECTS.

import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HologramProvider, hologramFactory } from '../hologram/adapter.js';
import { SimProviderError } from '../types.js';
import type {
  SimAlertKind,
  SimConnectionResult,
  SimProvider,
  SimProviderErrorKind,
  SimRef,
} from '../types.js';

interface StubRequest {
  method: string;
  url: URL;
  headers: IncomingMessage['headers'];
  body: unknown;
}

interface StubReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A canned reply for one method and path; `hang` never answers. */
interface StubRoute {
  method: 'GET' | 'POST';
  path: string;
  reply: (req: StubRequest) => StubReply | 'hang';
}

interface Stub {
  baseUrl: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

async function startStub(routes: StubRoute[]): Promise<Stub> {
  const requests: StubRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const request: StubRequest = {
        method: req.method ?? 'GET',
        url,
        headers: req.headers,
        body: await readBody(req),
      };
      requests.push(request);
      const route = routes.find((r) => r.method === request.method && r.path === url.pathname);
      const reply =
        route == null ? { status: 404, body: { success: false } } : route.reply(request);
      if (reply === 'hang') return;
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

interface ContractSubject {
  name: string;
  create: (baseUrl: string, timeoutMs?: number) => SimProvider;
  iccid: string;
  ref: SimRef;
  lookup: (hit: boolean) => StubRoute[];
  status: (openSession: boolean) => StubRoute[];
  /** Two pages of closed sessions, newest first, the second after the first's last id. */
  sessions: () => StubRoute[];
  /** One record per alert kind and one record without a known topic, over two pages. */
  alerts: () => StubRoute[];
  reset: (outcome: 'accepted' | 'unsupported') => StubRoute[];
  /**
   * The stored account holds no SIMs and one other account the key reaches
   * holds 3; a third answers 403 to the count and is left out.
   */
  connection: () => StubRoute[];
  connectionResult: SimConnectionResult;
  /** Any reply on the first path of testConnection. */
  anyReply: (reply: StubReply | 'hang') => StubRoute[];
  invalidKeyReply: StubReply;
  /** Checks a request carries the subject's auth and account scope. */
  expectAuthorized: (req: StubRequest) => void;
}

// --- Hologram ---------------------------------------------------------------

const HOLOGRAM_KEY = 'contract-key';
const HOLOGRAM_ORG = '1000001';
const H = '/hologram/api/1';

const hologramLink = (state = 'LIVE'): Record<string, unknown> => ({
  id: 5001,
  simcardid: 6001,
  deviceid: 4001,
  sim: '8900000000000000011',
  imsi: 310260000000001,
  state,
  apn: 'hologram',
  profile_name: 'Global-3',
  overagelimit: 0,
});

const hologramDevice = (state = 'LIVE'): Record<string, unknown> => ({
  id: 4001,
  simcardid: 6001,
  intended_plan_data: 10_000_000,
  links: { cellular: [hologramLink(state)] },
});

function usageRecord(id: number, day: number): Record<string, unknown> {
  const date = `2026-10-${String(day).padStart(2, '0')}`;
  return {
    linkid: 5001,
    record_id: id,
    session_begin: `${date} 08:00:00`,
    timestamp: `${date} 09:00:00`,
    bytes: 1000 + id,
    cellid: 100 + id,
    radio_access_technology: 'LTE',
    network_name: 'Test Network',
  };
}

const hologram: ContractSubject = {
  name: 'hologram',
  create: (baseUrl, timeoutMs) =>
    timeoutMs == null
      ? (hologramFactory.create(
          { hologram: { enabled: true, apiKey: HOLOGRAM_KEY, orgId: HOLOGRAM_ORG } },
          { testBaseUrl: baseUrl },
        ) as SimProvider)
      : new HologramProvider({
          apiKey: HOLOGRAM_KEY,
          orgId: HOLOGRAM_ORG,
          baseUrl: `${baseUrl}${H}`,
          timeoutMs,
        }),
  iccid: '8900000000000000011',
  ref: { providerSimId: '4001', linkId: '5001', simcardId: '6001' },
  lookup: (hit) => [
    {
      method: 'GET',
      path: `${H}/devices`,
      reply: () => ({ status: 200, body: { success: true, data: hit ? [hologramDevice()] : [] } }),
    },
  ],
  status: (openSession) => [
    {
      method: 'GET',
      path: `${H}/devices/4001`,
      reply: () => ({ status: 200, body: { success: true, data: hologramDevice() } }),
    },
    {
      method: 'GET',
      path: `${H}/usage/billing/simcard/6001`,
      reply: () => ({
        status: 200,
        body: {
          success: true,
          data: {
            current_billing_usage: 4096,
            linkids: [5001],
            simcardid: 6001,
            billing_period_end: '2026-11-20 00:00:00',
            most_recent_sessions: [
              {
                linkid: 5001,
                session_begin: '2026-10-20 08:00:00',
                session_end: '2026-10-20 09:00:00',
                session_bytes: 100,
              },
            ],
            open_sessions: openSession
              ? [{ linkid: 5001, session_begin: '2026-10-21 10:00:00', bytes: 10 }]
              : [],
          },
        },
      }),
    },
  ],
  sessions: () => [
    {
      method: 'GET',
      path: `${H}/usage/data/`,
      reply: (req) =>
        req.url.searchParams.get('startafter') === '18'
          ? {
              status: 200,
              body: { success: true, continues: false, lastid: 17, data: [usageRecord(17, 10)] },
            }
          : {
              status: 200,
              body: {
                success: true,
                continues: true,
                lastid: 18,
                data: [usageRecord(20, 20), usageRecord(19, 15), usageRecord(18, 12)],
              },
            },
    },
  ],
  alerts: () => {
    const csr = (id: number, topic: string): Record<string, unknown> => ({
      id,
      logged: `2026-10-${String(id).padStart(2, '0')} 12:00:00`,
      deviceid: 4001,
      tags: [topic],
      data: '{}',
    });
    return [
      {
        method: 'GET',
        path: `${H}/csr/data`,
        reply: (req) =>
          req.url.searchParams.get('startafter') === '18'
            ? {
                status: 200,
                body: {
                  success: true,
                  continues: false,
                  lastid: 15,
                  data: [csr(17, '_IMEI_TAC_CHANGE_'), csr(16, '_IMEI_FIRST_'), csr(15, '_OTHER_')],
                },
              }
            : {
                status: 200,
                body: {
                  success: true,
                  continues: true,
                  lastid: 18,
                  data: [
                    csr(20, '_DATALIMIT_'),
                    csr(19, '_DATAWARNING_'),
                    csr(18, '_IMEI_CHANGE_'),
                  ],
                },
              },
      },
    ];
  },
  reset: (outcome) => [
    {
      method: 'GET',
      path: `${H}/devices/4001`,
      reply: () => ({ status: 200, body: { success: true, data: hologramDevice() } }),
    },
    {
      method: 'POST',
      path: `${H}/links/cellular/updatelocation`,
      reply: () =>
        outcome === 'accepted'
          ? { status: 200, body: { success: true } }
          : {
              status: 400,
              body: {
                success: false,
                error: 'Some links are not able to update location due to carrier limitations',
                data: { '5001': 'carrier limitations' },
              },
            },
    },
  ],
  connection: () => [
    {
      method: 'GET',
      path: `${H}/organizations/${HOLOGRAM_ORG}`,
      reply: () => ({ status: 200, body: { success: true, data: { id: 1000001, name: 'Own' } } }),
    },
    {
      method: 'GET',
      path: `${H}/organizations`,
      reply: () => ({
        status: 200,
        body: {
          success: true,
          continues: false,
          data: [
            { id: 1000001, name: 'Own' },
            { id: 2000002, name: 'Company' },
            { id: 3000003, name: 'Locked' },
          ],
        },
      }),
    },
    {
      method: 'GET',
      path: `${H}/devices/count`,
      reply: (req) => {
        const orgid = req.url.searchParams.get('orgid');
        if (orgid === '3000003') {
          return { status: 403, body: { success: false, error: 'Forbidden' } };
        }
        return { status: 200, body: { success: true, data: orgid === '2000002' ? 3 : 0 } };
      },
    },
  ],
  connectionResult: {
    deviceCount: 0,
    otherOrganizations: [{ id: '2000002', name: 'Company', deviceCount: 3 }],
  },
  anyReply: (reply) => [
    { method: 'GET', path: `${H}/organizations/${HOLOGRAM_ORG}`, reply: () => reply },
  ],
  invalidKeyReply: { status: 403, body: { success: false, error: 'Invalid API Key' } },
  expectAuthorized: (req) => {
    expect(req.url.pathname.startsWith(`${H}/`)).toBe(true);
    expect(req.headers.authorization).toBe(
      `Basic ${Buffer.from(`apikey:${HOLOGRAM_KEY}`).toString('base64')}`,
    );
    // Test Connection lists every organization (no orgid) and counts SIMs in each one.
    if (req.url.pathname === `${H}/organizations`) {
      expect(req.url.searchParams.has('orgid')).toBe(false);
    } else if (req.url.pathname === `${H}/devices/count`) {
      expect(req.url.searchParams.get('orgid')).toMatch(/^\d+$/);
    } else {
      expect(req.url.searchParams.get('orgid')).toBe(HOLOGRAM_ORG);
    }
  },
};

const SUBJECTS: ContractSubject[] = [hologram];

// --- Contract -----------------------------------------------------------------

async function errorOf(promise: Promise<unknown>): Promise<SimProviderError> {
  try {
    await promise;
  } catch (err: unknown) {
    if (err instanceof SimProviderError) return err;
    throw err;
  }
  throw new Error('expected a SimProviderError');
}

const RANGE = { from: new Date('2026-07-23T00:00:00Z'), to: new Date('2026-10-21T00:00:00Z') };

describe.each(SUBJECTS)('SIM provider contract: $name', (subject) => {
  let stub: Stub | null = null;

  async function run(routes: StubRoute[], timeoutMs?: number) {
    stub = await startStub(routes);
    return { sim: subject.create(stub.baseUrl, timeoutMs), requests: stub.requests };
  }

  afterEach(async () => {
    if (stub != null) {
      for (const req of stub.requests) subject.expectAuthorized(req);
      await stub.close();
      stub = null;
    }
  });

  it('finds a SIM by ICCID and answers null for an unknown one', async () => {
    const hit = await run(subject.lookup(true));
    expect(await hit.sim.findByIccid(subject.iccid)).toEqual(subject.ref);
    await stub?.close();
    stub = null;
    const miss = await run(subject.lookup(false));
    expect(await miss.sim.findByIccid(subject.iccid)).toBeNull();
  });

  it('maps the status with an open session', async () => {
    const { sim } = await run(subject.status(true));
    const status = await sim.getStatus(subject.ref);
    expect(status.state).toBe('active');
    expect(status.inSession).toBe(true);
    expect(status.openSessionBeganAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(status.usage?.bytes).toBeGreaterThan(0);
    expect(status.usage?.periodEnd).toMatch(/Z$/);
  });

  it('maps the status without an open session', async () => {
    const { sim } = await run(subject.status(false));
    const status = await sim.getStatus(subject.ref);
    expect(status.inSession).toBe(false);
    expect(status.openSessionBeganAt).toBeNull();
    expect(status.lastSessionAt).not.toBeNull();
  });

  it('pages closed sessions newest first, so a caller can stop at a known record id', async () => {
    const { sim } = await run(subject.sessions());
    const first = await sim.listSessions(subject.ref, {});
    expect(first.continues).toBe(true);
    expect(first.lastId).not.toBeNull();
    const second = await sim.listSessions(subject.ref, { startAfter: first.lastId ?? '' });
    expect(second.continues).toBe(false);
    const ids = [...first.items, ...second.items].map((s) => Number(s.providerSessionId));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(ids.length);
    const starts = [...first.items, ...second.items].map((s) => s.startedAt);
    expect(starts).toEqual([...starts].sort().reverse());
    for (const session of [...first.items, ...second.items]) {
      expect(Date.parse(session.endedAt)).toBeGreaterThanOrEqual(Date.parse(session.startedAt));
    }
  });

  it('pages alerts and maps each topic, skipping unknown ones', async () => {
    const { sim } = await run(subject.alerts());
    const first = await sim.listAlerts(subject.ref, { range: RANGE });
    expect(first.continues).toBe(true);
    const second = await sim.listAlerts(subject.ref, {
      range: RANGE,
      startAfter: first.lastId ?? '',
    });
    expect(second.continues).toBe(false);
    const kinds = [...first.items, ...second.items].map((a) => a.kind);
    const expected: SimAlertKind[] = [
      'data_limit',
      'data_warning',
      'device_changed',
      'device_model_changed',
      'first_device',
    ];
    expect(kinds).toEqual(expected);
  });

  it('accepts a network reset', async () => {
    const { sim } = await run(subject.reset('accepted'));
    expect(await sim.resetNetwork(subject.ref)).toEqual({ status: 'accepted' });
  });

  it('tests the connection and counts SIMs in the stored and the other organizations', async () => {
    const { sim } = await run(subject.connection());
    expect(await sim.testConnection()).toEqual(subject.connectionResult);
  });

  it('maps a reset the provider refuses to unsupported', async () => {
    const { sim } = await run(subject.reset('unsupported'));
    expect((await errorOf(sim.resetNetwork(subject.ref))).kind).toBe('unsupported');
  });

  const errorCases: [string, () => StubReply, SimProviderErrorKind][] = [
    ['an invalid key', () => subject.invalidKeyReply, 'auth'],
    [
      'another 403',
      () => ({ status: 403, body: { success: false, error: 'Forbidden' } }),
      'unsupported',
    ],
    ['a 429', () => ({ status: 429, headers: { 'retry-after': '7' } }), 'rate_limited'],
    ['a 500', () => ({ status: 500, body: { success: false } }), 'unavailable'],
  ];

  it.each(errorCases)('maps %s', async (_name, reply, kind) => {
    const { sim } = await run(subject.anyReply(reply()));
    const err = await errorOf(sim.testConnection());
    expect(err.kind).toBe(kind);
    if (kind === 'rate_limited') expect(err.retryAfterSeconds).toBe(7);
  });

  it('maps a timeout to unavailable', async () => {
    const { sim } = await run(subject.anyReply('hang'), 100);
    expect((await errorOf(sim.testConnection())).kind).toBe('unavailable');
  });
});
