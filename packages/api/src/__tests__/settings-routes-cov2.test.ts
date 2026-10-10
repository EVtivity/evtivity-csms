// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { state, rec, mocks } = vi.hoisted(() => ({
  state: { results: [] as unknown[][], index: 0 },
  rec: { values: [] as unknown[], deletes: 0 },
  mocks: {
    publish: vi.fn(),
    writeAudit: vi.fn(),
    clearWebhookSettingsCache: vi.fn(),
    clearNotificationSettingsCache: vi.fn(),
    assertWritable: vi.fn(),
    isReservationEnabled: vi.fn(),
    isSupportEnabled: vi.fn(),
    isRoamingEnabled: vi.fn(),
    isPncEnabled: vi.fn(),
    isFleetEnabled: vi.fn(),
    isGuestChargingEnabled: vi.fn(),
    isChatbotAiEnabled: vi.fn(),
    clearRoamingCache: vi.fn(),
    clearSupportCache: vi.fn(),
    clearFleetCache: vi.fn(),
    clearGuestChargingCache: vi.fn(),
    clearPncSettingsCache: vi.fn(),
    clearAiSettingsCache: vi.fn(),
    getReservationSettings: vi.fn(),
    clearS3ConfigCache: vi.fn(),
  },
}));

function setupDbResults(...results: unknown[][]): void {
  state.results = results;
  state.index = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'returning', 'set', 'onConflictDoUpdate']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['values'] = vi.fn((v: unknown) => {
    rec.values.push(v);
    return chain;
  });
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = state.results[state.index] ?? [];
      state.index++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  return chain;
}

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

vi.mock('@evtivity/database', () => ({
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  getCompanyTaxBasis: vi.fn(() => Promise.resolve('net')),
  getCompanyPriceDisplay: vi.fn(() => Promise.resolve('net')),
  getReservationSettings: mocks.getReservationSettings,
  isReservationEnabled: mocks.isReservationEnabled,
  isSupportEnabled: mocks.isSupportEnabled,
  isRoamingEnabled: mocks.isRoamingEnabled,
  isPncEnabled: mocks.isPncEnabled,
  isFleetEnabled: mocks.isFleetEnabled,
  isGuestChargingEnabled: mocks.isGuestChargingEnabled,
  isChatbotAiEnabled: mocks.isChatbotAiEnabled,
  clearRoamingCache: mocks.clearRoamingCache,
  clearSupportCache: mocks.clearSupportCache,
  clearFleetCache: mocks.clearFleetCache,
  clearGuestChargingCache: mocks.clearGuestChargingCache,
  clearPncSettingsCache: mocks.clearPncSettingsCache,
  clearAiSettingsCache: mocks.clearAiSettingsCache,
  clearSystemSettingsCache: vi.fn(),
  clearMobileAppConfigCache: vi.fn(),
  clearStationMessageSettingsCache: vi.fn(),
  invalidateReservationSettingsCache: vi.fn(),
  clearWebhookSettingsCache: mocks.clearWebhookSettingsCache,
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
    delete: vi.fn(() => {
      rec.deletes++;
      return makeChain();
    }),
  },
  settings: { key: 'settings.key' },
  writeAudit: mocks.writeAudit,
  settingAuditLog: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  like: vi.fn(),
  or: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@evtivity/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/lib')>()),
  encryptString: vi.fn(() => 'encrypted-value'),
  clearNotificationSettingsCache: mocks.clearNotificationSettingsCache,
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: mocks.publish }),
}));

vi.mock('../lib/config.js', () => ({
  config: {
    SETTINGS_ENCRYPTION_KEY: 'test-encryption-key-32chars!!!!!!',
    JWT_SECRET: 'test-secret',
    NODE_ENV: 'test',
    CSMS_URL: 'http://localhost',
    PORTAL_URL: 'http://localhost:5174',
  },
}));

vi.mock('../services/s3.service.js', () => ({
  clearS3ConfigCache: mocks.clearS3ConfigCache,
  getS3Config: vi.fn(),
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

vi.mock('../lib/provider-switch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/provider-switch.js')>()),
  assertPaymentProviderWritable: mocks.assertWritable,
}));

import { registerAuth } from '../plugins/auth.js';
import { settingsRoutes } from '../routes/settings.js';
import { defaultSystemPrompt } from '../services/ai/engine/prompt-defaults.js';
import { resetSiteAccessMock, setMockUserSiteIds } from './helpers/site-access-mock.js';

const HOSTS_KEY = 'notifications.webhookAllowedPrivateHosts';
const SERVER_MANAGED = {
  error: 'This setting is managed by the CSMS and cannot be written directly',
  code: 'VALIDATION_ERROR',
};

describe('settings routes (cov2)', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    settingsRoutes(app);
    await app.ready();
    auth = {
      authorization: `Bearer ${app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_1' })}`,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    rec.values.length = 0;
    rec.deletes = 0;
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.publish.mockResolvedValue(undefined);
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.assertWritable.mockResolvedValue(undefined);
  });

  it('GET /portal/features answers the public feature flags and reservation limits', async () => {
    mocks.isReservationEnabled.mockResolvedValue(true);
    mocks.isSupportEnabled.mockResolvedValue(false);
    mocks.isRoamingEnabled.mockResolvedValue(true);
    mocks.isPncEnabled.mockResolvedValue(false);
    mocks.isFleetEnabled.mockResolvedValue(true);
    mocks.isGuestChargingEnabled.mockResolvedValue(false);
    mocks.isChatbotAiEnabled.mockResolvedValue(true);
    mocks.getReservationSettings.mockResolvedValue({
      cancellationFeeCents: 250,
      cancellationWindowMinutes: 15,
      maxHours: 4,
    });
    const res = await app.inject({ method: 'GET', url: '/portal/features' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reservationEnabled: true,
      supportEnabled: false,
      roamingEnabled: true,
      pncEnabled: false,
      fleetEnabled: true,
      guestChargingEnabled: false,
      chatbotAiEnabled: true,
      reservationCancellationFeeCents: 250,
      reservationCancellationWindowMinutes: 15,
      reservationMaxHours: 4,
      currency: 'EUR',
    });
  });

  it('GET /settings leaves out server-managed settings', async () => {
    setupDbResults([
      { key: 'company.name', value: 'Acme' },
      { key: 'pnc.local.caEnc', value: 'secret-ca' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/settings', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ 'company.name': 'Acme' });
  });

  it('GET /settings leaves out the SSO and security settings', async () => {
    setupDbResults([
      { key: 'company.name', value: 'Acme' },
      { key: 'security.recaptcha.secretKeyEnc', value: '' },
      { key: 'sso.entryPoint', value: 'https://idp.example.com' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/settings', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ 'company.name': 'Acme' });
  });

  it.each(['security.mfa.emailEnabled', 'sso.certEnc'])(
    'refuses the SSO and security setting %s on the generic routes',
    async (key) => {
      const get = await app.inject({ method: 'GET', url: `/settings/${key}`, headers: auth });
      expect(get.statusCode).toBe(404);
      for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
        const res = await app.inject({
          method,
          url: `/settings/${key}`,
          headers: auth,
          ...(method === 'DELETE' ? {} : { payload: { value: false } }),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_ERROR');
      }
      expect(rec.values).toEqual([]);
      expect(rec.deletes).toBe(0);
    },
  );

  describe('site-restricted user', () => {
    beforeEach(() => {
      setMockUserSiteIds(['sit_000000000001']);
    });
    afterEach(() => {
      resetSiteAccessMock();
    });

    it('GET /settings returns only the allowlisted keys, never a secret', async () => {
      setupDbResults([
        { key: 'company.name', value: 'Acme' },
        { key: 'stripe.secretKeyEnc', value: 'enc' },
        { key: 'smtp.passwordEnc', value: 'enc' },
        { key: 'payments.provider', value: 'stripe' },
        { key: 'prepaid.lowCreditThresholdCents', value: 500 },
        { key: 'invoice.paymentTermsDays', value: 30 },
        { key: 'fleet.invoiceRunDay', value: 1 },
      ]);
      const res = await app.inject({ method: 'GET', url: '/settings', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        'prepaid.lowCreditThresholdCents': 500,
        'invoice.paymentTermsDays': 30,
        'fleet.invoiceRunDay': 1,
      });
    });

    it('reads an allowlisted key but cannot write it (company-wide)', async () => {
      setupDbResults([{ key: 'invoice.paymentTermsDays', value: 30 }]);
      const get = await app.inject({
        method: 'GET',
        url: '/settings/invoice.paymentTermsDays',
        headers: auth,
      });
      expect(get.statusCode).toBe(200);

      setupDbResults([], [{ key: 'invoice.paymentTermsDays', value: 14 }]);
      for (const method of ['PUT', 'PATCH'] as const) {
        const write = await app.inject({
          method,
          url: '/settings/invoice.paymentTermsDays',
          headers: auth,
          payload: { value: 14 },
        });
        expect(write.statusCode).toBe(404);
        expect(write.json()).toEqual({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
      }
      expect(state.index).toBe(0);
    });

    it('answers 404 for any other key without reading it', async () => {
      setupDbResults([{ key: 'stripe.secretKeyEnc', value: 'enc' }]);
      const res = await app.inject({
        method: 'GET',
        url: '/settings/stripe.secretKeyEnc',
        headers: auth,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
      expect(state.index).toBe(0);
    });
  });

  it('PUT refuses a server-managed setting', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/pnc.local.caEnc',
      headers: auth,
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(SERVER_MANAGED);
    expect(rec.values).toEqual([]);
  });

  it('DELETE refuses a server-managed setting', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/settings/pnc.local.caEnc',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(SERVER_MANAGED);
    expect(rec.deletes).toBe(0);
  });

  it.each([
    ['roaming.enabled', 'clearRoamingCache'],
    ['support.enabled', 'clearSupportCache'],
    ['fleet.enabled', 'clearFleetCache'],
    ['guest.enabled', 'clearGuestChargingCache'],
    ['pnc.enabled', 'clearPncSettingsCache'],
    ['chatbotAi.enabled', 'clearAiSettingsCache'],
  ] as const)('PUT %s clears its cached reader', async (key, clear) => {
    setupDbResults([], [{ key, value: false }]);
    const res = await app.inject({
      method: 'PUT',
      url: `/settings/${key}`,
      headers: auth,
      payload: { value: false },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks[clear]).toHaveBeenCalledTimes(1);
    for (const other of [
      'clearRoamingCache',
      'clearSupportCache',
      'clearFleetCache',
      'clearGuestChargingCache',
      'clearPncSettingsCache',
      'clearAiSettingsCache',
    ] as const) {
      if (other !== clear) expect(mocks[other]).not.toHaveBeenCalled();
    }
  });

  describe('AI settings (TC-AI-C-05, TC-AI-C-06)', () => {
    it.each([
      ['ai.openai.baseUrl', 'https://proxy.example.com/v1'],
      ['ai.rateLimit.userPerMinute', 30],
      ['chatbotAi.effort', 'low'],
      ['supportAi.provider', 'deepseek'],
    ] as const)('PUT %s stores the value and clears the AI settings cache', async (key, value) => {
      setupDbResults([], [{ key, value }]);
      const res = await app.inject({
        method: 'PUT',
        url: `/settings/${key}`,
        headers: auth,
        payload: { value },
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.clearAiSettingsCache).toHaveBeenCalledTimes(1);
    });

    it('stores a limit sent as a numeric string as a number', async () => {
      setupDbResults([], [{ key: 'ai.maxToolCallsPerTurn', value: 30 }]);
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/ai.maxToolCallsPerTurn',
        headers: auth,
        payload: { value: '30' },
      });
      expect(res.statusCode).toBe(200);
      expect(rec.values[0]).toEqual({ key: 'ai.maxToolCallsPerTurn', value: 30 });
    });

    it.each([
      ['chatbotAi.systemPrompt', 'chatbot', 'de'],
      ['supportAi.systemPrompt', 'support', 'zh-TW'],
    ] as const)(
      'PUT %s stores an unchanged built-in prompt as empty',
      async (key, surface, language) => {
        setupDbResults([], [{ key, value: '' }]);
        const res = await app.inject({
          method: 'PUT',
          url: `/settings/${key}`,
          headers: auth,
          payload: { value: `${defaultSystemPrompt(surface, language)}\n` },
        });
        expect(res.statusCode).toBe(200);
        expect(rec.values[0]).toEqual({ key, value: '' });
      },
    );

    it('PUT chatbotAi.systemPrompt keeps a custom prompt', async () => {
      setupDbResults([], [{ key: 'chatbotAi.systemPrompt', value: 'Be brief.' }]);
      await app.inject({
        method: 'PUT',
        url: '/settings/chatbotAi.systemPrompt',
        headers: auth,
        payload: { value: 'Be brief.' },
      });
      expect(rec.values[0]).toEqual({ key: 'chatbotAi.systemPrompt', value: 'Be brief.' });
    });

    it.each([
      ['https://10.0.0.5'],
      ['http://api.example.com'],
      ['https://user:pass@api.example.com'],
      ['https://localhost:4010'],
    ])('refuses the base URL %s with AI_BASE_URL_INVALID', async (url) => {
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/ai.anthropic.baseUrl',
        headers: auth,
        payload: { value: url },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'AI_BASE_URL_INVALID' });
      expect(rec.values).toEqual([]);
      expect(mocks.clearAiSettingsCache).not.toHaveBeenCalled();
    });

    it.each([
      ['chatbotAi.temperature', '0.5', 'chatbotAi.effort'],
      ['supportAi.topK', '10', 'supportAi.effort'],
      ['chatbotAi.apiKeyEnc', 'sk-old', 'ai.<provider>.apiKeyEnc'],
    ])('refuses the removed key %s and names its replacement', async (key, value, replacement) => {
      const res = await app.inject({
        method: 'PUT',
        url: `/settings/${key}`,
        headers: auth,
        payload: { value },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: `${key} was removed, use ${replacement}`,
        code: 'VALIDATION_ERROR',
      });
      expect(rec.values).toEqual([]);
    });

    it.each([
      ['chatbotAi.provider', 'mistral', 'must be one of'],
      ['supportAi.effort', 'max', 'must be one of: low, medium, high'],
      ['supportAi.tone', 'sarcastic', 'must be one of'],
      ['ai.maxToolCallsPerTurn', 0, 'must be a whole number from 1 to 100'],
      ['chatbotAi.enabled', 'yes', 'must be true or false'],
    ] as const)('refuses %s = %s', async (key, value, message) => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/settings/${key}`,
        headers: auth,
        payload: { value },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(res.json().error).toContain(message);
    });
  });

  describe('webhook allowed private hosts', () => {
    it('stores a valid host list and clears the webhook settings cache', async () => {
      const hosts = ['10.0.0.5', 'hooks.internal'];
      setupDbResults([], [{ key: HOSTS_KEY, value: hosts }]);
      const res = await app.inject({
        method: 'PUT',
        url: `/settings/${HOSTS_KEY}`,
        headers: auth,
        payload: { value: hosts },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ key: HOSTS_KEY, value: hosts });
      expect(rec.values[0]).toEqual({ key: HOSTS_KEY, value: hosts });
      expect(mocks.clearWebhookSettingsCache).toHaveBeenCalled();
    });

    it('refuses a host with a scheme', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/settings/${HOSTS_KEY}`,
        headers: auth,
        payload: { value: ['https://10.0.0.5'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(res.json().error).toContain(HOSTS_KEY);
      expect(rec.values).toEqual([]);
    });
  });

  describe('notification settings invalidation', () => {
    it('broadcasts a notification settings invalidation for system.timezone', async () => {
      setupDbResults([], [{ key: 'system.timezone', value: 'Europe/Berlin' }]);
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/system.timezone',
        headers: auth,
        payload: { value: 'Europe/Berlin' },
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.clearNotificationSettingsCache).toHaveBeenCalled();
      expect(mocks.publish).toHaveBeenCalledWith(
        'cache_invalidate',
        JSON.stringify({ kind: 'notification_settings' }),
      );
    });

    it('still saves when the broadcast fails', async () => {
      mocks.publish.mockRejectedValue(new Error('redis down'));
      setupDbResults([], [{ key: 'smtp.host', value: 'mail.example.com' }]);
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/smtp.host',
        headers: auth,
        payload: { value: 'mail.example.com' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ key: 'smtp.host', value: 'mail.example.com' });
    });

    it('does not broadcast for unrelated keys', async () => {
      setupDbResults([], [{ key: 'support.enabled', value: true }]);
      await app.inject({
        method: 'PUT',
        url: '/settings/support.enabled',
        headers: auth,
        payload: { value: true },
      });
      expect(mocks.publish).not.toHaveBeenCalled();
    });
  });

  it('PATCH answers 500 when the provider check fails for another reason', async () => {
    mocks.assertWritable.mockRejectedValue(new Error('db down'));
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/payments.provider',
      headers: auth,
      payload: { value: 'stripe' },
    });
    expect(res.statusCode).toBe(500);
    expect(state.index).toBe(0);
  });

  it('PUT /settings/s3 audits only the S3 values that changed', async () => {
    setupDbResults([
      { key: 's3.bucket', value: 'b1' },
      { key: 's3.region', value: 'us-east-1' },
      { key: 's3.accessKeyIdEnc', value: 'encrypted-value' },
    ]);
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/s3',
      headers: auth,
      payload: { bucket: 'b1', region: 'eu-west-1', accessKeyId: 'AK', secretAccessKey: 'SK' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mocks.clearS3ConfigCache).toHaveBeenCalled();
    const audited = mocks.writeAudit.mock.calls.map(
      (c) => (c[1] as { entityId: string; before: unknown }).entityId,
    );
    expect(audited.sort()).toEqual(['s3.region', 's3.secretAccessKeyEnc']);
    const regionAudit = mocks.writeAudit.mock.calls.find(
      (c) => (c[1] as { entityId: string }).entityId === 's3.region',
    )?.[1] as { before: unknown; after: unknown };
    expect(regionAudit.before).toEqual({ key: 's3.region', value: 'us-east-1' });
    expect(regionAudit.after).toEqual({ key: 's3.region', value: 'eu-west-1' });
  });
});
