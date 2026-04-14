// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  invalidatePermissionCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { tokenRoutes } from '../routes/tokens.js';

const VALID_TOKEN_ID = 'dtk_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(tokenRoutes);
  await app.ready();
  return app;
}

describe('Token routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Auth requirements', () => {
    it('GET /v1/tokens returns 401 without auth', async () => {
      const response = await app.inject({ method: 'GET', url: '/tokens' });
      expect(response.statusCode).toBe(401);
    });

    it('GET /v1/tokens/export returns 401 without auth', async () => {
      const response = await app.inject({ method: 'GET', url: '/tokens/export' });
      expect(response.statusCode).toBe(401);
    });

    it('POST /v1/tokens/import returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tokens/import',
        payload: { rows: [] },
      });
      expect(response.statusCode).toBe(401);
    });

    it('GET /v1/tokens/:id returns 401 without auth', async () => {
      const response = await app.inject({ method: 'GET', url: '/tokens/' + VALID_TOKEN_ID });
      expect(response.statusCode).toBe(401);
    });

    it('POST /v1/tokens returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tokens',
        payload: { idToken: 'abc', tokenType: 'ISO14443' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('PATCH /v1/tokens/:id returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/tokens/' + VALID_TOKEN_ID,
        payload: { isActive: false },
      });
      expect(response.statusCode).toBe(401);
    });

    it('DELETE /v1/tokens/:id returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/tokens/' + VALID_TOKEN_ID,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('Schema validation', () => {
    it('POST /v1/tokens with empty body returns 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tokens',
        headers: { authorization: 'Bearer ' + token },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('POST /v1/tokens without tokenType returns 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tokens',
        headers: { authorization: 'Bearer ' + token },
        payload: { idToken: 'abc123' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('POST /v1/tokens with invalid driverId returns 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tokens',
        headers: { authorization: 'Bearer ' + token },
        payload: { idToken: 'abc', tokenType: 'ISO14443', driverId: 'not-a-nanoid' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('PATCH /v1/tokens/:id with non-boolean isActive returns 400', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/tokens/' + VALID_TOKEN_ID,
        headers: { authorization: 'Bearer ' + token },
        payload: { isActive: 'not-a-boolean' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('PATCH /v1/tokens/:id with invalid driverId returns 400', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/tokens/' + VALID_TOKEN_ID,
        headers: { authorization: 'Bearer ' + token },
        payload: { driverId: 'not-a-nanoid' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('POST /v1/tokens/import with invalid body returns 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tokens/import',
        headers: { authorization: 'Bearer ' + token },
        payload: { rows: 'not-an-array' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('POST /v1/tokens allows optional driverId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/tokens',
        headers: { authorization: 'Bearer ' + token },
        payload: { idToken: 'abc123', tokenType: 'ISO14443' },
      });
      // Should not be 400 (it will be 500 since no DB, but validates schema acceptance)
      expect(response.statusCode).not.toBe(400);
    });

    it('PATCH /v1/tokens/:id accepts idToken and tokenType', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/tokens/' + VALID_TOKEN_ID,
        headers: { authorization: 'Bearer ' + token },
        payload: { idToken: 'new-token', tokenType: 'eMAID' },
      });
      expect(response.statusCode).not.toBe(400);
    });

    it('PATCH /v1/tokens/:id accepts null driverId', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/tokens/' + VALID_TOKEN_ID,
        headers: { authorization: 'Bearer ' + token },
        payload: { driverId: null },
      });
      expect(response.statusCode).not.toBe(400);
    });
  });
});
