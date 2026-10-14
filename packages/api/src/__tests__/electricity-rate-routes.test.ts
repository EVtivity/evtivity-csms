// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_SITE_ID = 'sit_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

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
    'delete',
    'insert',
    'update',
    'having',
    'selectDistinct',
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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  sites: {},
  chargingStations: { id: {}, siteId: {} },
  maintenanceEvents: {},
  chargingSessions: {},
  drivers: {},
  meterValues: {},
  stationLayoutPositions: {},
  evses: {},
  connectors: {},
  siteLoadManagement: {},
  displayMessages: {},
  pricingGroupSites: {},
  pricingGroups: {},
  configTemplates: {},
  carbonIntensityFactors: {},
  pricingAssignmentAuditLog: {},
  siteElectricityRatePeriods: { id: {}, siteId: {}, priority: {} },
  writeAudit: vi.fn().mockResolvedValue(undefined),
  siteAuditLog: {},
  configTemplateAuditLog: {},
  clearFreeVendCache: vi.fn(),
  clearElectricityRateCache: vi.fn(),
  getCompanyCurrency: vi.fn().mockResolvedValue('EUR'),
}));

vi.mock('@evtivity/services/electricity-cost.service', () => ({
  recalculateSiteElectricityCost: vi.fn(),
}));

vi.mock('drizzle-orm', () => {
  const sqlFn = () => ({ as: vi.fn() });
  return {
    eq: vi.fn(),
    and: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
    sql: Object.assign(vi.fn(sqlFn), { raw: vi.fn(sqlFn), identifier: vi.fn(sqlFn) }),
    getTableName: vi.fn(() => 'sites'),
    gte: vi.fn(),
    lte: vi.fn(),
    desc: vi.fn(),
    count: vi.fn(),
    inArray: vi.fn(),
    isNotNull: vi.fn(),
  };
});

vi.mock('../services/site-import.service.js', () => ({
  exportSitesCsv: vi.fn().mockResolvedValue(''),
  exportSitesTemplateCsv: vi.fn().mockReturnValue(''),
  importSitesCsv: vi.fn().mockResolvedValue({ errors: [] }),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { siteRoutes } from '../routes/sites.js';
import { db, clearElectricityRateCache, writeAudit } from '@evtivity/database';
import { recalculateSiteElectricityCost } from '@evtivity/services/electricity-cost.service';
import { getUserSiteIds } from '../lib/site-access.js';

const getUserSiteIdsMock = getUserSiteIds as ReturnType<typeof vi.fn>;

function lastInsertValues(): Record<string, unknown> {
  const results = (db.insert as ReturnType<typeof vi.fn>).mock.results;
  const chain = results[results.length - 1]?.value as { values: ReturnType<typeof vi.fn> };
  return chain.values.mock.calls[0]?.[0] as Record<string, unknown>;
}

function lastSiteAudit(): Record<string, unknown> | undefined {
  const calls = (writeAudit as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1]?.[1] as Record<string, unknown> | undefined;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(siteRoutes);
  await app.ready();
  return app;
}

describe('Electricity rate routes', () => {
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
    setupDbResults();
    (db.insert as ReturnType<typeof vi.fn>).mockClear();
    (clearElectricityRateCache as ReturnType<typeof vi.fn>).mockClear();
    (writeAudit as ReturnType<typeof vi.fn>).mockClear();
    getUserSiteIdsMock.mockReset();
    getUserSiteIdsMock.mockResolvedValue(null);
  });

  const authHeaders = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  it('GET requires auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/electricity-rates`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET returns an empty list', async () => {
    setupDbResults([]);
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/electricity-rates`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('GET returns 404 when the site is outside the user site access', async () => {
    getUserSiteIdsMock.mockResolvedValueOnce(['sit_other']);
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${VALID_SITE_ID}/electricity-rates`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('SITE_NOT_FOUND');
  });

  it('POST creates a flat-rate period with priority 0 and isDefault true', async () => {
    const created = {
      id: 1,
      siteId: VALID_SITE_ID,
      name: 'Flat',
      ratePerKwh: '0.120000',
      restrictions: null,
      priority: 0,
      isDefault: true,
    };
    // select site, then insert returning
    setupDbResults([{ id: VALID_SITE_ID }], [created]);
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${VALID_SITE_ID}/electricity-rates`,
      headers: authHeaders(),
      payload: { name: 'Flat', ratePerKwh: 0.12 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ratePerKwh).toBe(0.12);
    expect(body.priority).toBe(0);
    expect(body.isDefault).toBe(true);
    const inserted = lastInsertValues();
    expect(inserted.priority).toBe(0);
    expect(inserted.isDefault).toBe(true);
    expect(inserted.ratePerKwh).toBe('0.12');
    expect(clearElectricityRateCache).toHaveBeenCalledWith(VALID_SITE_ID);
    const auditArgs = lastSiteAudit();
    expect(auditArgs).toMatchObject({
      entityId: VALID_SITE_ID,
      action: 'electricity_rates_changed',
      actor: 'operator',
      before: null,
      after: { electricityRate: { name: 'Flat' } },
      notes: 'electricity rate created: Flat',
    });
  });

  it('POST derives priority 10 for a time-only TOU period', async () => {
    const created = {
      id: 2,
      siteId: VALID_SITE_ID,
      name: 'Peak',
      ratePerKwh: '0.300000',
      restrictions: { timeRange: { startTime: '09:00', endTime: '17:00' } },
      priority: 10,
      isDefault: false,
    };
    setupDbResults([{ id: VALID_SITE_ID }], [created]);
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${VALID_SITE_ID}/electricity-rates`,
      headers: authHeaders(),
      payload: {
        name: 'Peak',
        ratePerKwh: 0.3,
        restrictions: { timeRange: { startTime: '09:00', endTime: '17:00' } },
      },
    });
    expect(res.statusCode).toBe(201);
    const inserted = lastInsertValues();
    expect(inserted.priority).toBe(10);
    expect(inserted.isDefault).toBe(false);
  });

  it('POST rejects an invalid restriction combination (daysOfWeek without timeRange)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${VALID_SITE_ID}/electricity-rates`,
      headers: authHeaders(),
      payload: { name: 'Bad', ratePerKwh: 0.2, restrictions: { daysOfWeek: [1, 2] } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH updates the rate', async () => {
    const updated = {
      id: 3,
      siteId: VALID_SITE_ID,
      name: 'Flat',
      ratePerKwh: '0.150000',
      restrictions: null,
      priority: 0,
      isDefault: true,
    };
    setupDbResults([{ ...updated, ratePerKwh: '0.100000' }], [updated]);
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/electricity-rates/3`,
      headers: authHeaders(),
      payload: { name: 'Flat', ratePerKwh: 0.15 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ratePerKwh).toBe(0.15);
    expect(clearElectricityRateCache).toHaveBeenCalledWith(VALID_SITE_ID);
    expect(lastSiteAudit()).toMatchObject({
      entityId: VALID_SITE_ID,
      action: 'electricity_rates_changed',
      before: { electricityRateId: 3, ratePerKwh: '0.100000' },
      after: { electricityRateId: 3, ratePerKwh: '0.150000' },
      notes: 'electricity rate updated: Flat',
    });
    // Only the changed field is recorded.
    expect(lastSiteAudit()?.['after']).not.toHaveProperty('name');
  });

  it('PATCH returns 404 when the period does not exist', async () => {
    setupDbResults([]);
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${VALID_SITE_ID}/electricity-rates/999`,
      headers: authHeaders(),
      payload: { name: 'X', ratePerKwh: 0.1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ELECTRICITY_RATE_NOT_FOUND');
  });

  it('DELETE removes the period', async () => {
    setupDbResults([{ id: 4, name: 'Night' }]);
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${VALID_SITE_ID}/electricity-rates/4`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(clearElectricityRateCache).toHaveBeenCalledWith(VALID_SITE_ID);
    expect(lastSiteAudit()).toMatchObject({
      entityId: VALID_SITE_ID,
      action: 'electricity_rates_changed',
      before: { electricityRate: { id: 4, name: 'Night' } },
      after: null,
      notes: 'electricity rate deleted: Night',
    });
  });

  it('writes no audit row when the period does not exist', async () => {
    setupDbResults([]);
    await app.inject({
      method: 'DELETE',
      url: `/sites/${VALID_SITE_ID}/electricity-rates/999`,
      headers: authHeaders(),
    });
    expect(lastSiteAudit()).toBeUndefined();
  });

  it('DELETE returns 404 when the period does not exist', async () => {
    setupDbResults([]);
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${VALID_SITE_ID}/electricity-rates/999`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ELECTRICITY_RATE_NOT_FOUND');
  });
});

describe('POST /sites/:id/electricity-cost/recalculate', () => {
  let app: FastifyInstance;
  let token: string;
  const recalculateMock = recalculateSiteElectricityCost as ReturnType<typeof vi.fn>;
  const writeAuditMock = writeAudit as ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    recalculateMock.mockReset();
    writeAuditMock.mockClear();
    getUserSiteIdsMock.mockReset();
    getUserSiteIdsMock.mockResolvedValue(null);
  });

  const post = () =>
    app.inject({
      method: 'POST',
      url: `/sites/${VALID_SITE_ID}/electricity-cost/recalculate`,
      headers: { authorization: `Bearer ${token}` },
    });

  it('fills the costs in the company currency, audits the counts and returns updated and remaining', async () => {
    setupDbResults([{ id: VALID_SITE_ID }]);
    recalculateMock.mockResolvedValue({ before: 4, updated: 4, remaining: 0 });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 4, remaining: 0 });
    expect(recalculateMock).toHaveBeenCalledWith(VALID_SITE_ID, { companyCurrency: 'EUR' });
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const [, args] = writeAuditMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(args).toMatchObject({
      entityId: VALID_SITE_ID,
      action: 'updated',
      before: { sessionsWithoutElectricityCost: 4 },
      after: { sessionsWithoutElectricityCost: 0, electricityCostsFilled: 4 },
      notes: 'electricity cost recalculated',
    });
  });

  it('writes no audit row when nothing changed (a repeated call)', async () => {
    setupDbResults([{ id: VALID_SITE_ID }]);
    recalculateMock.mockResolvedValue({ before: 0, updated: 0, remaining: 0 });
    const res = await post();
    expect(res.json()).toEqual({ updated: 0, remaining: 0 });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('answers 404 SITE_NOT_FOUND for a site outside the user scope, without recalculating', async () => {
    getUserSiteIdsMock.mockResolvedValue(['sit_000000000002']);
    const res = await post();
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('SITE_NOT_FOUND');
    expect(recalculateMock).not.toHaveBeenCalled();
  });

  it('answers 404 SITE_NOT_FOUND for an unknown site', async () => {
    setupDbResults([]);
    const res = await post();
    expect(res.statusCode).toBe(404);
    expect(recalculateMock).not.toHaveBeenCalled();
  });
});
