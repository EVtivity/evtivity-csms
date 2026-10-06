// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const STATION = 'sta_000000000001';
const USER = 'usr_000000000001';
const ROLE = 'rol_000000000001';
const SITE_A = 'sit_000000000001';
const SITE_B = 'sit_000000000002';
const VENDOR = 'vnd_000000000001';
const GROUP = 'pgr_000000000001';
const OTHER_GROUP = 'pgr_000000000002';

// -- DB mock: every db.select/insert/update/delete builds a chain that records
// its method calls and resolves to the next queued result when awaited.

interface ChainRecord {
  op: string;
  calls: Array<[string, unknown[]]>;
}

const dbState = vi.hoisted(() => ({
  results: [] as unknown[],
  index: 0,
  chains: [] as Array<{ op: string; calls: Array<[string, unknown[]]> }>,
}));

function queue(...results: unknown[]): void {
  dbState.results = results;
  dbState.index = 0;
}

function chainsOf(op: string): ChainRecord[] {
  return dbState.chains.filter((c) => c.op === op);
}

function argsOf(chain: ChainRecord | undefined, method: string): unknown[] | undefined {
  return chain?.calls.find(([m]) => m === method)?.[1];
}

const tables = vi.hoisted(() => {
  // Each table is a proxy whose columns describe themselves, so drizzle
  // operator mocks can record which column a condition targets.
  const make = (tableName: string): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== 'string' || prop === 'then') return undefined;
          return { name: prop, table: {}, col: `${tableName}.${prop}` };
        },
      },
    );
  const names = [
    'chargingStations',
    'evses',
    'connectors',
    'chargingSessions',
    'drivers',
    'meterValues',
    'sites',
    'vendors',
    'ocppMessageLogs',
    'connectionLogs',
    'stationCertificates',
    'pricingGroupStations',
    'pricingGroups',
    'securityEvents',
    'stationEvents',
    'stationConfigurations',
    'firmwareUpdates',
    'firmwareCampaigns',
    'chargingProfiles',
    'evChargingNeeds',
    'variableMonitoringRules',
    'eventAlerts',
    'chargingProfileTemplates',
    'configTemplates',
    'guestSessions',
    'pricingAssignmentAuditLog',
    'cssStations',
    'cssEvses',
    'maintenanceEvents',
    'stationAuditLog',
  ];
  return Object.fromEntries(names.map((n) => [n, make(n)]));
});

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  subscribe: vi.fn(),
  sendOcpp: vi.fn(),
  writeAudit: vi.fn(),
  execute: vi.fn(),
  pricingGroupExists: vi.fn(),
  publishPricingChanged: vi.fn(),
  enableCssPair: vi.fn(),
  disableCssPair: vi.fn(),
  getUserSiteIds: vi.fn(),
  checkStationSiteAccess: vi.fn(),
  userCanAccessSite: vi.fn(),
  sqlCalls: [] as unknown[][],
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ publish: mocks.publish, subscribe: mocks.subscribe })),
  setPubSub: vi.fn(),
}));

vi.mock('@evtivity/database', async () => {
  const pgErrors = await import('../../../database/src/lib/pg-errors.js');
  const makeChain = (op: string): Record<string, unknown> => {
    const record = { op, calls: [] as Array<[string, unknown[]]> };
    dbState.chains.push(record);
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
      'having',
      'as',
    ];
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        record.calls.push([m, args]);
        return chain;
      };
    }
    let settled: Promise<unknown> | null = null;
    chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
      if (settled == null) {
        const r = dbState.results[dbState.index] ?? [];
        dbState.index++;
        settled = r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      }
      return settled.then(resolve, reject);
    };
    return chain;
  };
  const dbMock: Record<string, unknown> = {
    select: vi.fn(() => makeChain('select')),
    selectDistinct: vi.fn(() => makeChain('select')),
    selectDistinctOn: vi.fn(() => makeChain('select')),
    insert: vi.fn((t: unknown) => {
      const c = makeChain('insert');
      dbState.chains[dbState.chains.length - 1]?.calls.push(['into', [t]]);
      return c;
    }),
    update: vi.fn((t: unknown) => {
      const c = makeChain('update');
      dbState.chains[dbState.chains.length - 1]?.calls.push(['table', [t]]);
      return c;
    }),
    delete: vi.fn((t: unknown) => {
      const c = makeChain('delete');
      dbState.chains[dbState.chains.length - 1]?.calls.push(['table', [t]]);
      return c;
    }),
    execute: mocks.execute,
    $client: {},
  };
  dbMock['transaction'] = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(dbMock));
  return {
    db: dbMock,
    client: {},
    ...tables,
    writeAudit: mocks.writeAudit,
    pgErrorCode: pgErrors.pgErrorCode,
    PG_UNIQUE_VIOLATION: pgErrors.PG_UNIQUE_VIOLATION,
    PG_FOREIGN_KEY_VIOLATION: pgErrors.PG_FOREIGN_KEY_VIOLATION,
    setStationDisabled: vi.fn().mockResolvedValue({ availabilityChanged: false }),
    SESSION_END_REQUEST_CHANNEL: 'session_end_requests',
    recordSessionEndRequest: vi.fn().mockResolvedValue(true),
    isRoamingEnabled: vi.fn(() => Promise.resolve(false)),
    recordRemovedOcpiEvses: vi.fn(() => Promise.resolve()),
    stationStatusReasonSql: () => 'NULL',
    getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  };
});

vi.mock('drizzle-orm', () => {
  const sqlFn = (...args: unknown[]) => {
    mocks.sqlCalls.push(args);
    return { op: 'sql', values: args.slice(1), as: vi.fn(), mapWith: vi.fn() };
  };
  const colOf = (c: unknown) => (c as { col?: string } | undefined)?.col;
  return {
    eq: vi.fn((a: unknown, b: unknown) => ({ op: 'eq', col: colOf(a), val: b })),
    gte: vi.fn((a: unknown, b: unknown) => ({ op: 'gte', col: colOf(a), val: b })),
    lte: vi.fn((a: unknown, b: unknown) => ({ op: 'lte', col: colOf(a), val: b })),
    ilike: vi.fn((a: unknown, b: unknown) => ({ op: 'ilike', col: colOf(a), val: b })),
    inArray: vi.fn((a: unknown, b: unknown) => ({ op: 'inArray', col: colOf(a), val: b })),
    isNull: vi.fn((a: unknown) => ({ op: 'isNull', col: colOf(a) })),
    isNotNull: vi.fn((a: unknown) => ({ op: 'isNotNull', col: colOf(a) })),
    and: vi.fn((...conds: unknown[]) => ({ op: 'and', conds })),
    or: vi.fn((...conds: unknown[]) => ({ op: 'or', conds })),
    desc: vi.fn((a: unknown) => ({ op: 'desc', col: colOf(a) })),
    count: vi.fn(() => ({ op: 'count' })),
    sql: Object.assign(vi.fn(sqlFn), {
      raw: vi.fn(sqlFn),
      join: vi.fn(() => ''),
      identifier: vi.fn(sqlFn),
    }),
    getTableName: vi.fn(() => 'charging_stations'),
  };
});

vi.mock('@evtivity/services/ocpp-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/services/ocpp-command')>()),
  sendOcppCommandAndWait: mocks.sendOcpp,
}));

vi.mock('@evtivity/services/availability-command', () => ({
  sendAvailabilityCommand: vi.fn().mockResolvedValue({ commandStatus: 'accepted', error: null }),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: mocks.getUserSiteIds,
  invalidateSiteAccessCache: vi.fn(),
  checkStationSiteAccess: mocks.checkStationSiteAccess,
  userCanAccessSite: mocks.userCanAccessSite,
}));

vi.mock('../lib/pricing-group-lookup.js', () => ({
  pricingGroupExists: mocks.pricingGroupExists,
}));

vi.mock('../lib/pricing-events.js', () => ({
  publishPricingChanged: mocks.publishPricingChanged,
}));

vi.mock('../lib/css-pairing.js', () => ({
  enableCssPair: mocks.enableCssPair,
  disableCssPair: mocks.disableCssPair,
}));

vi.mock('../services/station-security.service.js', () => ({
  changeStationPassword: vi.fn(),
  changeSecurityProfile: vi.fn(),
  rotateStationPassword: vi.fn(),
}));

vi.mock('../services/station-simulator.service.js', () => ({
  confirmRealStation: vi.fn(),
}));

vi.mock('argon2', () => ({
  hash: vi.fn().mockResolvedValue('hashed_password'),
}));

vi.mock('../lib/station-status-check.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/station-status-check.js')>()),
  triggerAndWaitForStatus: vi.fn().mockResolvedValue({ status: 'available' }),
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

import { registerAuth } from '../plugins/auth.js';
import { stationRoutes } from '../routes/stations.js';

const NOW = '2026-10-01T12:00:00.000Z';

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code });
}

function publishedOn(channel: string): Array<Record<string, unknown>> {
  return mocks.publish.mock.calls
    .filter((c) => c[0] === channel)
    .map((c) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

function ocppCalls(action: string): unknown[][] {
  return mocks.sendOcpp.mock.calls.filter((c) => c[1] === action);
}

describe('Station routes - extra coverage', () => {
  let app: FastifyInstance;
  let token: string;

  function inject(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  }

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(stationRoutes);
    await app.ready();
    token = app.jwt.sign({ userId: USER, roleId: ROLE });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    queue();
    dbState.chains = [];
    mocks.sqlCalls.length = 0;
    mocks.publish.mockResolvedValue(undefined);
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() });
    mocks.sendOcpp.mockResolvedValue({ commandId: 'cmd-1', response: { status: 'Accepted' } });
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.execute.mockResolvedValue([]);
    mocks.pricingGroupExists.mockResolvedValue(true);
    mocks.publishPricingChanged.mockResolvedValue(undefined);
    mocks.enableCssPair.mockResolvedValue(undefined);
    mocks.getUserSiteIds.mockResolvedValue(null);
    mocks.checkStationSiteAccess.mockResolvedValue(true);
    mocks.userCanAccessSite.mockResolvedValue(true);
  });

  // ---------------------------------------------------------------------------
  describe('site access denied returns 404 without touching the database', () => {
    const cases: Array<[string, 'GET' | 'POST' | 'DELETE', string, unknown?]> = [
      ['refresh configurations', 'POST', `/stations/${STATION}/configurations/refresh`],
      ['uptime history', 'GET', `/stations/${STATION}/uptime-history`],
      ['popular times', 'GET', `/stations/${STATION}/popular-times`],
      ['pricing group read', 'GET', `/stations/${STATION}/pricing-groups`],
      [
        'pricing group assign',
        'POST',
        `/stations/${STATION}/pricing-groups`,
        { pricingGroupId: GROUP },
      ],
      ['pricing group remove', 'DELETE', `/stations/${STATION}/pricing-groups/${GROUP}`],
      ['approve', 'POST', `/stations/${STATION}/approve`],
      ['unblock', 'POST', `/stations/${STATION}/unblock`],
      ['reject', 'POST', `/stations/${STATION}/reject`],
      ['security events', 'GET', `/stations/${STATION}/security-events`],
      ['events', 'GET', `/stations/${STATION}/events`],
      ['variables', 'GET', `/stations/${STATION}/variables`],
      ['firmware history', 'GET', `/stations/${STATION}/firmware-history`],
      ['charging profiles', 'GET', `/stations/${STATION}/charging-profiles`],
      ['refresh profiles', 'POST', `/stations/${STATION}/charging-profiles/refresh`],
      ['composite schedule', 'POST', `/stations/${STATION}/charging-profiles/composite`, {}],
      ['clear profiles', 'POST', `/stations/${STATION}/charging-profiles/clear`, {}],
      ['push profile', 'POST', `/stations/${STATION}/charging-profiles/push`, { templateId: 't1' }],
      ['push config', 'POST', `/stations/${STATION}/configurations/push`, { templateId: 't1' }],
      ['ev charging needs', 'GET', `/stations/${STATION}/ev-charging-needs`],
      ['monitoring rules list', 'GET', `/stations/${STATION}/monitoring-rules`],
      [
        'monitoring rule create',
        'POST',
        `/stations/${STATION}/monitoring-rules`,
        { component: 'EVSE', variable: 'Power', type: 'Delta', value: 5 },
      ],
      ['monitoring rule delete', 'DELETE', `/stations/${STATION}/monitoring-rules/3`],
      ['event alerts', 'GET', `/stations/${STATION}/event-alerts`],
      ['acknowledge alert', 'POST', `/stations/${STATION}/event-alerts/4/acknowledge`],
      ['standalone meter values', 'GET', `/stations/${STATION}/standalone-meter-values`],
      ['sessions', 'GET', `/stations/${STATION}/sessions`],
      ['ocpp logs', 'GET', `/stations/${STATION}/ocpp-logs`],
      ['meter values', 'GET', `/stations/${STATION}/meter-values`],
      ['energy history', 'GET', `/stations/${STATION}/energy-history`],
      ['revenue history', 'GET', `/stations/${STATION}/revenue-history`],
      ['certificates', 'GET', `/stations/${STATION}/certificates`],
      [
        'add connector',
        'POST',
        `/stations/${STATION}/evses/1/connectors`,
        { connectorId: 2, connectorType: 'CCS2', maxPowerKw: 50 },
      ],
      ['delete evse', 'DELETE', `/stations/${STATION}/evses/1`],
      ['delete connector', 'DELETE', `/stations/${STATION}/evses/1/connectors/1`],
      ['refresh evse status', 'POST', `/stations/${STATION}/evses/1/refresh-status`],
    ];

    it.each(cases)('%s', async (_name, method, url, payload) => {
      mocks.checkStationSiteAccess.mockResolvedValue(false);
      const res = await inject(method, url, payload);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(mocks.checkStationSiteAccess).toHaveBeenCalledWith(STATION, USER);
      expect(dbState.chains).toHaveLength(0);
      expect(mocks.sendOcpp).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  describe('GET /stations filters', () => {
    it('returns an empty page without querying when the user has no sites', async () => {
      mocks.getUserSiteIds.mockResolvedValue([]);
      const res = await inject('GET', '/stations');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(dbState.chains).toHaveLength(0);
    });

    it('applies site scope and every query filter to the where clause', async () => {
      mocks.getUserSiteIds.mockResolvedValue([SITE_A]);
      queue([], [{ count: 0 }]);
      const res = await inject(
        'GET',
        `/stations?siteId=${SITE_A}&search=abc&isOnline=true&isSimulator=false&onboardingStatus=pending&status=faulted&page=2&limit=5`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });

      const listChain = chainsOf('select')[0];
      const where = argsOf(listChain, 'where')?.[0] as { op: string; conds: unknown[] };
      expect(where.op).toBe('and');
      expect(where.conds).toEqual(
        expect.arrayContaining([
          {
            op: 'or',
            conds: [
              { op: 'isNull', col: 'chargingStations.siteId' },
              { op: 'inArray', col: 'chargingStations.siteId', val: [SITE_A] },
            ],
          },
          { op: 'eq', col: 'chargingStations.siteId', val: SITE_A },
          {
            op: 'or',
            conds: [
              { op: 'ilike', col: 'chargingStations.id', val: '%abc%' },
              { op: 'ilike', col: 'chargingStations.stationId', val: '%abc%' },
              { op: 'ilike', col: 'chargingStations.model', val: '%abc%' },
            ],
          },
          { op: 'eq', col: 'chargingStations.isOnline', val: true },
          { op: 'eq', col: 'chargingStations.isSimulator', val: false },
          { op: 'eq', col: 'chargingStations.onboardingStatus', val: 'pending' },
        ]),
      );
      // status filter is a derived-status SQL comparison against the value
      expect(where.conds).toHaveLength(7);
      expect(mocks.sqlCalls.some((args) => args.slice(1).includes('faulted'))).toBe(true);
      expect(argsOf(listChain, 'limit')).toEqual([5]);
      expect(argsOf(listChain, 'offset')).toEqual([5]);
      // the count query uses the same where clause
      expect(argsOf(chainsOf('select')[1], 'where')?.[0]).toBe(where);
    });

    it('sends no where clause when no filter applies', async () => {
      queue([], [{ count: 3 }]);
      const res = await inject('GET', '/stations');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 3 });
      expect(argsOf(chainsOf('select')[0], 'where')).toEqual([undefined]);
    });
  });

  describe('GET /stations/:id site scope', () => {
    it('returns 404 when the station belongs to a site the user cannot see', async () => {
      mocks.getUserSiteIds.mockResolvedValue([SITE_A]);
      queue([{ id: STATION, siteId: SITE_B }]);
      const res = await inject('GET', `/stations/${STATION}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /stations/:id/configurations/refresh', () => {
    it('returns 404 when the station does not exist', async () => {
      queue([]);
      const res = await inject('POST', `/stations/${STATION}/configurations/refresh`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 when the station is offline', async () => {
      queue([{ id: STATION, stationId: 'CS-1', isOnline: false, ocppProtocol: 'ocpp2.1' }]);
      const res = await inject('POST', `/stations/${STATION}/configurations/refresh`);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('STATION_OFFLINE');
      expect(mocks.sendOcpp).not.toHaveBeenCalled();
    });

    it('sends GetConfiguration for an OCPP 1.6 station', async () => {
      queue([{ id: STATION, stationId: 'CS-16', isOnline: true, ocppProtocol: 'ocpp1.6' }]);
      const res = await inject('POST', `/stations/${STATION}/configurations/refresh`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mocks.sendOcpp).toHaveBeenCalledWith('CS-16', 'GetConfiguration', {}, '1.6');
    });

    it('sends GetBaseReport FullInventory for an OCPP 2.1 station', async () => {
      queue([{ id: STATION, stationId: 'CS-21', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      const res = await inject('POST', `/stations/${STATION}/configurations/refresh`);
      expect(res.statusCode).toBe(200);
      expect(mocks.sendOcpp).toHaveBeenCalledWith(
        'CS-21',
        'GetBaseReport',
        { requestId: expect.any(Number), reportBase: 'FullInventory' },
        '2.1',
      );
    });

    it('returns 502 when the station command fails', async () => {
      queue([{ id: STATION, stationId: 'CS-21', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      mocks.sendOcpp.mockResolvedValue({ commandId: 'c', error: 'Timeout' });
      const res = await inject('POST', `/stations/${STATION}/configurations/refresh`);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'Timeout', code: 'OCPP_COMMAND_FAILED' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /stations', () => {
    const createdRow = {
      id: STATION,
      stationId: 'CS-NEW',
      siteId: SITE_A,
      vendorId: VENDOR,
      model: 'M1',
      serialNumber: null,
      firmwareVersion: null,
      availability: 'available',
      onboardingStatus: 'accepted',
      isOnline: false,
      isSimulator: true,
      loadPriority: 5,
      securityProfile: 1,
      pendingSecurityProfile: null,
      ocppProtocol: 'ocpp2.1',
      createdAt: NOW,
      updatedAt: NOW,
    };

    it('returns 404 when the user cannot access the target site', async () => {
      mocks.userCanAccessSite.mockResolvedValue(false);
      const res = await inject('POST', '/stations', { stationId: 'CS-NEW', siteId: SITE_A });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
      expect(mocks.userCanAccessSite).toHaveBeenCalledWith(USER, SITE_A);
      expect(chainsOf('insert')).toHaveLength(0);
    });

    it('returns 404 when the vendor does not exist', async () => {
      queue([], []);
      const res = await inject('POST', '/stations', { stationId: 'CS-NEW', vendorId: VENDOR });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('VENDOR_NOT_FOUND');
      expect(chainsOf('insert')).toHaveLength(0);
    });

    it('returns 409 when the station ID already exists', async () => {
      queue([{ id: 'sta_existing00001' }]);
      const res = await inject('POST', '/stations', { stationId: 'CS-NEW' });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('STATION_ID_EXISTS');
    });

    it('rejects a password longer than 20 characters on an OCPP 1.6 station', async () => {
      queue([]);
      const res = await inject('POST', '/stations', {
        stationId: 'CS-NEW',
        ocppProtocol: 'ocpp1.6',
        password: 'a'.repeat(25),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(chainsOf('insert')).toHaveLength(0);
    });

    it('pairs a simulator, creates its config template, and audits the creation', async () => {
      queue([{ id: VENDOR }], [], [createdRow], []);
      const res = await inject('POST', '/stations', {
        stationId: 'CS-NEW',
        siteId: SITE_A,
        vendorId: VENDOR,
        model: 'M1',
        ocppProtocol: 'ocpp2.1',
        securityProfile: 1,
        password: 'abcdefghijklmnopqrst',
        isSimulator: true,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: STATION, stationId: 'CS-NEW', hasPassword: true });

      const [stationInsert, templateInsert] = chainsOf('insert');
      const stationValues = argsOf(stationInsert, 'values')?.[0] as Record<string, unknown>;
      expect(stationValues).toMatchObject({
        stationId: 'CS-NEW',
        basicAuthPasswordHash: 'hashed_password',
        isSimulator: true,
      });
      expect(stationValues).not.toHaveProperty('password');

      expect(mocks.enableCssPair).toHaveBeenCalledWith(
        expect.objectContaining({
          stationId: 'CS-NEW',
          ocppProtocol: 'ocpp2.1',
          securityProfile: 1,
          password: 'abcdefghijklmnopqrst',
        }),
        expect.anything(),
      );

      expect(argsOf(templateInsert, 'values')?.[0]).toEqual({
        name: 'CS-NEW - Configurations',
        description: 'Auto generated. CS-NEW configurations (OCPP 2.1)',
        ocppVersion: '2.1',
        variables: [],
        stationId: STATION,
        targetFilter: { stationId: STATION, siteId: SITE_A, vendorId: VENDOR, model: 'M1' },
      });

      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ entityId: STATION, action: 'created', after: createdRow }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('builds a 1.6 template filter with only the station when no site, vendor, or model', async () => {
      queue(
        [],
        [
          {
            ...createdRow,
            isSimulator: false,
            siteId: null,
            vendorId: null,
            model: null,
            ocppProtocol: 'ocpp1.6',
          },
        ],
        [],
      );
      const res = await inject('POST', '/stations', { stationId: 'CS-NEW' });
      expect(res.statusCode).toBe(201);
      expect(res.json().hasPassword).toBe(false);
      expect(mocks.enableCssPair).not.toHaveBeenCalled();
      const templateInsert = chainsOf('insert')[1];
      expect(argsOf(templateInsert, 'values')?.[0]).toMatchObject({
        ocppVersion: '1.6',
        targetFilter: { stationId: STATION },
      });
    });

    it('maps a unique violation inside the transaction to 409', async () => {
      queue([], pgError('23505'));
      const res = await inject('POST', '/stations', { stationId: 'CS-NEW' });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('STATION_ID_EXISTS');
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });

    it('rethrows other database errors as 500', async () => {
      queue([], pgError('XX000'));
      const res = await inject('POST', '/stations', { stationId: 'CS-NEW' });
      expect(res.statusCode).toBe(500);
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  describe('PATCH /stations/:id site scope', () => {
    it('returns 404 when a scoped user patches a missing station', async () => {
      mocks.getUserSiteIds.mockResolvedValue([SITE_A]);
      queue([]);
      const res = await inject('PATCH', `/stations/${STATION}`, { model: 'X' });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(chainsOf('update')).toHaveLength(0);
    });

    it('returns 404 when the station is on a site outside the user scope', async () => {
      mocks.getUserSiteIds.mockResolvedValue([SITE_A]);
      queue([{ siteId: SITE_B }]);
      const res = await inject('PATCH', `/stations/${STATION}`, { model: 'X' });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(chainsOf('update')).toHaveLength(0);
    });

    it('returns 404 SITE_NOT_FOUND when moving to an inaccessible site', async () => {
      mocks.userCanAccessSite.mockResolvedValue(false);
      const res = await inject('PATCH', `/stations/${STATION}`, { siteId: SITE_B });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
      expect(mocks.userCanAccessSite).toHaveBeenCalledWith(USER, SITE_B);
      expect(chainsOf('update')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /stations/:id/evses', () => {
    const body = {
      evseId: 2,
      connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
    };

    it('maps a unique violation on insert to 409 DUPLICATE_EVSE_ID', async () => {
      queue([{ id: STATION, ocppProtocol: 'ocpp2.1' }], [], pgError('23505'));
      const res = await inject('POST', `/stations/${STATION}/evses`, body);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'EVSE ID 2 already exists on this station',
        code: 'DUPLICATE_EVSE_ID',
      });
    });

    it('returns 500 when the insert returns no row', async () => {
      queue([{ id: STATION, ocppProtocol: 'ocpp2.1' }], [], []);
      const res = await inject('POST', `/stations/${STATION}/evses`, body);
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('INTERNAL_ERROR');
    });

    it('mirrors new connectors into css_evses for a paired simulator', async () => {
      queue(
        [{ id: STATION, ocppProtocol: 'ocpp2.1' }],
        [],
        [{ id: 'evs_000000000009', evseId: 2 }],
        [
          {
            connectorId: 1,
            connectorType: 'CCS2',
            maxPowerKw: 150,
            maxCurrentAmps: null,
            status: 'unavailable',
          },
        ],
        [{ id: 'css-1' }],
        [],
      );
      const res = await inject('POST', `/stations/${STATION}/evses`, body);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        evseId: 2,
        connectors: [
          {
            connectorId: 1,
            connectorType: 'CCS2',
            maxPowerKw: 150,
            maxCurrentAmps: null,
            status: 'unavailable',
          },
        ],
      });
      const cssInsert = chainsOf('insert')[2];
      expect(argsOf(cssInsert, 'into')?.[0]).toBe(tables['cssEvses']);
      expect(argsOf(cssInsert, 'values')?.[0]).toEqual([
        {
          cssStationId: 'css-1',
          evseId: 2,
          connectorId: 1,
          connectorType: 'dc_ccs2',
          maxPowerW: 150000,
        },
      ]);
      expect(argsOf(cssInsert, 'onConflictDoUpdate')).toBeDefined();
    });
  });

  describe('POST /stations/:id/evses/:evseId/connectors', () => {
    const body = { connectorId: 2, connectorType: 'CHAdeMO', maxPowerKw: 50 };

    it('maps a unique violation on insert to 409 DUPLICATE_CONNECTOR_ID', async () => {
      queue([{ id: 'evs_000000000001', ocppProtocol: 'ocpp2.1' }], [], pgError('23505'));
      const res = await inject('POST', `/stations/${STATION}/evses/1/connectors`, body);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_CONNECTOR_ID');
    });

    it('returns 500 when the insert returns no row', async () => {
      queue([{ id: 'evs_000000000001', ocppProtocol: 'ocpp2.1' }], [], []);
      const res = await inject('POST', `/stations/${STATION}/evses/1/connectors`, body);
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('INTERNAL_ERROR');
    });

    it('mirrors the connector into css_evses for a paired simulator', async () => {
      queue(
        [{ id: 'evs_000000000001', ocppProtocol: 'ocpp2.1' }],
        [],
        [
          {
            connectorId: 2,
            connectorType: 'CHAdeMO',
            maxPowerKw: 50,
            maxCurrentAmps: null,
            status: 'unavailable',
          },
        ],
        [{ id: 'css-7' }],
        [],
      );
      const res = await inject('POST', `/stations/${STATION}/evses/1/connectors`, body);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        connectorId: 2,
        connectorType: 'CHAdeMO',
        maxPowerKw: 50,
        maxCurrentAmps: null,
        status: 'unavailable',
      });
      const cssInsert = chainsOf('insert')[1];
      expect(argsOf(cssInsert, 'values')?.[0]).toEqual({
        cssStationId: 'css-7',
        evseId: 1,
        connectorId: 2,
        connectorType: 'dc_chademo',
        maxPowerW: 50000,
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('GET /stations/:id/uptime-history', () => {
    it('rounds uptime to two decimals and uses the site timezone', async () => {
      queue([{ siteTimezone: 'Europe/Berlin' }]);
      mocks.execute.mockResolvedValue([
        { date: '2026-09-30', uptime_percent: '99.456' },
        { date: '2026-10-01', uptime_percent: 100 },
      ]);
      const res = await inject('GET', `/stations/${STATION}/uptime-history?days=7`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { date: '2026-09-30', uptimePercent: 99.46 },
        { date: '2026-10-01', uptimePercent: 100 },
      ]);
      const uptimeSql = mocks.sqlCalls.find((args) =>
        String((args[0] as string[] | undefined)?.join('')).includes('daily_uptime'),
      );
      expect(uptimeSql?.slice(1)).toContain('Europe/Berlin');
      expect(uptimeSql?.slice(1)).toContain(STATION);
    });

    it('falls back to America/New_York when the station has no site timezone', async () => {
      queue([]);
      const res = await inject('GET', `/stations/${STATION}/uptime-history`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      const uptimeSql = mocks.sqlCalls.find((args) =>
        String((args[0] as string[] | undefined)?.join('')).includes('daily_uptime'),
      );
      expect(uptimeSql?.slice(1)).toContain('America/New_York');
    });

    it('rejects days above 90', async () => {
      const res = await inject('GET', `/stations/${STATION}/uptime-history?days=91`);
      expect(res.statusCode).toBe(400);
      expect(mocks.execute).not.toHaveBeenCalled();
    });
  });

  describe('GET /stations/:id/popular-times', () => {
    it('averages session counts over the requested weeks', async () => {
      queue(
        [{ siteTimezone: 'Asia/Tokyo' }],
        [
          { dow: 1, hour: 8, totalSessions: 6 },
          { dow: 5, hour: 18, totalSessions: 7 },
        ],
      );
      const res = await inject('GET', `/stations/${STATION}/popular-times?weeks=3`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        { dow: 1, hour: 8, avgSessions: 2 },
        { dow: 5, hour: 18, avgSessions: 2.3 },
      ]);
      const sessionsChain = chainsOf('select')[1];
      const where = argsOf(sessionsChain, 'where')?.[0] as { conds: Array<{ val: unknown }> };
      expect(where.conds[0]).toEqual({
        op: 'eq',
        col: 'chargingSessions.stationId',
        val: STATION,
      });
      const since = where.conds[1]?.val as Date;
      const expectedDays = (Date.now() - since.getTime()) / 86_400_000;
      expect(Math.round(expectedDays)).toBe(21);
      expect(mocks.sqlCalls.some((args) => args.slice(1).includes('Asia/Tokyo'))).toBe(true);
    });

    it('rejects weeks above 52', async () => {
      const res = await inject('GET', `/stations/${STATION}/popular-times?weeks=53`);
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  describe('station pricing groups', () => {
    it('returns the assigned pricing group', async () => {
      const row = {
        id: GROUP,
        name: 'Default',
        description: null,
        isDefault: true,
        tariffCount: 2,
      };
      queue([row]);
      const res = await inject('GET', `/stations/${STATION}/pricing-groups`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(row);
      expect(argsOf(chainsOf('select')[0], 'where')?.[0]).toEqual({
        op: 'eq',
        col: 'pricingGroupStations.stationId',
        val: STATION,
      });
    });

    it('returns null when the station has no pricing group', async () => {
      queue([]);
      const res = await inject('GET', `/stations/${STATION}/pricing-groups`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('null');
    });

    it('returns 404 when the pricing group does not exist', async () => {
      mocks.pricingGroupExists.mockResolvedValue(false);
      const res = await inject('POST', `/stations/${STATION}/pricing-groups`, {
        pricingGroupId: GROUP,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
      expect(mocks.pricingGroupExists).toHaveBeenCalledWith(GROUP);
      expect(chainsOf('insert')).toHaveLength(0);
    });

    it('creates an assignment, audits it as created, and publishes the change', async () => {
      queue([], [{ stationId: STATION, pricingGroupId: GROUP }]);
      const res = await inject('POST', `/stations/${STATION}/pricing-groups`, {
        pricingGroupId: GROUP,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ stationId: STATION, pricingGroupId: GROUP });
      expect(argsOf(chainsOf('insert')[0], 'values')?.[0]).toEqual({
        stationId: STATION,
        pricingGroupId: GROUP,
      });
      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'pricing_assignment_id' }),
        expect.objectContaining({
          entityId: STATION,
          action: 'created',
          before: null,
          after: { scope: 'station', stationId: STATION, pricingGroupId: GROUP },
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(mocks.publishPricingChanged).toHaveBeenCalledWith({
        pricingGroupId: GROUP,
        action: 'assignment.changed',
        stationId: STATION,
      });
    });

    it('audits a reassignment as updated with the previous group', async () => {
      queue(
        [{ stationId: STATION, pricingGroupId: OTHER_GROUP }],
        [{ stationId: STATION, pricingGroupId: GROUP }],
      );
      const res = await inject('POST', `/stations/${STATION}/pricing-groups`, {
        pricingGroupId: GROUP,
      });
      expect(res.statusCode).toBe(201);
      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'updated',
          before: { scope: 'station', stationId: STATION, pricingGroupId: OTHER_GROUP },
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('maps a foreign key violation (group deleted mid-request) to 404', async () => {
      queue([], pgError('23503'));
      const res = await inject('POST', `/stations/${STATION}/pricing-groups`, {
        pricingGroupId: GROUP,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_GROUP_NOT_FOUND');
      expect(mocks.writeAudit).not.toHaveBeenCalled();
      expect(mocks.publishPricingChanged).not.toHaveBeenCalled();
    });

    it('rethrows other insert errors as 500', async () => {
      queue([], pgError('XX000'));
      const res = await inject('POST', `/stations/${STATION}/pricing-groups`, {
        pricingGroupId: GROUP,
      });
      expect(res.statusCode).toBe(500);
      expect(mocks.publishPricingChanged).not.toHaveBeenCalled();
    });

    it('returns 404 when removing an assignment that does not exist', async () => {
      queue([]);
      const res = await inject('DELETE', `/stations/${STATION}/pricing-groups/${GROUP}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('PRICING_ASSIGNMENT_NOT_FOUND');
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });

    it('removes an assignment, audits the deletion, and publishes the change', async () => {
      queue([{ stationId: STATION, pricingGroupId: GROUP }]);
      const res = await inject('DELETE', `/stations/${STATION}/pricing-groups/${GROUP}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ stationId: STATION, pricingGroupId: GROUP });
      expect(argsOf(chainsOf('delete')[0], 'where')?.[0]).toEqual({
        op: 'and',
        conds: [
          { op: 'eq', col: 'pricingGroupStations.stationId', val: STATION },
          { op: 'eq', col: 'pricingGroupStations.pricingGroupId', val: GROUP },
        ],
      });
      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'deleted',
          before: { scope: 'station', stationId: STATION, pricingGroupId: GROUP },
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(mocks.publishPricingChanged).toHaveBeenCalledWith({
        pricingGroupId: GROUP,
        action: 'assignment.changed',
        stationId: STATION,
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('approve and unblock', () => {
    it('approves a pending simulator and nudges it to reboot', async () => {
      queue([{ onboardingStatus: 'pending', stationId: 'SIM-1', isSimulator: true }], []);
      const res = await inject('POST', `/stations/${STATION}/approve`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(argsOf(chainsOf('update')[0], 'set')?.[0]).toMatchObject({
        onboardingStatus: 'accepted',
      });
      expect(publishedOn('csms_events')).toEqual([
        { eventType: 'station.status', stationId: STATION },
      ]);
      expect(publishedOn('css_commands')).toEqual([
        {
          commandId: expect.any(String),
          stationId: 'SIM-1',
          action: 'rebootStation',
          params: {},
        },
      ]);
    });

    it('still approves when the simulator reboot nudge fails to publish', async () => {
      queue([{ onboardingStatus: 'pending', stationId: 'SIM-1', isSimulator: true }], []);
      mocks.publish.mockImplementation((channel: string) =>
        channel === 'css_commands' ? Promise.reject(new Error('redis down')) : Promise.resolve(),
      );
      const res = await inject('POST', `/stations/${STATION}/approve`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ notes: 'Station approved' }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('does not nudge a real station', async () => {
      queue([{ onboardingStatus: 'pending', stationId: 'CS-1', isSimulator: false }], []);
      const res = await inject('POST', `/stations/${STATION}/approve`);
      expect(res.statusCode).toBe(200);
      expect(publishedOn('css_commands')).toEqual([]);
    });

    it('returns 409 when unblocking a station that is not blocked', async () => {
      queue([{ onboardingStatus: 'accepted' }]);
      const res = await inject('POST', `/stations/${STATION}/unblock`);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('NOT_BLOCKED');
      expect(chainsOf('update')).toHaveLength(0);
    });

    it('returns 404 when unblocking a missing station', async () => {
      queue([]);
      const res = await inject('POST', `/stations/${STATION}/unblock`);
      expect(res.statusCode).toBe(404);
    });

    it('unblocks a blocked station back to pending', async () => {
      queue([{ onboardingStatus: 'blocked' }], []);
      const res = await inject('POST', `/stations/${STATION}/unblock`);
      expect(res.statusCode).toBe(200);
      expect(argsOf(chainsOf('update')[0], 'set')?.[0]).toMatchObject({
        onboardingStatus: 'pending',
      });
      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          before: { onboardingStatus: 'blocked' },
          after: { onboardingStatus: 'pending' },
          notes: 'Station unblocked',
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(publishedOn('csms_events')).toEqual([
        { eventType: 'station.status', stationId: STATION },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('read-only station lists', () => {
    it('GET security-events filters by severity and paginates', async () => {
      const row = {
        id: 1,
        stationId: STATION,
        type: 'TamperDetectionActivated',
        severity: 'high',
        timestamp: NOW,
        techInfo: null,
        createdAt: NOW,
      };
      queue([row], [{ total: 11 }]);
      const res = await inject(
        'GET',
        `/stations/${STATION}/security-events?severity=high&page=3&limit=5`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [row], total: 11 });
      const listChain = chainsOf('select')[0];
      expect(argsOf(listChain, 'where')?.[0]).toEqual({
        op: 'and',
        conds: [
          { op: 'eq', col: 'securityEvents.stationId', val: STATION },
          { op: 'eq', col: 'securityEvents.severity', val: 'high' },
        ],
      });
      expect(argsOf(listChain, 'offset')).toEqual([10]);
      expect(argsOf(listChain, 'limit')).toEqual([5]);
    });

    it('GET security-events rejects an unknown severity', async () => {
      const res = await inject('GET', `/stations/${STATION}/security-events?severity=urgent`);
      expect(res.statusCode).toBe(400);
    });

    it('GET security-events defaults the total to 0', async () => {
      queue([], []);
      const res = await inject('GET', `/stations/${STATION}/security-events`);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });

    const stationScoped: Array<[string, string, string]> = [
      ['events', 'events', 'stationEvents.stationId'],
      ['firmware history', 'firmware-history', 'firmwareUpdates.stationId'],
      ['monitoring rules', 'monitoring-rules', 'variableMonitoringRules.stationId'],
    ];

    it.each(stationScoped)('GET %s returns 404 for a missing station', async (_n, path) => {
      queue([]);
      const res = await inject('GET', `/stations/${STATION}/${path}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(chainsOf('select')).toHaveLength(1);
    });

    it('GET events lists station events', async () => {
      const row = {
        id: 9,
        stationId: STATION,
        generatedAt: NOW,
        seqNo: 0,
        tbc: false,
        eventData: { trigger: 'Alerting' },
        createdAt: NOW,
      };
      queue([{ id: STATION }], [row], [{ total: 1 }]);
      const res = await inject('GET', `/stations/${STATION}/events?page=2&limit=10`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [row], total: 1 });
      const listChain = chainsOf('select')[1];
      expect(argsOf(listChain, 'where')?.[0]).toEqual({
        op: 'eq',
        col: 'stationEvents.stationId',
        val: STATION,
      });
      expect(argsOf(listChain, 'offset')).toEqual([10]);
    });

    const variableRow = {
      id: 1,
      stationId: STATION,
      component: 'OCPPCommCtrlr',
      instance: null,
      evseId: null,
      connectorId: null,
      variable: 'HeartbeatInterval',
      variableInstance: null,
      value: '300',
      attributeType: 'Actual',
      source: 'NotifyReport',
      createdAt: NOW,
      updatedAt: NOW,
    };

    it('GET variables returns 404 for a missing station', async () => {
      queue([]);
      const res = await inject('GET', `/stations/${STATION}/variables`);
      expect(res.statusCode).toBe(404);
    });

    it('GET variables searches component, variable, and value', async () => {
      queue([{ id: STATION }], [variableRow], [{ total: 1 }]);
      const res = await inject('GET', `/stations/${STATION}/variables?search=Heart`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [variableRow], total: 1 });
      expect(argsOf(chainsOf('select')[1], 'where')?.[0]).toEqual({
        op: 'and',
        conds: [
          { op: 'eq', col: 'stationConfigurations.stationId', val: STATION },
          {
            op: 'or',
            conds: [
              { op: 'ilike', col: 'stationConfigurations.component', val: '%Heart%' },
              { op: 'ilike', col: 'stationConfigurations.variable', val: '%Heart%' },
              { op: 'ilike', col: 'stationConfigurations.value', val: '%Heart%' },
            ],
          },
        ],
      });
    });

    it('GET variables without search filters by station only', async () => {
      queue([{ id: STATION }], [], [{ total: 0 }]);
      const res = await inject('GET', `/stations/${STATION}/variables`);
      expect(res.statusCode).toBe(200);
      expect(argsOf(chainsOf('select')[1], 'where')?.[0]).toEqual({
        op: 'and',
        conds: [{ op: 'eq', col: 'stationConfigurations.stationId', val: STATION }],
      });
    });

    it('GET firmware-history lists updates with the campaign version', async () => {
      const row = {
        id: 4,
        stationId: STATION,
        requestId: 12,
        firmwareUrl: 'https://fw.example.com/v2.bin',
        retrieveDateTime: NOW,
        status: 'Installed',
        statusInfo: null,
        campaignId: 'cmp-1',
        initiatedAt: NOW,
        lastStatusAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        version: '2.0.0',
      };
      queue([{ id: STATION }], [row], [{ total: 1 }]);
      const res = await inject('GET', `/stations/${STATION}/firmware-history`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [row], total: 1 });
      expect(argsOf(chainsOf('select')[1], 'leftJoin')?.[0]).toBe(tables['firmwareCampaigns']);
    });

    it('GET charging-profiles links templates only for csms_set rows', async () => {
      const base = {
        stationId: STATION,
        evseId: 0,
        requestId: null,
        chargingLimitSource: null,
        tbc: false,
        profileData: { id: 7 },
        sentAt: null,
        reportedAt: null,
        createdAt: NOW,
      };
      queue(
        [{ id: STATION }],
        [
          {
            profile: { ...base, id: 1, source: 'csms_set' },
            templateId: 'tpl-1',
            templateName: 'Night cap',
          },
          {
            profile: { ...base, id: 2, source: 'station_reported' },
            templateId: 'tpl-1',
            templateName: 'Night cap',
          },
        ],
        [{ total: 2 }],
      );
      const res = await inject('GET', `/stations/${STATION}/charging-profiles`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.data[0]).toMatchObject({ id: 1, templateId: 'tpl-1', templateName: 'Night cap' });
      expect(body.data[1]).toMatchObject({ id: 2, templateId: null, templateName: null });
    });

    it('GET charging-profiles returns 404 for a missing station', async () => {
      queue([]);
      const res = await inject('GET', `/stations/${STATION}/charging-profiles`);
      expect(res.statusCode).toBe(404);
    });

    it('GET ev-charging-needs returns the rows for the station', async () => {
      const row = {
        id: 1,
        stationId: STATION,
        evseId: 1,
        chargingNeeds: { requestedEnergyTransfer: 'DC' },
        departureTime: null,
        requestedEnergyTransfer: 'DC',
        controlMode: null,
        maxScheduleTuples: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      queue([{ id: STATION }], [row]);
      const res = await inject('GET', `/stations/${STATION}/ev-charging-needs`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([row]);
      expect(argsOf(chainsOf('select')[1], 'where')?.[0]).toEqual({
        op: 'eq',
        col: 'evChargingNeeds.stationId',
        val: STATION,
      });
    });

    it('GET ev-charging-needs returns 404 for a missing station', async () => {
      queue([]);
      const res = await inject('GET', `/stations/${STATION}/ev-charging-needs`);
      expect(res.statusCode).toBe(404);
    });

    it('GET monitoring-rules lists rules', async () => {
      const row = {
        id: 3,
        stationId: STATION,
        monitoringId: null,
        component: 'EVSE',
        variable: 'Power',
        type: 'Delta',
        value: '5',
        severity: 2,
        status: 'pending',
        errorInfo: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      queue([{ id: STATION }], [row], [{ total: 1 }]);
      const res = await inject('GET', `/stations/${STATION}/monitoring-rules`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [row], total: 1 });
    });

    const alertRow = {
      id: 5,
      stationId: STATION,
      stationEventId: null,
      ruleId: null,
      component: 'EVSE',
      variable: 'Problem',
      severity: 1,
      trigger: 'Alerting',
      actualValue: 'true',
      techInfo: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      createdAt: NOW,
    };

    it('GET event-alerts returns 404 for a missing station', async () => {
      queue([]);
      const res = await inject('GET', `/stations/${STATION}/event-alerts`);
      expect(res.statusCode).toBe(404);
    });

    it('GET event-alerts filters acknowledged alerts and max severity', async () => {
      queue([{ id: STATION }], [alertRow], [{ total: 1 }]);
      const res = await inject(
        'GET',
        `/stations/${STATION}/event-alerts?acknowledged=true&severity=3`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [alertRow], total: 1 });
      const where = argsOf(chainsOf('select')[1], 'where')?.[0] as { conds: unknown[] };
      expect(where.conds).toHaveLength(3);
      expect(where.conds[0]).toEqual({ op: 'eq', col: 'eventAlerts.stationId', val: STATION });
      expect(where.conds[1]).toMatchObject({ op: 'sql', values: [expect.anything(), 3] });
      expect(where.conds[2]).toEqual({ op: 'isNotNull', col: 'eventAlerts.acknowledgedAt' });
    });

    it('GET event-alerts filters unacknowledged alerts', async () => {
      queue([{ id: STATION }], [], [{ total: 0 }]);
      const res = await inject('GET', `/stations/${STATION}/event-alerts?acknowledged=false`);
      expect(res.statusCode).toBe(200);
      const where = argsOf(chainsOf('select')[1], 'where')?.[0] as { conds: unknown[] };
      expect(where.conds).toHaveLength(2);
      const isNullSql = where.conds[1] as { op: string; values: unknown[] };
      expect(isNullSql.op).toBe('sql');
      const strings = mocks.sqlCalls.find((args) =>
        String((args[0] as string[] | undefined)?.join('')).includes('IS NULL'),
      );
      expect(strings).toBeDefined();
    });

    it('GET event-alerts rejects severity above 9', async () => {
      const res = await inject('GET', `/stations/${STATION}/event-alerts?severity=10`);
      expect(res.statusCode).toBe(400);
    });

    it('GET standalone-meter-values returns 404 for a missing station', async () => {
      queue([]);
      const res = await inject('GET', `/stations/${STATION}/standalone-meter-values`);
      expect(res.statusCode).toBe(404);
    });

    it('GET standalone-meter-values filters session-less rows by measurand', async () => {
      const row = {
        id: 1,
        timestamp: NOW,
        measurand: 'Voltage',
        value: '230.1',
        unit: 'V',
        phase: 'L1',
        location: 'Outlet',
        context: 'Sample.Periodic',
      };
      queue([{ id: STATION }], [row], [{ count: 1 }]);
      const res = await inject(
        'GET',
        `/stations/${STATION}/standalone-meter-values?measurand=Voltage&page=2&limit=20`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [row], total: 1 });
      const listChain = chainsOf('select')[1];
      expect(argsOf(listChain, 'where')?.[0]).toEqual({
        op: 'and',
        conds: [
          { op: 'eq', col: 'meterValues.stationId', val: STATION },
          { op: 'isNull', col: 'meterValues.sessionId' },
          { op: 'eq', col: 'meterValues.measurand', val: 'Voltage' },
        ],
      });
      expect(argsOf(listChain, 'offset')).toEqual([20]);
    });

    it('GET standalone-meter-values defaults the total to 0', async () => {
      queue([{ id: STATION }], [], []);
      const res = await inject('GET', `/stations/${STATION}/standalone-meter-values`);
      expect(res.json()).toEqual({ data: [], total: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /stations/:id/charging-profiles/refresh', () => {
    it('returns 404 for a missing station', async () => {
      queue([]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/refresh`);
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for an offline station', async () => {
      queue([{ stationId: 'CS-1', isOnline: false, ocppProtocol: 'ocpp2.1' }]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/refresh`);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('STATION_OFFLINE');
    });

    it('returns 400 NOT_SUPPORTED for an OCPP 1.6 station', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp1.6' }]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/refresh`);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('NOT_SUPPORTED');
      expect(mocks.sendOcpp).not.toHaveBeenCalled();
    });

    it('sends GetChargingProfiles as OCPP 2.1', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/refresh`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mocks.sendOcpp).toHaveBeenCalledWith(
        'CS-1',
        'GetChargingProfiles',
        { requestId: expect.any(Number), chargingProfile: {} },
        '2.1',
      );
    });

    it('returns 502 when the command fails', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      mocks.sendOcpp.mockResolvedValue({ commandId: 'c', error: 'Rejected' });
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/refresh`);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'Rejected', code: 'OCPP_COMMAND_FAILED' });
    });
  });

  describe('POST /stations/:id/charging-profiles/composite', () => {
    it('returns 404 for a missing station', async () => {
      queue([]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/composite`, {});
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for an offline station', async () => {
      queue([{ stationId: 'CS-1', isOnline: false, ocppProtocol: 'ocpp2.1' }]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/composite`, {});
      expect(res.statusCode).toBe(400);
    });

    it('defaults evseId to 0 and duration to one day and returns the station response', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      mocks.sendOcpp.mockResolvedValue({
        commandId: 'c',
        response: { status: 'Accepted', schedule: { evseId: 0, duration: 86400 } },
      });
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/composite`, {});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'Accepted',
        schedule: { evseId: 0, duration: 86400 },
      });
      expect(mocks.sendOcpp).toHaveBeenCalledWith('CS-1', 'GetCompositeSchedule', {
        evseId: 0,
        duration: 86400,
        chargingRateUnit: undefined,
      });
    });

    it('passes explicit parameters through', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      mocks.sendOcpp.mockResolvedValue({ commandId: 'c', response: undefined });
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/composite`, {
        evseId: 2,
        duration: 3600,
        chargingRateUnit: 'A',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
      expect(mocks.sendOcpp).toHaveBeenCalledWith('CS-1', 'GetCompositeSchedule', {
        evseId: 2,
        duration: 3600,
        chargingRateUnit: 'A',
      });
    });

    it('rejects a duration above one year', async () => {
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/composite`, {
        duration: 31536001,
      });
      expect(res.statusCode).toBe(400);
      expect(mocks.sendOcpp).not.toHaveBeenCalled();
    });

    it('returns 502 when the command fails', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      mocks.sendOcpp.mockResolvedValue({ commandId: 'c', error: 'Timeout' });
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/composite`, {});
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('OCPP_COMMAND_FAILED');
    });
  });

  describe('POST /stations/:id/charging-profiles/clear', () => {
    it('returns 404 for a missing station', async () => {
      queue([]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/clear`, {});
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for an offline station', async () => {
      queue([{ stationId: 'CS-1', isOnline: false, ocppProtocol: 'ocpp2.1' }]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/clear`, {});
      expect(res.statusCode).toBe(400);
    });

    it('nests criteria, deletes the mirror rows, and refreshes a 2.1 station on Accepted', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], []);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/clear`, {
        chargingProfileId: 7,
        chargingProfilePurpose: 'TxDefaultProfile',
        stackLevel: 1,
        evseId: 2,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'Accepted' });
      expect(ocppCalls('ClearChargingProfile')[0]).toEqual([
        'CS-1',
        'ClearChargingProfile',
        {
          chargingProfileId: 7,
          chargingProfileCriteria: {
            chargingProfilePurpose: 'TxDefaultProfile',
            stackLevel: 1,
            evseId: 2,
          },
        },
      ]);
      const deleteChain = chainsOf('delete')[0];
      expect(argsOf(deleteChain, 'table')?.[0]).toBe(tables['chargingProfiles']);
      const where = argsOf(deleteChain, 'where')?.[0] as { conds: unknown[] };
      expect(where.conds).toHaveLength(5);
      expect(where.conds[0]).toEqual({
        op: 'eq',
        col: 'chargingProfiles.stationId',
        val: STATION,
      });
      expect(where.conds[4]).toEqual({ op: 'eq', col: 'chargingProfiles.evseId', val: 2 });
      expect(ocppCalls('GetChargingProfiles')).toEqual([
        [
          'CS-1',
          'GetChargingProfiles',
          { requestId: expect.any(Number), chargingProfile: {} },
          '2.1',
        ],
      ]);
    });

    it('sends an empty payload to clear all and does not refresh a 1.6 station', async () => {
      queue([{ stationId: 'CS-16', isOnline: true, ocppProtocol: 'ocpp1.6' }], []);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/clear`, {});
      expect(res.statusCode).toBe(200);
      expect(ocppCalls('ClearChargingProfile')[0]?.[2]).toEqual({});
      const where = argsOf(chainsOf('delete')[0], 'where')?.[0] as { conds: unknown[] };
      expect(where.conds).toHaveLength(1);
      expect(ocppCalls('GetChargingProfiles')).toHaveLength(0);
    });

    it('keeps the mirror rows when the station does not accept', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      mocks.sendOcpp.mockResolvedValue({ commandId: 'c', response: { status: 'Unknown' } });
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/clear`, {
        stackLevel: 0,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'Unknown' });
      expect(chainsOf('delete')).toHaveLength(0);
    });

    it('returns success when the station sent no payload', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      mocks.sendOcpp.mockResolvedValue({ commandId: 'c' });
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/clear`, {});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(chainsOf('delete')).toHaveLength(0);
    });

    it('returns 502 when the command fails', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      mocks.sendOcpp.mockResolvedValue({ commandId: 'c', error: 'Timeout' });
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/clear`, {});
      expect(res.statusCode).toBe(502);
      expect(chainsOf('delete')).toHaveLength(0);
    });

    it('does not fail the clear when the background refresh rejects', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], []);
      mocks.sendOcpp.mockImplementation((_s: string, action: string) =>
        action === 'GetChargingProfiles'
          ? Promise.reject(new Error('bus down'))
          : Promise.resolve({ commandId: 'c', response: { status: 'Accepted' } }),
      );
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/clear`, {});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'Accepted' });
    });
  });

  describe('POST /stations/:id/charging-profiles/push', () => {
    const template = {
      id: 'tpl-1',
      profileId: 101,
      stackLevel: 2,
      profilePurpose: 'TxDefaultProfile',
      profileKind: 'Absolute',
      recurrencyKind: null,
      validFrom: new Date('2026-10-01T00:00:00.000Z'),
      validTo: null,
      evseId: 1,
      chargingRateUnit: 'W',
      startSchedule: null,
      duration: 3600,
      schedulePeriods: [{ startPeriod: 0, limit: 7000 }],
    };

    it('returns 404 for a missing station', async () => {
      queue([]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/push`, {
        templateId: 'tpl-1',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
    });

    it('returns 400 for an offline station', async () => {
      queue([{ stationId: 'CS-1', isOnline: false, ocppProtocol: 'ocpp2.1' }]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/push`, {
        templateId: 'tpl-1',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 TEMPLATE_NOT_FOUND for an unknown template', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], []);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/push`, {
        templateId: 'tpl-x',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TEMPLATE_NOT_FOUND');
      expect(mocks.sendOcpp).not.toHaveBeenCalled();
    });

    it('clears, sets the profile, refreshes, and audits on Accepted (2.1)', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], [template]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/push`, {
        templateId: 'tpl-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, status: 'Accepted' });
      expect(mocks.sendOcpp.mock.calls.map((c) => c[1])).toEqual([
        'ClearChargingProfile',
        'SetChargingProfile',
        'GetChargingProfiles',
      ]);
      expect(ocppCalls('ClearChargingProfile')[0]?.[2]).toEqual({
        chargingProfileCriteria: {
          chargingProfilePurpose: 'TxDefaultProfile',
          stackLevel: 2,
          evseId: 1,
        },
      });
      expect(ocppCalls('SetChargingProfile')[0]?.[2]).toEqual({
        evseId: 1,
        chargingProfile: {
          id: 101,
          stackLevel: 2,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          recurrencyKind: undefined,
          validFrom: '2026-10-01T00:00:00.000Z',
          validTo: undefined,
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              startSchedule: undefined,
              duration: 3600,
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
            },
          ],
        },
      });
      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          entityId: STATION,
          action: 'configuration_pushed',
          notes: 'Charging profile template tpl-1 pushed',
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('still sets the profile when the clear throws, and skips refresh on 1.6', async () => {
      queue([{ stationId: 'CS-16', isOnline: true, ocppProtocol: 'ocpp1.6' }], [template]);
      mocks.sendOcpp.mockImplementation((_s: string, action: string) =>
        action === 'ClearChargingProfile'
          ? Promise.reject(new Error('bus down'))
          : Promise.resolve({ commandId: 'c', response: { status: 'Accepted' } }),
      );
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/push`, {
        templateId: 'tpl-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, status: 'Accepted' });
      expect(ocppCalls('SetChargingProfile')).toHaveLength(1);
      expect(ocppCalls('GetChargingProfiles')).toHaveLength(0);
    });

    it('reports a rejection without auditing', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], [template]);
      mocks.sendOcpp.mockResolvedValue({ commandId: 'c', response: { status: 'Rejected' } });
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/push`, {
        templateId: 'tpl-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: false, status: 'Rejected', errorInfo: 'Rejected' });
      expect(mocks.writeAudit).not.toHaveBeenCalled();
      expect(ocppCalls('GetChargingProfiles')).toHaveLength(0);
    });

    it('reports Failed when the set command errors', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], [template]);
      mocks.sendOcpp.mockImplementation((_s: string, action: string) =>
        Promise.resolve(
          action === 'SetChargingProfile'
            ? { commandId: 'c', error: 'Timeout' }
            : { commandId: 'c', response: { status: 'Accepted' } },
        ),
      );
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/push`, {
        templateId: 'tpl-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: false, status: 'Failed', errorInfo: 'Timeout' });
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /stations/:id/configurations/push', () => {
    const variables = [
      { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', value: '300' },
      { component: 'TxCtrlr', variable: 'EVConnectionTimeOut', value: '60' },
    ];

    it('returns 404 for a missing station', async () => {
      queue([]);
      const res = await inject('POST', `/stations/${STATION}/configurations/push`, {
        templateId: 'ct-1',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for an offline station', async () => {
      queue([{ stationId: 'CS-1', isOnline: false, ocppProtocol: 'ocpp2.1' }]);
      const res = await inject('POST', `/stations/${STATION}/configurations/push`, {
        templateId: 'ct-1',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 TEMPLATE_NOT_FOUND for an unknown template', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], []);
      const res = await inject('POST', `/stations/${STATION}/configurations/push`, {
        templateId: 'ct-x',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('TEMPLATE_NOT_FOUND');
    });

    it('returns success with no results for an empty template', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], [{ variables: [] }]);
      const res = await inject('POST', `/stations/${STATION}/configurations/push`, {
        templateId: 'ct-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, results: [] });
      expect(mocks.sendOcpp).not.toHaveBeenCalled();
    });

    it('batches SetVariables on 2.1, refreshes with GetBaseReport, and audits', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], [{ variables }]);
      mocks.sendOcpp.mockImplementation((_s: string, action: string) =>
        Promise.resolve(
          action === 'SetVariables'
            ? {
                commandId: 'c',
                response: {
                  setVariableResult: [
                    {
                      attributeStatus: 'Accepted',
                      component: { name: 'OCPPCommCtrlr' },
                      variable: { name: 'HeartbeatInterval' },
                    },
                    {
                      attributeStatus: 'Accepted',
                      component: { name: 'TxCtrlr' },
                      variable: { name: 'EVConnectionTimeOut' },
                    },
                  ],
                },
              }
            : { commandId: 'c', response: { status: 'Accepted' } },
        ),
      );
      const res = await inject('POST', `/stations/${STATION}/configurations/push`, {
        templateId: 'ct-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: true,
        results: [
          { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', status: 'Accepted' },
          { component: 'TxCtrlr', variable: 'EVConnectionTimeOut', status: 'Accepted' },
        ],
      });
      expect(ocppCalls('SetVariables')).toEqual([
        [
          'CS-1',
          'SetVariables',
          {
            setVariableData: [
              {
                component: { name: 'OCPPCommCtrlr' },
                variable: { name: 'HeartbeatInterval' },
                attributeValue: '300',
              },
              {
                component: { name: 'TxCtrlr' },
                variable: { name: 'EVConnectionTimeOut' },
                attributeValue: '60',
              },
            ],
          },
          '2.1',
        ],
      ]);
      expect(ocppCalls('GetBaseReport')[0]?.[2]).toEqual({
        requestId: expect.any(Number),
        reportBase: 'FullInventory',
      });
      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'configuration_pushed',
          notes: 'Config template ct-1 pushed',
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('reports a partial rejection on 2.1 and skips the audit', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], [{ variables }]);
      mocks.sendOcpp.mockResolvedValueOnce({
        commandId: 'c',
        response: {
          setVariableResult: [
            {
              attributeStatus: 'Accepted',
              component: { name: 'OCPPCommCtrlr' },
              variable: { name: 'HeartbeatInterval' },
            },
            {},
          ],
        },
      });
      const res = await inject('POST', `/stations/${STATION}/configurations/push`, {
        templateId: 'ct-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: false,
        results: [
          { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', status: 'Accepted' },
          { component: '', variable: '', status: 'Unknown' },
        ],
      });
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });

    it('marks every variable failed when the 2.1 batch errors', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }], [{ variables }]);
      mocks.sendOcpp.mockResolvedValueOnce({ commandId: 'c', error: 'Timeout' });
      mocks.sendOcpp.mockRejectedValueOnce(new Error('refresh failed'));
      const res = await inject('POST', `/stations/${STATION}/configurations/push`, {
        templateId: 'ct-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: false,
        results: [
          { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', status: 'Timeout' },
          { component: 'TxCtrlr', variable: 'EVConnectionTimeOut', status: 'Timeout' },
        ],
      });
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });

    it('sends one SetVariables per variable on 1.6 and refreshes with GetConfiguration', async () => {
      queue([{ stationId: 'CS-16', isOnline: true, ocppProtocol: 'ocpp1.6' }], [{ variables }]);
      mocks.sendOcpp
        .mockResolvedValueOnce({ commandId: 'a', response: { status: 'Accepted' } })
        .mockResolvedValueOnce({ commandId: 'b', error: 'Timeout' })
        .mockResolvedValueOnce({ commandId: 'c', response: {} });
      const res = await inject('POST', `/stations/${STATION}/configurations/push`, {
        templateId: 'ct-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: false,
        results: [
          { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', status: 'Accepted' },
          { component: 'TxCtrlr', variable: 'EVConnectionTimeOut', status: 'Timeout' },
        ],
      });
      const setCalls = ocppCalls('SetVariables');
      expect(setCalls).toHaveLength(2);
      expect(setCalls[1]?.[2]).toEqual({
        setVariableData: [
          {
            component: { name: 'TxCtrlr' },
            variable: { name: 'EVConnectionTimeOut' },
            attributeValue: '60',
          },
        ],
      });
      expect(ocppCalls('GetConfiguration')).toEqual([['CS-16', 'GetConfiguration', {}, '1.6']]);
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });

    it('reads the per-variable attributeStatus on 1.6', async () => {
      queue(
        [{ stationId: 'CS-16', isOnline: true, ocppProtocol: 'ocpp1.6' }],
        [{ variables: [variables[0]] }],
      );
      mocks.sendOcpp.mockResolvedValueOnce({
        commandId: 'a',
        response: { setVariableResult: [{ attributeStatus: 'RebootRequired' }] },
      });
      const res = await inject('POST', `/stations/${STATION}/configurations/push`, {
        templateId: 'ct-1',
      });
      expect(res.json()).toEqual({
        success: false,
        results: [
          { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', status: 'RebootRequired' },
        ],
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('variable monitoring rules', () => {
    const body = { component: 'EVSE', variable: 'Power', type: 'UpperThreshold', value: 7.5 };
    const ruleRow = {
      id: 3,
      stationId: STATION,
      monitoringId: null,
      component: 'EVSE',
      variable: 'Power',
      type: 'UpperThreshold',
      value: '7.5',
      severity: 0,
      status: 'pending',
      errorInfo: null,
      createdAt: NOW,
      updatedAt: NOW,
    };

    it('returns 404 when creating a rule on a missing station', async () => {
      queue([]);
      const res = await inject('POST', `/stations/${STATION}/monitoring-rules`, body);
      expect(res.statusCode).toBe(404);
      expect(chainsOf('insert')).toHaveLength(0);
    });

    it('rejects a severity above 9', async () => {
      const res = await inject('POST', `/stations/${STATION}/monitoring-rules`, {
        ...body,
        severity: 10,
      });
      expect(res.statusCode).toBe(400);
    });

    it('inserts a pending rule and dispatches SetVariableMonitoring', async () => {
      queue([{ id: STATION, stationId: 'CS-1' }], [ruleRow]);
      const res = await inject('POST', `/stations/${STATION}/monitoring-rules`, body);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(ruleRow);
      expect(argsOf(chainsOf('insert')[0], 'values')?.[0]).toEqual({
        stationId: STATION,
        component: 'EVSE',
        variable: 'Power',
        type: 'UpperThreshold',
        value: '7.5',
        severity: 0,
        status: 'pending',
      });
      expect(publishedOn('ocpp_commands')).toEqual([
        {
          commandId: expect.any(String),
          stationId: 'CS-1',
          action: 'SetVariableMonitoring',
          payload: {
            setMonitoringData: [
              {
                component: { name: 'EVSE' },
                variable: { name: 'Power' },
                type: 'UpperThreshold',
                value: 7.5,
                severity: 0,
              },
            ],
          },
        },
      ]);
    });

    it('returns 502 when the command cannot be published', async () => {
      queue([{ id: STATION, stationId: 'CS-1' }], [ruleRow]);
      mocks.publish.mockRejectedValue(new Error('redis down'));
      const res = await inject('POST', `/stations/${STATION}/monitoring-rules`, body);
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('STATION_REJECTED');
    });

    it('returns 404 RULE_NOT_FOUND when deleting an unknown rule', async () => {
      queue([]);
      const res = await inject('DELETE', `/stations/${STATION}/monitoring-rules/3`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RULE_NOT_FOUND');
      expect(chainsOf('update')).toHaveLength(0);
    });

    it('clears a station monitor and marks the rule cleared', async () => {
      queue([{ ...ruleRow, monitoringId: 42 }], [{ stationId: 'CS-1' }], []);
      const res = await inject('DELETE', `/stations/${STATION}/monitoring-rules/3`);
      expect(res.statusCode).toBe(204);
      expect(publishedOn('ocpp_commands')).toEqual([
        {
          commandId: expect.any(String),
          stationId: 'CS-1',
          action: 'ClearVariableMonitoring',
          payload: { id: [42] },
        },
      ]);
      const update = chainsOf('update')[0];
      expect(argsOf(update, 'set')?.[0]).toMatchObject({ status: 'cleared' });
      expect(argsOf(update, 'where')?.[0]).toEqual({
        op: 'eq',
        col: 'variableMonitoringRules.id',
        val: 3,
      });
    });

    it('marks the rule cleared even when the clear dispatch fails', async () => {
      queue([{ ...ruleRow, monitoringId: 42 }], [{ stationId: 'CS-1' }], []);
      mocks.publish.mockRejectedValue(new Error('redis down'));
      const res = await inject('DELETE', `/stations/${STATION}/monitoring-rules/3`);
      expect(res.statusCode).toBe(204);
      expect(argsOf(chainsOf('update')[0], 'set')?.[0]).toMatchObject({ status: 'cleared' });
    });

    it('does not dispatch for a rule the station never acknowledged', async () => {
      queue([ruleRow], []);
      const res = await inject('DELETE', `/stations/${STATION}/monitoring-rules/3`);
      expect(res.statusCode).toBe(204);
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(chainsOf('update')).toHaveLength(1);
    });
  });

  describe('POST /stations/:id/event-alerts/:alertId/acknowledge', () => {
    it('returns 404 when the alert is not on the station', async () => {
      queue([]);
      const res = await inject('POST', `/stations/${STATION}/event-alerts/4/acknowledge`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('ALERT_NOT_FOUND');
    });

    it('records who acknowledged the alert', async () => {
      queue([{ id: 4 }]);
      const res = await inject('POST', `/stations/${STATION}/event-alerts/4/acknowledge`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      const update = chainsOf('update')[0];
      expect(argsOf(update, 'set')?.[0]).toEqual({
        acknowledgedAt: expect.any(Date),
        acknowledgedBy: USER,
      });
      expect(argsOf(update, 'where')?.[0]).toEqual({
        op: 'and',
        conds: [
          { op: 'eq', col: 'eventAlerts.id', val: 4 },
          { op: 'eq', col: 'eventAlerts.stationId', val: STATION },
        ],
      });
    });
  });
});
