// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// POST /octt/runs: OCPP 2.0.1 has the CSMS suite only, so a charging station
// run for that version is refused before a run row is written.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

const { insertValues, publish } = vi.hoisted(() => ({
  insertValues: vi.fn(),
  publish: vi.fn(async () => {}),
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        insertValues(values);
        return {
          returning: async () => [
            {
              id: 1,
              status: 'pending',
              ocppVersion: values['ocppVersion'],
              sutType: values['sutType'],
              totalTests: 0,
              passed: 0,
              failed: 0,
              skipped: 0,
              errors: 0,
              notApplicable: 0,
              durationMs: null,
              triggeredBy: values['triggeredBy'],
              startedAt: null,
              completedAt: null,
              createdAt: '2026-10-19T00:00:00.000Z',
            },
          ],
        };
      },
    })),
  },
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish }),
}));

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
import { octtRoutes } from '../routes/octt.js';

describe('POST /octt/runs', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    octtRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    insertValues.mockClear();
    publish.mockClear();
  });

  function post(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/octt/runs',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it.each([
    ['csms', 'ocpp2.0.1'],
    ['cs', 'ocpp2.1'],
    ['cs', 'ocpp2.0.1'],
    ['cs', 'ocpp1.6'],
    ['cs', 'all'],
  ])('accepts sutType %s with %s', async (sutType, ocppVersion) => {
    const response = await post({ sutType, ocppVersion });

    expect(response.statusCode).toBe(201);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ sutType, ocppVersion }));
    expect(publish).toHaveBeenCalledWith('octt_run', expect.stringContaining(`"${sutType}"`));
  });
});
