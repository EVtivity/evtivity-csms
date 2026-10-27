// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'groupBy'];
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

const { mockFleetHealth, configState } = vi.hoisted(() => {
  const state: Record<string, unknown> = {};
  return { mockFleetHealth: vi.fn(), configState: state };
});

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
  },
  client: {},
  settings: {},
  sites: { dataPlan: 'sites.data_plan' },
  chargingStations: { onboardingStatus: 'onboarding_status' },
  cssStations: {},
  effectiveDataPlanSql: 'effective_plan',
  isOperatorStation: vi.fn(),
  getOcppFleetHealth: mockFleetHealth,
}));

vi.mock('drizzle-orm', () => ({
  inArray: vi.fn(),
  and: vi.fn(),
  eq: vi.fn(),
  isNotNull: vi.fn(),
  sql: vi.fn(() => ({})),
}));

vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>();
  Object.assign(configState, actual.config);
  return { ...actual, config: configState };
});

vi.mock('../lib/settings-crypto.js', () => ({
  storedSecretDecrypts: (_key: string, value: unknown) => value === 'decrypts',
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

const { mockActivePaymentProvider } = vi.hoisted(() => ({
  mockActivePaymentProvider: vi.fn(),
}));

vi.mock('../lib/payments.js', () => ({
  activePaymentProvider: mockActivePaymentProvider,
}));

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

import { registerAuth } from '../plugins/auth.js';
import { config as realConfig } from '../lib/config.js';
import { resetSiteAccessMock, setMockUserSiteIds } from './helpers/site-access-mock.js';
import { systemRoutes } from '../routes/system.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  systemRoutes(app);
  await app.ready();
  return app;
}

describe('System routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  const baseConfig = { ...realConfig };

  beforeEach(() => {
    resetSiteAccessMock();
    setupDbResults();
    Object.assign(configState, baseConfig);
    mockFleetHealth.mockReset();
    mockFleetHealth.mockResolvedValue({ instances: [] });
    mockActivePaymentProvider.mockReset();
    mockActivePaymentProvider.mockResolvedValue(null);
    vi.stubEnv('SMTP_HOST', undefined);
    vi.stubEnv('BIND_IP', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports the Docker Compose bind address from BIND_IP', async () => {
    vi.stubEnv('BIND_IP', '192.168.1.234');
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().network.bindIp).toBe('192.168.1.234');
  });

  it('reports no bind address outside Docker Compose', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().network.bindIp).toBeNull();
  });

  it('GET /system/info returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/system/info' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /system/info answers 404 SETTING_NOT_FOUND to a site-restricted user', async () => {
    setMockUserSiteIds(['sit_a']);
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Setting not found', code: 'SETTING_NOT_FOUND' });
    expect(mockActivePaymentProvider).not.toHaveBeenCalled();
  });

  it('reports integrations as not configured when no settings rows exist', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.secrets.stripeConfigured).toBe(false);
    expect(body.secrets.adyenConfigured).toBe(false);
    expect(body.payments).toEqual({ provider: 'none', configured: false });
    expect(body.secrets.smtpConfigured).toBe(false);
    expect(body.secrets.twilioConfigured).toBe(false);
    expect(body.secrets.s3Configured).toBe(false);
    expect(body.secrets.recaptchaConfigured).toBe(false);
    expect(body.secrets.hubjectConfigured).toBe(false);
    expect(body.secrets.googleMapsConfigured).toBe(false);
  });

  it('reports integrations as configured from settings rows', async () => {
    setupDbResults([
      { key: 'payments.provider', value: 'stripe' },
      { key: 'stripe.secretKeyEnc', value: 'ciphertext' },
      { key: 'adyen.apiKeyEnc', value: 'ciphertext' },
      { key: 'smtp.host', value: 'smtp.example.com' },
      { key: 'twilio.accountSid', value: 'AC123' },
      { key: 's3.bucket', value: 'attachments' },
      { key: 'security.recaptcha.secretKeyEnc', value: 'ciphertext' },
      { key: 'pnc.hubject.baseUrl', value: 'https://hubject.example.com' },
      { key: 'googleMaps.apiKeyEnc', value: 'ciphertext' },
    ]);
    mockActivePaymentProvider.mockResolvedValue({ id: 'stripe' });
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.secrets.stripeConfigured).toBe(true);
    expect(body.secrets.adyenConfigured).toBe(true);
    expect(body.payments).toEqual({ provider: 'stripe', configured: true });
    expect(body.secrets.smtpConfigured).toBe(true);
    expect(body.secrets.twilioConfigured).toBe(true);
    expect(body.secrets.s3Configured).toBe(true);
    expect(body.secrets.recaptchaConfigured).toBe(true);
    expect(body.secrets.hubjectConfigured).toBe(true);
    expect(body.secrets.googleMapsConfigured).toBe(true);
  });

  it('treats empty-string settings as not configured', async () => {
    setupDbResults([
      { key: 'stripe.secretKeyEnc', value: '' },
      { key: 's3.bucket', value: '' },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.secrets.stripeConfigured).toBe(false);
    expect(body.secrets.s3Configured).toBe(false);
  });

  it.each([
    ['dev-jwt-secret-change-in-production!!', 'dev-encryption-key-32chars-long!'],
    ['dev-secret-change-in-production', 'short-key'],
  ])('reports the published or short secrets %s and %s as not configured', async (jwt, key) => {
    configState['JWT_SECRET'] = jwt;
    configState['SETTINGS_ENCRYPTION_KEY'] = key;
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.secrets.jwtConfigured).toBe(false);
    expect(body.secrets.settingsEncryptionConfigured).toBe(false);
  });

  it('reports generated secrets as configured', async () => {
    configState['JWT_SECRET'] = 'a'.repeat(64);
    configState['SETTINGS_ENCRYPTION_KEY'] = 'b'.repeat(64);
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = response.json();
    expect(body.secrets.jwtConfigured).toBe(true);
    expect(body.secrets.settingsEncryptionConfigured).toBe(true);
  });

  it('honors the SMTP_HOST env override when the setting is absent', async () => {
    vi.stubEnv('SMTP_HOST', 'mailpit');
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.secrets.smtpConfigured).toBe(true);
  });

  it('reports a selected provider that is not usable as not configured', async () => {
    setupDbResults([{ key: 'payments.provider', value: 'adyen' }]);
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().payments).toEqual({ provider: 'adyen', configured: false });
  });

  it('reads the API values from the parsed config, not from the environment', async () => {
    vi.stubEnv('API_PORT', '9999');
    vi.stubEnv('CORS_ORIGIN', 'https://env.example');
    Object.assign(configState, {
      API_PORT: 7102,
      CORS_ORIGIN: 'https://csms.example',
      AUTH_RATE_LIMIT_WINDOW: '5 minutes',
      TRUST_PROXY: '10.0.0.0/8',
      WEBAUTHN_RP_ID: 'example.com',
      OCPP_STATION_TLS_URL: 'wss://ocpp.example',
    });
    const body = (
      await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(body.network.apiPort).toBe('7102');
    expect(body.network.corsOrigin).toBe('https://csms.example');
    expect(body.network.ocppStationTlsUrl).toBe('wss://ocpp.example');
    expect(body.network).not.toHaveProperty('ocppPort');
    expect(body.rateLimits.authRateLimitWindow).toBe('5 minutes');
    expect(body.rateLimits).not.toHaveProperty('ocppMaxConnectionsPerIp');
    expect(body.security).toEqual({
      trustProxyConfigured: true,
      webauthnRpId: 'example.com',
      sharedRateLimit: false,
    });
  });

  it('reports the registration policy setting', async () => {
    setupDbResults([{ key: 'ocpp.registrationPolicy', value: 'open' }]);
    const body = (
      await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(body.ocpp).toEqual({ registrationPolicy: 'open' });
  });

  it('lists each OCPP process with the settings it reports, null from an older one', async () => {
    const processConfig = {
      version: '0.1.48',
      wsCompression: true,
      tlsEnabled: true,
      tlsPort: 8443,
      clientCaConfigured: false,
      maxConnectionsPerIp: 2500,
      maxMessagesPerIpPerSecond: 5000,
      maxPendingAuthPerIp: 50,
      trustedProxiesConfigured: false,
    };
    mockFleetHealth.mockResolvedValue({
      instances: [
        {
          instanceId: 'ocpp-a',
          connectedStations: 3,
          serverStartedAt: new Date('2026-10-26T08:00:00Z'),
          updatedAt: new Date('2026-10-26T09:00:00Z'),
          config: processConfig,
        },
        {
          instanceId: 'ocpp-old',
          connectedStations: 1,
          serverStartedAt: new Date('2026-10-26T07:00:00Z'),
          updatedAt: new Date('2026-10-26T09:00:00Z'),
        },
      ],
    });
    const body = (
      await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(body.ocppProcesses).toEqual([
      {
        instanceId: 'ocpp-a',
        connectedStations: 3,
        serverStartedAt: '2026-10-26T08:00:00.000Z',
        updatedAt: '2026-10-26T09:00:00.000Z',
        config: processConfig,
      },
      {
        instanceId: 'ocpp-old',
        connectedStations: 1,
        serverStartedAt: '2026-10-26T07:00:00.000Z',
        updatedAt: '2026-10-26T09:00:00.000Z',
        config: null,
      },
    ]);
  });

  it('reports SIM provider settings, data plan counts, simulator stations and secret flags', async () => {
    setupDbResults(
      [
        { key: 'sim.hologram.enabled', value: true },
        { key: 'sim.hologram.orgId', value: '42' },
        { key: 'sim.hologram.apiKeyEnc', value: 'decrypts' },
        { key: 'sim.sessions.fetchDays', value: 7 },
        { key: 'sim.stationSignal.enabled', value: false },
        { key: 'notifications.webhookSigningSecretEnc', value: 'decrypts' },
      ],
      [
        { plan: 'wifi_or_wired', count: 5 },
        { plan: 'cellular', count: 2 },
      ],
      [{ plan: 'cellular', count: 1 }],
      [{ count: 4 }],
    );
    const response = await app.inject({
      method: 'GET',
      url: '/system/info',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = response.json();
    expect(body.simProviders).toEqual({
      hologram: { enabled: true, configured: true },
      sessionsFetchDays: 7,
      stationSignalEnabled: false,
    });
    expect(body.dataPlans).toEqual({
      stations: { wifiOrWired: 5, cellular: 2 },
      sites: { wifiOrWired: 0, cellular: 1 },
    });
    expect(body.simulator.stationCount).toBe(4);
    expect(body.secrets.webhookSigningConfigured).toBe(true);
    expect(body.secrets.simHologramConfigured).toBe(true);
    expect(response.body).not.toContain('decrypts');
  });

  it('reports a Hologram key that does not decrypt as not configured', async () => {
    setupDbResults([
      { key: 'sim.hologram.orgId', value: '42' },
      { key: 'sim.hologram.apiKeyEnc', value: 'other-key-ciphertext' },
      { key: 'notifications.webhookSigningSecretEnc', value: 'other-key-ciphertext' },
    ]);
    const body = (
      await app.inject({
        method: 'GET',
        url: '/system/info',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(body.simProviders.hologram.configured).toBe(false);
    expect(body.secrets.simHologramConfigured).toBe(false);
    expect(body.secrets.webhookSigningConfigured).toBe(false);
  });

  it('reports shared rate limits when the app counts them in Redis', async () => {
    const shared = Fastify();
    await registerAuth(shared);
    shared.decorate('sharedRateLimit', true);
    systemRoutes(shared);
    await shared.ready();
    const body = (
      await shared.inject({
        method: 'GET',
        url: '/system/info',
        headers: {
          authorization: `Bearer ${shared.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID })}`,
        },
      })
    ).json();
    await shared.close();
    expect(body.security.sharedRateLimit).toBe(true);
  });
});
