// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

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
    'onConflictDoNothing',
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
  client: vi.fn(() => Promise.resolve([])),
  users: {},
  roles: {},
  userTokens: {},
  userSiteAssignments: {},
  userPermissions: {},
  getRecaptchaConfig: vi.fn().mockResolvedValue(null),
  getMfaConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  between: vi.fn(),
}));

vi.mock('argon2', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$argon2id$hashed'),
    verify: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@evtivity/lib', () => ({
  getNotificationSettings: vi.fn().mockResolvedValue({
    smtp: {
      host: 'smtp.test',
      port: 587,
      username: 'test',
      password: 'test',
      from: 'test@test.com',
    },
    twilio: null,
    emailWrapperTemplate: null,
  }),
  sendEmail: vi.fn().mockResolvedValue(true),
  wrapEmailHtml: vi.fn().mockReturnValue('<html>wrapped</html>'),
  renderTemplate: vi.fn().mockResolvedValue({
    subject: 'Reset your password',
    body: 'Reset your password',
    html: '<p>Reset your password</p>',
  }),
  dispatchSystemNotification: vi.fn().mockResolvedValue(undefined),
  verifyRecaptcha: vi.fn().mockResolvedValue({ success: true }),
  decryptString: vi.fn().mockReturnValue('decrypted'),
  encryptString: vi.fn().mockReturnValue('encrypted'),
  generateTotpSecret: vi.fn().mockReturnValue('JBSWY3DPEHPK3PXP'),
  generateTotpUri: vi.fn().mockReturnValue('otpauth://totp/test'),
  verifyTotpCode: vi.fn().mockReturnValue(true),
  createMfaChallenge: vi.fn().mockResolvedValue({ challengeId: 1, code: '123456' }),
  verifyMfaChallenge: vi.fn().mockResolvedValue(true),
  ADMIN_DEFAULT_PERMISSIONS: ['stations:read', 'stations:write'],
  OPERATOR_DEFAULT_PERMISSIONS: ['stations:read'],
  VIEWER_DEFAULT_PERMISSIONS: ['stations:read'],
  hasPermission: vi.fn().mockReturnValue(true),
  PERMISSIONS: ['stations:read', 'stations:write'],
  isSubsetOf: vi.fn().mockReturnValue(true),
}));

vi.mock('../services/refresh-token.service.js', () => ({
  createRefreshToken: vi
    .fn()
    .mockResolvedValue({ rawToken: 'mock-refresh-token', expiresAt: new Date() }),
  validateAndRotateRefreshToken: vi.fn().mockResolvedValue(null),
  revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { userRoutes } from '../routes/users.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie, { secret: 'test-cookie-secret-12345' });
  await registerAuth(app);
  userRoutes(app);
  await app.ready();
  return app;
}

describe('User routes', () => {
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

  it('GET /v1/users returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/users' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/users/me returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/users/me' });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/users returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { email: 'test@example.com', password: 'TestPassword1', roleId: VALID_ROLE_ID },
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/roles returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/roles' });
    expect(response.statusCode).toBe(401);
  });

  // --- Schema validation ---

  it('POST /v1/auth/login rejects empty body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /v1/auth/login rejects invalid email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'not-an-email', password: 'TestPassword1' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /v1/users rejects missing email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { roleId: VALID_ROLE_ID },
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /v1/users rejects invalid roleId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: { email: 'test@example.com', password: 'TestPassword1', roleId: 'not-a-nanoid' },
    });
    expect(response.statusCode).toBe(400);
  });

  // --- Happy paths ---

  it('POST /v1/auth/login returns token on valid credentials', async () => {
    // First query: user lookup
    // Second query: role lookup
    // Third query: update lastLoginAt
    setupDbResults(
      [
        {
          id: VALID_USER_ID,
          email: 'admin@example.com',
          passwordHash: '$argon2id$hashed',
          firstName: 'Admin',
          lastName: 'User',
          roleId: VALID_ROLE_ID,
          isActive: true,
          mustResetPassword: false,
          language: 'en',
          timezone: 'America/New_York',
          mfaEnabled: false,
          mfaMethod: null,
          totpSecretEnc: null,
        },
      ],
      [{ id: VALID_USER_ID, name: 'admin' }],
      [{ id: VALID_USER_ID }],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@example.com', password: 'TestPassword1' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('token');
    expect(body).toHaveProperty('user');
    expect(body.user.email).toBe('admin@example.com');
    expect(body).toHaveProperty('role');
  });

  it('POST /v1/auth/login returns 401 when user not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nonexistent@example.com', password: 'TestPassword1' },
    });
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('INVALID_CREDENTIALS');
  });

  it('GET /v1/users/me returns current user profile', async () => {
    // First query: user
    // Second query: role
    setupDbResults(
      [
        {
          id: VALID_USER_ID,
          email: 'admin@example.com',
          firstName: 'Admin',
          lastName: 'User',
          roleId: VALID_ROLE_ID,
          isActive: true,
          mustResetPassword: false,
          language: 'en',
          timezone: 'America/New_York',
          themePreference: 'light',
          lastLoginAt: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
      [{ id: VALID_USER_ID, name: 'admin' }],
    );
    const response = await app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.email).toBe('admin@example.com');
    expect(body).toHaveProperty('role');
    expect(body.role.name).toBe('admin');
  });

  it('GET /v1/users/me returns 404 when user not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('USER_NOT_FOUND');
  });

  it('GET /v1/users returns paginated user list', async () => {
    // data query and count query run in parallel via Promise.all
    // Both resolve from the same dbResults sequence
    setupDbResults(
      [
        {
          id: VALID_USER_ID,
          email: 'user1@example.com',
          firstName: 'User',
          lastName: 'One',
          phone: null,
          roleId: VALID_ROLE_ID,
          isActive: true,
          mustResetPassword: false,
          hasAllSiteAccess: false,
          language: 'en',
          timezone: 'America/New_York',
          themePreference: 'light',
          lastLoginAt: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
      [{ count: 1 }],
      // site assignment counts
      [],
    );
    const response = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('POST /v1/users creates a new user and sends invite email', async () => {
    // 1: insert user returning row, 2: insert token
    setupDbResults(
      [
        {
          id: VALID_USER_ID,
          email: 'newuser@example.com',
          firstName: 'New',
          lastName: 'User',
          roleId: VALID_ROLE_ID,
        },
      ],
      [],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'newuser@example.com',
        firstName: 'New',
        lastName: 'User',
        roleId: VALID_ROLE_ID,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.email).toBe('newuser@example.com');
  });

  it('GET /v1/users/:id returns a user by id', async () => {
    setupDbResults(
      [
        {
          id: VALID_USER_ID,
          email: 'user@example.com',
          firstName: 'Test',
          lastName: 'User',
          phone: null,
          roleId: VALID_ROLE_ID,
          isActive: true,
          mustResetPassword: false,
          language: 'en',
          timezone: 'America/New_York',
          themePreference: 'light',
          lastLoginAt: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
      // site assignments
      [],
      // permissions
      [],
    );
    const response = await app.inject({
      method: 'GET',
      url: `/users/${VALID_USER_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.email).toBe('user@example.com');
  });

  it('GET /v1/users/:id returns 404 when not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: `/users/${VALID_USER_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('USER_NOT_FOUND');
  });

  it('PATCH /v1/users/:id updates a user', async () => {
    const otherId = 'usr_000000000002';
    setupDbResults(
      [
        {
          id: otherId,
          email: 'user@example.com',
          firstName: 'Updated',
          lastName: 'User',
          phone: null,
          roleId: VALID_ROLE_ID,
          isActive: true,
          mustResetPassword: false,
          language: 'en',
          timezone: 'America/New_York',
          themePreference: 'light',
          lastLoginAt: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
      // site assignments
      [],
      // permissions
      [],
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/users/${otherId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { firstName: 'Updated' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.firstName).toBe('Updated');
  });

  it('PATCH /v1/users/:id blocks self-edit of roleId', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/users/${VALID_USER_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { roleId: 'rol_000000000002' },
    });
    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SELF_EDIT_FORBIDDEN');
  });

  it('PATCH /v1/users/:id blocks self-edit of isActive', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/users/${VALID_USER_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isActive: false },
    });
    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SELF_EDIT_FORBIDDEN');
  });

  it('PATCH /v1/users/:id blocks self-edit of hasAllSiteAccess', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/users/${VALID_USER_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { hasAllSiteAccess: true },
    });
    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SELF_EDIT_FORBIDDEN');
  });

  it('PATCH /v1/users/:id allows self-edit of name, language, timezone, theme', async () => {
    setupDbResults(
      // update returning
      [
        {
          id: VALID_USER_ID,
          email: 'test@test.com',
          firstName: 'NewFirst',
          lastName: 'NewLast',
          phone: null,
          roleId: 'rol_1',
          isActive: true,
          language: 'es',
          timezone: 'Europe/Madrid',
          themePreference: 'dark',
          hasAllSiteAccess: false,
          lastLoginAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          mustResetPassword: false,
        },
      ],
      // site assignments
      [],
      // permissions
      [],
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/users/${VALID_USER_ID}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        firstName: 'NewFirst',
        lastName: 'NewLast',
        language: 'es',
        timezone: 'Europe/Madrid',
        themePreference: 'dark',
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('PATCH /v1/users/:id returns 404 when user not found', async () => {
    const otherId = 'usr_000000000099';
    setupDbResults([]);
    const response = await app.inject({
      method: 'PATCH',
      url: `/users/${otherId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { firstName: 'Updated' },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('USER_NOT_FOUND');
  });

  it('POST /v1/users/:id/reset-password resets password', async () => {
    setupDbResults([{ id: VALID_USER_ID }]);
    const response = await app.inject({
      method: 'POST',
      url: `/users/${VALID_USER_ID}/reset-password`,
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'NewPassword1' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it('POST /v1/users/:id/reset-password returns 404 when user not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'POST',
      url: `/users/${VALID_USER_ID}/reset-password`,
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'NewPassword1' },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('USER_NOT_FOUND');
  });

  it('POST /v1/users/me/change-password changes password', async () => {
    // First query: get current user with passwordHash
    // Second query: update passwordHash
    setupDbResults(
      [{ id: VALID_USER_ID, passwordHash: '$argon2id$hashed' }],
      [{ id: VALID_USER_ID }],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/users/me/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'OldPassword1', newPassword: 'NewPassword1' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it('POST /v1/users/me/change-password returns 404 when user not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'POST',
      url: '/users/me/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: 'OldPassword1', newPassword: 'NewPassword1' },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('USER_NOT_FOUND');
  });

  it('GET /v1/roles returns list of roles', async () => {
    setupDbResults([
      { id: VALID_USER_ID, name: 'admin' },
      { id: 'rol_000000000002', name: 'operator' },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/roles',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
  });

  // --- Forgot password ---

  it('POST /v1/auth/forgot-password returns success even for nonexistent email', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'nonexistent@example.com' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it('POST /v1/auth/forgot-password returns success for existing user', async () => {
    // 1: user lookup, 2: revoke old tokens, 3: insert new token
    setupDbResults([{ id: VALID_USER_ID }], [], []);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'admin@example.com' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it('POST /v1/auth/forgot-password rejects invalid email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'not-valid' },
    });
    expect(response.statusCode).toBe(400);
  });

  // --- Reset password ---

  it('POST /v1/auth/reset-password resets password with valid token', async () => {
    // 1: token lookup, 2: update user password, 3: revoke token, 4: fetch user for notification
    setupDbResults(
      [{ id: VALID_USER_ID, userId: VALID_USER_ID, expiresAt: new Date(Date.now() + 3600000) }],
      [],
      [],
      [{ email: 'user@example.com', firstName: 'Test', lastName: 'User', language: 'en' }],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: 'a'.repeat(64), password: 'NewPassword1' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it('POST /v1/auth/reset-password returns 400 for invalid token', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: 'invalid-token', password: 'NewPassword1' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('INVALID_TOKEN');
  });

  it('POST /v1/auth/reset-password returns 400 for expired token', async () => {
    setupDbResults([
      { id: VALID_USER_ID, userId: VALID_USER_ID, expiresAt: new Date(Date.now() - 1000) },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: 'a'.repeat(64), password: 'NewPassword1' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('INVALID_TOKEN');
  });

  it('POST /v1/auth/reset-password rejects short password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { token: 'a'.repeat(64), password: 'short' },
    });
    expect(response.statusCode).toBe(400);
  });

  // --- Force change password ---

  it('POST /v1/auth/force-change-password returns 401 when user not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/force-change-password',
      payload: {
        email: 'nobody@example.com',
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword1',
      },
    });
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('INVALID_CREDENTIALS');
  });

  it('POST /v1/auth/force-change-password returns 400 when mustResetPassword is false', async () => {
    setupDbResults([
      {
        id: VALID_USER_ID,
        email: 'admin@example.com',
        passwordHash: '$argon2id$hashed',
        firstName: 'Admin',
        lastName: 'User',
        roleId: VALID_ROLE_ID,
        isActive: true,
        mustResetPassword: false,
        language: 'en',
        timezone: 'America/New_York',
        themePreference: 'light',
        mfaEnabled: false,
        mfaMethod: null,
        totpSecretEnc: null,
      },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/force-change-password',
      payload: {
        email: 'admin@example.com',
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword1',
      },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('RESET_NOT_REQUIRED');
  });

  it('POST /v1/auth/force-change-password returns 403 when account disabled', async () => {
    setupDbResults([
      {
        id: VALID_USER_ID,
        email: 'admin@example.com',
        passwordHash: '$argon2id$hashed',
        firstName: 'Admin',
        lastName: 'User',
        roleId: VALID_ROLE_ID,
        isActive: false,
        mustResetPassword: true,
        language: 'en',
        timezone: 'America/New_York',
        themePreference: 'light',
        mfaEnabled: false,
        mfaMethod: null,
        totpSecretEnc: null,
      },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/force-change-password',
      payload: {
        email: 'admin@example.com',
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword1',
      },
    });
    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('ACCOUNT_DISABLED');
  });

  it('POST /v1/auth/force-change-password returns 401 when current password wrong', async () => {
    const argon2 = await import('argon2');
    vi.mocked(argon2.default.verify).mockResolvedValueOnce(false);
    setupDbResults([
      {
        id: VALID_USER_ID,
        email: 'admin@example.com',
        passwordHash: '$argon2id$hashed',
        firstName: 'Admin',
        lastName: 'User',
        roleId: VALID_ROLE_ID,
        isActive: true,
        mustResetPassword: true,
        language: 'en',
        timezone: 'America/New_York',
        themePreference: 'light',
        mfaEnabled: false,
        mfaMethod: null,
        totpSecretEnc: null,
      },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/force-change-password',
      payload: {
        email: 'admin@example.com',
        currentPassword: 'wrongpassword',
        newPassword: 'NewPassword1',
      },
    });
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('INVALID_CREDENTIALS');
  });

  it('POST /v1/auth/force-change-password succeeds and returns token', async () => {
    // 1: user lookup, 2: update password, 3: role lookup, 4: update lastLoginAt
    setupDbResults(
      [
        {
          id: VALID_USER_ID,
          email: 'admin@example.com',
          passwordHash: '$argon2id$hashed',
          firstName: 'Admin',
          lastName: 'User',
          roleId: VALID_ROLE_ID,
          isActive: true,
          mustResetPassword: true,
          language: 'en',
          timezone: 'America/New_York',
          themePreference: 'light',
          mfaEnabled: false,
          mfaMethod: null,
          totpSecretEnc: null,
        },
      ],
      [{ id: VALID_USER_ID }],
      [{ id: VALID_ROLE_ID, name: 'admin' }],
      [{ id: VALID_USER_ID }],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/auth/force-change-password',
      payload: {
        email: 'admin@example.com',
        currentPassword: 'OldPassword1',
        newPassword: 'NewPassword1',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('token');
    expect(body).toHaveProperty('user');
    expect(body.user.email).toBe('admin@example.com');
    expect(body).toHaveProperty('role');
    expect(body.role.name).toBe('admin');
  });
});
