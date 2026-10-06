// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// -- DB mock helpers --

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'onConflictDoNothing',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
  return chain;
}

vi.mock('@evtivity/database', () => {
  const dbMock: Record<string, unknown> = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  };
  dbMock['transaction'] = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(dbMock));
  return {
    db: dbMock,
    cssStations: { __t: 'cssStations' },
    cssEvses: { __t: 'cssEvses' },
    cssConfigVariables: { __t: 'cssConfigVariables' },
    cssTransactions: { __t: 'cssTransactions' },
    chargingStations: { __t: 'chargingStations' },
    evses: { __t: 'evses' },
    connectors: { __t: 'connectors' },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn((col: unknown, values: unknown) => ({ inArray: values })),
  isNull: vi.fn(() => ({ isNull: true })),
}));

// -- PubSub mock with a configurable simulator reply --

type ReplyMode =
  | { kind: 'success'; data?: Record<string, unknown> }
  | { kind: 'failure'; error?: string }
  | { kind: 'noise-then-success' }
  | { kind: 'silent' };

interface PubSubState {
  handler: ((raw: string) => void) | null;
  publishCalls: Array<[string, string]>;
  reply: ReplyMode;
  subscribeError: Error | null;
  publishError: Error | null;
  unsubscribed: number;
}

const { pubsubState } = vi.hoisted(() => {
  const pubsubState: PubSubState = {
    handler: null,
    publishCalls: [],
    reply: { kind: 'success' },
    subscribeError: null,
    publishError: null,
    unsubscribed: 0,
  };
  return { pubsubState };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: async (channel: string, raw: string): Promise<void> => {
      pubsubState.publishCalls.push([channel, raw]);
      if (pubsubState.publishError != null) throw pubsubState.publishError;
      if (channel !== 'css_commands' || pubsubState.handler == null) return;
      const { commandId } = JSON.parse(raw) as { commandId: string };
      const reply = pubsubState.reply;
      const h = pubsubState.handler;
      if (reply.kind === 'success') {
        h(
          JSON.stringify({
            commandId,
            success: true,
            ...(reply.data != null ? { data: reply.data } : {}),
          }),
        );
      } else if (reply.kind === 'failure') {
        h(
          JSON.stringify({
            commandId,
            success: false,
            ...(reply.error != null ? { error: reply.error } : {}),
          }),
        );
      } else if (reply.kind === 'noise-then-success') {
        h('not json');
        h(JSON.stringify({ commandId: 'someone-else', success: false, error: 'wrong' }));
        h(JSON.stringify({ commandId, success: true }));
      }
    },
    subscribe: async (channel: string, handler: (raw: string) => void) => {
      if (pubsubState.subscribeError != null) throw pubsubState.subscribeError;
      if (channel === 'css_command_results') pubsubState.handler = handler;
      return {
        unsubscribe: async (): Promise<void> => {
          pubsubState.unsubscribed += 1;
          pubsubState.handler = null;
        },
      };
    },
  })),
  setPubSub: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(async () => null),
}));

vi.mock('../services/station-security.service.js', () => ({
  initialStationPassword: vi.fn(),
  changeStationPassword: vi.fn(),
  changeSecurityProfile: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { cssRoutes } from '../routes/css.js';
import { getUserSiteIds } from '../lib/site-access.js';
import { db } from '@evtivity/database';
import { inArray } from 'drizzle-orm';
import {
  changeSecurityProfile,
  changeStationPassword,
} from '../services/station-security.service.js';

// GET /css/stations selects presence flags, never the secrets (STATION_ROW has none).
function listRow(): Record<string, unknown> {
  const rest = Object.fromEntries(
    Object.entries(STATION_ROW).filter(([key]) => key !== 'password' && key !== 'clientKey'),
  );
  return { ...rest, hasPassword: false, hasClientKey: false };
}

const STATION_ROW = {
  id: 'css_1',
  stationId: 'SIM-1',
  targetUrl: 'ws://localhost:3003',
  password: null,
  clientCert: null,
  clientKey: null,
  caCert: null,
  status: 'connected',
  availabilityState: 'Operative',
  bootReason: null,
  lastHeartbeatAt: null,
  lastBootAt: null,
  sourceType: 'api',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function setCalls(): unknown[] {
  return vi
    .mocked(db.update)
    .mock.results.map((r) => (r.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]?.[0]);
}

describe('CSS routes (site scope, lifecycle and simulator replies)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(cssRoutes);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.mocked(getUserSiteIds).mockResolvedValue(null);
    pubsubState.handler = null;
    pubsubState.publishCalls = [];
    pubsubState.reply = { kind: 'success' };
    pubsubState.subscribeError = null;
    pubsubState.publishError = null;
    pubsubState.unsubscribed = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const headers = () => ({ authorization: `Bearer ${token}` });

  describe('site access check', () => {
    it('allows a station that has no charging_stations row', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue(['sit_a']);
      // access lookup (none), station lookup, evses, tx count
      setupDbResults([], [STATION_ROW], [], [{ count: 2 }]);
      const res = await app.inject({
        method: 'GET',
        url: '/css/stations/SIM-1',
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        stationId: 'SIM-1',
        evses: [],
        activeTransactionCount: 2,
      });
    });

    it('allows an unsited charging_stations row', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue(['sit_a']);
      setupDbResults([{ siteId: null }], [STATION_ROW], [{ id: 'e1' }], []);
      const res = await app.inject({
        method: 'GET',
        url: '/css/stations/SIM-1',
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ evses: [{ id: 'e1' }], activeTransactionCount: 0 });
    });

    it('allows a station in an allowed site', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue(['sit_a']);
      setupDbResults([{ siteId: 'sit_a' }], [STATION_ROW], [], [{ count: 0 }]);
      const res = await app.inject({
        method: 'GET',
        url: '/css/stations/SIM-1',
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
    });

    const denied: Array<[string, string, unknown]> = [
      ['GET', '/css/stations/SIM-1', undefined],
      ['PATCH', '/css/stations/SIM-1', { enabled: false }],
      ['DELETE', '/css/stations/SIM-1', undefined],
      ['POST', '/css/stations/SIM-1/enable', undefined],
      ['POST', '/css/stations/SIM-1/disable', undefined],
      [
        'POST',
        '/css/stations',
        { stationId: 'SIM-1', targetUrl: 'ws://localhost:3003', evses: [{ evseId: 1 }] },
      ],
      ['POST', '/css/actions/plugIn', { stationId: 'SIM-1', evseId: 1 }],
    ];
    it.each(denied)(
      '%s %s returns 404 for a station in another site',
      async (method, url, payload) => {
        vi.mocked(getUserSiteIds).mockResolvedValue(['sit_a']);
        setupDbResults([{ siteId: 'sit_other' }]);
        const res = await app.inject({
          method: method as 'GET',
          url,
          headers: headers(),
          ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        expect(db.update).not.toHaveBeenCalled();
        expect(db.delete).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
        expect(pubsubState.publishCalls).toEqual([]);
      },
    );
  });

  describe('GET /css/stations', () => {
    it('returns rows and total for full access', async () => {
      setupDbResults([listRow()], [{ count: 1 }]);
      const res = await app.inject({
        method: 'GET',
        url: '/css/stations?page=2&limit=5',
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        data: [{ stationId: 'SIM-1', hasPassword: false, hasClientKey: false }],
        total: 1,
      });
      const [item] = res.json<{ data: Record<string, unknown>[] }>().data;
      expect(item).not.toHaveProperty('password');
      expect(item).not.toHaveProperty('clientKey');
      const chain = vi.mocked(db.select).mock.results[0]?.value as {
        offset: ReturnType<typeof vi.fn>;
        limit: ReturnType<typeof vi.fn>;
        where: ReturnType<typeof vi.fn>;
      };
      expect(chain.limit).toHaveBeenCalledWith(5);
      expect(chain.offset).toHaveBeenCalledWith(5);
      expect(chain.where).toHaveBeenCalledWith(undefined);
      expect(inArray).not.toHaveBeenCalled();
    });

    it('returns an empty page without querying when the user has no sites', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url: '/css/stations', headers: headers() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('filters by the allowed sites and defaults total to 0', async () => {
      vi.mocked(getUserSiteIds).mockResolvedValue(['sit_a', 'sit_b']);
      setupDbResults([], []);
      const res = await app.inject({ method: 'GET', url: '/css/stations', headers: headers() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(vi.mocked(inArray).mock.calls[0]?.[1]).toEqual(['sit_a', 'sit_b']);
    });
  });

  describe('PATCH /css/stations/:stationId', () => {
    it('returns 404 when the css station does not exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/css/stations/SIM-1',
        headers: headers(),
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
    });

    it('routes protocol fields to charging_stations, credentials to the security service and the rest to css_stations', async () => {
      // existing lookup, paired charging_stations lookup, charging_stations update,
      // css_stations update returning
      setupDbResults(
        [{ id: 'css_1' }],
        [{ id: 'cs_1' }],
        [],
        [{ ...STATION_ROW, password: 'pw-1234567890abcd', enabled: false }],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: '/css/stations/SIM-1',
        headers: headers(),
        payload: {
          ocppProtocol: 'ocpp2.1',
          securityProfile: 2,
          model: 'M2',
          serialNumber: null,
          firmwareVersion: '2.0',
          targetUrl: 'wss://csms.example.com/ocpp',
          password: 'pw-1234567890abcd',
          clientCert: null,
          clientKey: null,
          caCert: null,
          enabled: false,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ enabled: false, hasPassword: true });
      expect(res.json()).not.toHaveProperty('password');
      expect(vi.mocked(changeSecurityProfile)).toHaveBeenCalledWith(
        'cs_1',
        2,
        'pw-1234567890abcd',
        expect.objectContaining({ log: expect.anything() }),
      );
      expect(vi.mocked(changeStationPassword)).not.toHaveBeenCalled();
      const [csSet, cssSet] = setCalls() as Record<string, unknown>[];
      expect(csSet).not.toHaveProperty('securityProfile');
      expect(csSet).toMatchObject({
        ocppProtocol: 'ocpp2.1',
        model: 'M2',
        serialNumber: null,
        firmwareVersion: '2.0',
      });
      expect(csSet?.['updatedAt']).toBeInstanceOf(Date);
      expect(cssSet).not.toHaveProperty('password');
      expect(cssSet).toMatchObject({
        targetUrl: 'wss://csms.example.com/ocpp',
        clientCert: null,
        clientKey: null,
        caCert: null,
        enabled: false,
      });
      expect(cssSet).not.toHaveProperty('ocppProtocol');
    });

    it('updates only css_stations when no charging_stations field changes', async () => {
      // existing lookup, no paired charging_stations row, css_stations update returning
      setupDbResults([{ id: 'css_1' }], [], [{ ...STATION_ROW, targetUrl: 'ws://other:3003' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/css/stations/SIM-1',
        headers: headers(),
        payload: { targetUrl: 'ws://other:3003' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ targetUrl: 'ws://other:3003' });
      expect(db.update).toHaveBeenCalledTimes(1);
      expect(setCalls()[0]).toMatchObject({ targetUrl: 'ws://other:3003' });
    });

    it('changes only the password through the security service for a paired station', async () => {
      setupDbResults([{ id: 'css_1' }], [{ id: 'cs_1' }], [STATION_ROW]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/css/stations/SIM-1',
        headers: headers(),
        payload: { password: 'pw-1234567890abcd' },
      });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(changeStationPassword)).toHaveBeenCalledWith(
        'cs_1',
        'pw-1234567890abcd',
        expect.objectContaining({ log: expect.anything() }),
      );
      expect(vi.mocked(changeSecurityProfile)).not.toHaveBeenCalled();
      expect(setCalls()[0]).not.toHaveProperty('password');
    });

    it('stores the password on the simulator row only when no charging_stations row exists', async () => {
      setupDbResults([{ id: 'css_1' }], [], [STATION_ROW]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/css/stations/SIM-1',
        headers: headers(),
        payload: { password: 'pw-1234567890abcd' },
      });
      expect(res.statusCode).toBe(200);
      expect(vi.mocked(changeStationPassword)).not.toHaveBeenCalled();
      expect(setCalls()[0]).toMatchObject({ password: 'pw-1234567890abcd' });
    });
  });

  describe('DELETE, enable and disable', () => {
    it('deletes an existing station with 204', async () => {
      setupDbResults([{ id: 'css_1' }], []);
      const res = await app.inject({
        method: 'DELETE',
        url: '/css/stations/SIM-1',
        headers: headers(),
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(db.delete).toHaveBeenCalledWith(expect.objectContaining({ __t: 'cssStations' }));
    });

    it.each([
      ['enable', true],
      ['disable', false],
    ] as const)('%s sets enabled=%s', async (action, enabled) => {
      setupDbResults([{ id: 'css_1' }], [{ ...STATION_ROW, enabled }]);
      const res = await app.inject({
        method: 'POST',
        url: `/css/stations/SIM-1/${action}`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ stationId: 'SIM-1', enabled });
      expect(setCalls()[0]).toMatchObject({ enabled });
    });

    it.each(['enable', 'disable'])('%s returns 404 for an unknown station', async (action) => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: `/css/stations/SIM-1/${action}`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /css/stations', () => {
    it('returns 500 when the station insert returns no row', async () => {
      // duplicate check, existing cs lookup (simulator), css insert returning nothing
      setupDbResults([], [{ id: 'cs_1', isSimulator: true }], []);
      const res = await app.inject({
        method: 'POST',
        url: '/css/stations',
        headers: headers(),
        payload: { stationId: 'SIM-1', targetUrl: 'ws://localhost:3003', evses: [{ evseId: 1 }] },
      });
      expect(res.statusCode).toBe(500);
      // simulator row already exists: no charging_stations insert or update
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /css/actions', () => {
    const SIM = {
      id: 'css_1',
      stationId: 'SIM-1',
      ocppProtocol: 'ocpp2.1',
      chargingStationId: 'cs_1',
    };

    it('returns 404 when the station is not a simulator', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'POST',
        url: '/css/actions/plugIn',
        headers: headers(),
        payload: { stationId: 'SIM-1', evseId: 1 },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
    });

    it('reports unknown protocol in the version mismatch message', async () => {
      setupDbResults([{ ...SIM, ocppProtocol: null }]);
      const res = await app.inject({
        method: 'POST',
        url: '/css/actions/v21/sendHeartbeat',
        headers: headers(),
        payload: { stationId: 'SIM-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Action sendHeartbeat requires ocpp2.1, station SIM-1 is unknown',
        code: 'OCPP_VERSION_MISMATCH',
      });
    });

    it('startCharging returns 404 EVSE_NOT_FOUND for an unknown EVSE', async () => {
      setupDbResults([SIM], []);
      const res = await app.inject({
        method: 'POST',
        url: '/css/actions/startCharging',
        headers: headers(),
        payload: { stationId: 'SIM-1', evseId: 9, idToken: 'TAG' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'EVSE not found', code: 'EVSE_NOT_FOUND' });
      expect(pubsubState.publishCalls).toEqual([]);
    });

    it('startCharging returns 400 CONNECTOR_NOT_AVAILABLE when no cable is connected', async () => {
      setupDbResults([SIM], [{ id: 'evs_1' }], [{ status: 'available' }]);
      const res = await app.inject({
        method: 'POST',
        url: '/css/actions/startCharging',
        headers: headers(),
        payload: { stationId: 'SIM-1', evseId: 1, idToken: 'TAG' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Connector is not available for charging',
        code: 'CONNECTOR_NOT_AVAILABLE',
      });
      expect(pubsubState.publishCalls).toEqual([]);
    });

    it.each(['preparing', 'occupied', 'ev_connected', 'finishing'])(
      'startCharging dispatches when the connector is %s and returns simulator data',
      async (status) => {
        pubsubState.reply = { kind: 'success', data: { transactionId: 'tx-9' } };
        setupDbResults([SIM], [{ id: 'evs_1' }], [{ status }]);
        const res = await app.inject({
          method: 'POST',
          url: '/css/actions/startCharging',
          headers: headers(),
          payload: { stationId: 'SIM-1', evseId: 1, idToken: 'TAG' },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.data).toEqual({ transactionId: 'tx-9' });
        const sent = JSON.parse(pubsubState.publishCalls[0]?.[1] ?? '{}') as Record<
          string,
          unknown
        >;
        expect(sent).toEqual({
          commandId: body.commandId,
          stationId: 'SIM-1',
          action: 'startCharging',
          params: { evseId: 1, idToken: 'TAG' },
        });
        expect(pubsubState.unsubscribed).toBe(1);
      },
    );

    it('startCharging dispatches when the EVSE has no connector row', async () => {
      setupDbResults([SIM], [{ id: 'evs_1' }], []);
      const res = await app.inject({
        method: 'POST',
        url: '/css/actions/startCharging',
        headers: headers(),
        payload: { stationId: 'SIM-1', evseId: 1, idToken: 'TAG' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 400 CSS_ACTION_REJECTED with the simulator error', async () => {
      pubsubState.reply = { kind: 'failure', error: 'EVSE 1 not plugged' };
      setupDbResults([SIM]);
      const res = await app.inject({
        method: 'POST',
        url: '/css/actions/unplug',
        headers: headers(),
        payload: { stationId: 'SIM-1', evseId: 1 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'EVSE 1 not plugged', code: 'CSS_ACTION_REJECTED' });
    });

    it('uses a default message when the simulator rejects without an error', async () => {
      pubsubState.reply = { kind: 'failure' };
      setupDbResults([SIM]);
      const res = await app.inject({
        method: 'POST',
        url: '/css/actions/unplug',
        headers: headers(),
        payload: { stationId: 'SIM-1', evseId: 1 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Simulator rejected the action',
        code: 'CSS_ACTION_REJECTED',
      });
    });

    it('ignores malformed and unrelated results until its own arrives', async () => {
      pubsubState.reply = { kind: 'noise-then-success' };
      setupDbResults([SIM]);
      const res = await app.inject({
        method: 'POST',
        url: '/css/actions/plugIn',
        headers: headers(),
        payload: { stationId: 'SIM-1', evseId: 1 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('data');
    });

    it('returns 504 CSS_ACTION_TIMEOUT when the simulator never answers', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      pubsubState.reply = { kind: 'silent' };
      setupDbResults([SIM]);
      const pending = app.inject({
        method: 'POST',
        url: '/css/actions/plugIn',
        headers: headers(),
        payload: { stationId: 'SIM-1', evseId: 1 },
      });
      await vi.waitFor(() => {
        expect(pubsubState.publishCalls).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const res = await pending;
      expect(res.statusCode).toBe(504);
      expect(res.json()).toEqual({
        error: 'Simulator did not respond within 5s',
        code: 'CSS_ACTION_TIMEOUT',
      });
      expect(pubsubState.unsubscribed).toBe(1);
    });

    it('returns 400 with the publish error message when publishing fails', async () => {
      pubsubState.publishError = new Error('redis down');
      setupDbResults([SIM]);
      const res = await app.inject({
        method: 'POST',
        url: '/css/actions/plugIn',
        headers: headers(),
        payload: { stationId: 'SIM-1', evseId: 1 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'redis down', code: 'CSS_ACTION_REJECTED' });
      expect(pubsubState.unsubscribed).toBe(1);
    });

    it('returns 400 when subscribing fails, without publishing', async () => {
      pubsubState.subscribeError = new Error('subscribe failed');
      setupDbResults([SIM]);
      const res = await app.inject({
        method: 'POST',
        url: '/css/actions/plugIn',
        headers: headers(),
        payload: { stationId: 'SIM-1', evseId: 1 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'subscribe failed', code: 'CSS_ACTION_REJECTED' });
      expect(pubsubState.publishCalls).toEqual([]);
      expect(pubsubState.unsubscribed).toBe(0);
    });
  });
});
