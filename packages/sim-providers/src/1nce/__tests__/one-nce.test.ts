// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import { SimProviderError } from '../../types.js';
import {
  hasLuhnCheckDigit,
  ONENCE_EVENT_PAGE_CAP,
  ONENCE_EVENT_PAGE_SIZE,
  ONENCE_HISTORY_DAYS,
  ONENCE_PDP_EVENT_TYPES,
  ONENCE_REPORTING_DELAY_HOURS,
  ONENCE_SESSION_DETAIL_FIELDS,
  OneNceProvider,
  oneNceFactory,
  pdpEventKind,
} from '../adapter.js';

const ICCID = '8988303000000000010';
const LUHN = '89883030000000000106';
const IMEI_A = '869951030000001';
const BASE = 'https://1nce.test/management-api';
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-29T12:00:00.000Z');

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Route = (url: URL) => Reply | undefined;

function makeProvider(route: Route, options: { sessionDetailFields?: boolean } = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn((input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/oauth/token')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }),
      );
    }
    calls.push(`${url.pathname.replace('/management-api', '')}${url.search}`);
    const reply = route(url) ?? { status: 404, body: { error_code: 404, message: 'x' } };
    const status = reply.status ?? 200;
    const body = reply.body === undefined ? null : JSON.stringify(reply.body);
    return Promise.resolve(new Response(body, { status, headers: reply.headers ?? {} }));
  });
  const provider = new OneNceProvider({
    clientId: 'client',
    clientSecret: 'secret',
    baseUrl: BASE,
    fetch: fetchMock as unknown as typeof fetch,
    ...options,
  });
  return { provider, calls };
}

// The shape of a real `GET /v2/sims/{iccid}` reply (live, 2026-10-30): no
// `iccid_with_luhn`, `current_imsi` or `label`.
function simBody(overrides: Record<string, unknown> = {}) {
  return {
    activation_date: '2026-10-30T09:00:00.000Z',
    current_quota: 500,
    current_quota_SMS: 250,
    iccid: ICCID,
    imei_lock: false,
    imsi: '901405100000018',
    ip_address: '10.0.0.9',
    msisdn: '882285100000018',
    status: 'Enabled',
    quota_status: { id: 0, description: 'Data quota is more than 20%' },
    quota_status_SMS: { id: 0, description: 'SMS quota is more than 20%' },
    ...overrides,
  };
}

function at(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

// Event ids are not in time order on a real SIM (live), so the test ids are scrambled.
let nextId = 1000;
function scrambledId(): number {
  nextId += 1;
  return (nextId * 7919) % 100_003;
}

const PDP_DESCRIPTIONS = {
  create: 'Create PDP Context',
  update: 'Update PDP Context',
  delete: 'Delete PDP Context',
} as const;

function pdpEvent(
  type: 'create' | 'delete' | 'update',
  context: number,
  msAgo: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id: scrambledId(),
    event_type: {
      id: type === 'update' ? 4 : ONENCE_PDP_EVENT_TYPES[type],
      description: PDP_DESCRIPTIONS[type],
    },
    timestamp: at(msAgo),
    endpoint: { id: 1, name: 'Station', ip_address: '10.0.0.9', imei: IMEI_A },
    detail: {
      name: 'Telekom',
      ...(type === 'delete' ? { volume: { tx: 0.25, rx: 0.75, total: 1 } } : {}),
      pdp_context: {
        pdp_context_id: context,
        rat_type: 6,
        apn: 'iot.1nce.net',
        gtp_v2_uli: { eci: 4242 },
        ...extra,
      },
    },
  };
}

/**
 * The events route as 1NCE answers it (live): the pagination headers, and a
 * page past the last one answering the last page again.
 */
function eventsRoute(events: unknown[], options: { headers?: boolean } = {}): Route {
  return (url) => {
    if (!url.pathname.endsWith('/events')) return undefined;
    const size = Number(url.searchParams.get('pageSize'));
    const pages = Math.max(1, Math.ceil(events.length / size));
    const page = Math.min(Number(url.searchParams.get('page')), pages);
    const reply: Reply = { body: events.slice((page - 1) * size, page * size) };
    if (options.headers !== false) {
      reply.headers = {
        'x-total-count': String(events.length),
        'x-total-pages': String(pages),
        'x-current-page': String(page),
        'x-count-per-page': String(size),
      };
    }
    return reply;
  };
}

function sid(event: { id: number; timestamp: string }): string {
  const ms = String(Date.parse(event.timestamp)).padStart(13, '0');
  return `${ICCID}:${ms}:${String(event.id).padStart(19, '0')}`;
}

function range(days: number) {
  return { from: new Date(NOW - days * DAY), to: new Date(NOW) };
}

describe('1NCE adapter: lookup', () => {
  it('declares its window, delay and the session fields hidden until a real SIM proves them', () => {
    const { provider } = makeProvider(() => undefined);
    expect(provider.historyDays).toBe(ONENCE_HISTORY_DAYS);
    expect(ONENCE_HISTORY_DAYS).toBe(7);
    expect(provider.reportingDelayHours).toBe(ONENCE_REPORTING_DELAY_HOURS);
    expect(ONENCE_SESSION_DETAIL_FIELDS).toBe(false);
    expect(provider.capabilities).toEqual({
      networkName: false,
      radioAccessTechnology: false,
      cellId: false,
      usage: true,
      sessions: true,
      alerts: true,
      networkReset: true,
    });
    const shown = makeProvider(() => undefined, { sessionDetailFields: true }).provider;
    expect(shown.capabilities.networkName).toBe(true);
  });

  it('finds a SIM by its 19-digit ICCID', async () => {
    const { provider, calls } = makeProvider((url) =>
      url.pathname.endsWith(`/v2/sims/${ICCID}`) ? { body: simBody() } : undefined,
    );
    expect(await provider.findByIccid(`${ICCID}F`)).toEqual({ providerSimId: ICCID });
    expect(calls).toEqual([`/v2/sims/${ICCID}`]);
  });

  it('asks with 19 digits first for a 20-digit ICCID with its Luhn digit', async () => {
    expect(hasLuhnCheckDigit(LUHN)).toBe(true);
    expect(hasLuhnCheckDigit('89883030000000000107')).toBe(false);
    // Live: 1NCE answers 404 for the 20-digit form and its reply has no `iccid_with_luhn`.
    const { provider, calls } = makeProvider((url) =>
      url.pathname.endsWith(`/v2/sims/${ICCID}`) ? { body: simBody() } : undefined,
    );
    expect(await provider.findByIccid(LUHN)).toEqual({ providerSimId: ICCID });
    expect(calls).toEqual([`/v2/sims/${ICCID}`]);
  });

  it('asks with the 20 digits when the 19 are unknown', async () => {
    const wide = makeProvider((url) =>
      url.pathname.endsWith(`/v2/sims/${LUHN}`)
        ? { body: simBody({ iccid: LUHN.slice(0, 19), iccid_with_luhn: LUHN }) }
        : undefined,
    );
    // A reply naming the asked 20 digits matches.
    expect(await wide.provider.findByIccid(LUHN)).toEqual({ providerSimId: ICCID });
    expect(wide.calls).toEqual([`/v2/sims/${ICCID}`, `/v2/sims/${LUHN}`]);
  });

  it('answers null for an unknown ICCID and refuses a reply naming another SIM', async () => {
    const unknown = makeProvider(() => undefined);
    expect(await unknown.provider.findByIccid(LUHN)).toBeNull();
    const other = makeProvider((url) =>
      url.pathname.startsWith('/management-api/v2/sims/')
        ? { body: simBody({ iccid: '8988303000000000099', iccid_with_luhn: null }) }
        : undefined,
    );
    expect(await other.provider.findByIccid(ICCID)).toBeNull();
  });

  it('refuses an ICCID that is not one before any request', async () => {
    const { provider, calls } = makeProvider(() => undefined);
    await expect(provider.findByIccid('../../v2/sims')).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(provider.getStatus({ providerSimId: '1/../2' })).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(calls).toEqual([]);
  });

  it('builds from settings with the mock base only when a test base URL is set', () => {
    const settings = {
      hologram: { enabled: false, apiKey: '', orgId: '' },
      '1nce': { enabled: true, clientId: ' client ', clientSecret: ' secret ' },
    };
    expect(oneNceFactory.create(settings, { testBaseUrl: null })).toBeInstanceOf(OneNceProvider);
    expect(
      oneNceFactory.create(
        { ...settings, '1nce': { ...settings['1nce'], enabled: false } },
        { testBaseUrl: null },
      ),
    ).toBeNull();
  });
});

describe('1NCE adapter: status', () => {
  it('maps the SIM, connectivity and data quota', async () => {
    const { provider, calls } = makeProvider((url) => {
      const path = url.pathname.replace('/management-api', '');
      if (path === `/v2/sims/${ICCID}`) return { body: simBody() };
      if (path === `/v2/sims/${ICCID}/status`) {
        return {
          body: {
            status: { description: 'ONLINE' },
            pdp_contexts: [
              { created: at(3 * 3_600_000), apn: 'old.apn' },
              { created: at(3_600_000), apn: 'iot.1nce.net', ue_ip_address: '10.0.0.1' },
            ],
          },
        };
      }
      if (path === `/v2/sims/${ICCID}/quota/data`) {
        return {
          body: {
            volume: 400,
            total_volume: 500,
            status: { description: 'ACTIVE' },
            expiry_date: '2029-01-01T00:00:00.000Z',
          },
        };
      }
      return undefined;
    });
    const status = await provider.getStatus({ providerSimId: ICCID });
    expect(status).toEqual({
      providerSimId: ICCID,
      iccid: ICCID,
      imsi: '901405100000018',
      state: 'active',
      providerState: 'Enabled (ONLINE)',
      inSession: true,
      openSessionBeganAt: at(3_600_000),
      apn: 'iot.1nce.net',
      profileName: null,
      lastSessionAt: null,
      usage: {
        bytes: 100 * 1024 * 1024,
        periodEnd: '2029-01-01T00:00:00.000Z',
        limitBytes: 500 * 1024 * 1024,
      },
    });
    expect(JSON.stringify(status)).not.toContain(IMEI_A);
    expect(calls).toEqual([
      `/v2/sims/${ICCID}`,
      `/v2/sims/${ICCID}/status`,
      `/v2/sims/${ICCID}/quota/data`,
    ]);
  });

  it('shows a Disabled SIM as suspended and a missing quota as no usage', async () => {
    const { provider } = makeProvider((url) => {
      const path = url.pathname.replace('/management-api', '');
      if (path === `/v2/sims/${ICCID}`) return { body: simBody({ status: 'Disabled' }) };
      if (path === `/v2/sims/${ICCID}/status`) {
        return { body: { status: { description: 'OFFLINE' }, pdp_contexts: [] } };
      }
      return undefined;
    });
    const status = await provider.getStatus({ providerSimId: ICCID });
    expect(status.state).toBe('suspended');
    expect(status.inSession).toBe(false);
    expect(status.usage).toBeNull();
  });

  it('clamps a negative left volume to the whole quota used', async () => {
    const { provider } = makeProvider((url) => {
      const path = url.pathname.replace('/management-api', '');
      if (path === `/v2/sims/${ICCID}`) return { body: simBody() };
      if (path === `/v2/sims/${ICCID}/status`) return { body: { status: {} } };
      if (path === `/v2/sims/${ICCID}/quota/data`) {
        return { body: { volume: -5, total_volume: 500 } };
      }
      return undefined;
    });
    const status = await provider.getStatus({ providerSimId: ICCID });
    expect(status.usage?.bytes).toBe(505 * 1024 * 1024);
    expect(status.state).toBe('active');
  });
});

describe('1NCE adapter: sessions from PDP context events', () => {
  it('pairs each Delete with the latest earlier Create of the same context', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const events = [
      pdpEvent('create', 1, 5 * 3_600_000),
      pdpEvent('delete', 1, 4 * 3_600_000),
      pdpEvent('create', 2, 3 * 3_600_000),
      // The open session: a Create without a Delete is not returned.
      pdpEvent('create', 3, 3_600_000),
      pdpEvent('delete', 2, 2 * 3_600_000),
    ];
    // Unordered on the page.
    const { provider } = makeProvider(
      eventsRoute([events[2], events[0], events[4], events[3], events[1]]),
    );
    const page = await provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(page.continues).toBe(false);
    expect(page.coveredFrom).toBeUndefined();
    expect(page.items).toEqual([
      {
        providerSessionId: sid(events[4] as { id: number; timestamp: string }),
        startedAt: at(3 * 3_600_000),
        endedAt: at(2 * 3_600_000),
        bytes: 1024 * 1024,
        networkName: null,
        radioAccessTechnology: null,
        cellId: null,
        apn: 'iot.1nce.net',
      },
      {
        providerSessionId: sid(events[1] as { id: number; timestamp: string }),
        startedAt: at(5 * 3_600_000),
        endedAt: at(4 * 3_600_000),
        bytes: 1024 * 1024,
        networkName: null,
        radioAccessTechnology: null,
        cellId: null,
        apn: 'iot.1nce.net',
      },
    ]);
    expect(page.lastId).toBe(page.items[1]?.providerSessionId);
    vi.useRealTimers();
  });

  it('returns the network name, radio type and cell id once the switch is on', async () => {
    const events = [pdpEvent('create', 1, 2 * 3_600_000), pdpEvent('delete', 1, 3_600_000)];
    const { provider } = makeProvider(eventsRoute(events), { sessionDetailFields: true });
    const page = await provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(page.items[0]).toMatchObject({
      networkName: 'Telekom',
      radioAccessTechnology: '4G',
      cellId: '4242',
    });
  });

  it('starts a session without its Create at the tunnel creation', async () => {
    const del = pdpEvent('delete', 9, 3_600_000, { tunnel_created: at(2 * 3_600_000) });
    const { provider } = makeProvider(eventsRoute([del]));
    const page = await provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(page.items[0]?.startedAt).toBe(at(2 * 3_600_000));
    const bare = pdpEvent('delete', 10, 3_600_000);
    const second = makeProvider(eventsRoute([bare]));
    const only = await second.provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(only.items[0]?.startedAt).toBe(only.items[0]?.endedAt);
  });

  it('keeps only sessions that ended in the range and honors startAfter', async () => {
    const old = pdpEvent('delete', 1, 10 * DAY);
    const recent = pdpEvent('delete', 2, DAY);
    const newer = pdpEvent('delete', 3, 3_600_000);
    const { provider } = makeProvider(eventsRoute([newer, recent, old]));
    const all = await provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(all.items.map((s) => s.endedAt)).toEqual([at(3_600_000), at(DAY)]);
    const after = await provider.listSessions(
      { providerSimId: ICCID },
      { range: range(7), startAfter: all.items[0]?.providerSessionId ?? '' },
    );
    expect(after.items.map((s) => s.endedAt)).toEqual([at(DAY)]);
  });

  it('reads the pages across a boundary and gives the same ids twice', async () => {
    const events = [];
    for (let i = 0; i < ONENCE_EVENT_PAGE_SIZE + 2; i += 1) {
      events.push(
        pdpEvent(i % 2 === 0 ? 'delete' : 'create', 5000 + Math.floor(i / 2), i * 60_000),
      );
    }
    const { provider, calls } = makeProvider(eventsRoute(events));
    const first = await provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(calls.filter((c) => c.includes('/events'))).toEqual([
      `/v2/sims/${ICCID}/events?page=1&pageSize=1000`,
      `/v2/sims/${ICCID}/events?page=2&pageSize=1000`,
    ]);
    expect(first.items).toHaveLength(501);
    const second = await provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(second.items.map((s) => s.providerSessionId)).toEqual(
      first.items.map((s) => s.providerSessionId),
    );
  });

  it('stops at the page cap and reports where the read coverage starts', async () => {
    const events = [];
    const total = ONENCE_EVENT_PAGE_SIZE * ONENCE_EVENT_PAGE_CAP + 5;
    for (let i = 0; i < total; i += 1) events.push(pdpEvent('delete', i, i * 10_000));
    const { provider, calls } = makeProvider(eventsRoute(events));
    const page = await provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(calls.filter((c) => c.includes('/events'))).toHaveLength(ONENCE_EVENT_PAGE_CAP);
    expect(page.coveredFrom).toBe(
      at((ONENCE_EVENT_PAGE_SIZE * ONENCE_EVENT_PAGE_CAP - 1) * 10_000),
    );
  });

  it('stops paging once a page reaches before the range', async () => {
    const events = [];
    for (let i = 0; i < ONENCE_EVENT_PAGE_SIZE * 3; i += 1) {
      events.push(pdpEvent('delete', i, i * 15 * 60_000));
    }
    const { provider, calls } = makeProvider(eventsRoute(events));
    const page = await provider.listSessions({ providerSimId: ICCID }, { range: range(1) });
    expect(calls.filter((c) => c.includes('/events'))).toHaveLength(1);
    expect(page.coveredFrom).toBeUndefined();
    expect(page.items.every((s) => Date.parse(s.endedAt) >= NOW - DAY)).toBe(true);
  });

  it('orders sessions and their ids by time when the event ids are not', async () => {
    const older = pdpEvent('delete', 1, 2 * 3_600_000);
    const newer = pdpEvent('delete', 2, 3_600_000);
    // Live: a later event can carry a lower id.
    older.id = 900;
    newer.id = 100;
    const { provider } = makeProvider(eventsRoute([newer, older]));
    const page = await provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(page.items.map((s) => s.endedAt)).toEqual([at(3_600_000), at(2 * 3_600_000)]);
    const ids = page.items.map((s) => s.providerSessionId);
    expect(ids).toEqual([sid(newer), sid(older)]);
    // The caller compares stored ids as text to stop at a known session.
    expect((ids[0] ?? '') > (ids[1] ?? '')).toBe(true);
  });

  it('reads the description first: an Update ends no session, a described Delete with id 4 does', async () => {
    const create = pdpEvent('create', 1, 3 * 3_600_000);
    const update = pdpEvent('update', 1, 2 * 3_600_000);
    const del = pdpEvent('delete', 1, 3_600_000);
    // The v2 REST spec example pairs id 4 with "Delete PDP Context".
    const specDelete = {
      ...pdpEvent('delete', 2, 1_800_000),
      event_type: { id: 4, description: 'Delete PDP Context' },
    };
    // Without a description the ids of the event type table decide.
    const bareDelete = {
      ...pdpEvent('delete', 3, 900_000),
      event_type: { id: ONENCE_PDP_EVENT_TYPES.delete },
    };
    const { provider } = makeProvider(eventsRoute([bareDelete, specDelete, del, update, create]));
    const page = await provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(page.items.map((s) => s.endedAt)).toEqual([at(900_000), at(1_800_000), at(3_600_000)]);
    expect(page.items[2]?.startedAt).toBe(at(3 * 3_600_000));
    expect(pdpEventKind({ typeId: 4, typeName: 'Update PDP Context' })).toBeNull();
    expect(pdpEventKind({ typeId: 4, typeName: null })).toBeNull();
    expect(pdpEventKind({ typeId: 3, typeName: null })).toBe('create');
    expect(pdpEventKind({ typeId: 56, typeName: 'Data quota assigned' })).toBeNull();
  });

  it('stops at the last page: a page past it answers the last page again', async () => {
    const events: ReturnType<typeof pdpEvent>[] = [];
    for (let i = 0; i < ONENCE_EVENT_PAGE_SIZE; i += 1) {
      events.push(pdpEvent('delete', i, i * 60_000));
    }
    // With the headers: the total pages end the read.
    const withHeaders = makeProvider(eventsRoute(events));
    const first = await withHeaders.provider.listSessions(
      { providerSimId: ICCID },
      { range: range(7) },
    );
    expect(withHeaders.calls.filter((c) => c.includes('/events'))).toHaveLength(1);
    expect(first.items).toHaveLength(ONENCE_EVENT_PAGE_SIZE);
    // Only `X-Current-Page`: the repeated page is not read twice.
    const currentOnly = makeProvider((url) => {
      const reply = eventsRoute(events)(url);
      if (reply?.headers != null) delete reply.headers['x-total-pages'];
      return reply;
    });
    const second = await currentOnly.provider.listSessions(
      { providerSimId: ICCID },
      { range: range(7) },
    );
    expect(currentOnly.calls.filter((c) => c.includes('/events'))).toHaveLength(2);
    expect(second.items).toHaveLength(ONENCE_EVENT_PAGE_SIZE);
    // No headers at all: a repeated event id is kept once.
    const bare = makeProvider(eventsRoute(events, { headers: false }));
    const third = await bare.provider.listSessions({ providerSimId: ICCID }, { range: range(7) });
    expect(new Set(third.items.map((s) => s.providerSessionId)).size).toBe(third.items.length);
    expect(third.items).toHaveLength(ONENCE_EVENT_PAGE_SIZE);
  });

  it('fails the read on an events error', async () => {
    const { provider } = makeProvider((url) =>
      url.pathname.endsWith('/events') ? { status: 500, body: {} } : undefined,
    );
    const err: unknown = await provider
      .listSessions({ providerSimId: ICCID }, { range: range(7) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimProviderError);
    expect((err as SimProviderError).kind).toBe('unavailable');
  });
});

describe('1NCE adapter: alerts', () => {
  function alertRoute(sim: Record<string, unknown>, events: unknown[]): Route {
    return (url) => {
      const path = url.pathname.replace('/management-api', '');
      if (path === `/v2/sims/${ICCID}`) return { body: simBody(sim) };
      return eventsRoute(events)(url);
    };
  }

  function withImei(event: ReturnType<typeof pdpEvent>, imei: string) {
    return { ...event, endpoint: { ...event.endpoint, imei } };
  }

  it('derives the data alerts from the quota dates and a device change from the events', async () => {
    const first = withImei(pdpEvent('create', 1, 4 * DAY), '869951030000001');
    const second = withImei(pdpEvent('delete', 1, 3 * DAY), '869951030000002');
    const third = withImei(pdpEvent('create', 2, 2 * DAY), '869951030000002');
    const { provider } = makeProvider(
      alertRoute(
        {
          quota_status: {
            id: 2,
            threshold_reached_date: at(2 * DAY),
            quota_exceeded_date: at(DAY),
          },
        },
        [third, second, first],
      ),
    );
    const page = await provider.listAlerts({ providerSimId: ICCID }, { range: range(7) });
    expect(page).toEqual({
      items: [
        {
          providerAlertId: `${ICCID}:dl:${String(Math.floor((NOW - DAY) / 1000))}`,
          kind: 'data_limit',
          receivedAt: at(DAY),
        },
        {
          providerAlertId: `${ICCID}:dw:${String(Math.floor((NOW - 2 * DAY) / 1000))}`,
          kind: 'data_warning',
          receivedAt: at(2 * DAY),
        },
        {
          providerAlertId: `${ICCID}:dc:${String(second.id)}`,
          kind: 'device_changed',
          receivedAt: at(3 * DAY),
        },
      ],
      continues: false,
      lastId: null,
    });
    const text = JSON.stringify(page);
    expect(text).not.toContain('869951030000001');
    expect(text).not.toContain('869951030000002');
  });

  it('keeps only alerts inside the range', async () => {
    const { provider } = makeProvider(
      alertRoute({ quota_status: { threshold_reached_date: at(10 * DAY) } }, []),
    );
    const page = await provider.listAlerts({ providerSimId: ICCID }, { range: range(7) });
    expect(page.items).toEqual([]);
  });

  it('reads the SIM and the events once in a Refresh with sessions and alerts', async () => {
    const { provider, calls } = makeProvider((url) => {
      const path = url.pathname.replace('/management-api', '');
      if (path === `/v2/sims/${ICCID}`) return { body: simBody() };
      if (path === `/v2/sims/${ICCID}/status`) return { body: { status: {} } };
      if (path === `/v2/sims/${ICCID}/quota/data`) return { body: {} };
      return eventsRoute([pdpEvent('delete', 1, 3_600_000)])(url);
    });
    const ref = { providerSimId: ICCID };
    await provider.getStatus(ref);
    await provider.listSessions(ref, { range: range(7) });
    await provider.listAlerts(ref, { range: range(7) });
    expect(calls).toEqual([
      `/v2/sims/${ICCID}`,
      `/v2/sims/${ICCID}/status`,
      `/v2/sims/${ICCID}/quota/data`,
      `/v2/sims/${ICCID}/events?page=1&pageSize=1000`,
    ]);
  });
});

describe('1NCE adapter: network reset and Test Connection', () => {
  function resetWith(reply: Reply) {
    return makeProvider((url) => (url.pathname.endsWith('/reset') ? reply : undefined));
  }

  it('answers submitted when 1NCE queues the reset', async () => {
    const { provider, calls } = resetWith({ status: 201 });
    expect(await provider.resetNetwork({ providerSimId: ICCID })).toEqual({ status: 'submitted' });
    expect(calls).toEqual([`/v2/sims/${ICCID}/reset`]);
  });

  it('maps a refusal to fixed text, an unknown SIM to not_found and a 429 to its wait', async () => {
    for (const status of [400, 409]) {
      const err: unknown = await resetWith({
        status,
        body: { error_code: status, message: 'Conflict for client-login' },
      })
        .provider.resetNetwork({ providerSimId: ICCID })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'unsupported', message: '1NCE refused the network reset' });
      expect(String(err)).not.toContain('client-login');
    }
    await expect(
      resetWith({ status: 404 }).provider.resetNetwork({ providerSimId: ICCID }),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(
      resetWith({ status: 429, headers: { 'retry-after': '42' } }).provider.resetNetwork({
        providerSimId: ICCID,
      }),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 42 });
  });

  it('counts the SIMs of the account from X-Total-Count', async () => {
    const { provider, calls } = makeProvider((url) =>
      url.pathname.endsWith('/v2/sims')
        ? { body: [], headers: { 'x-total-count': '3' } }
        : undefined,
    );
    expect(await provider.testConnection()).toEqual({ deviceCount: 3, otherOrganizations: [] });
    expect(calls).toEqual(['/v2/sims?page=1&pageSize=1']);
  });

  it('refuses a SIM list without a usable count', async () => {
    for (const headers of [{}, { 'x-total-count': '-1' }, { 'x-total-count': 'many' }]) {
      const { provider } = makeProvider((url) =>
        url.pathname.endsWith('/v2/sims') ? { body: [], headers } : undefined,
      );
      await expect(provider.testConnection()).rejects.toMatchObject({ kind: 'unavailable' });
    }
  });
});
