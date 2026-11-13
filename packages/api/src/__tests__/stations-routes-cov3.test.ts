// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const STATION = 'sta_000000000001';
const USER = 'usr_000000000001';
const ROLE = 'rol_000000000001';

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
    'configTemplatePushStations',
    'configTemplatePushes',
    'evChargingSchedules',
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
    asc: vi.fn((a: unknown) => ({ op: 'asc', col: colOf(a) })),
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

const { mockStationLogSince } = vi.hoisted(() => ({
  mockStationLogSince: vi.fn((): Promise<Date | null | 'closed'> => Promise.resolve(null)),
}));
vi.mock('../lib/station-log-window.js', () => ({ stationLogSince: mockStationLogSince }));

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
  // The caller holds every further permission (securityEvents:read included).
  requestHasPermission: vi.fn().mockResolvedValue(true),
}));

// The services behind the routes have their own tests; here only the routes' use of them.
vi.mock('../services/station-evse-retire.service.js', () => ({
  retireEvse: vi.fn(),
  restoreEvse: vi.fn(),
  retireConnector: vi.fn(),
  restoreConnector: vi.fn(),
}));
vi.mock('../services/station-ai-insights.service.js', () => ({
  suppressStationAiInsights: vi.fn(),
  resumeStationAiInsights: vi.fn(),
}));
vi.mock('../services/ai-insight-scope.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ai-insight-scope.service.js')>()),
  stationAiInsightsScopeStatus: vi.fn(),
}));
vi.mock('@evtivity/services/station-data-plan.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/services/station-data-plan.service')>()),
  snapshotStationDataPlans: vi.fn(async () => ({ snapshot: true })),
  pushStationDataPlanChanges: vi.fn(async () => undefined),
}));

import { registerAuth } from '../plugins/auth.js';
import { stationRoutes } from '../routes/stations.js';
import { OCPP_VERSION_MISMATCH } from '@evtivity/lib';
import {
  retireEvse,
  restoreEvse,
  retireConnector,
  restoreConnector,
} from '../services/station-evse-retire.service.js';
import {
  suppressStationAiInsights,
  resumeStationAiInsights,
} from '../services/station-ai-insights.service.js';
import { stationAiInsightsScopeStatus } from '../services/ai-insight-scope.service.js';
import { pushStationDataPlanChanges } from '@evtivity/services/station-data-plan.service';

const NOW = '2026-10-01T12:00:00.000Z';

describe('Station routes - cov3', () => {
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
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.getUserSiteIds.mockResolvedValue(null);
    mocks.checkStationSiteAccess.mockResolvedValue(true);
    mocks.sendOcpp.mockResolvedValue({ commandId: 'cmd-1', response: { status: 'Accepted' } });
    vi.mocked(stationAiInsightsScopeStatus).mockResolvedValue(null);
  });

  function auditCalls(action: string): Array<Record<string, unknown>> {
    return mocks.writeAudit.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .filter((a) => a['action'] === action);
  }

  describe('AI insight suppression', () => {
    const suppressed = {
      suppressedAt: new Date(NOW),
      suppressedUntil: null,
      suppressedBy: USER,
      suppressedByName: 'Op Erator',
      reason: 'Planned works',
      insightsDismissed: 2,
      actionsExpired: 1,
    };

    it('suppresses the station insights and returns the counts', async () => {
      vi.mocked(suppressStationAiInsights).mockResolvedValueOnce(suppressed);
      const res = await inject('POST', `/stations/${STATION}/ai-insights/suppress`, {
        reason: 'Planned works',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        aiInsightsSuppressedBy: USER,
        aiInsightsSuppressedByName: 'Op Erator',
        aiInsightsSuppressedReason: 'Planned works',
        aiInsightsSuppressedUntil: null,
        insightsDismissed: 2,
        actionsExpired: 1,
      });
      expect(suppressStationAiInsights).toHaveBeenCalledWith(
        STATION,
        { reason: 'Planned works', until: null },
        expect.objectContaining({ actorUserId: USER }),
        expect.anything(),
      );
    });

    it('answers 404 outside the caller sites without suppressing', async () => {
      mocks.checkStationSiteAccess.mockResolvedValueOnce(false);
      const res = await inject('POST', `/stations/${STATION}/ai-insights/suppress`, {
        reason: 'x',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(suppressStationAiInsights).not.toHaveBeenCalled();
    });

    it('refuses an end date that is not in the future', async () => {
      const res = await inject('POST', `/stations/${STATION}/ai-insights/suppress`, {
        reason: 'x',
        until: '2020-01-01T00:00:00.000Z',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      expect(suppressStationAiInsights).not.toHaveBeenCalled();
    });

    it('answers 409 for a station outside the AI insights scope', async () => {
      vi.mocked(stationAiInsightsScopeStatus).mockResolvedValueOnce({
        enabled: false,
        reason: 'site_not_selected',
      } as never);
      const res = await inject('POST', `/stations/${STATION}/ai-insights/suppress`, {
        reason: 'x',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('AI_INSIGHTS_NOT_IN_SCOPE');
      expect(suppressStationAiInsights).not.toHaveBeenCalled();
    });

    it('passes a future end date and answers 404 when the station is gone', async () => {
      vi.mocked(suppressStationAiInsights).mockResolvedValueOnce(null);
      const until = new Date(Date.now() + 86_400_000).toISOString();
      const res = await inject('POST', `/stations/${STATION}/ai-insights/suppress`, {
        reason: 'x',
        until,
      });
      expect(res.statusCode).toBe(404);
      expect(vi.mocked(suppressStationAiInsights).mock.calls[0]?.[1]).toEqual({
        reason: 'x',
        until: new Date(until),
      });
    });

    it('resumes the station insights', async () => {
      vi.mocked(resumeStationAiInsights).mockResolvedValueOnce({
        ...suppressed,
        suppressedAt: null,
        suppressedBy: null,
        suppressedByName: null,
        reason: null,
        insightsDismissed: 0,
        actionsExpired: 0,
      } as never);
      const res = await inject('POST', `/stations/${STATION}/ai-insights/resume`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        aiInsightsSuppressedAt: null,
        aiInsightsSuppressedReason: null,
      });
      expect(resumeStationAiInsights).toHaveBeenCalledWith(
        STATION,
        expect.objectContaining({ actorUserId: USER }),
        expect.anything(),
      );
    });

    it('answers 409 while the site of the station is suppressed', async () => {
      vi.mocked(resumeStationAiInsights).mockResolvedValueOnce('site_suppressed');
      const res = await inject('POST', `/stations/${STATION}/ai-insights/resume`);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('STATION_SITE_SUPPRESSED');
    });

    it('answers 404 for resume outside the sites and for a missing station', async () => {
      mocks.checkStationSiteAccess.mockResolvedValueOnce(false);
      const denied = await inject('POST', `/stations/${STATION}/ai-insights/resume`);
      expect(denied.statusCode).toBe(404);
      expect(resumeStationAiInsights).not.toHaveBeenCalled();
      vi.mocked(resumeStationAiInsights).mockResolvedValueOnce(null);
      const missing = await inject('POST', `/stations/${STATION}/ai-insights/resume`);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe('STATION_NOT_FOUND');
    });
  });

  describe('retire and restore', () => {
    const done = { retiredAt: new Date(NOW), changed: true };

    it.each([
      ['retire EVSE', `/stations/${STATION}/evses/2/retire`, retireEvse, [STATION, 2]],
      ['restore EVSE', `/stations/${STATION}/evses/2/restore`, restoreEvse, [STATION, 2]],
      [
        'retire connector',
        `/stations/${STATION}/evses/2/connectors/1/retire`,
        retireConnector,
        [STATION, 2, 1],
      ],
      [
        'restore connector',
        `/stations/${STATION}/evses/2/connectors/1/restore`,
        restoreConnector,
        [STATION, 2, 1],
      ],
    ] as const)(
      '%s calls the retire service and pushes the plan change',
      async (_n, url, fn, args) => {
        vi.mocked(fn).mockResolvedValueOnce(done);
        const res = await inject('POST', url);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ changed: true });
        expect(vi.mocked(fn).mock.calls[0]?.slice(0, args.length)).toEqual([...args]);
        expect(vi.mocked(fn).mock.calls[0]?.at(-1)).toMatchObject({
          actor: expect.objectContaining({ actorUserId: USER }),
        });
        expect(pushStationDataPlanChanges).toHaveBeenCalledWith(
          { snapshot: true },
          expect.anything(),
        );
      },
    );

    it.each([
      [`/stations/${STATION}/evses/2/retire`, retireEvse],
      [`/stations/${STATION}/evses/2/restore`, restoreEvse],
      [`/stations/${STATION}/evses/2/connectors/1/retire`, retireConnector],
      [`/stations/${STATION}/evses/2/connectors/1/restore`, restoreConnector],
    ] as const)('%s answers 404 outside the caller sites and pushes nothing', async (url, fn) => {
      mocks.checkStationSiteAccess.mockResolvedValueOnce(false);
      const res = await inject('POST', url);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(fn).not.toHaveBeenCalled();
      expect(pushStationDataPlanChanges).not.toHaveBeenCalled();
    });
  });

  describe('monitoring rule create outcomes', () => {
    const station = { id: STATION, stationId: 'CS-1', isOnline: true, ocppProtocol: 'ocpp2.1' };
    const ruleRow = {
      id: 5,
      stationId: STATION,
      monitoringId: null,
      component: 'EVSE',
      componentInstance: null,
      variable: 'Power',
      type: 'UpperThreshold',
      value: '50',
      severity: 5,
      status: 'pending',
      errorInfo: null,
      source: 'operator',
      reportRequestId: null,
      reportReason: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const body = {
      component: 'EVSE',
      variable: 'Power',
      type: 'UpperThreshold',
      value: 50,
      severity: 5,
    };

    it('answers 201 with the inserted rule when a concurrent delete won the update', async () => {
      mocks.sendOcpp.mockResolvedValueOnce({
        commandId: 'c',
        response: { setMonitoringResult: [{ status: 'Accepted', id: 12 }] },
      });
      queue([station], [ruleRow], []);
      const res = await inject('POST', `/stations/${STATION}/monitoring-rules`, body);
      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json).toMatchObject({ id: 5, component: 'EVSE', status: 'pending' });
      expect(json).not.toHaveProperty('componentInstance');
      expect(json).not.toHaveProperty('source');
    });

    it('answers 504 when the station does not answer', async () => {
      mocks.sendOcpp.mockResolvedValueOnce({ commandId: 'c', timedOut: true });
      queue([station], [ruleRow], [{ ...ruleRow, status: 'error' }]);
      const res = await inject('POST', `/stations/${STATION}/monitoring-rules`, body);
      expect(res.statusCode).toBe(504);
      expect(res.json().code).toBe('STATION_TIMEOUT');
      expect(auditCalls('monitoring_changed')[0]).toMatchObject({
        after: { status: 'error', errorInfo: 'No response from station' },
      });
    });

    it('answers 400 OCPP_VERSION_MISMATCH when the server refused the command', async () => {
      mocks.sendOcpp.mockResolvedValueOnce({
        commandId: 'c',
        code: OCPP_VERSION_MISMATCH,
        error: 'Not in 2.0.1',
      });
      queue([station], [ruleRow], [{ ...ruleRow, status: 'error' }]);
      const res = await inject('POST', `/stations/${STATION}/monitoring-rules`, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'OCPP_VERSION_MISMATCH', error: 'Not in 2.0.1' });
    });

    it('answers 502 OCPP_COMMAND_FAILED for a send error', async () => {
      mocks.sendOcpp.mockResolvedValueOnce({ commandId: 'c', error: 'socket closed' });
      queue([station], [ruleRow], [{ ...ruleRow, status: 'error' }]);
      const res = await inject('POST', `/stations/${STATION}/monitoring-rules`, body);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ code: 'OCPP_COMMAND_FAILED', error: 'socket closed' });
    });

    it('answers 502 STATION_REJECTED with the station reason', async () => {
      mocks.sendOcpp.mockResolvedValueOnce({
        commandId: 'c',
        response: { setMonitoringResult: [{ status: 'UnknownVariable' }] },
      });
      queue([station], [ruleRow], [{ ...ruleRow, status: 'error' }]);
      const res = await inject('POST', `/stations/${STATION}/monitoring-rules`, body);
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        code: 'STATION_REJECTED',
        error: 'Station did not accept the monitor: UnknownVariable',
      });
    });
  });

  describe('monitoring rule clear of an active monitor', () => {
    const activeRule = {
      id: 5,
      stationId: STATION,
      component: 'EVSE',
      variable: 'Power',
      type: 'UpperThreshold',
      value: '50',
      severity: 5,
      status: 'active',
      monitoringId: 12,
    };

    it('clears it at the station first, then stores cleared', async () => {
      mocks.sendOcpp.mockResolvedValueOnce({
        commandId: 'c',
        response: { clearMonitoringResult: [{ id: 12, status: 'Accepted' }] },
      });
      queue([activeRule], [{ stationId: 'CS-1', isOnline: true }], []);
      const res = await inject('DELETE', `/stations/${STATION}/monitoring-rules/5`);
      expect(res.statusCode).toBe(204);
      expect(mocks.sendOcpp).toHaveBeenCalledWith(
        'CS-1',
        'ClearVariableMonitoring',
        { id: [12] },
        '2.1',
      );
      expect(argsOf(chainsOf('update')[0], 'set')?.[0]).toMatchObject({ status: 'cleared' });
    });

    it('answers 404 when the station row is gone', async () => {
      queue([activeRule], []);
      const res = await inject('DELETE', `/stations/${STATION}/monitoring-rules/5`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('STATION_NOT_FOUND');
      expect(mocks.sendOcpp).not.toHaveBeenCalled();
    });

    it('answers 400 for an offline station', async () => {
      queue([activeRule], [{ stationId: 'CS-1', isOnline: false }]);
      const res = await inject('DELETE', `/stations/${STATION}/monitoring-rules/5`);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('STATION_OFFLINE');
      expect(chainsOf('update')).toHaveLength(0);
    });

    it.each([
      [
        { response: { clearMonitoringResult: [{ id: 12, status: 'Rejected' }] } },
        502,
        'STATION_REJECTED',
      ],
      [{ timedOut: true }, 504, 'STATION_TIMEOUT'],
      [{ error: 'socket closed' }, 502, 'OCPP_COMMAND_FAILED'],
    ] as const)('keeps the rule when the station answers %o', async (result, status, code) => {
      mocks.sendOcpp.mockResolvedValueOnce({ commandId: 'c', ...result });
      queue([activeRule], [{ stationId: 'CS-1', isOnline: true }]);
      const res = await inject('DELETE', `/stations/${STATION}/monitoring-rules/5`);
      expect(res.statusCode).toBe(status);
      expect(res.json().code).toBe(code);
      expect(chainsOf('update')).toHaveLength(0);
      expect(auditCalls('monitoring_changed')).toHaveLength(0);
    });

    it('answers 404 RULE_NOT_FOUND for an unknown rule', async () => {
      queue([]);
      const res = await inject('DELETE', `/stations/${STATION}/monitoring-rules/9`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RULE_NOT_FOUND');
    });
  });
});
