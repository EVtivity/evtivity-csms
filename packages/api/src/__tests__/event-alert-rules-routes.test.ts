// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

const { inserted, insertCalls } = vi.hoisted(() => ({
  inserted: { rows: [] as unknown[] },
  insertCalls: [] as Array<{ method: string; args: unknown[] }>,
}));

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

vi.mock('@evtivity/database', async (importOriginal) => {
  const chain: Record<string, unknown> = {};
  for (const m of ['values', 'onConflictDoNothing', 'returning']) {
    chain[m] = (...args: unknown[]) => {
      insertCalls.push({ method: m, args });
      return chain;
    };
  }
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(inserted.rows).then(resolve);
  return {
    ...(await importOriginal<typeof import('@evtivity/database')>()),
    db: { insert: () => chain },
  };
});

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
}));

import { registerAuth } from '../plugins/auth.js';
import { eventAlertRuleRoutes } from '../routes/event-alert-rules.js';

describe('POST /event-alert-rules', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    eventAlertRuleRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    insertCalls.length = 0;
  });

  function create(): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/event-alert-rules',
      headers: { authorization: `Bearer ${token}` },
      payload: { component: 'Connector', variable: 'AvailabilityState' },
    });
  }

  it('answers 409 DUPLICATE_ALERT_RULE when the component and variable have a rule', async () => {
    inserted.rows = [];
    const res = await create();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'An alert rule for this component and variable already exists',
      code: 'DUPLICATE_ALERT_RULE',
    });
    expect(insertCalls.map((c) => c.method)).toEqual([
      'values',
      'onConflictDoNothing',
      'returning',
    ]);
  });

  it('creates the rule otherwise', async () => {
    const now = new Date().toISOString();
    inserted.rows = [
      {
        id: 1,
        component: 'Connector',
        variable: 'AvailabilityState',
        minSeverity: 0,
        isEnabled: true,
        notifyChannel: 'email',
        notifyRecipient: '$admin',
        createdAt: now,
        updatedAt: now,
      },
    ];
    const res = await create();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 1, component: 'Connector' });
  });
});
