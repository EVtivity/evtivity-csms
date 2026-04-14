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
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  like: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
}));

vi.mock('@evtivity/lib', () => ({
  encryptString: vi.fn((_val: string, _key: string) => 'encrypted-value'),
}));

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

const { mockClearS3ConfigCache, mockGetS3Config } = vi.hoisted(() => ({
  mockClearS3ConfigCache: vi.fn(),
  mockGetS3Config: vi.fn(),
}));

vi.mock('../services/s3.service.js', () => ({
  clearS3ConfigCache: mockClearS3ConfigCache,
  getS3Config: mockGetS3Config,
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

import { registerAuth } from '../plugins/auth.js';
import { settingsRoutes } from '../routes/settings.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  settingsRoutes(app);
  await app.ready();
  return app;
}

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

    it('returns empty object when no company settings exist', async () => {
      setupDbResults([]);
      const res = await app.inject({ method: 'GET', url: '/portal/branding' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
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
      setupDbResults([{ key: 'smtp.host', value: '"new-host"' }]);
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
      setupDbResults([{ key: 'app.config', value: '{"debug":true}' }]);
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
      setupDbResults([{ key: 'new.key', value: '"hello"' }]);
      const res = await app.inject({
        method: 'PUT',
        url: '/settings/new.key',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { value: 'hello' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.key).toBe('new.key');
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

      // 4 upserts run in parallel via Promise.all
      setupDbResults([], [], [], []);

      const res = await app.inject({
        method: 'PUT',
        url: '/settings/s3',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: s3Body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const { encryptString } = await import('@evtivity/lib');
      expect(encryptString).toHaveBeenCalledWith('AKIA123', 'test-encryption-key-32chars!!!!!');
      expect(encryptString).toHaveBeenCalledWith('secret123', 'test-encryption-key-32chars!!!!!');
      expect(mockClearS3ConfigCache).toHaveBeenCalled();

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
  });

  // ----------------------------------------------------------------
  // POST /v1/settings/s3/test (authenticated, test S3 connection)
  // ----------------------------------------------------------------
  describe('POST /v1/settings/s3/test', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'POST', url: '/settings/s3/test' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 when S3 is not configured', async () => {
      mockGetS3Config.mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'POST',
        url: '/settings/s3/test',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('S3 not configured');
      expect(body.code).toBe('S3_NOT_CONFIGURED');
    });

    it('returns success when S3 connection works', async () => {
      const mockSend = vi.fn().mockResolvedValueOnce({});
      mockGetS3Config.mockResolvedValueOnce({
        client: { send: mockSend },
        bucket: 'test-bucket',
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
      const mockSend = vi.fn().mockRejectedValueOnce(new Error('Access Denied'));
      mockGetS3Config.mockResolvedValueOnce({
        client: { send: mockSend },
        bucket: 'test-bucket',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/settings/s3/test',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Access Denied');
      expect(body.code).toBe('S3_CONNECTION_FAILED');
    });

    it('returns 400 with "Unknown error" when S3 throws non-Error', async () => {
      const mockSend = vi.fn().mockRejectedValueOnce('string-error');
      mockGetS3Config.mockResolvedValueOnce({
        client: { send: mockSend },
        bucket: 'test-bucket',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/settings/s3/test',
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Unknown error');
      expect(body.code).toBe('S3_CONNECTION_FAILED');
    });
  });
});
