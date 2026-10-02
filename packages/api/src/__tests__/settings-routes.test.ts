// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeChain()),
        insert: vi.fn(() => makeChain()),
        update: vi.fn(() => makeChain()),
        delete: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  },
  settings: {},
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  clearSystemSettingsCache: vi.fn(),
  writeAudit: vi.fn().mockResolvedValue(undefined),
  siteAuditLog: {},
  stationAuditLog: {},
  driverAuditLog: {},
  fleetAuditLog: {},
  userAuditLog: {},
  vehicleAuditLog: {},
  supportCaseAuditLog: {},
  ocpiPartnerAuditLog: {},
  certificateAuditLog: {},
  roleAuditLog: {},
  apiKeyAuditLog: {},
  settingAuditLog: {},
  smartChargingTemplateAuditLog: {},
  configTemplateAuditLog: {},
  firmwareCampaignAuditLog: {},
  stationImageAuditLog: {},
  localAuthListAuditLog: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  like: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  between: vi.fn(),
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
import { settingsRoutes } from '../routes/settings.js';
import { db, clearSystemSettingsCache } from '@evtivity/database';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  settingsRoutes(app);
  await app.ready();
  return app;
}

describe('Settings routes', () => {
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
  });

  // --- Auth requirements ---

  it('GET /v1/settings returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/settings' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/settings/:key returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/settings/smtp.host' });
    expect(response.statusCode).toBe(401);
  });

  it('PATCH /v1/settings/:key returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings/smtp.host',
      payload: { value: 'localhost' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('DELETE /v1/settings/:key returns 401 without auth', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/settings/smtp.host' });
    expect(response.statusCode).toBe(401);
  });

  // --- Happy paths ---

  it('GET /v1/portal/branding returns branding data without auth', async () => {
    setupDbResults([
      { key: 'company.name', value: 'TestCo' },
      { key: 'company.logo', value: 'logo.png' },
    ]);
    const response = await app.inject({ method: 'GET', url: '/portal/branding' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('name', 'TestCo');
    expect(body).toHaveProperty('logo', 'logo.png');
  });

  it('GET /v1/portal/branding returns the normalized company currency', async () => {
    setupDbResults([
      { key: 'company.name', value: 'TestCo' },
      { key: 'company.currency', value: 'eur' },
    ]);
    const response = await app.inject({ method: 'GET', url: '/portal/branding' });
    expect(response.statusCode).toBe(200);
    expect(response.json().currency).toBe('EUR');
  });

  it('GET /v1/settings returns all settings as key-value map', async () => {
    setupDbResults([
      { key: 'smtp.host', value: 'mail.example.com' },
      { key: 'smtp.port', value: '587' },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body['smtp.host']).toBe('mail.example.com');
    expect(body['smtp.port']).toBe('587');
  });

  it('GET /v1/settings/:key returns a single setting', async () => {
    setupDbResults([{ key: 'smtp.host', value: 'mail.example.com' }]);
    const response = await app.inject({
      method: 'GET',
      url: '/settings/smtp.host',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.key).toBe('smtp.host');
    expect(body.value).toBe('mail.example.com');
  });

  it('GET /v1/settings/:key returns 404 when not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/settings/nonexistent',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SETTING_NOT_FOUND');
  });

  it('PATCH /v1/settings/:key updates a setting', async () => {
    // 1: before SELECT, 2: UPDATE returning
    setupDbResults(
      [{ key: 'smtp.host', value: 'oldhost' }],
      [{ key: 'smtp.host', value: '"newhost"' }],
    );
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings/smtp.host',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'newhost' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.key).toBe('smtp.host');
  });

  it('PATCH /v1/settings/:key returns 404 when setting does not exist', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings/nonexistent',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'something' },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SETTING_NOT_FOUND');
  });

  it('PUT /v1/settings/:key upserts a setting', async () => {
    // 1: before SELECT, 2: INSERT...returning
    setupDbResults([], [{ key: 'new.setting', value: '"hello"' }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/new.setting',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'hello' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.key).toBe('new.setting');
  });

  it('PUT /v1/settings/company.currency rejects an unsupported currency', async () => {
    vi.mocked(db.insert).mockClear();
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/company.currency',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'XYZ' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('PATCH /v1/settings/company.currency rejects a currency without two decimals', async () => {
    vi.mocked(db.update).mockClear();
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings/company.currency',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'JPY' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
    expect(db.update).not.toHaveBeenCalled();
  });

  it('PUT /v1/settings/company.currency rejects a non-string value', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/company.currency',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 978 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('PUT /v1/settings/company.currency stores the uppercase code and clears the cache', async () => {
    vi.mocked(db.insert).mockClear();
    vi.mocked(clearSystemSettingsCache).mockClear();
    setupDbResults([], [{ key: 'company.currency', value: 'EUR' }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/company.currency',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: ' eur ' },
    });
    expect(response.statusCode).toBe(200);
    const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith({ key: 'company.currency', value: 'EUR' });
    expect(clearSystemSettingsCache).toHaveBeenCalled();
  });

  it('PATCH /v1/settings/company.currency stores the uppercase code', async () => {
    vi.mocked(db.update).mockClear();
    setupDbResults([], [{ key: 'company.currency', value: 'GBP' }]);
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings/company.currency',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'gbp' },
    });
    expect(response.statusCode).toBe(200);
    const updateChain = vi.mocked(db.update).mock.results.at(-1)?.value as {
      set: ReturnType<typeof vi.fn>;
    };
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ value: 'GBP' }));
  });

  it('PUT /v1/settings/company.priceDisplay rejects a value other than gross or net', async () => {
    vi.mocked(db.insert).mockClear();
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/company.priceDisplay',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'brutto' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
    expect(response.json().error).toContain('company.priceDisplay');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('PUT /v1/settings/company.priceDisplay stores gross and clears the cache', async () => {
    vi.mocked(db.insert).mockClear();
    vi.mocked(clearSystemSettingsCache).mockClear();
    setupDbResults([], [{ key: 'company.priceDisplay', value: 'gross' }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/company.priceDisplay',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'gross' },
    });
    expect(response.statusCode).toBe(200);
    const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith({
      key: 'company.priceDisplay',
      value: 'gross',
    });
    expect(clearSystemSettingsCache).toHaveBeenCalled();
  });

  it('GET /v1/portal/branding includes the company price display', async () => {
    setupDbResults([{ key: 'company.priceDisplay', value: 'gross' }]);
    const response = await app.inject({ method: 'GET', url: '/portal/branding' });
    expect(response.statusCode).toBe(200);
    expect(response.json().priceDisplay).toBe('gross');
  });

  it('DELETE /v1/settings/:key deletes a setting', async () => {
    setupDbResults([{ key: 'smtp.host', value: 'mail.example.com' }]);
    const response = await app.inject({
      method: 'DELETE',
      url: '/settings/smtp.host',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.key).toBe('smtp.host');
  });

  it('DELETE /v1/settings/:key returns 404 when not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'DELETE',
      url: '/settings/nonexistent',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SETTING_NOT_FOUND');
  });
});
