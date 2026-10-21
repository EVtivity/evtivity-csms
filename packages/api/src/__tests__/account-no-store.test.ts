// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { isAccountRoute, registerAccountNoStore } from '../plugins/account-no-store.js';

describe('account replies are never cached', () => {
  it('names the account and sign-in routes', () => {
    for (const path of [
      '/v1/users/me',
      '/v1/users/me/mfa',
      '/v1/users/me/webauthn',
      '/v1/auth/mfa/verify',
      '/v1/portal/auth/login',
      '/v1/portal/driver/mfa',
      '/v1/portal/driver/webauthn',
      '/v1/api-keys',
      '/v1/api-keys/:id',
      // Admin views of an account (security review Info).
      '/v1/users',
      '/v1/users/:id',
      '/v1/users/:id/api-keys',
      '/v1/drivers',
      '/v1/drivers/:id',
      '/v1/drivers/:id/tokens',
    ]) {
      expect(isAccountRoute(path), path).toBe(true);
    }
    for (const path of [
      '/v1/stations',
      '/v1/usersettings',
      '/v1/driversx',
      '/v1/portal/chargers',
      '/v1/ocpp/schemas',
    ]) {
      expect(isAccountRoute(path), path).toBe(false);
    }
  });

  it('sends no-store on an account route and keeps a header a route set', async () => {
    const app = Fastify();
    registerAccountNoStore(app);
    app.get('/v1/users/me/mfa', async () => ({ mfaEnabled: false }));
    app.get('/v1/stations', async () => []);
    app.get('/v1/auth/own', async (_request, reply) => {
      void reply.header('Cache-Control', 'no-cache');
      return {};
    });
    await app.ready();
    const mfa = await app.inject({ method: 'GET', url: '/v1/users/me/mfa' });
    expect(mfa.headers['cache-control']).toBe('no-store');
    const stations = await app.inject({ method: 'GET', url: '/v1/stations' });
    expect(stations.headers['cache-control']).toBeUndefined();
    const own = await app.inject({ method: 'GET', url: '/v1/auth/own' });
    expect(own.headers['cache-control']).toBe('no-cache');
    await app.close();
  });
});
