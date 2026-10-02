// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { dbResults, published, conditions, resultCallback } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  published: [] as Record<string, unknown>[],
  conditions: [] as unknown[],
  resultCallback: { current: null as ((raw: string) => void) | null },
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize: () => async (request: { jwtVerify: () => Promise<void> }) => {
    await request.jwtVerify();
  },
  invalidatePermissionCache: vi.fn(),
}));

// The station answers every GetVariables item with Accepted.
vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    subscribe: vi.fn(async (_channel: string, cb: (raw: string) => void) => {
      resultCallback.current = cb;
      return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
    }),
    publish: vi.fn(async (_channel: string, raw: string) => {
      const msg = JSON.parse(raw) as {
        commandId: string;
        payload: { getVariableData: Record<string, unknown>[] };
      };
      published.push(msg.payload);
      const getVariableResult = msg.payload.getVariableData.map((d) => ({
        attributeStatus: 'Accepted',
        attributeValue: '1',
        component: d['component'],
        variable: d['variable'],
      }));
      queueMicrotask(() => {
        resultCallback.current?.(
          JSON.stringify({ commandId: msg.commandId, response: { getVariableResult } }),
        );
      });
    }),
  })),
  setPubSub: vi.fn(),
}));

vi.mock('@evtivity/ocpp', () => ({
  ActionRegistry: { GetVariables: { validateRequest: vi.fn().mockReturnValue(true) } },
  ActionRegistry16: {},
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      conditions.push(['eq', col, val]);
      return { eq: [col, val] };
    },
    isNull: (col: unknown) => {
      conditions.push(['isNull', col]);
      return { isNull: col };
    },
    and: (...c: unknown[]) => ({ and: c }),
  };
});

// Each awaited select takes the next preset result.
vi.mock('@evtivity/database', () => {
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'orderBy']) chain[m] = vi.fn(() => chain);
    chain['then'] = (onFulfilled?: (v: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(onFulfilled);
    return chain;
  }
  return {
    db: {
      select: vi.fn(() => makeChain()),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue([{ id: 1 }]) })),
    },
    chargingStations: {
      id: 'chargingStations.id',
      siteId: 'chargingStations.siteId',
      stationId: 'chargingStations.stationId',
      ocppProtocol: 'chargingStations.ocppProtocol',
    },
    stationConfigurations: {
      stationId: 'sc.stationId',
      component: 'sc.component',
      instance: 'sc.instance',
      evseId: 'sc.evseId',
      connectorId: 'sc.connectorId',
      variable: 'sc.variable',
      variableInstance: 'sc.variableInstance',
      attributeType: 'sc.attributeType',
      value: 'sc.value',
    },
    stationAuditLog: {},
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
});

import { registerAuth } from '../plugins/auth.js';
import { ocppCommandRoutes } from '../routes/ocpp-commands.js';

const FIVE_VARIABLES = [
  {
    component: { name: 'DeviceDataCtrlr' },
    variable: { name: 'ItemsPerMessage', instance: 'GetReport' },
  },
  {
    component: { name: 'DeviceDataCtrlr' },
    variable: { name: 'ItemsPerMessage', instance: 'GetVariables' },
  },
  {
    component: { name: 'DeviceDataCtrlr' },
    variable: { name: 'BytesPerMessage', instance: 'GetReport' },
  },
  {
    component: { name: 'DeviceDataCtrlr' },
    variable: { name: 'BytesPerMessage', instance: 'GetVariables' },
  },
  { component: { name: 'AuthCtrlr' }, variable: { name: 'AuthorizeRemoteStart' } },
];

const STATION = { id: 'sta_1', siteId: null, ocppProtocol: 'ocpp2.1' };

describe('POST /ocpp/commands/v21/GetVariables', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    ocppCommandRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults.length = 0;
    published.length = 0;
    conditions.length = 0;
  });

  function send() {
    return app.inject({
      method: 'POST',
      url: '/ocpp/commands/v21/GetVariables',
      headers: { authorization: `Bearer ${token}` },
      payload: { stationId: 'CS-1', getVariableData: FIVE_VARIABLES },
    });
  }

  it('splits by the stored ItemsPerMessage[GetVariables] limit', async () => {
    // station lookup, limit lookup, first-chunk station check
    dbResults.push([{ id: 'sta_1' }], [{ value: '4' }], [STATION]);

    const res = await send();

    expect(res.statusCode).toBe(200);
    expect(published.map((p) => (p['getVariableData'] as unknown[]).length)).toEqual([4, 1]);
    const body = res.json<{ response: { getVariableResult: unknown[] } }>();
    expect(body.response.getVariableResult).toHaveLength(5);
  });

  it('reads only the top-level Actual ItemsPerMessage[GetVariables] row', async () => {
    dbResults.push([{ id: 'sta_1' }], [{ value: '4' }], [STATION]);

    await send();

    expect(conditions).toEqual(
      expect.arrayContaining([
        ['eq', 'sc.component', 'DeviceDataCtrlr'],
        ['isNull', 'sc.instance'],
        ['isNull', 'sc.evseId'],
        ['isNull', 'sc.connectorId'],
        ['eq', 'sc.variable', 'ItemsPerMessage'],
        ['eq', 'sc.variableInstance', 'GetVariables'],
        ['eq', 'sc.attributeType', 'Actual'],
      ]),
    );
  });

  it('sends one request when the station has not reported the limit', async () => {
    dbResults.push([{ id: 'sta_1' }], [], [STATION]);

    const res = await send();

    expect(res.statusCode).toBe(200);
    expect(published.map((p) => (p['getVariableData'] as unknown[]).length)).toEqual([5]);
  });
});
