// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_STATION_ID = 'sta_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const STATION_OCPP_ID = 'TEST-PAIR-001';

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
    'having',
    'selectDistinct',
    'selectDistinctOn',
    'as',
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

const updateChainSpy = vi.fn();
const insertChainSpy = vi.fn();

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => {
      insertChainSpy();
      return makeChain();
    }),
    update: vi.fn(() => {
      updateChainSpy();
      return makeChain();
    }),
    delete: vi.fn(() => makeChain()),
    selectDistinct: vi.fn(() => makeChain()),
    selectDistinctOn: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
    $client: {},
  },
  chargingStations: {},
  evses: {},
  connectors: {},
  chargingSessions: {},
  drivers: {},
  meterValues: {},
  sites: {},
  vendors: { id: 'id', name: 'name' },
  ocppMessageLogs: {},
  connectionLogs: {},
  stationCertificates: {},
  pricingGroupStations: {},
  pricingGroups: {},
  cssStations: { id: 'id', stationId: 'stationId' },
  cssEvses: {},
  cssConfigVariables: {},
  securityEvents: {},
  stationEvents: {},
  stationConfigurations: {},
  firmwareUpdates: {},
  chargingProfiles: {},
  evChargingNeeds: {},
  variableMonitoringRules: {},
  eventAlerts: {},
  chargingProfileTemplates: {},
  configTemplates: {},
}));

vi.mock('drizzle-orm', () => {
  const sqlFn = () => ({ as: vi.fn() });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    sql: Object.assign(vi.fn(sqlFn), { raw: vi.fn(sqlFn), join: vi.fn(() => '') }),
    gte: vi.fn(),
    desc: vi.fn(),
    count: vi.fn(),
    inArray: vi.fn(),
    isNotNull: vi.fn(),
    isNull: vi.fn(),
  };
});

vi.mock('argon2', () => ({
  hash: vi.fn().mockResolvedValue('hashed_password'),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
  checkStationSiteAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

const { mockPublish, mockSubscribe } = vi.hoisted(() => {
  const pub = vi.fn().mockResolvedValue(undefined);
  const sub = vi.fn().mockImplementation(async (_channel: string, _cb: (raw: string) => void) => {
    return { unsubscribe: vi.fn() };
  });
  return { mockPublish: pub, mockSubscribe: sub };
});

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({ publish: mockPublish, subscribe: mockSubscribe })),
  setPubSub: vi.fn(),
}));

const enableCssPairMock = vi.fn().mockResolvedValue(undefined);
const disableCssPairMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/css-pairing.js', () => ({
  enableCssPair: (...args: unknown[]) => enableCssPairMock(...args),
  disableCssPair: (...args: unknown[]) => disableCssPairMock(...args),
}));

import { registerAuth } from '../plugins/auth.js';
import { stationRoutes } from '../routes/stations.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(stationRoutes);
  await app.ready();
  return app;
}

describe('PATCH /v1/stations/:id isSimulator toggle pairs css_stations', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    enableCssPairMock.mockClear();
    disableCssPairMock.mockClear();
    vi.clearAllMocks();
  });

  it('calls enableCssPair when isSimulator flips false -> true', async () => {
    setupDbResults(
      // update().returning() result
      [
        {
          id: VALID_STATION_ID,
          stationId: STATION_OCPP_ID,
          siteId: null,
          vendorId: null,
          model: 'TestModel',
          serialNumber: 'SN1',
          firmwareVersion: '1.0',
          availability: 'available',
          onboardingStatus: 'accepted',
          isOnline: false,
          isSimulator: true,
          loadPriority: 0,
          securityProfile: 1,
          ocppProtocol: 'ocpp2.1',
          hasPassword: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    );

    const res = await app.inject({
      method: 'PATCH',
      url: `/stations/${VALID_STATION_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isSimulator: true },
    });

    expect(res.statusCode).toBe(200);
    expect(enableCssPairMock).toHaveBeenCalledTimes(1);
    expect(disableCssPairMock).not.toHaveBeenCalled();
    const callArgs = enableCssPairMock.mock.calls[0]?.[0];
    expect(callArgs).toMatchObject({
      stationId: STATION_OCPP_ID,
      ocppProtocol: 'ocpp2.1',
      securityProfile: 1,
    });
  });

  it('calls disableCssPair when isSimulator flips true -> false', async () => {
    setupDbResults([
      {
        id: VALID_STATION_ID,
        stationId: STATION_OCPP_ID,
        siteId: null,
        vendorId: null,
        model: 'TestModel',
        serialNumber: 'SN1',
        firmwareVersion: '1.0',
        availability: 'available',
        onboardingStatus: 'accepted',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 1,
        ocppProtocol: 'ocpp2.1',
        hasPassword: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/stations/${VALID_STATION_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isSimulator: false },
    });

    expect(res.statusCode).toBe(200);
    expect(disableCssPairMock).toHaveBeenCalledTimes(1);
    expect(disableCssPairMock).toHaveBeenCalledWith(STATION_OCPP_ID);
    expect(enableCssPairMock).not.toHaveBeenCalled();
  });

  it('skips css pairing when isSimulator is omitted', async () => {
    setupDbResults([
      {
        id: VALID_STATION_ID,
        stationId: STATION_OCPP_ID,
        siteId: null,
        vendorId: null,
        model: 'NewModel',
        serialNumber: 'SN1',
        firmwareVersion: '1.0',
        availability: 'available',
        onboardingStatus: 'accepted',
        isOnline: false,
        isSimulator: false,
        loadPriority: 0,
        securityProfile: 1,
        ocppProtocol: 'ocpp2.1',
        hasPassword: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/stations/${VALID_STATION_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'NewModel' },
    });

    expect(res.statusCode).toBe(200);
    expect(enableCssPairMock).not.toHaveBeenCalled();
    expect(disableCssPairMock).not.toHaveBeenCalled();
  });
});
