// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
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
    isDriverRfidSelfServiceEnabled: vi.fn(),
    isRoamingEnabled: vi.fn(),
    isPncEnabled: vi.fn(),
    isFleetEnabled: vi.fn(),
    isFleetChargingEnabled: vi.fn(),
    isGuestChargingEnabled: vi.fn(),
    isPortalRegistrationEnabled: vi.fn(),
    isChatbotAiEnabled: vi.fn(),
    isAiInsightsEnabled: vi.fn(),
    clearRoamingCache: vi.fn(),
    clearSupportCache: vi.fn(),
    clearDriverRfidSelfServiceCache: vi.fn(),
    clearCsmsUpdateCheckSettingCache: vi.fn(),
    clearFleetCache: vi.fn(),
    clearFleetChargingSettingCache: vi.fn(),
    clearVdv463SettingCache: vi.fn(),
    clearGuestChargingCache: vi.fn(),
    clearPncSettingsCache: vi.fn(),
    clearAiSettingsCache: vi.fn(),
    getReservationSettings: vi.fn(),
    clearObjectStorageCache: vi.fn(),
    getObjectStorage: vi.fn(),
    readSimSettings: vi.fn(),
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

vi.mock('../lib/sim.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sim.js')>()),
  readSimSettings: mocks.readSimSettings,
}));

function simSettings(hologram: boolean, stationSignal: boolean): unknown {
  return {
    hologram: { enabled: hologram },
    '1nce': { enabled: false },
    stationSignalEnabled: stationSignal,
  };
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
  isDriverRfidSelfServiceEnabled: mocks.isDriverRfidSelfServiceEnabled,
  clearDriverRfidSelfServiceCache: mocks.clearDriverRfidSelfServiceCache,
  clearCsmsUpdateCheckSettingCache: mocks.clearCsmsUpdateCheckSettingCache,
  RFID_SELF_SERVICE_SETTING_KEY: 'portal.rfidSelfServiceEnabled',
  isRoamingEnabled: mocks.isRoamingEnabled,
  isPncEnabled: mocks.isPncEnabled,
  isFleetEnabled: mocks.isFleetEnabled,
  isFleetChargingEnabled: mocks.isFleetChargingEnabled,
  isGuestChargingEnabled: mocks.isGuestChargingEnabled,
  isPortalRegistrationEnabled: mocks.isPortalRegistrationEnabled,
  isChatbotAiEnabled: mocks.isChatbotAiEnabled,
  isAiInsightsEnabled: mocks.isAiInsightsEnabled,
  clearRoamingCache: mocks.clearRoamingCache,
  clearSupportCache: mocks.clearSupportCache,
  clearFleetCache: mocks.clearFleetCache,
  clearFleetChargingSettingCache: mocks.clearFleetChargingSettingCache,
  clearVdv463SettingCache: mocks.clearVdv463SettingCache,
  clearGuestChargingCache: mocks.clearGuestChargingCache,
  GUEST_STARTS_PER_IP_PER_HOUR_KEY: 'guest.startsPerIpPerHour',
  GUEST_DECLINES_PER_IP_PER_HOUR_KEY: 'guest.declinesPerIpPerHour',
  MAX_GUEST_VELOCITY_LIMIT: 10_000,
  parseGuestVelocityLimit: (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000
      ? value
      : null,
  clearGuestVelocityCache: vi.fn(),
  clearAutochargeCache: vi.fn(),
  clearCompanyPortalUrlCache: vi.fn(),
  isAutochargeOffered: vi.fn(() => Promise.resolve(false)),
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

vi.mock('../services/storage.service.js', () => ({
  clearObjectStorageCache: mocks.clearObjectStorageCache,
  getObjectStorage: mocks.getObjectStorage,
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

vi.mock('../lib/driver-ai-availability.js', () => ({
  readDriverAiAvailability: () => Promise.resolve({ available: false, perMinute: 2 }),
}));

vi.mock('@evtivity/services/station-message.service', () => ({
  requestStationMessageRepush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/provider-switch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/provider-switch.js')>()),
  assertPaymentProviderWritable: mocks.assertWritable,
}));

vi.mock('../lib/autocharge-invalidation.js', () => ({
  invalidateAutochargeCaches: vi.fn(async () => undefined),
}));

import { invalidateAutochargeCaches } from '../lib/autocharge-invalidation.js';
import { registerAuth } from '../plugins/auth.js';
import { settingsRoutes } from '../routes/settings.js';
import { resetSiteAccessMock, setMockUserSiteIds } from './helpers/site-access-mock.js';

describe('settings routes (cov3)', () => {
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
    mocks.readSimSettings.mockResolvedValue(simSettings(false, false));
  });

  describe('webhook signing secret', () => {
    const url = '/settings/notifications/webhook-signing-secret';

    it('generates a secret, stores it encrypted, audits it and shows it once', async () => {
      setupDbResults([], [{ key: 'notifications.webhookSigningSecretEnc', value: 'x' }]);
      const res = await app.inject({ method: 'POST', url, headers: auth });
      expect(res.statusCode).toBe(200);
      const { secret } = res.json();
      expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      expect(rec.values[0]).toMatchObject({ value: 'encrypted-value' });
      expect(JSON.stringify(rec.values)).not.toContain(secret);
      expect(mocks.writeAudit.mock.calls[0]?.[1]).toMatchObject({
        action: 'updated',
        notes: 'Webhook signing secret generated',
      });
      expect(mocks.clearNotificationSettingsCache).toHaveBeenCalled();
    });

    it('removes the secret and reports it not configured', async () => {
      setupDbResults([{ key: 'notifications.webhookSigningSecretEnc', value: 'old' }], []);
      const res = await app.inject({ method: 'DELETE', url, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ configured: false });
      expect(mocks.writeAudit.mock.calls[0]?.[1]).toMatchObject({
        notes: 'Webhook signing secret removed',
        before: { value: 'old' },
      });
    });

    it.each(['GET', 'POST', 'DELETE'] as const)(
      '%s answers 404 to a site-restricted user and writes nothing',
      async (method) => {
        setMockUserSiteIds(['sit_000000000001']);
        try {
          const res = await app.inject({ method, url, headers: auth });
          expect(res.statusCode).toBe(404);
          expect(rec.values).toHaveLength(0);
          expect(mocks.writeAudit).not.toHaveBeenCalled();
        } finally {
          resetSiteAccessMock();
        }
      },
    );
  });

  it.each(['PUT', 'PATCH'] as const)(
    '%s autocharge.enabled drops the Autocharge caches',
    async (method) => {
      setupDbResults([], [{ key: 'autocharge.enabled', value: true }]);
      const res = await app.inject({
        method,
        url: '/settings/autocharge.enabled',
        headers: auth,
        payload: { value: true },
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      expect(invalidateAutochargeCaches).toHaveBeenCalledTimes(1);
    },
  );

  it('DELETE autocharge.enabled drops the Autocharge caches', async () => {
    setupDbResults([{ key: 'autocharge.enabled', value: true }]);
    const res = await app.inject({
      method: 'DELETE',
      url: '/settings/autocharge.enabled',
      headers: auth,
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(invalidateAutochargeCaches).toHaveBeenCalledTimes(1);
  });

  it('keeps the depot interface save when the switch announcement fails', async () => {
    setupDbResults([], [{ key: 'vdv463.enabled', value: true }]);
    mocks.publish.mockRejectedValueOnce(new Error('redis down'));
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/vdv463.enabled',
      headers: auth,
      payload: { value: true },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.clearVdv463SettingCache).toHaveBeenCalled();
  });

  it.each([
    ['a non-string', 42],
    ['an unknown raw variable', '<p>{{{driverName}}}</p>'],
  ])('refuses %s as the email layout', async (_label, value) => {
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/email.wrapperTemplate',
      headers: auth,
      payload: { value },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(rec.values).toHaveLength(0);
  });

  it('stores an empty email layout, which restores the built-in one', async () => {
    setupDbResults([], [{ key: 'email.wrapperTemplate', value: '' }]);
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/email.wrapperTemplate',
      headers: auth,
      payload: { value: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(rec.values[0]).toMatchObject({ key: 'email.wrapperTemplate', value: '' });
  });
});
