// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  HOLOGRAM_ALERT_TOPICS,
  HOLOGRAM_HISTORY_DAYS,
  HOLOGRAM_REPORTING_DELAY_HOURS,
  HologramProvider,
  hologramFactory,
  hologramTimeToIso,
} from '../adapter.js';
import { HOLOGRAM_BASE_URL, HologramRequestError } from '../client.js';
import { HOLOGRAM_NETWORK_STATES, mapHologramState } from '../states.js';
import { SimProviderError } from '../../types.js';
import type { SimProviderErrorKind } from '../../types.js';

const API_KEY = 'test-api-key-0123456789';
const ORG_ID = '777';
const BASE = 'https://hologram.test/api/1';

// Values the adapter must never return. Each one appears in the fake replies.
const SECRET_VALUES = [
  'PIN-1234',
  'PUK-87654321',
  'LPA:1$ACTIVATION$CODE',
  '359999000000001',
  '35999900000000101',
  '89SECRETICCIDINRECORD',
  'secret-tag',
  '37.4219',
  '-122.0841',
  'IMEI-IN-PAYLOAD',
  'IMEI-IN-METADATA',
];

interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'network-error';

function fakeFetch(route: (req: Recorded) => Reply): {
  fetch: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const req: Recorded = { method: init?.method ?? 'GET', url, headers, body };
    requests.push(req);
    const reply = route(req);
    if (reply === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(
      new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...reply.headers },
      }),
    );
  };
  return { fetch: impl, requests };
}

function link(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    simcardid: 6001,
    deviceid: 4001,
    sim: '8900000000000000011',
    imsi: 310260000000001,
    msisdn: '+15550000001',
    state: 'LIVE',
    apn: 'hologram',
    profile_name: 'Global-3',
    overagelimit: 50_000_000,
    plan: { id: 1, zone: 'global', name: 'Plan', data: 10_000_000 },
    pin: 'PIN-1234',
    puk: 'PUK-87654321',
    euicc_activation_code: 'LPA:1$ACTIVATION$CODE',
    ...overrides,
  };
}

function device(
  overrides: Record<string, unknown> = {},
  links = [link()],
): Record<string, unknown> {
  return {
    id: 4001,
    orgid: 777,
    name: 'Station modem',
    simcardid: 6001,
    imei: '359999000000001',
    imei_sv: '35999900000000101',
    intended_plan_data: 0,
    state: null,
    tags: ['secret-tag'],
    links: { cellular: links },
    ...overrides,
  };
}

const billing = {
  success: true,
  data: {
    current_billing_usage: 1_234_567,
    linkids: [5001],
    simcardid: 6001,
    billing_period_end: '2026-11-20 14:55:54',
    most_recent_sessions: [
      {
        linkid: 5001,
        session_begin: '2026-10-21 08:00:00',
        session_end: '2026-10-21 10:30:00',
        session_bytes: 1000,
      },
      { linkid: 5000, session_begin: null, session_end: null, session_bytes: null },
    ],
    open_sessions: [
      {
        linkid: 5001,
        session_begin: '2026-10-21 11:00:00',
        time_of_last_usage: '2026-10-21 11:30:00',
        bytes: 200,
      },
    ],
  },
};

function provider(route: (req: Recorded) => Reply, timeoutMs?: number) {
  const fake = fakeFetch(route);
  return {
    sim: new HologramProvider({
      apiKey: API_KEY,
      orgId: ORG_ID,
      baseUrl: BASE,
      fetch: fake.fetch,
      ...(timeoutMs == null ? {} : { timeoutMs }),
    }),
    requests: fake.requests,
  };
}

async function errorKind(promise: Promise<unknown>): Promise<SimProviderErrorKind> {
  try {
    await promise;
  } catch (err: unknown) {
    if (err instanceof SimProviderError) return err.kind;
    throw err;
  }
  throw new Error('expected a SimProviderError');
}

const REF = { providerSimId: '4001', linkId: '5001', simcardId: '6001' };

describe('Hologram adapter requests', () => {
  it('sends Basic auth with user apikey and the organization id on every call', async () => {
    const { sim, requests } = provider((req) => {
      const path = req.url.pathname;
      if (path === '/api/1/devices')
        return { status: 200, body: { success: true, data: [device()] } };
      if (path === '/api/1/devices/4001')
        return { status: 200, body: { success: true, data: device() } };
      if (path.startsWith('/api/1/usage/billing/')) return { status: 200, body: billing };
      if (path === '/api/1/links/cellular/updatelocation')
        return { status: 200, body: { success: true } };
      if (path === '/api/1/devices/count') return { status: 200, body: { success: true, data: 1 } };
      return { status: 200, body: { success: true, data: [], continues: false } };
    });
    const range = { from: new Date('2026-10-14T00:00:00Z'), to: new Date('2026-10-21T00:00:00Z') };
    await sim.findByIccid('8900000000000000011');
    await sim.getStatus(REF);
    await sim.listSessions(REF, {});
    await sim.listAlerts(REF, { range });
    await sim.resetNetwork(REF);
    await sim.testConnection();
    const expected = `Basic ${Buffer.from(`apikey:${API_KEY}`).toString('base64')}`;
    expect(requests.length).toBeGreaterThanOrEqual(8);
    for (const req of requests) {
      expect(req.headers['authorization']).toBe(expected);
      // The organization list is the one call that must not be scoped to one organization.
      if (req.url.pathname === '/api/1/organizations') {
        expect(req.url.searchParams.has('orgid')).toBe(false);
      } else {
        expect(req.url.searchParams.get('orgid')).toBe(ORG_ID);
      }
      expect(req.url.href.startsWith(`${BASE}/`)).toBe(true);
      expect(req.url.searchParams.has('getlocationinfo')).toBe(false);
    }
  });

  it('looks a SIM up by ICCID and keeps the device, link and SIM card ids', async () => {
    const other = link({ id: 5002, sim: '8900000000000000029', state: 'INACTIVE' });
    const { sim, requests } = provider(() => ({
      status: 200,
      body: { success: true, data: [device({}, [other, link()])] },
    }));
    expect(await sim.findByIccid('8900000000000000011')).toEqual({
      providerSimId: '4001',
      linkId: '5001',
      simcardId: '6001',
    });
    expect(requests[0]?.url.pathname).toBe('/api/1/devices');
    expect(requests[0]?.url.searchParams.get('iccid')).toBe('8900000000000000011');
  });

  it('answers null when no device has the ICCID', async () => {
    const { sim } = provider(() => ({ status: 200, body: { success: true, data: [] } }));
    expect(await sim.findByIccid('8900000000000000011')).toBeNull();
  });

  it('answers null when the filter reply holds only devices whose links lack the ICCID', async () => {
    const { sim } = provider(() => ({
      status: 200,
      body: { success: true, data: [device({}, [link({ sim: '8900000000000000029' })])] },
    }));
    expect(await sim.findByIccid('8900000000000000011')).toBeNull();
  });

  it('picks the device whose link carries the ICCID, not the first one', async () => {
    const other = device({ id: 4002, simcardid: 6002 }, [
      link({ id: 5002, simcardid: 6002, sim: '8900000000000000029' }),
    ]);
    const { sim } = provider(() => ({
      status: 200,
      body: { success: true, data: [other, device()] },
    }));
    expect(await sim.findByIccid('8900000000000000011')).toEqual({
      providerSimId: '4001',
      linkId: '5001',
      simcardId: '6001',
    });
  });

  it('matches an ICCID with a trailing F either side and sends the normalized one', async () => {
    const { sim, requests } = provider(() => ({
      status: 200,
      body: { success: true, data: [device()] },
    }));
    expect(await sim.findByIccid('8900000000000000011F')).toMatchObject({ linkId: '5001' });
    expect(requests[0]?.url.searchParams.get('iccid')).toBe('8900000000000000011');
    const padded = provider(() => ({
      status: 200,
      body: { success: true, data: [device({}, [link({ sim: '8900000000000000011F' })])] },
    }));
    expect(await padded.sim.findByIccid('8900000000000000011')).toMatchObject({ linkId: '5001' });
  });

  it('refuses an invalid ICCID without calling Hologram', async () => {
    const { sim, requests } = provider(() => ({ status: 200, body: { success: true, data: [] } }));
    for (const iccid of ['', '123', '89000000000000000AB', '8900000000000000011FF']) {
      expect(await errorKind(sim.findByIccid(iccid))).toBe('not_found');
    }
    expect(requests).toHaveLength(0);
  });
});

describe('Hologram status', () => {
  function statusRoute(billingReply: Reply, dev = device()): (req: Recorded) => Reply {
    return (req) =>
      req.url.pathname === '/api/1/devices/4001'
        ? { status: 200, body: { success: true, data: dev } }
        : billingReply;
  }

  it('maps the link, the usage and the open session', async () => {
    const { sim, requests } = provider(statusRoute({ status: 200, body: billing }));
    const status = await sim.getStatus(REF);
    expect(status).toEqual({
      providerSimId: '4001',
      iccid: '8900000000000000011',
      imsi: '310260000000001',
      state: 'active',
      providerState: 'LIVE',
      inSession: true,
      openSessionBeganAt: '2026-10-21T11:00:00.000Z',
      apn: 'hologram',
      profileName: 'Global-3',
      lastSessionAt: '2026-10-21T10:30:00.000Z',
      usage: {
        bytes: 1_234_567,
        periodEnd: '2026-11-20T14:55:54.000Z',
        limitBytes: 60_000_000,
      },
    });
    const usageCall = requests.find((r) => r.url.pathname.startsWith('/api/1/usage/billing/'));
    expect(usageCall?.url.pathname).toBe('/api/1/usage/billing/simcard/6001');
    expect(usageCall?.url.searchParams.get('with_session_details')).toBe('true');
  });

  it('falls back to the first link when the stored link is gone', async () => {
    const { sim } = provider(statusRoute({ status: 200, body: billing }));
    const status = await sim.getStatus({ ...REF, linkId: '9999' });
    expect(status.iccid).toBe('8900000000000000011');
    expect(status.state).toBe('active');
  });

  it('takes the last session of the link only', async () => {
    const reply = {
      success: true,
      data: {
        ...billing.data,
        most_recent_sessions: [
          ...billing.data.most_recent_sessions,
          {
            linkid: 5000,
            session_begin: '2026-10-21 11:00:00',
            session_end: '2026-10-21 12:00:00',
          },
        ],
      },
    };
    const status = await provider(statusRoute({ status: 200, body: reply })).sim.getStatus(REF);
    expect(status.lastSessionAt).toBe('2026-10-21T10:30:00.000Z');
  });

  it('is not in session without an open session for the link', async () => {
    const reply = {
      success: true,
      data: {
        ...billing.data,
        open_sessions: [{ linkid: 5000, session_begin: '2026-10-21 11:00:00' }],
      },
    };
    const status = await provider(statusRoute({ status: 200, body: reply })).sim.getStatus(REF);
    expect(status.inSession).toBe(false);
    expect(status.openSessionBeganAt).toBeNull();
  });

  it('uses the intended plan data when the link has no plan, and no limit for unlimited overage', async () => {
    const noPlan = device({ intended_plan_data: 5_000_000 }, [link({ plan: undefined })]);
    const limited = await provider(
      statusRoute({ status: 200, body: billing }, noPlan),
    ).sim.getStatus(REF);
    expect(limited.usage?.limitBytes).toBe(55_000_000);
    const unlimited = device({}, [link({ overagelimit: -1 })]);
    const status = await provider(
      statusRoute({ status: 200, body: billing }, unlimited),
    ).sim.getStatus(REF);
    expect(status.usage?.limitBytes).toBeNull();
  });

  it('keeps the status without usage when the key has no billing access or the SIM card none', async () => {
    for (const reply of [
      { status: 403, body: { success: false, error: 'billing_visible permission required' } },
      { status: 404, body: { success: false, error: 'SIM card not found' } },
    ]) {
      const status = await provider(statusRoute(reply)).sim.getStatus(REF);
      expect(status.state).toBe('active');
      expect(status.usage).toBeNull();
      expect(status.inSession).toBeNull();
      expect(status.lastSessionAt).toBeNull();
    }
  });

  it('drops a string field longer than 200 characters', async () => {
    const long = device({}, [link({ apn: 'a'.repeat(201), profile_name: 'p'.repeat(200) })]);
    const status = await provider(statusRoute({ status: 200, body: billing }, long)).sim.getStatus(
      REF,
    );
    expect(status.apn).toBeNull();
    expect(status.profileName).toBe('p'.repeat(200));
  });

  // link.simcardid, link.plan.data and intended_plan_data are not in the pinned
  // spec's link and device schemas: optional, read when present, never required.
  it('reads a device without the unconfirmed simcardid, plan.data and intended_plan_data fields', async () => {
    const bare = device({ intended_plan_data: undefined }, [
      link({ simcardid: undefined, plan: { id: 1, zone: 'global', name: 'Plan' } }),
    ]);
    const status = await provider(statusRoute({ status: 200, body: billing }, bare)).sim.getStatus(
      REF,
    );
    expect(status.state).toBe('active');
    expect(status.usage?.limitBytes).toBeNull();
  });

  it('never returns the PIN, PUK, activation code, IMEI or tags', async () => {
    const status = await provider(statusRoute({ status: 200, body: billing })).sim.getStatus(REF);
    const text = JSON.stringify(status);
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  });

  it('maps a device the key cannot reach to not_found', async () => {
    const { sim } = provider(() => ({
      status: 400,
      body: { success: false, error: 'Invalid device or unable to access' },
    }));
    expect(await errorKind(sim.getStatus(REF))).toBe('not_found');
  });
});

describe('Hologram sessions', () => {
  const record = (id: number, begin: string, end: string): Record<string, unknown> => ({
    linkid: 5001,
    record_id: id,
    session_begin: begin,
    timestamp: end,
    bytes: 2048,
    imeisv: '35999900000000101',
    imei: '359999000000001',
    cellid: 123456,
    lac: 789,
    radio_access_technology: 'LTE',
    network_name: 'T-Mobile',
    sim: '89SECRETICCIDINRECORD',
    simcardid: 6001,
    tags: ['secret-tag'],
    latitude: 37.4219,
    longitude: -122.0841,
  });

  it('pages newest first with the record id cursor and maps each record', async () => {
    const { sim, requests } = provider(() => ({
      status: 200,
      body: {
        success: true,
        limit: 5000,
        size: 2,
        continues: true,
        lastid: 900,
        data: [
          record(901, '2026-10-21 08:00:00', '2026-10-21 10:00:00'),
          record(900, '2026-10-20 08:00:00', '2026-10-20 09:00:00'),
        ],
      },
    }));
    const page = await sim.listSessions(REF, { startAfter: '950' });
    expect(page.continues).toBe(true);
    expect(page.lastId).toBe('900');
    expect(page.items[0]).toEqual({
      providerSessionId: '901',
      startedAt: '2026-10-21T08:00:00.000Z',
      endedAt: '2026-10-21T10:00:00.000Z',
      bytes: 2048,
      networkName: 'T-Mobile',
      radioAccessTechnology: 'LTE',
      cellId: '123456',
      apn: null,
    });
    const params = requests[0]?.url.searchParams;
    expect(requests[0]?.url.pathname).toBe('/api/1/usage/data/');
    expect(params?.get('linkid')).toBe('5001');
    expect(params?.get('limit')).toBe('5000');
    expect(params?.get('startafter')).toBe('950');
    expect(params?.has('timestart')).toBe(false);
    expect(params?.has('timeend')).toBe(false);
    const text = JSON.stringify(page);
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  });

  it('sends a range as Unix seconds', async () => {
    const { sim, requests } = provider(() => ({
      status: 200,
      body: { success: true, data: [], continues: false },
    }));
    const page = await sim.listSessions(REF, {
      range: { from: new Date('2026-10-14T00:00:00.900Z'), to: new Date('2026-10-21T00:00:00Z') },
    });
    expect(page).toEqual({ items: [], continues: false, lastId: null });
    const seconds = (iso: string): string => String(Math.floor(Date.parse(iso) / 1000));
    expect(requests[0]?.url.searchParams.get('timestart')).toBe(seconds('2026-10-14T00:00:00Z'));
    expect(requests[0]?.url.searchParams.get('timeend')).toBe(seconds('2026-10-21T00:00:00Z'));
  });

  it('ends paging when the reply has no lastid, and skips records without times', async () => {
    const { sim } = provider(() => ({
      status: 200,
      body: {
        success: true,
        continues: true,
        data: [record(901, '2026-10-21 08:00:00', '2026-10-21 10:00:00'), { record_id: 899 }],
      },
    }));
    const page = await sim.listSessions(REF, {});
    expect(page.items.map((s) => s.providerSessionId)).toEqual(['901']);
    expect(page.continues).toBe(false);
    expect(page.lastId).toBeNull();
  });

  it('stops paging when a page says it continues but has no last id', async () => {
    const { sim } = provider(() => ({
      status: 200,
      body: { success: true, continues: true, data: [] },
    }));
    expect(await sim.listSessions(REF, {})).toEqual({ items: [], continues: false, lastId: null });
  });

  it('needs a link id', async () => {
    const { sim } = provider(() => ({ status: 200, body: { success: true, data: [] } }));
    expect(await errorKind(sim.listSessions({ providerSimId: '4001' }, {}))).toBe('not_found');
  });
});

describe('Hologram alerts', () => {
  const csr = (id: number, tags: string[]): Record<string, unknown> => ({
    id,
    logged: '2026-10-20 12:00:00',
    orgid: 777,
    deviceid: 4001,
    record_id: `rec-${String(id)}`,
    data: '{"imei":"IMEI-IN-PAYLOAD"}',
    device_metadata: 'IMEI-IN-METADATA',
    tags,
  });

  it('maps each system topic and skips other records', async () => {
    const { sim, requests } = provider(() => ({
      status: 200,
      body: {
        success: true,
        continues: true,
        lastid: 10,
        data: [
          csr(15, ['_DATALIMIT_']),
          csr(14, ['_DATAWARNING_']),
          csr(13, ['secret-tag', '_IMEI_CHANGE_']),
          csr(12, ['_IMEI_TAC_CHANGE_']),
          csr(11, ['_IMEI_FIRST_']),
          csr(10, ['_OTHER_TOPIC_']),
        ],
      },
    }));
    const range = { from: new Date('2026-07-23T00:00:00Z'), to: new Date('2026-10-21T00:00:00Z') };
    const page = await sim.listAlerts(REF, { range, startAfter: '16' });
    expect(page.items).toEqual([
      { providerAlertId: '15', kind: 'data_limit', receivedAt: '2026-10-20T12:00:00.000Z' },
      { providerAlertId: '14', kind: 'data_warning', receivedAt: '2026-10-20T12:00:00.000Z' },
      { providerAlertId: '13', kind: 'device_changed', receivedAt: '2026-10-20T12:00:00.000Z' },
      {
        providerAlertId: '12',
        kind: 'device_model_changed',
        receivedAt: '2026-10-20T12:00:00.000Z',
      },
      { providerAlertId: '11', kind: 'first_device', receivedAt: '2026-10-20T12:00:00.000Z' },
    ]);
    expect(page).toMatchObject({ continues: true, lastId: '10' });
    const params = requests[0]?.url.searchParams;
    expect(requests[0]?.url.pathname).toBe('/api/1/csr/data');
    expect(params?.get('deviceid')).toBe('4001');
    expect(params?.get('topicnames')).toBe(
      '_DATALIMIT_,_DATAWARNING_,_IMEI_CHANGE_,_IMEI_TAC_CHANGE_,_IMEI_FIRST_',
    );
    expect(params?.get('timestart')).toBe(String(range.from.getTime() / 1000));
    expect(params?.get('timeend')).toBe(String(range.to.getTime() / 1000));
    expect(params?.get('startafter')).toBe('16');
    expect(params?.get('limit')).toBe('1000');
    const text = JSON.stringify(page);
    for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  });

  it('stops paging when a page says it continues but has no last id', async () => {
    const { sim } = provider(() => ({
      status: 200,
      body: { success: true, continues: true, data: [] },
    }));
    const range = { from: new Date('2026-10-14T00:00:00Z'), to: new Date('2026-10-21T00:00:00Z') };
    expect(await sim.listAlerts(REF, { range })).toEqual({
      items: [],
      continues: false,
      lastId: null,
    });
  });

  it('names the five alert topics', () => {
    expect(Object.keys(HOLOGRAM_ALERT_TOPICS)).toEqual([
      '_DATALIMIT_',
      '_DATAWARNING_',
      '_IMEI_CHANGE_',
      '_IMEI_TAC_CHANGE_',
      '_IMEI_FIRST_',
    ]);
  });
});

describe('Hologram network reset', () => {
  function resetRoute(
    state: string,
    preview: Reply,
    commit: Reply = { status: 200, body: { success: true } },
  ) {
    return (req: Recorded): Reply => {
      if (req.url.pathname === '/api/1/devices/4001') {
        return { status: 200, body: { success: true, data: device({}, [link({ state })]) } };
      }
      return req.url.searchParams.get('preview') === 'true' ? preview : commit;
    };
  }

  it('previews, then updates the location of the link', async () => {
    const { sim, requests } = provider(
      resetRoute('LIVE', { status: 200, body: { success: true } }),
    );
    expect(await sim.resetNetwork(REF)).toEqual({ status: 'accepted' });
    const posts = requests.filter((r) => r.method === 'POST');
    // The spec types preview as a boolean query parameter, so it is sent as true.
    expect(posts.map((r) => r.url.searchParams.get('preview'))).toEqual(['true', null]);
    for (const post of posts) {
      expect(post.url.pathname).toBe('/api/1/links/cellular/updatelocation');
      expect(post.body).toEqual({ linkids: [5001] });
      expect(post.headers['content-type']).toBe('application/json');
    }
  });

  it('refuses a SIM outside LIVE, TEST-ACTIVATE and TEST-AUTOACTIVATE without calling the reset', async () => {
    for (const state of ['PAUSED-SYS', 'INACTIVE', 'DEAD']) {
      const { sim, requests } = provider(
        resetRoute(state, { status: 200, body: { success: true } }),
      );
      expect(await errorKind(sim.resetNetwork(REF))).toBe('unsupported');
      expect(requests.some((r) => r.method === 'POST')).toBe(false);
    }
  });

  it('allows the test states', async () => {
    for (const state of ['TEST-ACTIVATE', 'TEST-AUTOACTIVATE']) {
      const { sim } = provider(resetRoute(state, { status: 200, body: { success: true } }));
      expect(await sim.resetNetwork(REF)).toEqual({ status: 'accepted' });
    }
  });

  it('maps a preview refusal to unsupported and sends no update', async () => {
    const refused: Reply = {
      status: 400,
      body: {
        success: false,
        error: 'Some links are not able to update location due to carrier limitations',
        data: { '5001': 'Some links are not able to update location due to carrier limitations' },
      },
    };
    const { sim, requests } = provider(resetRoute('LIVE', refused));
    expect(await errorKind(sim.resetNetwork(REF))).toBe('unsupported');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('refuses a stored link that is no longer on the device, or none, without calling the reset', async () => {
    for (const ref of [{ ...REF, linkId: '9999' }, { providerSimId: '4001' }]) {
      const { sim, requests } = provider(
        resetRoute('LIVE', { status: 200, body: { success: true } }),
      );
      expect(await errorKind(sim.resetNetwork(ref))).toBe('not_found');
      expect(requests.some((r) => r.method === 'POST')).toBe(false);
    }
  });

  it('names a known refusal with a fixed message and never copies other provider text', async () => {
    const refusal = (error: string): Reply => ({
      status: 400,
      body: { success: false, error, data: { '5001': error } },
    });
    const known = provider(
      resetRoute(
        'LIVE',
        refusal('Some links are not able to update location due to carrier limitations'),
      ),
    );
    await expect(known.sim.resetNetwork(REF)).rejects.toThrow(
      'Hologram refused the network reset: the carrier does not support it',
    );
    const odd = provider(resetRoute('LIVE', refusal(`secret-${'x'.repeat(300)}`)));
    try {
      await odd.sim.resetNetwork(REF);
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as Error).message).toBe('Hologram refused the network reset');
    }
  });

  it('maps its own 429 to rate_limited with the retry hint', async () => {
    const { sim } = provider(
      resetRoute(
        'LIVE',
        { status: 200, body: { success: true } },
        {
          status: 429,
          headers: { 'retry-after': '42' },
        },
      ),
    );
    try {
      await sim.resetNetwork(REF);
      expect.unreachable();
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(SimProviderError);
      expect((err as SimProviderError).kind).toBe('rate_limited');
      expect((err as SimProviderError).retryAfterSeconds).toBe(42);
    }
  });
});

describe('Hologram errors', () => {
  const cases: [string, Reply, SimProviderErrorKind][] = [
    ['an invalid key', { status: 403, body: { success: false, error: 'Invalid API Key' } }, 'auth'],
    ['a 401', { status: 401 }, 'auth'],
    ['another 403', { status: 403, body: { success: false, error: 'Forbidden' } }, 'unsupported'],
    ['a 429', { status: 429 }, 'rate_limited'],
    ['a 500', { status: 500, body: { success: false } }, 'unavailable'],
    ['a 503', { status: 503 }, 'unavailable'],
    ['success false', { status: 200, body: { success: false, error: 'x' } }, 'unavailable'],
    ['a network error', 'network-error', 'unavailable'],
  ];

  it.each(cases)('maps %s', async (_name, reply, kind) => {
    const { sim } = provider(() => reply);
    expect(await errorKind(sim.testConnection())).toBe(kind);
  });

  it('maps a reply that is not JSON to unavailable', async () => {
    const impl = (() => Promise.resolve(new Response('<html>', { status: 200 }))) as typeof fetch;
    const sim = new HologramProvider({
      apiKey: API_KEY,
      orgId: ORG_ID,
      baseUrl: BASE,
      fetch: impl,
    });
    expect(await errorKind(sim.testConnection())).toBe('unavailable');
  });

  it('maps a timeout to unavailable', async () => {
    const hang = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      })) as typeof fetch;
    const sim = new HologramProvider({
      apiKey: API_KEY,
      orgId: ORG_ID,
      baseUrl: BASE,
      fetch: hang,
      timeoutMs: 20,
    });
    expect(await errorKind(sim.testConnection())).toBe('unavailable');
  });

  it('uses 60 seconds when a 429 has no Retry-After, or an empty one', async () => {
    const { sim } = provider(() => ({ status: 429 }));
    await expect(sim.testConnection()).rejects.toMatchObject({ retryAfterSeconds: 60 });
    for (const header of ['', '  ']) {
      const empty = provider(() => ({ status: 429, headers: { 'retry-after': header } }));
      await expect(empty.sim.testConnection()).rejects.toMatchObject({ retryAfterSeconds: 60 });
    }
  });

  it('caps a Retry-After at one hour', async () => {
    const seconds = provider(() => ({ status: 429, headers: { 'retry-after': '86400' } }));
    await expect(seconds.sim.testConnection()).rejects.toMatchObject({ retryAfterSeconds: 3600 });
    const date = provider(() => ({
      status: 429,
      headers: { 'retry-after': new Date(Date.now() + 7 * 86_400_000).toUTCString() },
    }));
    await expect(date.sim.testConnection()).rejects.toMatchObject({ retryAfterSeconds: 3600 });
  });

  it.each([
    [429, 'rate_limited'],
    [403, 'unsupported'],
    [401, 'auth'],
    [500, 'unavailable'],
    [502, 'unavailable'],
  ] as const)('keeps the status mapping of a %i whose body is not JSON', async (status, kind) => {
    const impl = (() =>
      Promise.resolve(
        new Response('<html>busy</html>', { status, headers: { 'retry-after': '30' } }),
      )) as typeof fetch;
    const sim = new HologramProvider({
      apiKey: API_KEY,
      orgId: ORG_ID,
      baseUrl: BASE,
      fetch: impl,
    });
    const err = (await sim.testConnection().catch((e: unknown) => e)) as SimProviderError;
    expect(err.kind).toBe(kind);
    expect(err.message).not.toContain('without valid JSON');
    if (kind === 'rate_limited') expect(err.retryAfterSeconds).toBe(30);
  });

  it('refuses a reply body over 2 MB without reading it all', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const impl = (() => Promise.resolve(new Response(stream, { status: 200 }))) as typeof fetch;
    const sim = new HologramProvider({
      apiKey: API_KEY,
      orgId: ORG_ID,
      baseUrl: BASE,
      fetch: impl,
    });
    const err = (await sim.testConnection().catch((e: unknown) => e)) as SimProviderError;
    expect(err.kind).toBe('unavailable');
    expect(err.message).toContain('too large');
    expect(pulled).toBeLessThan(20);
  });

  it('refuses a reply whose Content-Length is over 2 MB', async () => {
    const impl = (() =>
      Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } }),
      )) as typeof fetch;
    const sim = new HologramProvider({
      apiKey: API_KEY,
      orgId: ORG_ID,
      baseUrl: BASE,
      fetch: impl,
    });
    await expect(sim.testConnection()).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('too large') as unknown,
    });
  });

  it('never puts the key, the organization or the ICCID in an error message', async () => {
    const { sim } = provider(() => ({ status: 500 }));
    try {
      await sim.findByIccid('8900000000000000011');
      expect.unreachable();
    } catch (err: unknown) {
      const message = (err as Error).message;
      expect(message).toContain('/devices');
      expect(message).not.toContain(API_KEY);
      expect(message).not.toContain(ORG_ID);
      expect(message).not.toContain('8900000000000000011');
    }
  });

  it('reads an HTTP date Retry-After', async () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    const { sim } = provider(() => ({ status: 429, headers: { 'retry-after': at } }));
    const err = (await sim.testConnection().catch((e: unknown) => e)) as SimProviderError;
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterSeconds).toBeGreaterThanOrEqual(28);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(30);
    const past = provider(() => ({
      status: 429,
      headers: { 'retry-after': new Date(Date.now() - 60_000).toUTCString() },
    }));
    await expect(past.sim.testConnection()).rejects.toMatchObject({ retryAfterSeconds: 0 });
  });

  it('maps any 2xx with success false to unavailable', async () => {
    const { sim } = provider(() => ({ status: 201, body: { success: false, error: 'x' } }));
    await expect(sim.testConnection()).rejects.toMatchObject({
      kind: 'unavailable',
      message: 'Hologram GET /organizations/{orgId} answered success false',
    });
  });

  it.each([404, 400, 500])(
    'never puts the organization, device, link or SIM card id in a %i error',
    async (status) => {
      const messages: string[] = [];
      const collect = async (promise: Promise<unknown>): Promise<void> => {
        try {
          await promise;
        } catch (err: unknown) {
          messages.push((err as Error).message);
        }
      };
      const failing = provider(() => ({ status, body: { success: false, error: 'x' } }));
      await collect(failing.sim.testConnection());
      await collect(failing.sim.getStatus(REF));
      await collect(failing.sim.listSessions(REF, {}));
      const billingFails = provider((req) =>
        req.url.pathname === '/api/1/devices/4001'
          ? { status: 200, body: { success: true, data: device() } }
          : { status, body: { success: false, error: 'x' } },
      );
      await collect(billingFails.sim.getStatus(REF));
      expect(messages.length).toBeGreaterThanOrEqual(3);
      expect(messages[0]).toContain('/organizations/{orgId}');
      for (const message of messages) {
        for (const id of [ORG_ID, '4001', '5001', '6001']) expect(message).not.toContain(id);
      }
    },
  );

  it('keeps the reply data off the error, so a logged error never holds it', async () => {
    const { sim } = provider(() => ({
      status: 404,
      body: { success: false, error: 'Not found', data: { secret: 'S3CRET-DATA' } },
    }));
    const err = await sim.testConnection().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HologramRequestError);
    const typed = err as HologramRequestError;
    expect(typed.reply).toEqual({ status: 404, error: 'Not found' });
    expect(Object.keys(typed)).not.toContain('reply');
    expect(JSON.stringify(typed)).not.toContain('S3CRET-DATA');
  });
});

describe('Hologram test connection', () => {
  const org = (id: number, name: string): Record<string, unknown> => ({ id, name, ownerid: 1 });
  const count = (n: number): Reply => ({ status: 200, body: { success: true, data: n } });

  function connectionRoute(
    orgs: Record<string, unknown>[],
    counts: Record<string, Reply>,
  ): (req: Recorded) => Reply {
    return (req) => {
      const path = req.url.pathname;
      if (path === `/api/1/organizations/${ORG_ID}`) {
        return { status: 200, body: { success: true, data: org(Number(ORG_ID), 'Personal') } };
      }
      if (path === '/api/1/organizations') {
        return { status: 200, body: { success: true, continues: false, data: orgs } };
      }
      if (path === '/api/1/devices/count') {
        return counts[req.url.searchParams.get('orgid') ?? ''] ?? { status: 404 };
      }
      return { status: 404 };
    };
  }

  it('counts the devices of the stored organization and of every other one the key reaches', async () => {
    const { sim, requests } = provider(
      connectionRoute([org(Number(ORG_ID), 'Personal'), org(888, 'Company'), org(999, 'Locked')], {
        [ORG_ID]: count(0),
        '888': count(3),
        '999': { status: 403, body: { success: false, error: 'Forbidden' } },
      }),
    );
    expect(await sim.testConnection()).toEqual({
      deviceCount: 0,
      otherOrganizations: [{ id: '888', name: 'Company', deviceCount: 3 }],
    });
    expect(requests[0]?.url.pathname).toBe(`/api/1/organizations/${ORG_ID}`);
    const list = requests.find((r) => r.url.pathname === '/api/1/organizations');
    expect(list?.url.searchParams.has('orgid')).toBe(false);
    expect(list?.url.searchParams.get('limit')).toBe('11');
  });

  it('counts at most 10 other organizations', async () => {
    const orgs = Array.from({ length: 15 }, (_, i) => org(2000 + i, `Org ${String(i)}`));
    const counts = Object.fromEntries(
      [ORG_ID, ...orgs.map((o) => String(o['id']))].map((id) => [id, count(1)]),
    );
    const { sim, requests } = provider(connectionRoute(orgs, counts));
    const result = await sim.testConnection();
    expect(result.otherOrganizations).toHaveLength(10);
    expect(requests.filter((r) => r.url.pathname === '/api/1/devices/count')).toHaveLength(11);
  });

  it('refuses a count reply without a number', async () => {
    const { sim } = provider(
      connectionRoute([], { [ORG_ID]: { status: 200, body: { success: true, data: 'many' } } }),
    );
    expect(await errorKind(sim.testConnection())).toBe('unavailable');
  });
});

describe('Hologram states', () => {
  it('maps every NetworkState value and none to unknown', () => {
    expect(HOLOGRAM_NETWORK_STATES).toHaveLength(20);
    for (const state of HOLOGRAM_NETWORK_STATES)
      expect(mapHologramState(state)).not.toBe('unknown');
  });

  it('maps each group', () => {
    expect(mapHologramState('LIVE')).toBe('active');
    for (const s of [
      'LIVE-PENDING',
      'PAUSED-PENDING-SYS',
      'PAUSED-PENDING-USER',
      'FACTORY',
      'FACTORY-PENDING',
    ]) {
      expect(mapHologramState(s)).toBe('pending');
    }
    for (const s of ['PAUSED-USER', 'PAUSED-SYS', 'FROZEN', 'FROZEN-PENDING']) {
      expect(mapHologramState(s)).toBe('suspended');
    }
    expect(mapHologramState('INACTIVE')).toBe('inactive');
    expect(mapHologramState('INACTIVE-TESTED')).toBe('inactive');
    for (const s of HOLOGRAM_NETWORK_STATES.filter((v) => v.startsWith('TEST-'))) {
      expect(mapHologramState(s)).toBe('test');
    }
    expect(mapHologramState('DEAD')).toBe('deactivated');
    expect(mapHologramState('DEAD-PENDING')).toBe('deactivated');
  });

  it('maps a value the spec adds later, and none, to unknown', () => {
    expect(mapHologramState('SOMETHING-NEW')).toBe('unknown');
    expect(mapHologramState(null)).toBe('unknown');
    expect(mapHologramState('constructor')).toBe('unknown');
  });
});

describe('Hologram factory and constants', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const settings = (overrides: Record<string, unknown>) => ({
    hologram: { enabled: true, apiKey: 'k', orgId: '1', ...overrides },
  });

  it('builds nothing while off or without credentials', () => {
    const options = { testBaseUrl: null };
    expect(hologramFactory.create(settings({ enabled: false }), options)).toBeNull();
    expect(hologramFactory.create(settings({ apiKey: '' }), options)).toBeNull();
    expect(hologramFactory.create(settings({ orgId: ' ' }), options)).toBeNull();
    expect(hologramFactory.create(settings({}), options)).toBeInstanceOf(HologramProvider);
  });

  it('builds nothing for an organization id that is not a number', () => {
    const options = { testBaseUrl: null };
    for (const orgId of ['abc', '12a', '-1', '1.5', '1/../2']) {
      expect(hologramFactory.create(settings({ orgId }), options)).toBeNull();
    }
    expect(hologramFactory.create(settings({ orgId: ' 42 ' }), options)).toBeInstanceOf(
      HologramProvider,
    );
  });

  it('sends the trimmed API key', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: [] })));
    const sim = hologramFactory.create(settings({ apiKey: '  k-123 \n' }), {
      testBaseUrl: 'http://mock.test',
    });
    await sim?.findByIccid('8900000000000000011');
    const init = spy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      `Basic ${Buffer.from('apikey:k-123').toString('base64')}`,
    );
  });

  it('declares its capabilities, history window and reporting delay', () => {
    const sim = hologramFactory.create(settings({}), { testBaseUrl: null });
    expect(sim?.capabilities).toEqual({
      networkName: true,
      radioAccessTechnology: true,
      cellId: true,
      usage: true,
      sessions: true,
      alerts: true,
      networkReset: true,
    });
    expect(HOLOGRAM_HISTORY_DAYS).toBe(90);
    expect(HOLOGRAM_REPORTING_DELAY_HOURS).toBe(6);
    expect(HOLOGRAM_BASE_URL).toBe('https://dashboard.hologram.io/api/1');
  });

  it('parses Hologram UTC times', () => {
    expect(hologramTimeToIso('2026-11-20 14:55:54')).toBe('2026-11-20T14:55:54.000Z');
    expect(hologramTimeToIso('2026-11-20T14:55:54Z')).toBe('2026-11-20T14:55:54.000Z');
    expect(hologramTimeToIso('not a time')).toBeNull();
    expect(hologramTimeToIso(null)).toBeNull();
  });
});
