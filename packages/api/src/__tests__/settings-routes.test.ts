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
  getCompanyPriceDisplay: vi.fn(() => Promise.resolve('gross')),
  getCompanyTaxBasis: vi.fn(() => Promise.resolve('gross')),
  clearSystemSettingsCache: vi.fn(),
  clearMobileAppConfigCache: vi.fn(),
  clearStationMessageSettingsCache: vi.fn(),
  clearWebhookSettingsCache: vi.fn(),
  clearRoamingCache: vi.fn(),
  clearSupportCache: vi.fn(),
  clearFleetCache: vi.fn(),
  WEBHOOK_ALLOWED_PRIVATE_HOSTS_KEY: 'notifications.webhookAllowedPrivateHosts',
  PREPAID_LOW_CREDIT_THRESHOLD_KEY: 'prepaid.lowCreditThresholdCents',
  MAX_PREPAID_LOW_CREDIT_THRESHOLD_CENTS: 100_000_000,
  parsePrepaidLowCreditThresholdCents: (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000_000
      ? value
      : null,
  clearPrepaidSettingsCache: vi.fn(),
  INVOICE_PAYMENT_TERMS_DAYS_KEY: 'invoice.paymentTermsDays',
  MAX_INVOICE_PAYMENT_TERMS_DAYS: 365,
  parseInvoicePaymentTermsDays: (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365
      ? value
      : null,
  FLEET_INVOICE_RUN_DAY_KEY: 'fleet.invoiceRunDay',
  MAX_FLEET_INVOICE_RUN_DAY: 28,
  parseFleetInvoiceRunDay: (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 28
      ? value
      : null,
  clearInvoiceSettingsCache: vi.fn(),
  FLEET_CREDIT_RESERVATION_KEY: 'fleet.creditReservationCents',
  MAX_FLEET_CREDIT_RESERVATION_CENTS: 100_000_000,
  parseFleetCreditReservationCents: (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100_000_000
      ? value
      : null,
  clearFleetCreditSettingsCache: vi.fn(),
  invalidateReservationSettingsCache: vi.fn(),
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

vi.mock('../lib/payments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/payments.js')>()),
  clearPaymentCaches: vi.fn(),
}));

vi.mock('@evtivity/services/station-message.service', () => ({
  requestStationMessageRepush: vi.fn().mockResolvedValue(undefined),
}));

// The provider-switch guard has its own tests (settings-routes-full, provider-switch).
vi.mock('../lib/provider-switch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/provider-switch.js')>()),
  assertPaymentProviderWritable: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { settingsRoutes } from '../routes/settings.js';
import { clearPaymentCaches } from '../lib/payments.js';
import { requestStationMessageRepush } from '@evtivity/services/station-message.service';
import {
  db,
  clearSystemSettingsCache,
  clearMobileAppConfigCache,
  clearStationMessageSettingsCache,
  invalidateReservationSettingsCache,
  clearPrepaidSettingsCache,
  clearInvoiceSettingsCache,
  clearFleetCreditSettingsCache,
} from '@evtivity/database';

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

  it('PUT /v1/settings/stationMessage.language rejects an unsupported language', async () => {
    vi.mocked(db.insert).mockClear();
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/stationMessage.language',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'fr' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
    expect(response.json().error).toContain('stationMessage.language');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('PUT /v1/settings/stationMessage.language stores the language and clears the cache', async () => {
    vi.mocked(db.insert).mockClear();
    vi.mocked(clearStationMessageSettingsCache).mockClear();
    vi.mocked(clearSystemSettingsCache).mockClear();
    setupDbResults([], [{ key: 'stationMessage.language', value: 'zh-TW' }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/stationMessage.language',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'zh-TW' },
    });
    expect(response.statusCode).toBe(200);
    const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith({
      key: 'stationMessage.language',
      value: 'zh-TW',
    });
    expect(clearStationMessageSettingsCache).toHaveBeenCalled();
    expect(clearSystemSettingsCache).not.toHaveBeenCalled();
  });

  it.each([-1, 2.5, '500', 100_000_001])(
    'PUT /v1/settings/prepaid.lowCreditThresholdCents rejects %s',
    async (value) => {
      vi.mocked(db.insert).mockClear();
      const response = await app.inject({
        method: 'PUT',
        url: '/settings/prepaid.lowCreditThresholdCents',
        headers: { authorization: `Bearer ${token}` },
        payload: { value },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      expect(response.json().error).toContain('prepaid.lowCreditThresholdCents');
      expect(db.insert).not.toHaveBeenCalled();
    },
  );

  it('PUT /v1/settings/prepaid.lowCreditThresholdCents stores the threshold and clears the cache', async () => {
    vi.mocked(db.insert).mockClear();
    vi.mocked(clearPrepaidSettingsCache).mockClear();
    setupDbResults([], [{ key: 'prepaid.lowCreditThresholdCents', value: 1000 }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/prepaid.lowCreditThresholdCents',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 1000 },
    });
    expect(response.statusCode).toBe(200);
    const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith({
      key: 'prepaid.lowCreditThresholdCents',
      value: 1000,
    });
    expect(clearPrepaidSettingsCache).toHaveBeenCalled();
  });

  it.each([-1, 1.5, '30', 366, null])(
    'PUT /v1/settings/invoice.paymentTermsDays rejects %s',
    async (value) => {
      vi.mocked(db.insert).mockClear();
      const response = await app.inject({
        method: 'PUT',
        url: '/settings/invoice.paymentTermsDays',
        headers: { authorization: `Bearer ${token}` },
        payload: { value },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      expect(response.json().error).toContain('invoice.paymentTermsDays');
      expect(db.insert).not.toHaveBeenCalled();
    },
  );

  it.each([0, 14, 365])(
    'PUT /v1/settings/invoice.paymentTermsDays stores %s days and clears the cache',
    async (value) => {
      vi.mocked(db.insert).mockClear();
      vi.mocked(clearInvoiceSettingsCache).mockClear();
      setupDbResults([], [{ key: 'invoice.paymentTermsDays', value }]);
      const response = await app.inject({
        method: 'PUT',
        url: '/settings/invoice.paymentTermsDays',
        headers: { authorization: `Bearer ${token}` },
        payload: { value },
      });
      expect(response.statusCode).toBe(200);
      const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      expect(insertChain.values).toHaveBeenCalledWith({ key: 'invoice.paymentTermsDays', value });
      expect(clearInvoiceSettingsCache).toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, '5000', 100_000_001, null])(
    'PUT /v1/settings/fleet.creditReservationCents rejects %s',
    async (value) => {
      vi.mocked(db.insert).mockClear();
      const response = await app.inject({
        method: 'PUT',
        url: '/settings/fleet.creditReservationCents',
        headers: { authorization: `Bearer ${token}` },
        payload: { value },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      expect(response.json().error).toContain('fleet.creditReservationCents');
      expect(db.insert).not.toHaveBeenCalled();
    },
  );

  it.each([1, 5000, 100_000_000])(
    'PUT /v1/settings/fleet.creditReservationCents stores %s cents and clears the cache',
    async (value) => {
      vi.mocked(db.insert).mockClear();
      vi.mocked(clearFleetCreditSettingsCache).mockClear();
      setupDbResults([], [{ key: 'fleet.creditReservationCents', value }]);
      const response = await app.inject({
        method: 'PUT',
        url: '/settings/fleet.creditReservationCents',
        headers: { authorization: `Bearer ${token}` },
        payload: { value },
      });
      expect(response.statusCode).toBe(200);
      const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      expect(insertChain.values).toHaveBeenCalledWith({
        key: 'fleet.creditReservationCents',
        value,
      });
      expect(clearFleetCreditSettingsCache).toHaveBeenCalled();
    },
  );

  it.each([0, 29, 2.5, '1', null])(
    'PUT /v1/settings/fleet.invoiceRunDay rejects %s',
    async (value) => {
      vi.mocked(db.insert).mockClear();
      const response = await app.inject({
        method: 'PUT',
        url: '/settings/fleet.invoiceRunDay',
        headers: { authorization: `Bearer ${token}` },
        payload: { value },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('VALIDATION_ERROR');
      expect(response.json().error).toContain('fleet.invoiceRunDay');
      expect(db.insert).not.toHaveBeenCalled();
    },
  );

  it.each([1, 28])(
    'PUT /v1/settings/fleet.invoiceRunDay stores day %s and clears the cache',
    async (value) => {
      vi.mocked(db.insert).mockClear();
      vi.mocked(clearInvoiceSettingsCache).mockClear();
      setupDbResults([], [{ key: 'fleet.invoiceRunDay', value }]);
      const response = await app.inject({
        method: 'PUT',
        url: '/settings/fleet.invoiceRunDay',
        headers: { authorization: `Bearer ${token}` },
        payload: { value },
      });
      expect(response.statusCode).toBe(200);
      const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      expect(insertChain.values).toHaveBeenCalledWith({ key: 'fleet.invoiceRunDay', value });
      expect(clearInvoiceSettingsCache).toHaveBeenCalled();
    },
  );

  it('PUT /v1/settings/stationMessage.language re-renders station screens when the value changes', async () => {
    vi.mocked(requestStationMessageRepush).mockClear();
    setupDbResults(
      [{ key: 'stationMessage.language', value: 'en' }],
      [{ key: 'stationMessage.language', value: 'de' }],
    );
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/stationMessage.language',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'de' },
    });
    expect(response.statusCode).toBe(200);
    expect(requestStationMessageRepush).toHaveBeenCalledTimes(1);
  });

  it('PUT /v1/settings/company.name does not re-render station screens for an unchanged value', async () => {
    vi.mocked(requestStationMessageRepush).mockClear();
    setupDbResults(
      [{ key: 'company.name', value: 'ACME' }],
      [{ key: 'company.name', value: 'ACME' }],
    );
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/company.name',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'ACME' },
    });
    expect(response.statusCode).toBe(200);
    expect(requestStationMessageRepush).not.toHaveBeenCalled();
  });

  it('PUT /v1/settings/smtp.host does not re-render station screens', async () => {
    vi.mocked(requestStationMessageRepush).mockClear();
    setupDbResults([], [{ key: 'smtp.host', value: 'mail.example.com' }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/smtp.host',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'mail.example.com' },
    });
    expect(response.statusCode).toBe(200);
    expect(requestStationMessageRepush).not.toHaveBeenCalled();
  });

  it('PUT /v1/settings/reservation.cancellationFeeCents clears the reservation settings cache', async () => {
    vi.mocked(invalidateReservationSettingsCache).mockClear();
    vi.mocked(clearStationMessageSettingsCache).mockClear();
    setupDbResults([], [{ key: 'reservation.cancellationFeeCents', value: 500 }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/reservation.cancellationFeeCents',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 500 },
    });
    expect(response.statusCode).toBe(200);
    expect(invalidateReservationSettingsCache).toHaveBeenCalled();
    expect(clearStationMessageSettingsCache).not.toHaveBeenCalled();
  });

  it('PUT /v1/settings/stripe.webhookSecretEnc encrypts the secret and clears the payment caches', async () => {
    vi.mocked(db.insert).mockClear();
    // The returned row passes through decryptForRead; '' passes through unchanged.
    setupDbResults([], [{ key: 'stripe.webhookSecretEnc', value: '' }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/stripe.webhookSecretEnc',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'whsec_generic' },
    });
    expect(response.statusCode).toBe(200);
    const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    const stored = (insertChain.values.mock.calls[0]?.[0] as { value: unknown }).value;
    expect(stored).not.toBe('whsec_generic');
    expect(clearPaymentCaches).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['payments.provider', 'simulated'],
    ['stripe.publishableKey', 'pk_test_1'],
    ['adyen.merchantAccount', 'EVtivityECOM'],
    ['simulated.resultMode', 'approve'],
  ])('PUT /v1/settings/%s clears the payment caches', async (key, value) => {
    setupDbResults([], [{ key, value }]);
    const response = await app.inject({
      method: 'PUT',
      url: `/settings/${key}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value },
    });
    expect(response.statusCode).toBe(200);
    expect(clearPaymentCaches).toHaveBeenCalledTimes(1);
    expect(clearSystemSettingsCache).not.toHaveBeenCalled();
  });

  it('PATCH /v1/settings/payments.provider clears the payment caches', async () => {
    setupDbResults([], [{ key: 'payments.provider', value: 'stripe' }]);
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings/payments.provider',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'stripe' },
    });
    expect(response.statusCode).toBe(200);
    expect(clearPaymentCaches).toHaveBeenCalledTimes(1);
  });

  it('DELETE /v1/settings/adyen.merchantAccount clears the payment caches', async () => {
    setupDbResults([{ key: 'adyen.merchantAccount', value: 'EVtivityECOM' }]);
    const response = await app.inject({
      method: 'DELETE',
      url: '/settings/adyen.merchantAccount',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(clearPaymentCaches).toHaveBeenCalledTimes(1);
  });

  it('PUT /v1/settings/smtp.host does not clear the payment caches', async () => {
    setupDbResults([], [{ key: 'smtp.host', value: 'mail.example.com' }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/smtp.host',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'mail.example.com' },
    });
    expect(response.statusCode).toBe(200);
    expect(clearPaymentCaches).not.toHaveBeenCalled();
  });

  it('GET /v1/portal/branding includes the company price display', async () => {
    setupDbResults([{ key: 'company.priceDisplay', value: 'gross' }]);
    const response = await app.inject({ method: 'GET', url: '/portal/branding' });
    expect(response.statusCode).toBe(200);
    expect(response.json().priceDisplay).toBe('gross');
  });

  it('GET /v1/portal/branding returns the normalized price display, not the stored value', async () => {
    // The cached reader (mocked to 'gross') resolves an invalid stored value.
    setupDbResults([{ key: 'company.priceDisplay', value: 'brutto' }]);
    const response = await app.inject({ method: 'GET', url: '/portal/branding' });
    expect(response.statusCode).toBe(200);
    expect(response.json().priceDisplay).toBe('gross');
  });

  it('PUT /v1/settings/company.taxBasis rejects a value other than net or gross', async () => {
    vi.mocked(db.insert).mockClear();
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/company.taxBasis',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'inclusive' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
    expect(response.json().error).toBe('company.taxBasis must be one of: net, gross');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('PATCH /v1/settings/company.taxBasis rejects a value other than net or gross', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/settings/company.taxBasis',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'Gross' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
  });

  it('PUT /v1/settings/company.taxBasis stores gross and clears the cache', async () => {
    vi.mocked(db.insert).mockClear();
    vi.mocked(clearSystemSettingsCache).mockClear();
    setupDbResults([], [{ key: 'company.taxBasis', value: 'gross' }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/company.taxBasis',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'gross' },
    });
    expect(response.statusCode).toBe(200);
    const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith({ key: 'company.taxBasis', value: 'gross' });
    expect(clearSystemSettingsCache).toHaveBeenCalled();
  });

  it('PUT /v1/settings/mobile.app.urlSchemes stores normalized schemes and clears the cache', async () => {
    vi.mocked(db.insert).mockClear();
    vi.mocked(clearMobileAppConfigCache).mockClear();
    setupDbResults([], [{ key: 'mobile.app.urlSchemes', value: ['myapp'] }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/mobile.app.urlSchemes',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: [' MyApp ', 'myapp'] },
    });
    expect(response.statusCode).toBe(200);
    const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith({
      key: 'mobile.app.urlSchemes',
      value: ['myapp'],
    });
    expect(clearMobileAppConfigCache).toHaveBeenCalled();
  });

  it.each([
    ['mobile.app.urlSchemes', ['https'], 'mobile.app.urlSchemes must be'],
    ['mobile.app.urlSchemes', 'myapp', 'mobile.app.urlSchemes must be'],
    ['mobile.app.androidPackageNames', ['driver'], 'mobile.app.androidPackageNames must be'],
  ])('PUT /v1/settings/%s refuses %j', async (key, value, message) => {
    vi.mocked(db.insert).mockClear();
    const response = await app.inject({
      method: 'PUT',
      url: `/settings/${key}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
    expect(response.json().error).toContain(message);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('GET /v1/portal/branding returns the normalized tax basis', async () => {
    setupDbResults([{ key: 'company.taxBasis', value: 'brutto' }]);
    const response = await app.inject({ method: 'GET', url: '/portal/branding' });
    expect(response.statusCode).toBe(200);
    expect(response.json().taxBasis).toBe('gross');
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
