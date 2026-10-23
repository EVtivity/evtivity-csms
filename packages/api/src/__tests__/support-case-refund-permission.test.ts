// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A support case refund moves money: it needs payments:write on top of
// support:write. Without it the route answers 403 before any read and the provider is never called.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);
vi.mock('../middleware/rbac.js', async () =>
  (await import('./helpers/rbac-permission-mock.js')).rbacPermissionMock(),
);

const { dbCall, refundPaymentRecord } = vi.hoisted(() => ({
  dbCall: vi.fn(() => {
    throw new Error('database not available in this test');
  }),
  refundPaymentRecord: vi.fn(),
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
vi.mock('@evtivity/payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/payments')>()),
  refundPaymentRecord,
}));

import { registerAuth } from '../plugins/auth.js';
import { supportCaseRoutes } from '../routes/support-cases.js';
import { setMockPermissions } from './helpers/rbac-permission-mock.js';

describe('support case refund permission', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
    supportCaseRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbCall.mockClear();
    refundPaymentRecord.mockClear();
  });

  function refund() {
    return app.inject({
      method: 'POST',
      url: '/support-cases/case_000000000001/refund',
      headers: { authorization: `Bearer ${token}` },
      payload: { sessionId: 'ses_000000000001', amountCents: 100 },
    });
  }

  it('refuses support:write without payments:write and never calls the provider', async () => {
    setMockPermissions(['support:read', 'support:write']);
    const res = await refund();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(dbCall).not.toHaveBeenCalled();
    expect(refundPaymentRecord).not.toHaveBeenCalled();
  });

  it('passes the permission check with support:write and payments:write', async () => {
    setMockPermissions(['support:write', 'payments:write']);
    const res = await refund();
    expect(res.statusCode).not.toBe(403);
  });
});
