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
import { ONENCE_PDP_EVENT_TYPES, OneNceProvider, oneNceFactory } from '../1nce/adapter.js';
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
  /** Closed sessions, newest first, over `sessionPages` pages (each after the last id). */
  sessions: () => StubRoute[];
  sessionPages: number;
  /** The order key of a session id: larger is newer. */
  sessionOrder: (providerSessionId: string) => number;
  /** Whether the status reports the last closed session (Hologram's billing usage does). */
  reportsLastSession: boolean;
  /** One record per alert kind the provider reports, over `alertPages` pages. */
  alerts: () => StubRoute[];
  alertPages: number;
  alertKinds: SimAlertKind[];
  reset: (outcome: 'accepted' | 'unsupported') => StubRoute[];
  /** `accepted` for a synchronous reset, `submitted` for a queued one. */
  resetStatus: 'accepted' | 'submitted';
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
          {
            hologram: { enabled: true, apiKey: HOLOGRAM_KEY, orgId: HOLOGRAM_ORG },
            '1nce': { enabled: false, clientId: '', clientSecret: '' },
          },
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
  sessionPages: 2,
  sessionOrder: Number,
  reportsLastSession: true,
  alertPages: 2,
  alertKinds: [
    'data_limit',
    'data_warning',
    'device_changed',
    'device_model_changed',
    'first_device',
  ],
  resetStatus: 'accepted',
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

// --- 1NCE ------------------------------------------------------------------------

const ONENCE_CLIENT = 'contract-client';
const ONENCE_SECRET = 'contract-secret';
const ONENCE_TOKEN = 'contract-token';
const N = '/1nce/management-api';
const ONENCE_ICCID = '8988303000000000010';

const oneNceToken: StubRoute = {
  method: 'POST',
  path: `${N}/oauth/token`,
  reply: (req) =>
    req.headers.authorization ===
    `Basic ${Buffer.from(`${ONENCE_CLIENT}:${ONENCE_SECRET}`).toString('base64')}`
      ? {
          status: 200,
          body: { access_token: ONENCE_TOKEN, token_type: 'bearer', expires_in: 3600 },
        }
      : {
          status: 400,
          body: { statusCode: 400, errorCode: 'BadCredentials', message: 'Incorrect' },
        },
};

function oneNceRoute(method: 'GET' | 'POST', path: string, reply: StubRoute['reply']): StubRoute {
  return { method, path: `${N}${path}`, reply };
}

const oneNceSim = (): Record<string, unknown> => ({
  iccid: ONENCE_ICCID,
  iccid_with_luhn: `${ONENCE_ICCID}6`,
  imsi: '901405100000018',
  imei: '869951030000001',
  status: 'Enabled',
  quota_status: {
    id: 2,
    threshold_reached_date: '2026-10-19T12:00:00.000Z',
    quota_exceeded_date: '2026-10-20T12:00:00.000Z',
  },
});

function oneNceEvent(
  id: number,
  type: 'create' | 'delete',
  context: number,
  day: number,
  hour: number,
  imei = '869951030000001',
): Record<string, unknown> {
  return {
    id,
    event_type: { id: ONENCE_PDP_EVENT_TYPES[type], description: `${type} PDP Context` },
    timestamp: `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    endpoint: { id: 1, imei },
    detail: {
      ...(type === 'delete' ? { volume: { tx: 0.001, rx: 0.002, total: 0.003 } } : {}),
      pdp_context: { pdp_context_id: context, apn: 'iot.1nce.net' },
    },
  };
}

const oneNce: ContractSubject = {
  name: '1nce',
  create: (baseUrl, timeoutMs) =>
    timeoutMs == null
      ? (oneNceFactory.create(
          {
            hologram: { enabled: false, apiKey: '', orgId: '' },
            '1nce': { enabled: true, clientId: ONENCE_CLIENT, clientSecret: ONENCE_SECRET },
          },
          { testBaseUrl: baseUrl },
        ) as SimProvider)
      : new OneNceProvider({
          clientId: ONENCE_CLIENT,
          clientSecret: ONENCE_SECRET,
          baseUrl: `${baseUrl}${N}`,
          timeoutMs,
        }),
  iccid: `${ONENCE_ICCID}6`,
  ref: { providerSimId: ONENCE_ICCID },
  sessionPages: 1,
  sessionOrder: (id) => Number(id.split(':').at(-1)),
  reportsLastSession: false,
  alertPages: 1,
  alertKinds: ['data_limit', 'data_warning', 'device_changed'],
  resetStatus: 'submitted',
  lookup: (hit) => [
    oneNceToken,
    oneNceRoute('GET', `/v2/sims/${ONENCE_ICCID}`, () =>
      hit ? { status: 200, body: oneNceSim() } : { status: 404, body: { error_code: 404 } },
    ),
  ],
  status: (openSession) => [
    oneNceToken,
    oneNceRoute('GET', `/v2/sims/${ONENCE_ICCID}`, () => ({ status: 200, body: oneNceSim() })),
    oneNceRoute('GET', `/v2/sims/${ONENCE_ICCID}/status`, () => ({
      status: 200,
      body: {
        status: { description: openSession ? 'ONLINE' : 'ATTACHED' },
        pdp_contexts: openSession
          ? [{ created: '2026-10-21T10:00:00.000Z', apn: 'iot.1nce.net' }]
          : [],
      },
    })),
    oneNceRoute('GET', `/v2/sims/${ONENCE_ICCID}/quota/data`, () => ({
      status: 200,
      body: {
        volume: 400,
        total_volume: 500,
        expiry_date: '2028-10-21T00:00:00.000Z',
        status: { description: 'ACTIVE' },
      },
    })),
  ],
  sessions: () => [
    oneNceToken,
    oneNceRoute('GET', `/v2/sims/${ONENCE_ICCID}/events`, () => ({
      status: 200,
      body: [
        oneNceEvent(26, 'delete', 3, 20, 9),
        oneNceEvent(25, 'create', 3, 20, 8),
        oneNceEvent(24, 'delete', 2, 15, 9),
        oneNceEvent(23, 'create', 2, 15, 8),
        oneNceEvent(22, 'delete', 1, 12, 9),
        oneNceEvent(21, 'create', 1, 12, 8),
      ],
    })),
  ],
  alerts: () => [
    oneNceToken,
    oneNceRoute('GET', `/v2/sims/${ONENCE_ICCID}`, () => ({ status: 200, body: oneNceSim() })),
    oneNceRoute('GET', `/v2/sims/${ONENCE_ICCID}/events`, () => ({
      status: 200,
      body: [
        oneNceEvent(32, 'create', 5, 18, 8, '869951030000002'),
        oneNceEvent(31, 'delete', 4, 17, 9),
      ],
    })),
  ],
  reset: (outcome) => [
    oneNceToken,
    oneNceRoute('POST', `/v2/sims/${ONENCE_ICCID}/reset`, () =>
      outcome === 'accepted'
        ? { status: 201 }
        : { status: 409, body: { error_code: 409, error_token: 'Conflict', message: 'x' } },
    ),
  ],
  connection: () => [
    oneNceToken,
    oneNceRoute('GET', '/v2/sims', () => ({
      status: 200,
      body: [],
      headers: { 'x-total-count': '0' },
    })),
  ],
  connectionResult: { deviceCount: 0, otherOrganizations: [] },
  anyReply: (reply) => [oneNceToken, oneNceRoute('GET', '/v2/sims', () => reply)],
  invalidKeyReply: { status: 401, body: { message: 'idtoken not found in decoded payload' } },
  expectAuthorized: (req) => {
    expect(req.url.pathname.startsWith(`${N}/`)).toBe(true);
    if (req.url.pathname === `${N}/oauth/token`) {
      expect(req.method).toBe('POST');
      expect(req.body).toEqual({ grant_type: 'client_credentials' });
    } else {
      expect(req.headers.authorization).toBe(`Bearer ${ONENCE_TOKEN}`);
    }
  },
};

const SUBJECTS: ContractSubject[] = [hologram, oneNce];

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
    if (subject.reportsLastSession) expect(status.lastSessionAt).not.toBeNull();
  });

  it('pages closed sessions newest first, so a caller can stop at a known record id', async () => {
    const { sim } = await run(subject.sessions());
    const pages = [];
    let startAfter: string | undefined;
    for (let i = 0; i < subject.sessionPages; i += 1) {
      const page = await sim.listSessions(subject.ref, startAfter == null ? {} : { startAfter });
      pages.push(page);
      expect(page.continues).toBe(i < subject.sessionPages - 1);
      if (page.continues) expect(page.lastId).not.toBeNull();
      startAfter = page.lastId ?? '';
    }
    const items = pages.flatMap((p) => p.items);
    expect(items.length).toBeGreaterThan(1);
    const ids = items.map((s) => subject.sessionOrder(s.providerSessionId));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(ids).size).toBe(ids.length);
    const starts = items.map((s) => s.startedAt);
    expect(starts).toEqual([...starts].sort().reverse());
    for (const session of items) {
      expect(Date.parse(session.endedAt)).toBeGreaterThanOrEqual(Date.parse(session.startedAt));
    }
  });

  it('pages alerts and maps each kind, skipping unknown records', async () => {
    const { sim } = await run(subject.alerts());
    const kinds: SimAlertKind[] = [];
    let startAfter: string | undefined;
    for (let i = 0; i < subject.alertPages; i += 1) {
      const page = await sim.listAlerts(subject.ref, {
        range: RANGE,
        ...(startAfter == null ? {} : { startAfter }),
      });
      expect(page.continues).toBe(i < subject.alertPages - 1);
      kinds.push(...page.items.map((a) => a.kind));
      startAfter = page.lastId ?? '';
    }
    expect(kinds).toEqual(subject.alertKinds);
  });

  it('accepts a network reset', async () => {
    const { sim } = await run(subject.reset('accepted'));
    expect(await sim.resetNetwork(subject.ref)).toEqual({ status: subject.resetStatus });
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
