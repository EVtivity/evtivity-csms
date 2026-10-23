// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A security profile change through PATCH /v1/stations/:id or the simulator
// PATCH sends SetNetworkProfile or ChangeConfiguration: it needs
// settings.stationConfig:write on top of stations:write.
// A password change stays on stations:write.

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

const { dbCall, securityService } = vi.hoisted(() => ({
  dbCall: vi.fn(() => {
    throw new Error('database not available in this test');
  }),
  securityService: {
    changeSecurityProfile: vi.fn(),
    changeStationPassword: vi.fn(),
  },
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
vi.mock('../services/station-security.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/station-security.service.js')>()),
  changeSecurityProfile: securityService.changeSecurityProfile,
  changeStationPassword: securityService.changeStationPassword,
}));

import { registerAuth } from '../plugins/auth.js';
import { stationRoutes } from '../routes/stations.js';
import { cssRoutes } from '../routes/css.js';
import { setMockPermissions } from './helpers/rbac-permission-mock.js';

describe('security profile changes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
    stationRoutes(app);
    cssRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbCall.mockClear();
    securityService.changeSecurityProfile.mockClear();
  });

  function patch(url: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it.each(['/stations/sta_000000000001', '/css/stations/CS-1'])(
    'PATCH %s refuses a profile change with stations:write alone before any read',
    async (url) => {
      setMockPermissions(['stations:read', 'stations:write']);
      const res = await patch(url, { securityProfile: 2 });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
      expect(dbCall).not.toHaveBeenCalled();
      expect(securityService.changeSecurityProfile).not.toHaveBeenCalled();
    },
  );

  it.each(['/stations/sta_000000000001', '/css/stations/CS-1'])(
    'PATCH %s passes the check with settings.stationConfig:write, and a password change without it',
    async (url) => {
      setMockPermissions(['stations:write', 'settings.stationConfig:write']);
      const profile = await patch(url, { securityProfile: 2 });
      expect(profile.statusCode).not.toBe(403);
      setMockPermissions(['stations:write']);
      const password = await patch(url, { password: 'NewStationPass12345' });
      expect(password.statusCode).not.toBe(403);
    },
  );
});
