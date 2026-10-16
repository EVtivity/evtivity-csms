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
    'sessionAuditLog',
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
  mirrorCssConnectors: vi.fn(),
  removeCssConnectors: vi.fn(),
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
    ...(await import('@evtivity/database/src/lib/ai-insight-suppression.js')),
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

const { mockListStationMessageLog } = vi.hoisted(() => ({
  mockListStationMessageLog: vi.fn(() => Promise.resolve({ data: [], total: 0, actions: [] })),
}));
vi.mock('../lib/station-message-log.js', () => ({
  listStationMessageLog: mockListStationMessageLog,
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
  mirrorCssConnectors: mocks.mirrorCssConnectors,
  removeCssConnectors: mocks.removeCssConnectors,
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
import rateLimit from '@fastify/rate-limit';
import { triggerAndWaitForStatus } from '../lib/station-status-check.js';

const NOW = '2026-10-01T12:00:00.000Z';

const stationRow = {
  id: STATION,
  stationId: 'CS-1',
  siteId: SITE_A,
  vendorId: null,
  model: 'M1',
  serialNumber: null,
  firmwareVersion: null,
  availability: 'available',
  onboardingStatus: 'accepted',
  isOnline: true,
  isSimulator: false,
  loadPriority: 5,
  securityProfile: 1,
  pendingSecurityProfile: null,
  ocppProtocol: 'ocpp1.6',
  hasPassword: false,
  createdAt: NOW,
  updatedAt: NOW,
};

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code });
}

function conditionsOf(chain: ChainRecord | undefined): unknown[] {
  const where = argsOf(chain, 'where')?.[0] as { op: string; conds?: unknown[] } | undefined;
  return where?.conds ?? [];
}

describe('Station routes - cov2', () => {
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
    queue();
    dbState.chains = [];
    mocks.sqlCalls.length = 0;
    mocks.publish.mockResolvedValue(undefined);
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() });
    mocks.sendOcpp.mockResolvedValue({ commandId: 'cmd-1', response: { status: 'Accepted' } });
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.execute.mockResolvedValue([]);
    mocks.enableCssPair.mockResolvedValue(undefined);
    mocks.disableCssPair.mockResolvedValue(undefined);
    mocks.getUserSiteIds.mockResolvedValue(null);
    mocks.checkStationSiteAccess.mockResolvedValue(true);
    mocks.userCanAccessSite.mockResolvedValue(true);
    vi.mocked(triggerAndWaitForStatus).mockResolvedValue({ status: 'available' });
  });

  describe('site access denied returns 404 before any station work', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    const cases: Array<[string, 'GET' | 'POST' | 'PATCH', string, unknown?]> = [
      ['connectors', 'GET', `/stations/${STATION}/connectors`],
      [
        'create EVSE',
        'POST',
        `/stations/${STATION}/evses`,
        { evseId: 1, connectors: [{ connectorId: 1, connectorType: 'Type2', maxPowerKw: 22 }] },
      ],
      ['update EVSE', 'PATCH', `/stations/${STATION}/evses/1`, { connectors: [] }],
      ['stop active session', 'POST', `/stations/${STATION}/evses/1/stop-active-session`],
      ['metrics', 'GET', `/stations/${STATION}/metrics`],
      [
        'set credentials',
        'POST',
        `/stations/${STATION}/credentials`,
        { password: 'abcdefghijklmnopqrst' },
      ],
      ['rotate credentials', 'POST', `/stations/${STATION}/rotate-credentials`],
      ['confirm real station', 'POST', `/stations/${STATION}/confirm-real-station`],
      ['security logs', 'GET', `/stations/${STATION}/security-logs`],
      [
        'install certificate',
        'POST',
        `/stations/${STATION}/certificates/install`,
        { certificateType: 'V2GRootCertificate', certificate: pem },
      ],
      [
        'delete certificate',
        'POST',
        `/stations/${STATION}/certificates/delete`,
        {
          certificateHashData: {
            hashAlgorithm: 'SHA256',
            issuerNameHash: 'a',
            issuerKeyHash: 'b',
            serialNumber: 'c',
          },
        },
      ],
      ['query certificates', 'POST', `/stations/${STATION}/certificates/query`, {}],
    ];

    it.each(cases)('%s', async (_name, method, url, payload) => {
      mocks.checkStationSiteAccess.mockResolvedValue(false);
      const res = await inject(method, url, payload);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(mocks.checkStationSiteAccess).toHaveBeenCalledWith(STATION, USER);
      expect(dbState.chains).toHaveLength(0);
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(mocks.sendOcpp).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /stations/:id simulator toggle', () => {
    it('defaults a missing protocol to 1.6, pairs the simulator, and audits simulator_toggled', async () => {
      // protocol lookup, before snapshot, update returning
      queue(
        [{ ocppProtocol: null }],
        [{ ...stationRow, ocppProtocol: null }],
        [{ ...stationRow, isSimulator: true }],
      );
      const res = await inject('PATCH', `/stations/${STATION}`, { isSimulator: true });
      expect(res.statusCode).toBe(200);

      const update = chainsOf('update')[0];
      expect(argsOf(update, 'set')?.[0]).toMatchObject({
        isSimulator: true,
        simulatorConflictAt: null,
        ocppProtocol: 'ocpp1.6',
      });
      expect(mocks.enableCssPair).toHaveBeenCalledWith(
        expect.objectContaining({ stationId: 'CS-1', ocppProtocol: 'ocpp1.6', password: null }),
        expect.anything(),
      );
      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'simulator_toggled' }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('keeps an existing protocol when enabling the simulator', async () => {
      queue(
        [{ ocppProtocol: 'ocpp2.1' }],
        [{ ...stationRow, isSimulator: true, ocppProtocol: 'ocpp2.1' }],
        [{ ...stationRow, isSimulator: true, ocppProtocol: 'ocpp2.1' }],
      );
      const res = await inject('PATCH', `/stations/${STATION}`, { isSimulator: true });
      expect(res.statusCode).toBe(200);
      expect(argsOf(chainsOf('update')[0], 'set')?.[0]).not.toHaveProperty('ocppProtocol');
      // unchanged flag: plain update
      expect(mocks.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'updated' }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('DELETE /stations/:id', () => {
    it('returns 404 for a station in a site outside the user scope', async () => {
      mocks.getUserSiteIds.mockResolvedValue([SITE_B]);
      queue([{ ...stationRow, siteId: SITE_A }]);
      const res = await inject('DELETE', `/stations/${STATION}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(chainsOf('update')).toHaveLength(0);
      expect(mocks.disableCssPair).not.toHaveBeenCalled();
    });

    it('refuses a station with an active session with 409 STATION_HAS_ACTIVE_SESSION', async () => {
      queue([stationRow], [{ id: 'ses_1' }]);
      const res = await inject('DELETE', `/stations/${STATION}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('STATION_HAS_ACTIVE_SESSION');
      expect(chainsOf('update')).toHaveLength(0);
      expect(mocks.publish).not.toHaveBeenCalled();
    });

    it('returns 404 when the removal update matches no row', async () => {
      queue([stationRow], [], []);
      const res = await inject('DELETE', `/stations/${STATION}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(mocks.disableCssPair).not.toHaveBeenCalled();
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });

    it('blocks the station and closes its live connection', async () => {
      queue([stationRow], [], [{ ...stationRow, onboardingStatus: 'blocked' }]);
      const res = await inject('DELETE', `/stations/${STATION}`);
      expect(res.statusCode).toBe(200);
      const disconnects = mocks.publish.mock.calls
        .filter((c) => c[0] === 'cache_invalidate')
        .map((c) => JSON.parse(c[1] as string) as unknown);
      expect(disconnects).toEqual([
        { kind: 'station_disconnect', stationId: stationRow.stationId },
      ]);
    });
  });

  describe('EVSE and connector writes', () => {
    it('create EVSE rethrows a non-unique insert error as 500', async () => {
      // station lookup, duplicate check, insert fails
      queue([{ id: STATION, ocppProtocol: 'ocpp2.1' }], [], pgError('XX000'));
      const res = await inject('POST', `/stations/${STATION}/evses`, {
        evseId: 2,
        connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
      });
      expect(res.statusCode).toBe(500);
      expect(chainsOf('insert')).toHaveLength(1);
    });

    it('update EVSE returns 404 naming the first missing connector without updating', async () => {
      queue([{ id: 7, evseId: 1 }], [{ connectorId: 1 }]);
      const res = await inject('PATCH', `/stations/${STATION}/evses/1`, {
        connectors: [{ connectorId: 1 }, { connectorId: 3 }],
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'Connector 3 not found on this EVSE',
        code: 'CONNECTOR_NOT_FOUND',
      });
      expect(chainsOf('update')).toHaveLength(0);
    });

    it('update EVSE writes every supplied connector field', async () => {
      queue(
        [{ id: 7, evseId: 1 }],
        [{ connectorId: 1 }],
        [],
        [
          {
            connectorId: 1,
            connectorType: 'CCS2',
            maxPowerKw: '150',
            maxCurrentAmps: 200,
            status: 'available',
          },
        ],
      );
      const res = await inject('PATCH', `/stations/${STATION}/evses/1`, {
        connectors: [
          { connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150, maxCurrentAmps: 200 },
        ],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ evseId: 1, connectors: [{ connectorId: 1 }] });
      expect(argsOf(chainsOf('update')[0], 'set')?.[0]).toMatchObject({
        connectorType: 'CCS2',
        maxPowerKw: '150',
        maxCurrentAmps: 200,
      });
    });

    it('add connector rethrows a non-unique insert error as 500', async () => {
      queue([{ id: 7, ocppProtocol: 'ocpp2.1' }], [], pgError('XX000'));
      const res = await inject('POST', `/stations/${STATION}/evses/1/connectors`, {
        connectorId: 2,
        connectorType: 'Type2',
        maxPowerKw: 22,
      });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('station audit rows', () => {
    function auditCalls(action: string): Array<Record<string, unknown>> {
      return mocks.writeAudit.mock.calls
        .filter(
          (c) =>
            (c[0] as { table: unknown }).table === tables['stationAuditLog'] &&
            (c[1] as { action: string }).action === action,
        )
        .map((c) => c[1] as Record<string, unknown>);
    }

    it('create EVSE writes evse_changed with the new EVSE and connectors', async () => {
      queue(
        [{ id: STATION, ocppProtocol: 'ocpp2.1' }],
        [],
        [{ id: 7, evseId: 2 }],
        [
          {
            connectorId: 1,
            connectorType: 'CCS2',
            maxPowerKw: '150',
            maxCurrentAmps: null,
            status: 'unavailable',
          },
        ],
        [],
      );
      const res = await inject('POST', `/stations/${STATION}/evses`, {
        evseId: 2,
        connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
      });
      expect(res.statusCode).toBe(201);
      const [row] = auditCalls('evse_changed');
      expect(row).toMatchObject({
        entityId: STATION,
        actor: 'operator',
        actorUserId: USER,
        after: { evseId: 2, connectors: [{ connectorId: 1, connectorType: 'CCS2' }] },
      });
    });

    it('update EVSE audits only the changed connector fields', async () => {
      queue(
        [{ id: 7, evseId: 1 }],
        [{ connectorId: 1, connectorType: 'Type2', maxPowerKw: '22', maxCurrentAmps: 32 }],
        [],
        [
          {
            connectorId: 1,
            connectorType: 'CCS2',
            maxPowerKw: '150',
            maxCurrentAmps: 32,
            status: 'available',
          },
        ],
      );
      const res = await inject('PATCH', `/stations/${STATION}/evses/1`, {
        connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: 150 }],
      });
      expect(res.statusCode).toBe(200);
      const [row] = auditCalls('evse_changed');
      expect(row?.['before']).toEqual({
        evseId: 1,
        connectors: [{ connectorId: 1, connectorType: 'Type2', maxPowerKw: '22' }],
      });
      expect(row?.['after']).toEqual({
        evseId: 1,
        connectors: [{ connectorId: 1, connectorType: 'CCS2', maxPowerKw: '150' }],
      });
    });

    it('update EVSE without a change writes no audit row', async () => {
      const current = {
        connectorId: 1,
        connectorType: 'Type2',
        maxPowerKw: '22',
        maxCurrentAmps: 32,
      };
      queue([{ id: 7, evseId: 1 }], [current], [], [{ ...current, status: 'available' }]);
      const res = await inject('PATCH', `/stations/${STATION}/evses/1`, {
        connectors: [{ connectorId: 1, connectorType: 'Type2' }],
      });
      expect(res.statusCode).toBe(200);
      expect(auditCalls('evse_changed')).toHaveLength(0);
    });

    it('add connector writes evse_changed with the connector', async () => {
      queue(
        [{ id: 7, ocppProtocol: 'ocpp2.1' }],
        [],
        [
          {
            connectorId: 2,
            connectorType: 'Type2',
            maxPowerKw: '22',
            maxCurrentAmps: null,
            status: 'unavailable',
          },
        ],
        [],
      );
      const res = await inject('POST', `/stations/${STATION}/evses/1/connectors`, {
        connectorId: 2,
        connectorType: 'Type2',
        maxPowerKw: 22,
      });
      expect(res.statusCode).toBe(201);
      expect(auditCalls('evse_changed')[0]).toMatchObject({
        after: { evseId: 1, connectors: [{ connectorId: 2, connectorType: 'Type2' }] },
      });
    });

    it('delete EVSE writes evse_changed with the removed EVSE', async () => {
      queue([{ id: 7 }], [], [{ siteId: null }], []);
      const res = await inject('DELETE', `/stations/${STATION}/evses/1`);
      expect(res.statusCode).toBe(200);
      expect(auditCalls('evse_changed')[0]).toMatchObject({
        before: { evseId: 1 },
        notes: 'EVSE 1 deleted',
      });
    });

    it('delete connector writes evse_changed with the removed connector', async () => {
      queue(
        [{ id: 7 }],
        [{ id: 9, status: 'available', connectorType: 'Type2', maxPowerKw: '22' }],
        [],
      );
      const res = await inject('DELETE', `/stations/${STATION}/evses/1/connectors/2`);
      expect(res.statusCode).toBe(200);
      expect(auditCalls('evse_changed')[0]).toMatchObject({
        before: { evseId: 1, connectors: [{ connectorId: 2, connectorType: 'Type2' }] },
      });
    });

    it('delete EVSE removes it from the paired simulator by the OCPP identity', async () => {
      queue([{ id: 7 }], [], [{ siteId: null, stationOcppId: 'CS-1' }], []);
      const res = await inject('DELETE', `/stations/${STATION}/evses/1`);
      expect(res.statusCode).toBe(200);
      expect(mocks.removeCssConnectors).toHaveBeenCalledWith(expect.anything(), 'CS-1', 1);
    });

    it('delete EVSE with sessions or meter values answers 409 EVSE_HAS_HISTORY', async () => {
      queue([{ id: 7 }], [], [{ siteId: null, stationOcppId: 'CS-1' }], pgError('23503'));
      const res = await inject('DELETE', `/stations/${STATION}/evses/1`);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error:
          'The EVSE or connector has charging history and cannot be deleted. Retire it instead.',
        code: 'EVSE_HAS_HISTORY',
      });
      expect(auditCalls('evse_changed')).toHaveLength(0);
      expect(mocks.removeCssConnectors).not.toHaveBeenCalled();
    });

    it('delete connector with sessions answers 409 EVSE_HAS_HISTORY', async () => {
      queue(
        [{ id: 7, stationOcppId: 'CS-1', siteId: null }],
        [{ id: 9, status: 'available', connectorType: 'Type2', maxPowerKw: '22' }],
        pgError('23503'),
      );
      const res = await inject('DELETE', `/stations/${STATION}/evses/1/connectors/2`);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('EVSE_HAS_HISTORY');
      expect(auditCalls('evse_changed')).toHaveLength(0);
    });

    it('delete connector removes it from the simulator and pushes the OCPI location', async () => {
      queue(
        [{ id: 7, stationOcppId: 'CS-1', siteId: 'sit_000000000001' }],
        [{ id: 9, status: 'available', connectorType: 'Type2', maxPowerKw: '22' }],
        [],
      );
      const { isRoamingEnabled } = await import('@evtivity/database');
      vi.mocked(isRoamingEnabled).mockResolvedValueOnce(true);
      const res = await inject('DELETE', `/stations/${STATION}/evses/1/connectors/2`);
      expect(res.statusCode).toBe(200);
      expect(mocks.removeCssConnectors).toHaveBeenCalledWith(expect.anything(), 'CS-1', 1, 2);
      expect(mocks.publish).toHaveBeenCalledWith(
        'ocpi_push',
        JSON.stringify({ type: 'location', siteId: 'sit_000000000001' }),
      );
    });

    it('stop active session writes command_dispatched with the session', async () => {
      queue(
        [{ stationId: 'CS-1', ocppProtocol: 'ocpp2.1' }],
        [{ id: 7 }],
        [{ id: 'ses_1', transactionId: 'tx-1' }],
      );
      const res = await inject('POST', `/stations/${STATION}/evses/1/stop-active-session`);
      expect(res.statusCode).toBe(200);
      expect(auditCalls('command_dispatched')[0]).toMatchObject({
        entityId: STATION,
        after: {
          action: 'RequestStopTransaction',
          payload: { transactionId: 'tx-1' },
          sessionId: 'ses_1',
          outcome: 'Accepted',
          ghostRecovered: false,
        },
      });
      // The session's own history records the operator stop too.
      const sessionRows = mocks.writeAudit.mock.calls
        .filter((c) => (c[0] as { table: unknown }).table === tables['sessionAuditLog'])
        .map((c) => c[1] as Record<string, unknown>);
      expect(sessionRows).toEqual([
        expect.objectContaining({
          entityId: 'ses_1',
          action: 'stopped_by_csms',
          after: expect.objectContaining({ outcome: 'Accepted', ghostRecovered: false }),
        }),
      ]);
    });

    it('stop active session audits a station that did not answer', async () => {
      mocks.sendOcpp.mockResolvedValueOnce({ commandId: 'c', error: 'timeout', timedOut: true });
      queue(
        [{ stationId: 'CS-1', ocppProtocol: 'ocpp2.1' }],
        [{ id: 7 }],
        [{ id: 'ses_1', transactionId: 'tx-1' }],
      );
      const res = await inject('POST', `/stations/${STATION}/evses/1/stop-active-session`);
      expect(res.statusCode).toBe(504);
      expect(auditCalls('command_dispatched')[0]).toMatchObject({
        after: { outcome: 'timeout' },
      });
    });

    it('clear charging profiles writes command_dispatched with the outcome', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp1.6' }]);
      const res = await inject('POST', `/stations/${STATION}/charging-profiles/clear`, {});
      expect(res.statusCode).toBe(200);
      expect(auditCalls('command_dispatched')[0]).toMatchObject({
        after: { action: 'ClearChargingProfile', payload: [{}], outcome: 'Accepted' },
        notes: 'ClearChargingProfile (Accepted)',
      });
    });

    it('create monitoring rule writes monitoring_changed with the rule and result', async () => {
      mocks.sendOcpp.mockResolvedValueOnce({
        commandId: 'c',
        response: { setMonitoringResult: [{ status: 'Accepted', id: 12 }] },
      });
      const ruleRow = {
        id: 5,
        stationId: STATION,
        monitoringId: null,
        component: 'EVSE',
        variable: 'Power',
        type: 'UpperThreshold',
        value: '50',
        severity: 5,
        status: 'pending',
        errorInfo: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      queue(
        [{ id: STATION, stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }],
        [ruleRow],
        [{ ...ruleRow, status: 'active', monitoringId: 12 }],
      );
      const res = await inject('POST', `/stations/${STATION}/monitoring-rules`, {
        component: 'EVSE',
        variable: 'Power',
        type: 'UpperThreshold',
        value: 50,
        severity: 5,
      });
      expect(res.statusCode).toBe(201);
      expect(auditCalls('monitoring_changed')[0]).toMatchObject({
        after: {
          ruleId: 5,
          component: 'EVSE',
          variable: 'Power',
          status: 'active',
          monitoringId: 12,
        },
      });
    });

    it('clear monitoring rule writes monitoring_changed with the cleared rule', async () => {
      queue(
        [
          {
            id: 5,
            stationId: STATION,
            component: 'EVSE',
            variable: 'Power',
            type: 'UpperThreshold',
            value: '50',
            severity: 5,
            status: 'error',
            monitoringId: null,
          },
        ],
        [],
      );
      const res = await inject('DELETE', `/stations/${STATION}/monitoring-rules/5`);
      expect(res.statusCode).toBe(204);
      expect(auditCalls('monitoring_changed')[0]).toMatchObject({
        before: { ruleId: 5, status: 'error' },
        after: { ruleId: 5, status: 'cleared' },
      });
    });

    it('acknowledge event alert writes alert_acknowledged, a missing alert writes none', async () => {
      queue([{ id: 3, component: 'EVSE', variable: 'Power', severity: 2, acknowledgedAt: NOW }]);
      const res = await inject('POST', `/stations/${STATION}/event-alerts/3/acknowledge`);
      expect(res.statusCode).toBe(200);
      expect(auditCalls('alert_acknowledged')[0]).toMatchObject({
        entityId: STATION,
        after: { alertId: 3, component: 'EVSE', severity: 2 },
      });

      mocks.writeAudit.mockClear();
      queue([]);
      const missing = await inject('POST', `/stations/${STATION}/event-alerts/4/acknowledge`);
      expect(missing.statusCode).toBe(404);
      expect(auditCalls('alert_acknowledged')).toHaveLength(0);
    });
  });

  describe('POST /stations/:id/evses/:evseId/refresh-status', () => {
    it('returns 404 when the station does not exist', async () => {
      queue([]);
      const res = await inject('POST', `/stations/${STATION}/evses/1/refresh-status`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(triggerAndWaitForStatus).not.toHaveBeenCalled();
    });

    it('returns 404 CONNECTOR_NOT_FOUND when the EVSE has no connector', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' }]);
      mocks.execute.mockResolvedValue([]);
      const res = await inject('POST', `/stations/${STATION}/evses/1/refresh-status`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Connector not found', code: 'CONNECTOR_NOT_FOUND' });
      expect(triggerAndWaitForStatus).not.toHaveBeenCalled();
    });

    it('maps a status check error code to its HTTP status', async () => {
      queue([{ stationId: 'CS-1', isOnline: true, ocppProtocol: null }]);
      mocks.execute.mockResolvedValue([{ connector_id: 2 }]);
      vi.mocked(triggerAndWaitForStatus).mockResolvedValue({
        status: null,
        errorCode: 'STATUS_CHECK_REJECTED',
      });
      const res = await inject('POST', `/stations/${STATION}/evses/1/refresh-status`);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        error: 'Station rejected the status check',
        code: 'STATUS_CHECK_REJECTED',
      });
      expect(triggerAndWaitForStatus).toHaveBeenCalledWith('CS-1', 1, 2, STATION, undefined);
    });
  });

  describe('list filters', () => {
    it('sessions status=idling filters active sessions with an idle start', async () => {
      queue([], [{ count: 0 }]);
      const res = await inject('GET', `/stations/${STATION}/sessions?status=idling`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(conditionsOf(chainsOf('select')[0])).toEqual([
        { op: 'eq', col: 'chargingSessions.stationId', val: STATION },
        { op: 'eq', col: 'chargingSessions.status', val: 'active' },
        { op: 'isNotNull', col: 'chargingSessions.idleStartedAt' },
      ]);
    });

    it('sessions status=completed filters by that status', async () => {
      queue([], [{ count: 0 }]);
      const res = await inject('GET', `/stations/${STATION}/sessions?status=completed`);
      expect(res.statusCode).toBe(200);
      expect(conditionsOf(chainsOf('select')[0])).toEqual([
        { op: 'eq', col: 'chargingSessions.stationId', val: STATION },
        { op: 'eq', col: 'chargingSessions.status', val: 'completed' },
      ]);
    });

    it('ocpp logs filter by action and direction', async () => {
      const res = await inject(
        'GET',
        `/stations/${STATION}/ocpp-logs?action=Heartbeat&direction=inbound`,
      );
      expect(res.statusCode).toBe(200);
      expect(mockListStationMessageLog).toHaveBeenCalledWith(STATION, {
        page: 1,
        limit: 50,
        action: 'Heartbeat',
        direction: 'inbound',
      });
    });

    it('security events filter by type search', async () => {
      queue([], [{ total: 0 }]);
      const res = await inject('GET', `/stations/${STATION}/security-events?search=Tamper`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(conditionsOf(chainsOf('select')[0])).toEqual([
        { op: 'eq', col: 'securityEvents.stationId', val: STATION },
        { op: 'ilike', col: 'securityEvents.type', val: '%Tamper%' },
      ]);
    });
  });

  it('install certificate rejects text without a PEM block', async () => {
    const res = await inject('POST', `/stations/${STATION}/certificates/install`, {
      certificateType: 'V2GRootCertificate',
      certificate: 'not a certificate',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'certificate is not a valid PEM-encoded certificate',
    });
    expect(mocks.sendOcpp).not.toHaveBeenCalled();
  });

  it('reject returns 404 for an unknown station', async () => {
    // The compare-and-set moves nothing and no station has the id.
    queue([], []);
    const res = await inject('POST', `/stations/${STATION}/reject`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('STATION_NOT_FOUND');
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

describe('Station routes - charging profile rate limits', () => {
  let app: FastifyInstance;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(rateLimit, { global: false });
    await app.register(stationRoutes);
    await app.ready();
    tokenA = app.jwt.sign({ userId: USER, roleId: ROLE });
    tokenB = app.jwt.sign({ userId: 'usr_000000000002', roleId: ROLE });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    queue();
    dbState.chains = [];
    mocks.checkStationSiteAccess.mockResolvedValue(false);
  });

  it.each([
    ['refresh', `/stations/${STATION}/charging-profiles/refresh`],
    ['composite', `/stations/${STATION}/charging-profiles/composite`],
  ])('%s allows 10 requests per minute and then answers 429', async (_name, url) => {
    const send = (t: string) =>
      app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${t}` },
        payload: {},
      });
    for (let i = 0; i < 10; i++) {
      const res = await send(tokenA);
      expect(res.statusCode).toBe(404);
    }
    const limited = await send(tokenA);
    expect(limited.statusCode).toBe(429);
    const other = await send(tokenB);
    expect(other.statusCode).toBe(404);
  });
});
