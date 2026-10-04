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
  const methods = ['select', 'from', 'where', 'orderBy', 'limit', 'offset'];
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
  },
  settings: {},
}));

vi.mock('drizzle-orm', () => ({
  inArray: vi.fn(),
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

import { registerAuth } from '../plugins/auth.js';
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
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    mockActivePaymentProvider.mockReset();
    mockActivePaymentProvider.mockResolvedValue(null);
    savedEnv['SMTP_HOST'] = process.env['SMTP_HOST'];
    delete process.env['SMTP_HOST'];
  });

  afterEach(() => {
    if (savedEnv['SMTP_HOST'] == null) {
      delete process.env['SMTP_HOST'];
    } else {
      process.env['SMTP_HOST'] = savedEnv['SMTP_HOST'];
    }
  });

  it('GET /system/info returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/system/info' });
    expect(response.statusCode).toBe(401);
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

  it('honors the SMTP_HOST env override when the setting is absent', async () => {
    process.env['SMTP_HOST'] = 'mailpit';
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
});
