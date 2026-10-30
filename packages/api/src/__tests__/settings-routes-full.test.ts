// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

process.env['JWT_SECRET'] = process.env['JWT_SECRET'] || 'test-secret';

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
  getCompanyCurrency: vi.fn(() => Promise.resolve('USD')),
  getCompanyTaxBasis: vi.fn(() => Promise.resolve('net')),
  getCompanyPriceDisplay: vi.fn(() => Promise.resolve('net')),
  clearSystemSettingsCache: vi.fn(),
  clearGuestChargingCache: vi.fn(),
  clearGuestVelocityCache: vi.fn(),
  GUEST_STARTS_PER_IP_PER_HOUR_KEY: 'guest.startsPerIpPerHour',
  GUEST_DECLINES_PER_IP_PER_HOUR_KEY: 'guest.declinesPerIpPerHour',
  MAX_GUEST_VELOCITY_LIMIT: 10_000,
  parseGuestVelocityLimit: vi.fn((value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000
      ? value
      : null,
  ),
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
    typeof value === 'number' ? value : null,
  clearPrepaidSettingsCache: vi.fn(),
  INVOICE_PAYMENT_TERMS_DAYS_KEY: 'invoice.paymentTermsDays',
  MAX_INVOICE_PAYMENT_TERMS_DAYS: 365,
  parseInvoicePaymentTermsDays: (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365
      ? value
      : null,
  FLEET_INVOICE_RUN_DAY_KEY: 'fleet.invoiceRunDay',
  MAX_FLEET_INVOICE_RUN_DAY: 28,
  parseFleetInvoiceRunDay: () => null,
  clearInvoiceSettingsCache: vi.fn(),
  FLEET_CREDIT_RESERVATION_KEY: 'fleet.creditReservationCents',
  MAX_FLEET_CREDIT_RESERVATION_CENTS: 100_000_000,
  parseFleetCreditReservationCents: (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100_000_000
      ? value
      : null,
  clearFleetCreditSettingsCache: vi.fn(),
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
  like: vi.fn(),
  ilike: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@evtivity/lib')>();
  return {
    OCTT_PENDING_RESTORE_SETTING_KEY: actual.OCTT_PENDING_RESTORE_SETTING_KEY,
    WEBHOOK_SIGNING_SECRET_KEY: actual.WEBHOOK_SIGNING_SECRET_KEY,
    assertTemplateAllowed: actual.assertTemplateAllowed,
    EMAIL_LAYOUT_TEMPLATE: actual.EMAIL_LAYOUT_TEMPLATE,
    isDataRetentionSettingKey: actual.isDataRetentionSettingKey,
    isDataPlanSettingKey: actual.isDataPlanSettingKey,
    validateDataPlanSetting: actual.validateDataPlanSetting,
    normalizeMeasurandList: actual.normalizeMeasurandList,
    encryptString: vi.fn((_val: string, _key: string) => 'encrypted-value'),
    decryptString: actual.decryptString,
    clearNotificationSettingsCache: vi.fn(),
    createLogger: actual.createLogger,
    isSupportedCurrency: actual.isSupportedCurrency,
    SUPPORTED_CURRENCIES: actual.SUPPORTED_CURRENCIES,
    isPriceDisplay: actual.isPriceDisplay,
    PRICE_DISPLAYS: actual.PRICE_DISPLAYS,
    isStationMessageLanguage: actual.isStationMessageLanguage,
    STATION_MESSAGE_LANGUAGES: actual.STATION_MESSAGE_LANGUAGES,
    isTaxBasis: actual.isTaxBasis,
    OCPI_TARIFF_SETTING_KEYS: actual.OCPI_TARIFF_SETTING_KEYS,
    TAX_BASES: actual.TAX_BASES,
    UI_LANGUAGES: actual.UI_LANGUAGES,
    isMobileAppSettingKey: actual.isMobileAppSettingKey,
    parseMobileAppList: actual.parseMobileAppList,
    MOBILE_APP_URL_SCHEMES_KEY: actual.MOBILE_APP_URL_SCHEMES_KEY,
    MOBILE_APP_ANDROID_PACKAGES_KEY: actual.MOBILE_APP_ANDROID_PACKAGES_KEY,
    parseAllowedPrivateHosts: actual.parseAllowedPrivateHosts,
    isPrivateUrl: actual.isPrivateUrl,
    isUnroutableAddress: actual.isUnroutableAddress,
    MAX_ALLOWED_PRIVATE_HOSTS: actual.MAX_ALLOWED_PRIVATE_HOSTS,
    validateAiBaseUrl: actual.validateAiBaseUrl,
    isAiBaseUrlSettingKey: actual.isAiBaseUrlSettingKey,
    isAiSettingKey: actual.isAiSettingKey,
    isAiNumberSettingKey: actual.isAiNumberSettingKey,
    isAiFlagSettingKey: actual.isAiFlagSettingKey,
    AI_MCP_MAX_ALLOWED_ORIGINS: actual.AI_MCP_MAX_ALLOWED_ORIGINS,
    normalizeAiSettingValue: actual.normalizeAiSettingValue,
    AI_NUMBER_SETTINGS: actual.AI_NUMBER_SETTINGS,
    AI_PROVIDER_IDS: actual.AI_PROVIDER_IDS,
    AI_EFFORTS: actual.AI_EFFORTS,
    AI_SUPPORT_TONES: actual.AI_SUPPORT_TONES,
    REMOVED_AI_SETTING_KEYS: actual.REMOVED_AI_SETTING_KEYS,
    PDF_LOGO_KEY: actual.PDF_LOGO_KEY,
    PDF_FOOTER_KEY: actual.PDF_FOOTER_KEY,
    MAX_PDF_LOGO_BYTES: actual.MAX_PDF_LOGO_BYTES,
    MAX_PDF_FOOTER_LENGTH: actual.MAX_PDF_FOOTER_LENGTH,
    MAX_PDF_FOOTER_LINES: actual.MAX_PDF_FOOTER_LINES,
    normalizePdfLogo: actual.normalizePdfLogo,
    normalizePdfFooter: actual.normalizePdfFooter,
    INVOICE_SELLER_MAX_LENGTHS: actual.INVOICE_SELLER_MAX_LENGTHS,
    COMPANY_INVOICE_EMAIL_KEY: actual.COMPANY_INVOICE_EMAIL_KEY,
    isInvoiceSellerSettingKey: actual.isInvoiceSellerSettingKey,
    normalizeInvoiceSellerSetting: actual.normalizeInvoiceSellerSetting,
    COMPANY_BIC_KEY: actual.COMPANY_BIC_KEY,
    COMPANY_IBAN_KEY: actual.COMPANY_IBAN_KEY,
    INVOICE_EPC_QR_ENABLED_KEY: actual.INVOICE_EPC_QR_ENABLED_KEY,
    INVOICE_PAYMENT_MAX_LENGTHS: actual.INVOICE_PAYMENT_MAX_LENGTHS,
    isInvoicePaymentSettingKey: actual.isInvoicePaymentSettingKey,
    normalizeInvoicePaymentSetting: actual.normalizeInvoicePaymentSetting,
  };
});

const mockConfig = vi.hoisted(() => ({
  SETTINGS_ENCRYPTION_KEY: 'test-encryption-key-32chars!!!!!!',
  COOKIE_DOMAIN: undefined as string | undefined,
  JWT_SECRET: 'test-secret',
  NODE_ENV: 'test',
  CSMS_URL: 'http://localhost',
  PORTAL_URL: 'http://localhost:5174',
}));

vi.mock('../lib/config.js', () => ({
  config: mockConfig,
}));

const { mockClearObjectStorageCache, mockGetObjectStorage } = vi.hoisted(() => ({
  mockClearObjectStorageCache: vi.fn(),
  mockGetObjectStorage: vi.fn(),
}));

vi.mock('../services/storage.service.js', () => ({
  clearObjectStorageCache: mockClearObjectStorageCache,
  getObjectStorage: mockGetObjectStorage,
}));

// The fresh proof itself has its own tests (session-proof, mfa-factor-proof).
const proofState = vi.hoisted(() => ({ calls: 0, apiKey: false }));
vi.mock('../lib/mfa-factor-proof.js', async () => {
  const { z } = await import('zod');
  return { factorProof: z.object({ kind: z.string() }).loose() };
});
vi.mock('../lib/session-proof.js', () => ({
  sessionProofErrorFields: {},
  SESSION_PROOF_ERROR_CODES: ['VALIDATION_ERROR', 'INVALID_PASSWORD'],
  isApiKeyRequest: () => proofState.apiKey,
  requireSessionProof: async (
    _request: unknown,
    reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    proof: unknown,
  ) => {
    proofState.calls += 1;
    if (proof != null) return true;
    await reply
      .status(400)
      .send({ error: 'Proof required', code: 'VALIDATION_ERROR', proofKinds: ['password'] });
    return false;
  },
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

const { mockAssertWritable } = vi.hoisted(() => ({ mockAssertWritable: vi.fn() }));
vi.mock('@evtivity/services/station-message.service', () => ({
  requestStationMessageRepush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/provider-switch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/provider-switch.js')>()),
  assertPaymentProviderWritable: mockAssertWritable,
}));

import { PaymentProviderUpgradePendingError } from '@evtivity/payments';
import { registerAuth } from '../plugins/auth.js';
import { settingsRoutes } from '../routes/settings.js';
import { db } from '@evtivity/database';
import { clearPaymentCaches } from '../lib/payments.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  settingsRoutes(app);
  await app.ready();
  return app;
}

// Imported once, not in the first test: loading the module graph can exceed the 5 s test timeout under load.
let libModule: typeof import('@evtivity/lib');
beforeAll(async () => {
  libModule = await import('@evtivity/lib');
}, 30_000);

describe('Settings routes - full coverage', () => {
  let app: FastifyInstance;
  let operatorToken: string;

  beforeAll(async () => {
    app = await buildApp();
    operatorToken = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.clearAllMocks();
  });

  // ----------------------------------------------------------------
  // GET /v1/portal/content/:type (public legal content)
  // ----------------------------------------------------------------
  describe('GET /v1/portal/content/:type', () => {
    it('returns stored content for a Korean request', async () => {
      setupDbResults([{ key: 'content.privacyPolicy.ko', value: '<h1>Custom KO</h1>' }]);
      const res = await app.inject({
        method: 'GET',
        url: '/portal/content/privacy-policy?lang=ko',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().html).toBe('<h1>Custom KO</h1>');
    });

    it('falls back to the Korean default when nothing is stored', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/portal/content/terms-of-service?lang=ko',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().html).toContain('<h1>서비스 이용약관</h1>');
    });

    it('falls back to the Traditional Chinese default for zh-TW', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/portal/content/privacy-policy?lang=zh-TW',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().html).toContain('<h1>隱私權政策</h1>');
    });

    it('defaults to English without a lang parameter', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url: '/portal/content/privacy-policy' });
      expect(res.statusCode).toBe(200);
      expect(res.json().html).toContain('<h1>Privacy Policy</h1>');
    });

    it('rejects an unsupported language', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/portal/content/privacy-policy?lang=fr',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ----------------------------------------------------------------
  // GET /v1/portal/branding (public, no auth required)
  // ----------------------------------------------------------------
  describe('GET /v1/portal/branding', () => {
    it('returns branding settings with short keys', async () => {
      setupDbResults([
        { key: 'company.name', value: 'Acme Charging' },
        { key: 'company.logo', value: 'https://example.com/logo.png' },
      ]);
      const res = await app.inject({ method: 'GET', url: '/portal/branding' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('Acme Charging');
      expect(body.logo).toBe('https://example.com/logo.png');
    });

    it('returns only the defaults and the portal URL when no company settings exist', async () => {
      const { config } = await import('../lib/config.js');
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url: '/portal/branding' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        currency: 'USD',
        priceDisplay: 'net',
        taxBasis: 'net',
        portalUrl: config.PORTAL_URL,
      });
    });

    it('returns the QR code icon as qrCodeIcon', async () => {
      setupDbResults([
        { key: 'company.name', value: 'Acme Charging' },
        { key: 'qr_code_icon', value: '<svg/>' },
      ]);
      const res = await app.inject({ method: 'GET', url: '/portal/branding' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.qrCodeIcon).toBe('<svg/>');
      expect(body.name).toBe('Acme Charging');
      expect(body).not.toHaveProperty('qr_code_icon');
    });

    it('converts non-string values to empty string', async () => {
      setupDbResults([
        { key: 'company.theme', value: 123 },
        { key: 'company.active', value: true },
      ]);
      const res = await app.inject({ method: 'GET', url: '/portal/branding' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.theme).toBe('');
      expect(body.active).toBe('');
    });

    it('works without auth token (public endpoint)', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url: '/portal/branding' });
      expect(res.statusCode).toBe(200);
    });
  });

  // ----------------------------------------------------------------
  // GET /v1/settings (authenticated, list all)
  // ----------------------------------------------------------------
  describe('GET /v1/settings', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/settings' });
      expect(res.statusCode).toBe(401);
    });

    it('returns all settings as key-value map', async () => {
      setupDbResults([
        { key: 'smtp.host', value: 'mail.example.com' },
        { key: 'smtp.port', value: 587 },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body['smtp.host']).toBe('mail.example.com');
      expect(body['smtp.port']).toBe(587);
    });

    it('returns empty object when no settings exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
    });
  });

  // ----------------------------------------------------------------
  // GET /v1/settings/:key (authenticated, single setting)
  // ----------------------------------------------------------------
  describe('GET /v1/settings/:key', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/settings/smtp.host' });
      expect(res.statusCode).toBe(401);
    });

    it('returns a setting by key', async () => {
      setupDbResults([{ key: 'smtp.host', value: 'mail.example.com' }]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/smtp.host',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.key).toBe('smtp.host');
      expect(body.value).toBe('mail.example.com');
    });

    it('returns 404 when setting not found', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/nonexistent',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Setting not found');
      expect(body.code).toBe('SETTING_NOT_FOUND');
    });
  });

  // ----------------------------------------------------------------
  // PATCH /v1/settings/:key (authenticated, update existing)
  // ----------------------------------------------------------------
  describe('PATCH /v1/settings/:key', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/smtp.host',
        payload: { value: 'new-host' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('updates a setting and returns the updated row', async () => {
      // 1: before SELECT, 2: UPDATE returning
      setupDbResults(
        [{ key: 'smtp.host', value: 'old-host' }],
        [{ key: 'smtp.host', value: '"new-host"' }],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/smtp.host',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { value: 'new-host' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.key).toBe('smtp.host');
    });

    it('returns 404 when updating a nonexistent setting', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/nonexistent',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { value: 'anything' },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Setting not found');
      expect(body.code).toBe('SETTING_NOT_FOUND');
    });

    it('handles non-string value (object)', async () => {
      // 1: before SELECT, 2: UPDATE returning
      setupDbResults(
        [{ key: 'app.config', value: '{}' }],
        [{ key: 'app.config', value: '{"debug":true}' }],
      );
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings/app.config',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { value: { debug: true } },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ----------------------------------------------------------------
  // PUT /v1/settings/:key (authenticated, upsert)
  // ----------------------------------------------------------------
  describe('PUT /v1/settings/:key', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/new.key',
        payload: { value: 'hello' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('upserts a setting and returns the row', async () => {
      // 1: before SELECT, 2: INSERT...returning
      setupDbResults([], [{ key: 'new.key', value: '"hello"' }]);
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/new.key',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { value: 'hello' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.key).toBe('new.key');
      expect(clearPaymentCaches).not.toHaveBeenCalled();
    });

    it('clears the payment caches after writing a payment setting', async () => {
      setupDbResults([], [{ key: 'payments.provider', value: 'adyen' }]);
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/payments.provider',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { value: 'adyen' },
      });
      expect(res.statusCode).toBe(200);
      expect(clearPaymentCaches).toHaveBeenCalledTimes(1);
    });

    it.each(['PUT', 'PATCH'] as const)(
      '%s answers 409 and writes nothing while the provider-switch guard refuses',
      async (method) => {
        const details = {
          legacyConnections: 1,
          hosts: ['172.18.0.5'],
          lastLegacySeenAt: null,
          watchCheckedAt: null,
        };
        mockAssertWritable.mockRejectedValueOnce(
          new PaymentProviderUpgradePendingError('adyen', details),
        );
        setupDbResults([], [{ key: 'payments.provider', value: 'adyen' }]);
        const res = await app.inject({
          method,
          url: '/settings/payments.provider',
          headers: { authorization: `Bearer ${operatorToken}` },
          payload: { value: 'adyen' },
        });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({
          error:
            'A process older than v0.1.38 is still connected. Finish the upgrade, then select Adyen.',
          code: 'PAYMENT_PROVIDER_UPGRADE_PENDING',
          details,
        });
        expect(mockAssertWritable).toHaveBeenCalledWith('payments.provider', 'adyen');
        expect(dbCallIndex).toBe(0);
        expect(clearPaymentCaches).not.toHaveBeenCalled();
      },
    );

    it('passes a failed guard check on as 500', async () => {
      mockAssertWritable.mockRejectedValueOnce(new Error('redis down'));
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/payments.provider',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { value: 'adyen' },
      });
      expect(res.statusCode).toBe(500);
      expect(dbCallIndex).toBe(0);
    });

    it('does not clear the payment caches when the write fails', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/stripe.publishableKey',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { value: 'pk_test_1' },
      });
      expect(res.statusCode).toBe(500);
      expect(clearPaymentCaches).not.toHaveBeenCalled();
    });

    it('throws when insert returns no rows', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/new.key',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { value: 'hello' },
      });
      expect(res.statusCode).toBe(500);
    });
  });

  // ----------------------------------------------------------------
  // DELETE /v1/settings/:key (authenticated)
  // ----------------------------------------------------------------
  describe('DELETE /v1/settings/:key', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/settings/old.key',
      });
      expect(res.statusCode).toBe(401);
    });

    it('deletes a setting and returns it', async () => {
      setupDbResults([{ key: 'old.key', value: '"bye"' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/settings/old.key',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.key).toBe('old.key');
    });

    it('clears the payment caches after deleting a payment setting', async () => {
      setupDbResults([{ key: 'simulated.resultMode', value: 'approve' }]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/settings/simulated.resultMode',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(clearPaymentCaches).toHaveBeenCalledTimes(1);
    });

    it('returns 404 when deleting a nonexistent setting', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/settings/nonexistent',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe('Setting not found');
      expect(body.code).toBe('SETTING_NOT_FOUND');
    });
  });

  // ----------------------------------------------------------------
  // GET /v1/settings/s3/status (authenticated)
  // ----------------------------------------------------------------
  describe('GET /v1/settings/s3/status', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/settings/s3/status' });
      expect(res.statusCode).toBe(401);
    });

    it('returns configured: true when all s3 keys are present and non-empty', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-key-id' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(true);
    });

    it('returns configured: false when bucket is missing', async () => {
      setupDbResults([
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-key-id' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
    });

    it('returns configured: false when region is empty string', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: '' },
        { key: 's3.accessKeyIdEnc', value: 'enc-key-id' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
    });

    it('returns configured: false when accessKeyIdEnc is missing', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
    });

    it('returns configured: false when secretAccessKeyEnc is empty', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-key-id' },
        { key: 's3.secretAccessKeyEnc', value: '' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
    });

    it('returns configured: false when no s3 settings exist', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
    });

    it('returns configured: false for an S3-compatible provider without an endpoint', async () => {
      setupDbResults([
        { key: 's3.provider', value: 's3-compatible' },
        { key: 's3.endpoint', value: '' },
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-key-id' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
    });

    it('returns configured: true for an S3-compatible provider with an endpoint', async () => {
      setupDbResults([
        { key: 's3.provider', value: 's3-compatible' },
        { key: 's3.endpoint', value: 'https://storage.example.com' },
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-key-id' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(true);
    });

    it('ignores non-s3 settings in the result set', async () => {
      setupDbResults([
        { key: 'smtp.host', value: 'mail.example.com' },
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-key-id' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(true);
    });

    it('returns configured: false when bucket is empty string', async () => {
      setupDbResults([
        { key: 's3.bucket', value: '' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: 'enc-key-id' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
    });

    it('returns configured: false when accessKeyIdEnc is empty string', async () => {
      setupDbResults([
        { key: 's3.bucket', value: 'my-bucket' },
        { key: 's3.region', value: 'us-east-1' },
        { key: 's3.accessKeyIdEnc', value: '' },
        { key: 's3.secretAccessKeyEnc', value: 'enc-secret' },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/s3/status',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // PUT /v1/settings/s3 (authenticated, save S3 settings)
  // ----------------------------------------------------------------
  describe('PUT /v1/settings/s3', () => {
    const s3Body = {
      bucket: 'my-bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIA123',
      secretAccessKey: 'secret123',
    };

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/s3',
        payload: s3Body,
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 500 when SETTINGS_ENCRYPTION_KEY is not set', async () => {
      const original = mockConfig.SETTINGS_ENCRYPTION_KEY;
      mockConfig.SETTINGS_ENCRYPTION_KEY = '';

      // Need 4 db results for the 4 upserts in Promise.all, but we return before that
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/s3',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: s3Body,
      });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.error).toBe('SETTINGS_ENCRYPTION_KEY not configured on server');
      expect(body.code).toBe('ENCRYPTION_KEY_MISSING');

      mockConfig.SETTINGS_ENCRYPTION_KEY = original;
    });

    it('returns 500 when SETTINGS_ENCRYPTION_KEY is empty string', async () => {
      const original = mockConfig.SETTINGS_ENCRYPTION_KEY;
      mockConfig.SETTINGS_ENCRYPTION_KEY = '';

      const res = await app.inject({
        method: 'PUT',
        url: '/settings/s3',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: s3Body,
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe('ENCRYPTION_KEY_MISSING');

      mockConfig.SETTINGS_ENCRYPTION_KEY = original;
    });

    it('saves S3 settings, encrypts credentials, clears cache', async () => {
      const original = mockConfig.SETTINGS_ENCRYPTION_KEY;
      mockConfig.SETTINGS_ENCRYPTION_KEY = 'test-encryption-key-32chars!!!!!';

      // 1 SELECT for the before-snapshot, 4 upserts (bucket, region,
      // accessKeyIdEnc, secretAccessKeyEnc), then 4 parallel audit inserts
      // via Promise.allSettled.
      setupDbResults([], [], [], [], [], [], [], [], []);

      const res = await app.inject({
        method: 'PUT',
        url: '/settings/s3',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: s3Body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const { encryptString } = libModule;
      expect(encryptString).toHaveBeenCalledWith('AKIA123', 'test-encryption-key-32chars!!!!!');
      expect(encryptString).toHaveBeenCalledWith('secret123', 'test-encryption-key-32chars!!!!!');
      expect(mockClearObjectStorageCache).toHaveBeenCalled();

      mockConfig.SETTINGS_ENCRYPTION_KEY = original;
    });

    it('rejects request with missing required fields', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/s3',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { bucket: 'my-bucket' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects request with empty bucket', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/s3',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { ...s3Body, bucket: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    /** The settings the route upserted, by key (the audit rows are left out). */
    function upserted(): Record<string, unknown> {
      const written: Record<string, unknown> = {};
      for (const result of vi.mocked(db.insert).mock.results) {
        const chain = result.value as { values: ReturnType<typeof vi.fn> };
        for (const [row] of chain.values.mock.calls as Array<[Record<string, unknown>]>) {
          if (typeof row['key'] === 'string' && 'value' in row) written[row['key']] = row['value'];
        }
      }
      return written;
    }

    function putS3(payload: Record<string, unknown>) {
      return app.inject({
        method: 'PUT',
        url: '/settings/s3',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { ...s3Body, ...payload },
      });
    }

    const PROOF = { kind: 'password', password: 'current-password' };

    it('saves an S3-compatible endpoint with path-style addressing', async () => {
      const res = await putS3({
        proof: PROOF,
        provider: 's3-compatible',
        endpoint: 'https://s3.wasabisys.com/',
        forcePathStyle: true,
      });
      expect(res.statusCode).toBe(200);
      expect(upserted()).toMatchObject({
        's3.provider': 's3-compatible',
        's3.endpoint': 'https://s3.wasabisys.com',
        's3.forcePathStyle': true,
        's3.allowedPrivateHosts': [],
        's3.bucket': 'my-bucket',
      });
      expect(mockClearObjectStorageCache).toHaveBeenCalled();
    });

    it('saves a private endpoint whose host is on the allowlist', async () => {
      const res = await putS3({
        proof: PROOF,
        provider: 's3-compatible',
        endpoint: 'http://minio.internal:9000',
        allowedPrivateHosts: [' MinIO.internal '],
      });
      expect(res.statusCode).toBe(200);
      expect(upserted()).toMatchObject({
        's3.endpoint': 'http://minio.internal:9000',
        's3.forcePathStyle': false,
        's3.allowedPrivateHosts': ['minio.internal'],
      });
    });

    it.each([
      ['a private host', 'https://10.0.0.5:9000'],
      ['an internal name', 'https://minio.internal'],
      ['localhost', 'http://localhost:9000'],
      ['plain http on a public host', 'http://storage.example.com'],
      ['a path', 'https://storage.example.com/bucket'],
      ['credentials', 'https://user:pass@storage.example.com'],
      ['no endpoint', undefined],
    ])('refuses %s as the endpoint and writes nothing', async (_name, endpoint) => {
      const res = await putS3({ provider: 's3-compatible', endpoint });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('PRIVATE_URL');
      expect(db.insert).not.toHaveBeenCalled();
      expect(mockClearObjectStorageCache).not.toHaveBeenCalled();
    });

    it('refuses an invalid allowlist', async () => {
      const res = await putS3({
        provider: 's3-compatible',
        endpoint: 'http://minio.internal:9000',
        allowedPrivateHosts: ['http://minio.internal:9000'],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', field: 'allowedPrivateHosts' });
      expect(db.insert).not.toHaveBeenCalled();
    });

    describe('unroutable addresses (security review case 278)', () => {
      it.each(['169.254.169.254', 'fd00:ec2::254', 'fe80::1', '0.0.0.0'])(
        'refuses %s on the allowlist and writes nothing',
        async (host) => {
          const literal = host.includes(':') ? `[${host}]` : host;
          const res = await putS3({
            proof: PROOF,
            provider: 's3-compatible',
            endpoint: `http://${literal}`,
            allowedPrivateHosts: [host],
          });
          expect(res.statusCode).toBe(400);
          expect(res.json()).toMatchObject({
            code: 'VALIDATION_ERROR',
            field: 'allowedPrivateHosts',
          });
          expect(db.insert).not.toHaveBeenCalled();
          expect(mockClearObjectStorageCache).not.toHaveBeenCalled();
        },
      );

      it('refuses a cloud metadata endpoint that is not listed', async () => {
        const res = await putS3({
          proof: PROOF,
          provider: 's3-compatible',
          endpoint: 'http://169.254.169.254',
          allowedPrivateHosts: ['minio.internal'],
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('PRIVATE_URL');
        expect(db.insert).not.toHaveBeenCalled();
      });
    });

    describe('fresh proof for the provider and endpoint (security review case 280)', () => {
      beforeEach(() => {
        proofState.calls = 0;
        proofState.apiKey = false;
      });

      afterAll(() => {
        proofState.apiKey = false;
      });

      it('asks a session for the proof when it switches to S3-compatible, and writes nothing', async () => {
        const res = await putS3({
          provider: 's3-compatible',
          endpoint: 'https://s3.wasabisys.com',
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR', proofKinds: ['password'] });
        expect(proofState.calls).toBe(1);
        expect(db.insert).not.toHaveBeenCalled();
        expect(mockClearObjectStorageCache).not.toHaveBeenCalled();
      });

      it('asks for the proof when only the endpoint changes', async () => {
        setupDbResults([
          { key: 's3.provider', value: 's3-compatible' },
          { key: 's3.endpoint', value: 'https://s3.wasabisys.com' },
        ]);
        const res = await putS3({
          provider: 's3-compatible',
          endpoint: 'https://s3.eu-central-1.wasabisys.com',
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().proofKinds).toEqual(['password']);
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('asks for the proof when switching back to AWS S3', async () => {
        setupDbResults([
          { key: 's3.provider', value: 's3-compatible' },
          { key: 's3.endpoint', value: 'https://s3.wasabisys.com' },
        ]);
        const res = await putS3({});
        expect(res.statusCode).toBe(400);
        expect(res.json().proofKinds).toEqual(['password']);
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('saves without a proof when the provider and endpoint stay', async () => {
        setupDbResults([
          { key: 's3.provider', value: 's3-compatible' },
          { key: 's3.endpoint', value: 'https://s3.wasabisys.com' },
        ]);
        const res = await putS3({
          provider: 's3-compatible',
          endpoint: 'https://s3.wasabisys.com/',
          forcePathStyle: true,
          bucket: 'other-bucket',
        });
        expect(res.statusCode).toBe(200);
        expect(proofState.calls).toBe(0);
        expect(upserted()['s3.bucket']).toBe('other-bucket');
      });

      it('saves AWS S3 again without a proof', async () => {
        const res = await putS3({ region: 'eu-west-1' });
        expect(res.statusCode).toBe(200);
        expect(proofState.calls).toBe(0);
      });

      it('refuses an API key that changes the provider or endpoint, with no proof asked', async () => {
        proofState.apiKey = true;
        const res = await putS3({
          proof: PROOF,
          provider: 's3-compatible',
          endpoint: 'https://s3.wasabisys.com',
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('SESSION_REQUIRED');
        expect(proofState.calls).toBe(0);
        expect(db.insert).not.toHaveBeenCalled();
        expect(mockClearObjectStorageCache).not.toHaveBeenCalled();
      });

      it('lets an API key save the bucket and keys while the provider and endpoint stay', async () => {
        proofState.apiKey = true;
        const res = await putS3({ bucket: 'rotated-bucket', accessKeyId: 'AKIA999' });
        expect(res.statusCode).toBe(200);
        expect(proofState.calls).toBe(0);
        expect(upserted()['s3.bucket']).toBe('rotated-bucket');
      });
    });

    it('refuses an unknown provider', async () => {
      const res = await putS3({ provider: 'ftp' });
      expect(res.statusCode).toBe(400);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('clears the endpoint settings for AWS S3', async () => {
      const res = await putS3({
        endpoint: 'https://storage.example.com',
        forcePathStyle: true,
        allowedPrivateHosts: ['minio.internal'],
      });
      expect(res.statusCode).toBe(200);
      expect(upserted()).toMatchObject({
        's3.provider': 's3',
        's3.endpoint': '',
        's3.forcePathStyle': false,
        's3.allowedPrivateHosts': [],
      });
    });
  });

  describe('storage endpoint settings through the generic routes', () => {
    it.each([
      ['PATCH', 's3.endpoint', 'http://10.0.0.5:9000'],
      ['PUT', 's3.endpoint', 'https://storage.example.com'],
      ['PUT', 's3.allowedPrivateHosts', ['10.0.0.5']],
      ['PUT', 's3.provider', 's3-compatible'],
      ['PATCH', 's3.forcePathStyle', true],
    ] as const)('%s %s is refused', async (method, key, value) => {
      setupDbResults([{ key, value: '' }], [{ key, value }]);
      const res = await app.inject({
        method,
        url: `/settings/${key}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { value },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'The storage provider and endpoint are written through PUT /v1/settings/s3',
        code: 'VALIDATION_ERROR',
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // POST /v1/settings/s3/test (authenticated, test S3 connection)
  // ----------------------------------------------------------------
  describe('webhook signing secret', () => {
    const url = '/settings/notifications/webhook-signing-secret';

    it('refuses to generate a secret without SETTINGS_ENCRYPTION_KEY and stores nothing', async () => {
      const { db } = await import('@evtivity/database');
      const original = mockConfig.SETTINGS_ENCRYPTION_KEY;
      mockConfig.SETTINGS_ENCRYPTION_KEY = '';
      try {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toMatchObject({ code: 'ENCRYPTION_KEY_MISSING' });
        expect(res.body).not.toContain('whsec_');
        expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
      } finally {
        mockConfig.SETTINGS_ENCRYPTION_KEY = original;
      }
    });

    it('reports configured only when the stored value decrypts under the current key', async () => {
      const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
      const good = actual.encryptString('whsec_abc', mockConfig.SETTINGS_ENCRYPTION_KEY);
      const otherKey = actual.encryptString('whsec_abc', 'another-key-of-thirty-two-chars!!');
      const status = async (rows: unknown[]): Promise<unknown> => {
        setupDbResults(rows);
        const res = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        return res.json();
      };
      expect(await status([{ value: good }])).toEqual({ configured: true });
      expect(await status([{ value: otherKey }])).toEqual({ configured: false });
      expect(await status([{ value: 'not-a-ciphertext' }])).toEqual({ configured: false });
      expect(await status([{ value: '' }])).toEqual({ configured: false });
      expect(await status([])).toEqual({ configured: false });
    });
  });

  describe('POST /v1/settings/s3/test', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'POST', url: '/settings/s3/test' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when S3 is not configured', async () => {
      mockGetObjectStorage.mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'POST',
        url: '/settings/s3/test',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('S3 not configured');
      expect(body.code).toBe('STORAGE_NOT_CONFIGURED');
    });

    it('returns success when S3 connection works', async () => {
      const mockTestConnection = vi.fn().mockResolvedValueOnce(undefined);
      mockGetObjectStorage.mockResolvedValueOnce({
        bucket: 'test-bucket',
        testConnection: mockTestConnection,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/settings/s3/test',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('returns 400 with error message when S3 connection fails (Error instance)', async () => {
      const mockTestConnection = vi.fn().mockRejectedValueOnce(new Error('Access Denied'));
      mockGetObjectStorage.mockResolvedValueOnce({
        bucket: 'test-bucket',
        testConnection: mockTestConnection,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/settings/s3/test',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(400);
      // The provider message can name internal hosts: it stays in the log (case 279).
      expect(res.json()).toEqual({
        error: 'Storage connection failed',
        code: 'STORAGE_CONNECTION_FAILED',
      });
    });

    it('never returns the provider error, which can name internal addresses', async () => {
      const mockTestConnection = vi
        .fn()
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:9000 minio.internal'));
      mockGetObjectStorage.mockResolvedValueOnce({
        bucket: 'test-bucket',
        testConnection: mockTestConnection,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/settings/s3/test',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('10.0.0.5');
      expect(res.body).not.toContain('minio.internal');
    });

    it('returns the constant message when S3 throws non-Error', async () => {
      const mockTestConnection = vi.fn().mockRejectedValueOnce('string-error');
      mockGetObjectStorage.mockResolvedValueOnce({
        bucket: 'test-bucket',
        testConnection: mockTestConnection,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/settings/s3/test',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Storage connection failed',
        code: 'STORAGE_CONNECTION_FAILED',
      });
    });
  });
});
