// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
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

const {
  mockGetSsoConfig,
  mockGenerateId,
  mockGetAuthorizeUrlAsync,
  mockValidatePostResponseAsync,
  mockCreateRefreshToken,
  mockSetAuthCookies,
} = vi.hoisted(() => ({
  mockGetSsoConfig: vi.fn(),
  mockGenerateId: vi.fn(),
  mockGetAuthorizeUrlAsync: vi.fn(),
  mockValidatePostResponseAsync: vi.fn(),
  mockCreateRefreshToken: vi.fn(),
  mockSetAuthCookies: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  users: {},
  roles: {},
  getSsoConfig: mockGetSsoConfig,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('@evtivity/lib', () => ({
  generateId: mockGenerateId,
}));

vi.mock('@node-saml/node-saml', () => ({
  SAML: class {
    getAuthorizeUrlAsync(...args: unknown[]) {
      return mockGetAuthorizeUrlAsync(...args);
    }
    validatePostResponseAsync(...args: unknown[]) {
      return mockValidatePostResponseAsync(...args);
    }
  },
}));

vi.mock('../services/refresh-token.service.js', () => ({
  createRefreshToken: mockCreateRefreshToken,
}));

vi.mock('../lib/csms-cookies.js', () => ({
  setAuthCookies: mockSetAuthCookies,
}));

import { registerAuth } from '../plugins/auth.js';
import { ssoAuthRoutes } from '../routes/sso-auth.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  await app.register(formbody);
  await registerAuth(app);
  ssoAuthRoutes(app);
  await app.ready();
  return app;
}

const SSO_CONFIG = {
  entryPoint: 'https://idp.example.com/sso',
  issuer: 'https://csms.example.com',
  cert: 'MIIC...',
  attributeMapping: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
  autoProvision: false,
  defaultRoleId: '',
  allowedDomains: [] as string[],
};

describe('SSO auth routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  describe('GET /auth/sso/login', () => {
    it('returns 400 when SSO is disabled', async () => {
      mockGetSsoConfig.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/sso/login',
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body['code']).toBe('SSO_DISABLED');
    });

    it('returns redirect when SSO is enabled', async () => {
      mockGetSsoConfig.mockResolvedValue(SSO_CONFIG);
      mockGetAuthorizeUrlAsync.mockResolvedValue('https://idp.example.com/sso?SAMLRequest=xxx');

      const res = await app.inject({
        method: 'GET',
        url: '/auth/sso/login',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('https://idp.example.com/sso?SAMLRequest=xxx');
    });
  });

  describe('POST /auth/sso/callback', () => {
    it('sets cookies and redirects for existing active user', async () => {
      mockGetSsoConfig.mockResolvedValue({
        ...SSO_CONFIG,
        attributeMapping: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
      });
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'test@example.com', firstName: 'Test', lastName: 'User' },
      });

      // First query: user lookup returns existing active user
      // Second query: update lastLoginAt
      setupDbResults([{ id: 'usr_001', roleId: 'rol_001', isActive: true }], []);

      mockCreateRefreshToken.mockResolvedValue({
        rawToken: 'refresh_xxx',
        expiresAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'SAMLResponse=base64encodedresponse',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/');
      expect(mockSetAuthCookies).toHaveBeenCalled();
      expect(mockCreateRefreshToken).toHaveBeenCalledWith({ userId: 'usr_001' });
    });

    it('redirects with error when user not found and auto-provision disabled', async () => {
      mockGetSsoConfig.mockResolvedValue({
        ...SSO_CONFIG,
        autoProvision: false,
      });
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'unknown@example.com', firstName: 'Unknown', lastName: 'User' },
      });

      // User lookup returns empty
      setupDbResults([]);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'SAMLResponse=base64encodedresponse',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/login?error=sso_user_not_found');
    });

    it('creates user and redirects when auto-provision enabled', async () => {
      mockGetSsoConfig.mockResolvedValue({
        ...SSO_CONFIG,
        autoProvision: true,
        defaultRoleId: 'rol_001',
      });
      mockValidatePostResponseAsync.mockResolvedValue({
        profile: { email: 'new@example.com', firstName: 'New', lastName: 'Driver' },
      });

      // First query: user lookup returns empty (not found)
      // Second query: role lookup returns the default role
      // Third query: insert user
      setupDbResults([], [{ id: 'rol_001' }], []);

      mockGenerateId.mockReturnValue('usr_new001');
      mockCreateRefreshToken.mockResolvedValue({
        rawToken: 'refresh_xxx',
        expiresAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sso/callback',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'SAMLResponse=base64encodedresponse',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers['location']).toBe('/');
      expect(mockSetAuthCookies).toHaveBeenCalled();
      expect(mockCreateRefreshToken).toHaveBeenCalledWith({ userId: 'usr_new001' });
      expect(mockGenerateId).toHaveBeenCalledWith('user');
    });
  });
});
