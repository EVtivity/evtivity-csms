// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

const { inserted, insertCalls, queued, writeAudit } = vi.hoisted(() => ({
  inserted: { rows: [] as unknown[] },
  insertCalls: [] as Array<{ method: string; args: unknown[] }>,
  // Results of select, update and delete chains, in call order.
  queued: [] as unknown[][],
  writeAudit: vi.fn((..._args: unknown[]) => Promise.resolve()),
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
  const queryChain = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'set', 'returning']) q[m] = () => q;
    q['then'] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(queued.shift() ?? []).then(resolve);
    return q;
  };
  return {
    ...(await importOriginal<typeof import('@evtivity/database')>()),
    db: {
      insert: () => chain,
      select: () => queryChain(),
      update: () => queryChain(),
      delete: () => queryChain(),
    },
    writeAudit,
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
    queued.length = 0;
    writeAudit.mockClear();
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
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0]?.[0]).toMatchObject({ idColumn: 'event_alert_rule_id' });
    expect(writeAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: '1',
      entityIdSnapshot: '1',
      action: 'created',
      actor: 'operator',
      actorUserId: 'usr_000000000001',
      after: { id: 1, component: 'Connector', variable: 'AvailabilityState' },
    });
  });

  it('writes no audit row for a duplicate', async () => {
    inserted.rows = [];
    await create();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  const rule = {
    id: 3,
    component: 'Connector',
    variable: 'AvailabilityState',
    minSeverity: 0,
    isEnabled: true,
    notifyChannel: 'email',
    notifyRecipient: '$admin',
  };

  it('PATCH audits only the changed fields', async () => {
    queued.push([rule], [{ ...rule, isEnabled: false, minSeverity: 0 }]);
    const res = await app.inject({
      method: 'PATCH',
      url: '/event-alert-rules/3',
      headers: { authorization: `Bearer ${token}` },
      payload: { isEnabled: false, minSeverity: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: '3',
      action: 'updated',
      before: { isEnabled: true },
      after: { isEnabled: false },
    });
  });

  it('PATCH with no change writes no audit row', async () => {
    queued.push([rule], [rule]);
    const res = await app.inject({
      method: 'PATCH',
      url: '/event-alert-rules/3',
      headers: { authorization: `Bearer ${token}` },
      payload: { isEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('PATCH of a missing rule answers 404 without an audit row', async () => {
    queued.push([], []);
    const res = await app.inject({
      method: 'PATCH',
      url: '/event-alert-rules/9',
      headers: { authorization: `Bearer ${token}` },
      payload: { isEnabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('DELETE audits the deleted rule', async () => {
    queued.push([rule]);
    const res = await app.inject({
      method: 'DELETE',
      url: '/event-alert-rules/3',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(writeAudit.mock.calls[0]?.[1]).toMatchObject({
      entityId: null,
      entityIdSnapshot: '3',
      action: 'deleted',
      before: rule,
    });
  });
});
