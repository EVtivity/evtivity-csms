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
  getPasswordPolicy: vi.fn().mockResolvedValue({
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSymbol: false,
  }),
  writeAudit: vi.fn(() => Promise.resolve()),
  userAuditLog: { _table: 'user_audit_log' },
  driverAuditLog: { _table: 'driver_audit_log' },
  stationAuditLog: { _table: 'station_audit_log' },
  sessionAuditLog: { _table: 'session_audit_log' },
  apiKeyAuditLog: { _table: 'api_key_audit_log' },
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
  verifyMfaChallenge: vi.fn().mockResolvedValue('verified'),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
  })),
}));

vi.mock('@evtivity/services/template-dirs', () => ({
  ALL_TEMPLATES_DIRS: ['/mock/templates'],
  API_TEMPLATES_DIR: '/mock/templates',
  OCPP_TEMPLATES_DIR: '/mock/templates',
}));

vi.mock('../services/refresh-token.service.js', () => ({
  endDriverSessions: vi.fn().mockResolvedValue(undefined),
  createRefreshToken: vi.fn().mockResolvedValue({ rawToken: 'mock', expiresAt: new Date() }),
}));

// The session issuer is tested in session-token-lifetimes.test.ts.
vi.mock('../lib/driver-session.js', () => ({
  issueDriverTokens: vi.fn().mockResolvedValue(null),
}));

const { updateDriverBillingAddressMock } = vi.hoisted(() => ({
  updateDriverBillingAddressMock: vi.fn(),
}));

vi.mock('../services/driver-billing.service.js', () => ({
  DRIVER_BILLING_ADDRESS_MAX_LENGTHS: {
    billingName: 255,
    billingStreet: 255,
    billingCity: 100,
    billingState: 100,
    billingZip: 20,
    billingCountry: 100,
  },
  updateDriverBillingAddress: updateDriverBillingAddressMock,
}));

import { registerAuth } from '../plugins/auth.js';
import { portalDriverRoutes } from '../routes/portal/driver.js';
import * as argon2Module from 'argon2';
import * as databaseModule from '@evtivity/database';
import { writeAudit } from '@evtivity/database';
import { endDriverSessions } from '../services/refresh-token.service.js';
import { issueDriverTokens } from '../lib/driver-session.js';

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
    vi.mocked(databaseModule.writeAudit).mockClear();
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
        priceDisplay: null,
        isActive: true,
        createdAt: '2024-01-01',
      };
      // The row before the update, then the updated row.
      setupDbResults([{ ...updatedDriver, firstName: 'John', phone: null }], [updatedDriver]);
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
      // Audited with the changed fields only, the driver as actor.
      expect(vi.mocked(databaseModule.writeAudit)).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({
          entityId: DRIVER_ID,
          action: 'updated',
          actor: 'driver',
          actorDriverId: DRIVER_ID,
          before: { firstName: 'John', phone: null },
          after: { firstName: 'Jane', phone: '555-9999' },
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('accepts language update', async () => {
      // The stored row already holds every value sent.
      setupDbResults(
        [
          {
            firstName: 'John',
            lastName: 'Doe',
            phone: null,
            language: 'es',
            timezone: 'America/New_York',
            themePreference: 'light',
            distanceUnit: 'miles',
            priceDisplay: null,
          },
        ],
        [
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
            priceDisplay: null,
            isActive: true,
            createdAt: '2024-01-01',
          },
        ],
      );
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { language: 'es' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().language).toBe('es');
      // Nothing changed: no audit row.
      expect(vi.mocked(databaseModule.writeAudit)).not.toHaveBeenCalled();
    });
    it('stores the price display and clears it with null', async () => {
      const driverRow = {
        id: DRIVER_ID,
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        phone: null,
        language: 'de',
        timezone: 'Europe/Berlin',
        themePreference: 'light',
        distanceUnit: 'km',
        isActive: true,
        createdAt: '2024-01-01',
      };
      setupDbResults(
        [{ ...driverRow, priceDisplay: null }],
        [{ ...driverRow, priceDisplay: 'gross' }],
      );
      const gross = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { priceDisplay: 'gross' },
      });
      expect(gross.statusCode).toBe(200);
      expect(gross.json().priceDisplay).toBe('gross');

      setupDbResults(
        [{ ...driverRow, priceDisplay: 'gross' }],
        [{ ...driverRow, priceDisplay: null }],
      );
      const inherit = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { priceDisplay: null },
      });
      expect(inherit.statusCode).toBe(200);
      expect(inherit.json().priceDisplay).toBeNull();
    });

    it('rejects an unknown price display', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/profile',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { priceDisplay: 'brutto' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('PATCH /v1/portal/driver/billing-address', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/billing-address',
        payload: { billingCity: 'Berlin' },
      });
      expect(response.statusCode).toBe(401);
      expect(updateDriverBillingAddressMock).not.toHaveBeenCalled();
    });

    it('updates the address of the signed-in driver as the driver', async () => {
      const address = {
        billingName: 'Erika Muster',
        billingStreet: null,
        billingCity: 'Berlin',
        billingState: null,
        billingZip: null,
        billingCountry: null,
      };
      updateDriverBillingAddressMock.mockResolvedValueOnce(address);
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/billing-address',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { billingName: 'Erika Muster', billingCity: 'Berlin' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(address);
      expect(updateDriverBillingAddressMock).toHaveBeenCalledWith(
        DRIVER_ID,
        { billingName: 'Erika Muster', billingCity: 'Berlin' },
        expect.objectContaining({
          actor: expect.objectContaining({ actor: 'driver', actorDriverId: DRIVER_ID }),
        }),
      );
    });

    it('rejects a field longer than its column', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/billing-address',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { billingCountry: 'x'.repeat(101) },
      });
      expect(response.statusCode).toBe(400);
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
      const argon2 = argon2Module;
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
      const argon2 = argon2Module;
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
      expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({ entityId: DRIVER_ID, action: 'password_reset', actor: 'driver' }),
        expect.anything(),
        expect.anything(),
      );
      expect(JSON.stringify(vi.mocked(writeAudit).mock.calls)).not.toContain('NewPassword1');
      // Every session ends, then this client gets a new one.
      expect(vi.mocked(endDriverSessions)).toHaveBeenCalledWith(DRIVER_ID);
      expect(vi.mocked(issueDriverTokens)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        DRIVER_ID,
      );
      expect(vi.mocked(endDriverSessions).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(issueDriverTokens).mock.invocationCallOrder[0] ?? 0,
      );
      expect(response.json()).toEqual({ success: true });
    });

    it('returns new tokens in the body for a mobile client', async () => {
      const argon2 = argon2Module;
      vi.mocked(argon2.default.verify).mockResolvedValueOnce(true);
      vi.mocked(issueDriverTokens).mockResolvedValueOnce({
        token: 'new-access',
        refreshToken: 'mock',
        expiresIn: 3600,
      });

      setupDbResults([{ passwordHash: '$argon2id$hashed' }], []);
      const response = await app.inject({
        method: 'PATCH',
        url: '/portal/driver/password',
        headers: { authorization: `Bearer ${driverToken}`, 'x-client': 'mobile' },
        payload: { currentPassword: 'OldPassword1', newPassword: 'NewPassword1' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(body['success']).toBe(true);
      expect(body['token']).toBe('new-access');
      expect(body['refreshToken']).toBe('mock');
      expect(body['expiresIn']).toBe(3600);
      expect(vi.mocked(endDriverSessions)).toHaveBeenCalledWith(DRIVER_ID);
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

    it('audits the changed channels against the defaults when no row is stored', async () => {
      setupDbResults([], []);
      const response = await app.inject({
        method: 'PUT',
        url: '/portal/driver/notification-preferences',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { emailEnabled: false, smsEnabled: true },
      });
      expect(response.statusCode).toBe(200);
      expect(vi.mocked(writeAudit)).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'driver_id' }),
        expect.objectContaining({
          entityId: DRIVER_ID,
          action: 'updated',
          actor: 'driver',
          before: { notificationPreferences: { emailEnabled: true } },
          after: { notificationPreferences: { emailEnabled: false } },
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('writes no audit row when the preferences do not change', async () => {
      setupDbResults([{ emailEnabled: true, smsEnabled: true, pushEnabled: false }], []);
      const response = await app.inject({
        method: 'PUT',
        url: '/portal/driver/notification-preferences',
        headers: { authorization: `Bearer ${driverToken}` },
        payload: { emailEnabled: true, smsEnabled: true },
      });
      expect(response.statusCode).toBe(200);
      // The stored push choice is kept, not reset.
      expect(response.json().pushEnabled).toBe(false);
      expect(vi.mocked(writeAudit)).not.toHaveBeenCalled();
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
