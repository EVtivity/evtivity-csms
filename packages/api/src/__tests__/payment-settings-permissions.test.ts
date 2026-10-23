// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Payment provider settings (Stripe, Adyen, the provider selection, their test
// and webhook routes) need settings.payment:*, never payments:* alone. An all-site operator with
// payments:read and payments:write gets 403 before any read or write.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);
vi.mock('../middleware/rbac.js', async () =>
  (await import('./helpers/rbac-permission-mock.js')).rbacPermissionMock(),
);

// Any database access fails the test: the permission check answers before it.
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
import { paymentRoutes } from '../routes/payments.js';
import { adyenSettingsRoutes } from '../routes/adyen-settings.js';
import { paymentSettingsRoutes } from '../routes/payment-settings.js';
import { setMockPermissions } from './helpers/rbac-permission-mock.js';

const ROUTES = [
  ['GET', '/settings/stripe', 'settings.payment:read'],
  ['PUT', '/settings/stripe', 'settings.payment:write'],
  ['POST', '/settings/stripe/test', 'settings.payment:write'],
  ['GET', '/settings/stripe/webhook', 'settings.payment:read'],
  ['POST', '/settings/stripe/webhook', 'settings.payment:write'],
  ['GET', '/settings/adyen', 'settings.payment:read'],
  ['PUT', '/settings/adyen', 'settings.payment:write'],
  ['POST', '/settings/adyen/test', 'settings.payment:write'],
  ['GET', '/settings/adyen/webhook', 'settings.payment:read'],
  ['POST', '/settings/adyen/webhook', 'settings.payment:write'],
  ['GET', '/settings/payments', 'settings.payment:read'],
  ['PUT', '/settings/payments', 'settings.payment:write'],
] as const;

describe('payment provider settings permissions', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    // The permission check runs before validation: accept any body.
    app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
    paymentRoutes(app);
    adyenSettingsRoutes(app);
    paymentSettingsRoutes(app);
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
      method: method as 'GET' | 'POST' | 'PUT',
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(method === 'GET' ? {} : { payload: {} }),
    });
  }

  it.each(ROUTES)('%s %s refuses payments:* without %s', async (method, url) => {
    setMockPermissions(['payments:read', 'payments:write']);
    const res = await send(method, url);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(dbCall).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s %s passes the permission check with %s', async (method, url, perm) => {
    setMockPermissions([perm]);
    const res = await send(method, url);
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });
});
