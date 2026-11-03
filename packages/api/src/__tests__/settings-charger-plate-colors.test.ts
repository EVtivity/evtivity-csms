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

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

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
  GUEST_STARTS_PER_IP_PER_HOUR_KEY: 'guest.startsPerIpPerHour',
  GUEST_DECLINES_PER_IP_PER_HOUR_KEY: 'guest.declinesPerIpPerHour',
  MAX_GUEST_VELOCITY_LIMIT: 10_000,
  parseGuestVelocityLimit: (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000
      ? value
      : null,
  clearGuestVelocityCache: vi.fn(),
  clearGuestChargingCache: vi.fn(),
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

// The S3 route's fresh proof has its own tests (settings-routes-full, session-proof).
vi.mock('../lib/mfa-factor-proof.js', async () => {
  const { z } = await import('zod');
  return { factorProof: z.object({ kind: z.string() }).loose() };
});
vi.mock('../lib/session-proof.js', () => ({
  sessionProofErrorFields: {},
  SESSION_PROOF_ERROR_CODES: ['VALIDATION_ERROR', 'INVALID_PASSWORD'],
  isApiKeyRequest: () => false,
  requireSessionProof: () => Promise.resolve(true),
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
import { db } from '@evtivity/database';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  settingsRoutes(app);
  await app.ready();
  return app;
}

describe('Charger plate color settings', () => {
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

  it.each(['company.chargerColorAc', 'company.chargerColorDc'])(
    'PUT /v1/settings/%s stores a lowercase hex color',
    async (key) => {
      setupDbResults([], [{ key, value: '#a1b2c3' }]);
      const response = await app.inject({
        method: 'PUT',
        url: `/settings/${key}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { value: ' #A1B2C3 ' },
      });
      expect(response.statusCode).toBe(200);
      const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      expect(insertChain.values).toHaveBeenCalledWith({ key, value: '#a1b2c3' });
    },
  );

  it('PUT stores an empty value, which follows the brand color', async () => {
    setupDbResults([], [{ key: 'company.chargerColorAc', value: '' }]);
    const response = await app.inject({
      method: 'PUT',
      url: '/settings/company.chargerColorAc',
      headers: { authorization: `Bearer ${token}` },
      payload: { value: '' },
    });
    expect(response.statusCode).toBe(200);
    const insertChain = vi.mocked(db.insert).mock.results.at(-1)?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith({ key: 'company.chargerColorAc', value: '' });
  });

  it.each([
    ['PUT', '#abc'],
    ['PUT', 'red'],
    ['PUT', '#a1b2c3d4'],
    ['PUT', 123],
    ['PATCH', 'a1b2c3'],
    ['PATCH', '#zzzzzz'],
  ] as const)('%s refuses %j with 400 VALIDATION_ERROR', async (method, value) => {
    vi.mocked(db.insert).mockClear();
    vi.mocked(db.update).mockClear();
    const response = await app.inject({
      method,
      url: '/settings/company.chargerColorDc',
      headers: { authorization: `Bearer ${token}` },
      payload: { value },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('VALIDATION_ERROR');
    expect(response.json().error).toBe(
      'company.chargerColorDc must be empty or a #rrggbb hex color',
    );
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('GET /v1/portal/branding resolves empty plate colors to the brand color', async () => {
    setupDbResults([
      { key: 'company.themeColor', value: '#112233' },
      { key: 'company.chargerColorAc', value: '' },
    ]);
    const response = await app.inject({ method: 'GET', url: '/portal/branding' });
    expect(response.statusCode).toBe(200);
    expect(response.json().chargerColorAc).toBe('#112233');
    expect(response.json().chargerColorDc).toBe('#112233');
  });

  it('GET /v1/portal/branding returns a set plate color as stored', async () => {
    setupDbResults([
      { key: 'company.themeColor', value: '#112233' },
      { key: 'company.chargerColorAc', value: '#00aa55' },
      { key: 'company.chargerColorDc', value: '#ff8800' },
    ]);
    const response = await app.inject({ method: 'GET', url: '/portal/branding' });
    expect(response.json().chargerColorAc).toBe('#00aa55');
    expect(response.json().chargerColorDc).toBe('#ff8800');
  });

  it('GET /v1/portal/branding falls back to the default brand color without a theme color', async () => {
    setupDbResults([{ key: 'company.chargerColorDc', value: 'not-a-color' }]);
    const response = await app.inject({ method: 'GET', url: '/portal/branding' });
    expect(response.json().chargerColorAc).toBe('#2563eb');
    expect(response.json().chargerColorDc).toBe('#2563eb');
  });
});
