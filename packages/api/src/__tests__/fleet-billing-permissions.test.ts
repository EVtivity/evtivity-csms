// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Fleet billing changes money: account billing, the billing profile, the
// credit limit and a member's opt-out need payments:write on top of
// fleets:write, and the credit limit read payments:read.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);
vi.mock('../middleware/rbac.js', async () =>
  (await import('./helpers/rbac-permission-mock.js')).rbacPermissionMock(),
);
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn() }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  setPubSub: vi.fn(),
}));

const { dbCall } = vi.hoisted(() => ({
  dbCall: vi.fn(() => {
    throw new Error('the database must not be read or written');
  }),
}));
vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: {
    select: dbCall,
    insert: dbCall,
    update: dbCall,
    delete: dbCall,
    execute: dbCall,
    transaction: dbCall,
  },
}));

import { registerAuth } from '../plugins/auth.js';
import { fleetRoutes } from '../routes/fleets.js';
import { setMockPermissions } from './helpers/rbac-permission-mock.js';

const FLEET = 'flt_000000000001';
const ROUTES = [
  ['PATCH', `/fleets/${FLEET}/billing`, 'payments:write'],
  ['PATCH', `/fleets/${FLEET}/billing-profile`, 'payments:write'],
  ['PATCH', `/fleets/${FLEET}/credit-limit`, 'payments:write'],
  ['PATCH', `/fleets/${FLEET}/drivers/drv_000000000001`, 'payments:write'],
  ['GET', `/fleets/${FLEET}/credit-limit`, 'payments:read'],
] as const;

describe('fleet billing permissions', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
    fleetRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbCall.mockClear();
  });

  function send(method: string, url: string) {
    return app.inject({
      method: method as 'GET' | 'PATCH',
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(method === 'GET' ? {} : { payload: {} }),
    });
  }

  it.each(ROUTES)('%s %s refuses fleets:* without %s', async (method, url) => {
    setMockPermissions(['fleets:read', 'fleets:write']);
    const res = await send(method, url);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(dbCall).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s %s passes the check with fleets and %s', async (method, url, perm) => {
    setMockPermissions(['fleets:write', perm]);
    const res = await send(method, url);
    expect(res.statusCode).not.toBe(403);
  });
});
