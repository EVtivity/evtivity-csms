// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A simulator connects only to the OCPP server: the CSS create and PATCH routes
// refuse a target URL on another origin with 400 VALIDATION_ERROR before any
// read or write.

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
vi.mock('@evtivity/ocpp', () => ({ ActionRegistry: {}, ActionRegistry16: {} }));

const { dbCall } = vi.hoisted(() => {
  process.env['OCPP_SERVER_URL'] = 'ws://ocpp:7103';
  process.env['OCPP_TLS_SERVER_URL'] = 'wss://ocpp:8443';
  return {
    dbCall: vi.fn(() => {
      throw new Error('database not available in this test');
    }),
  };
});
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
import { cssRoutes } from '../routes/css.js';
import { setMockPermissions } from './helpers/rbac-permission-mock.js';

describe('simulator target URL', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
    cssRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
    setMockPermissions(['stations:write']);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbCall.mockClear();
  });

  function send(method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  }

  it.each([
    ['POST', '/css/stations', { stationId: 'CS-SIM-1', targetUrl: 'ws://evil.example/' }],
    ['PATCH', '/css/stations/CS-SIM-1', { targetUrl: 'wss://evil.example:8443' }],
  ] as const)('%s %s refuses a foreign target before any read', async (method, url, body) => {
    const res = await send(method, url, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(dbCall).not.toHaveBeenCalled();
  });

  it('lets the OCPP server URL through the check (control)', async () => {
    const res = await send('PATCH', '/css/stations/CS-SIM-1', { targetUrl: 'wss://ocpp:8443' });
    expect(res.statusCode).not.toBe(400);
  });
});
