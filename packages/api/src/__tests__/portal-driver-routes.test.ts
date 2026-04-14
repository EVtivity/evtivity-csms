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
  client: {},
  drivers: {},
  driverNotificationPreferences: {},
  getMfaConfig: vi
    .fn()
    .mockResolvedValue({ emailEnabled: false, totpEnabled: false, smsEnabled: false }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$argon2id$new_hashed_password'),
    verify: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@evtivity/lib', () => ({
  dispatchDriverNotification: vi.fn(),
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  encryptString: vi.fn().mockReturnValue('encrypted'),
  decryptString: vi.fn().mockReturnValue('decrypted'),
  generateTotpSecret: vi.fn().mockReturnValue('secret'),
  generateTotpUri: vi.fn().mockReturnValue('otpauth://totp/test'),
  verifyTotpCode: vi.fn().mockReturnValue(true),
  createMfaChallenge: vi.fn().mockResolvedValue({ challengeId: 1, code: '123456' }),
  verifyMfaChallenge: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
  })),
}));

vi.mock('../lib/template-dirs.js', () => ({
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
  API_TEMPLATES_DIR: '/mock/templates',
  OCPP_TEMPLATES_DIR: '/mock/templates',
}));

vi.mock('../services/refresh-token.service.js', () => ({
  revokeAllDriverRefreshTokens: vi.fn().mockResolvedValue(undefined),
  createRefreshToken: vi.fn().mockResolvedValue({ rawToken: 'mock', expiresAt: new Date() }),
}));

import { registerAuth } from '../plugins/auth.js';
import { portalDriverRoutes } from '../routes/portal/driver.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';
const DRIVER_ID = 'drv_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalDriverRoutes);
  await app.ready();
  return app;
}

describe('Portal driver routes - handler logic', () => {
  let app: FastifyInstance;
  let driverToken: string;

  beforeAll(async () => {
    app = await buildApp();
    driverToken = app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
  });

  describe('PATCH /v1/portal/driver/profile', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        payload: { firstName: 'Jane' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 with operator token', async () => {
      const operatorToken = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { firstName: 'Jane' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 404 when driver not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { firstName: 'Jane' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('updates driver profile successfully', async () => {
      const updatedDriver = {
        id: DRIVER_ID,
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        phone: '555-9999',
        language: 'en',
        timezone: 'America/New_York',
        themePreference: 'light',
        distanceUnit: 'miles',
        isActive: true,
        createdAt: '2024-01-01',
      };
      setupDbResults([updatedDriver]);
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { firstName: 'Jane', phone: '555-9999' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.firstName).toBe('Jane');
      expect(body.phone).toBe('555-9999');
    });

    it('accepts language update', async () => {
      setupDbResults([
        {
          id: DRIVER_ID,
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
          phone: null,
          language: 'es',
          timezone: 'America/New_York',
          themePreference: 'light',
          distanceUnit: 'miles',
          isActive: true,
          createdAt: '2024-01-01',
        },
      ]);
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { language: 'es' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().language).toBe('es');
    });
  });

  describe('PATCH /v1/portal/driver/password', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/password',
        payload: { currentPassword: 'OldPassword1', newPassword: 'NewPassword1' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when driver not found', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/password',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { currentPassword: 'OldPassword1', newPassword: 'NewPassword1' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns 404 when driver has no password hash', async () => {
      setupDbResults([{ passwordHash: null }]);
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/password',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { currentPassword: 'OldPassword1', newPassword: 'NewPassword1' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe('DRIVER_NOT_FOUND');
    });

    it('returns 400 when current password is incorrect', async () => {
      const argon2 = await import('argon2');
      vi.mocked(argon2.default.verify).mockResolvedValueOnce(false);

      setupDbResults([{ passwordHash: '$argon2id$hashed' }]);
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/password',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { currentPassword: 'WrongPassword1', newPassword: 'NewPassword1' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_PASSWORD');
    });

    it('changes password successfully', async () => {
      const argon2 = await import('argon2');
      vi.mocked(argon2.default.verify).mockResolvedValueOnce(true);

      setupDbResults([{ passwordHash: '$argon2id$hashed' }], []);
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/password',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { currentPassword: 'OldPassword1', newPassword: 'NewPassword1' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });

    it('returns 400 when new password is too short', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/password',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { currentPassword: 'OldPassword1', newPassword: 'short' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/portal/driver/notification-preferences', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/portal/driver/notification-preferences',
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns defaults when no preferences exist', async () => {
      setupDbResults([]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/driver/notification-preferences',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.emailEnabled).toBe(true);
      expect(body.smsEnabled).toBe(true);
    });

    it('returns stored preferences', async () => {
      setupDbResults([{ emailEnabled: true, smsEnabled: false }]);
      const response = await app.inject({
        method: 'GET',
        url: '/portal/driver/notification-preferences',
        headers: { authorization: `Bearer ${driverToken}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.emailEnabled).toBe(true);
      expect(body.smsEnabled).toBe(false);
    });
  });

  describe('PUT /v1/portal/driver/notification-preferences', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/portal/driver/notification-preferences',
        payload: { emailEnabled: true, smsEnabled: false },
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 400 with invalid body', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/portal/driver/notification-preferences',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { emailEnabled: 'not-a-boolean' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('upserts notification preferences', async () => {
      const savedPrefs = {
        driverId: DRIVER_ID,
        emailEnabled: false,
        smsEnabled: true,
        updatedAt: '2024-01-01',
      };
      setupDbResults([savedPrefs]);
      const response = await app.inject({
        method: 'PUT',
        url: '/portal/driver/notification-preferences',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { emailEnabled: false, smsEnabled: true },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.emailEnabled).toBe(false);
      expect(body.smsEnabled).toBe(true);
    });

    it('returns 400 when smsEnabled is missing', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/portal/driver/notification-preferences',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { emailEnabled: true },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
