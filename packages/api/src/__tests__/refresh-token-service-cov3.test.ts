// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Refresh token reads that never rotate (who a token belongs to), the device
// binding of a rotation and the driver sign-out revoke.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  wheres: [] as unknown[],
  updates: 0,
}));

vi.mock('@evtivity/database', () => {
  function chain(kind: string): unknown {
    if (kind === 'update') state.updates += 1;
    const proxy: Record<string, unknown> = {};
    for (const name of ['from', 'where', 'set', 'returning']) {
      proxy[name] = (...args: unknown[]) => {
        if (name === 'where') state.wheres.push(args[0]);
        return proxy;
      };
    }
    proxy['then'] = (resolve: (v: unknown) => void) => {
      resolve(state.results.shift() ?? []);
    };
    return proxy;
  }
  return {
    db: {
      select: () => chain('select'),
      update: () => chain('update'),
      delete: () => chain('delete'),
      insert: () => chain('insert'),
    },
    driverPushTokens: { driverId: 'pt.driverId' },
    drivers: { id: 'drivers.id', sessionVersion: 'drivers.sv' },
    refreshTokens: {
      id: 'rt.id',
      userId: 'rt.userId',
      driverId: 'rt.driverId',
      deviceId: 'rt.deviceId',
      tokenHash: 'rt.tokenHash',
      type: 'rt.type',
      expiresAt: 'rt.expiresAt',
      revokedAt: 'rt.revokedAt',
    },
  };
});
vi.mock('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...c: unknown[]) => ({ and: c }),
  isNull: (a: unknown) => ({ isNull: a }),
  isNotNull: (a: unknown) => ({ isNotNull: a }),
  sql: () => ({ sql: true }),
}));
vi.mock('../lib/device-cookie.js', () => ({ revokeSignInDevices: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/driver-active.js', () => ({ announceDriverSessionChange: vi.fn() }));

import {
  revokeRefreshToken,
  sessionRefreshTokenDriverId,
  sessionRefreshTokenUserId,
  validateAndRotateRefreshToken,
} from '../services/refresh-token.service.js';

const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 86_400_000);

beforeEach(() => {
  state.results = [];
  state.wheres = [];
  state.updates = 0;
});

describe('validateAndRotateRefreshToken device binding', () => {
  it('refuses a device-bound token from another device without rotating it', async () => {
    state.results.push([{ id: 1, driverId: 'drv_1', deviceId: 'dev-a', revokedAt: null }]);
    expect(
      await validateAndRotateRefreshToken('raw', { realm: 'driver', deviceId: 'dev-b' }),
    ).toBeNull();
    expect(state.updates).toBe(0);
  });

  it('rotates a device-bound token from its own device', async () => {
    state.results.push(
      [
        {
          id: 1,
          userId: null,
          driverId: 'drv_1',
          deviceId: 'dev-a',
          revokedAt: null,
          client: 'mobile',
        },
      ],
      [{ id: 1 }],
    );
    expect(
      await validateAndRotateRefreshToken('raw', { realm: 'driver', deviceId: 'dev-a' }),
    ).toEqual({ userId: null, driverId: 'drv_1', tokenId: 1, client: 'mobile' });
  });
});

describe('sessionRefreshTokenUserId', () => {
  it('names the operator of a live web token only', async () => {
    const base = { userId: 'usr_1', deviceId: null, revokedAt: null, expiresAt: future };
    state.results.push([base]);
    expect(await sessionRefreshTokenUserId('raw')).toBe('usr_1');
    state.results.push([{ ...base, expiresAt: null }]);
    expect(await sessionRefreshTokenUserId('raw')).toBe('usr_1');
    state.results.push([]);
    expect(await sessionRefreshTokenUserId('raw')).toBeNull();
    state.results.push([{ ...base, revokedAt: past }]);
    expect(await sessionRefreshTokenUserId('raw')).toBeNull();
    state.results.push([{ ...base, deviceId: 'dev' }]);
    expect(await sessionRefreshTokenUserId('raw')).toBeNull();
    state.results.push([{ ...base, expiresAt: past }]);
    expect(await sessionRefreshTokenUserId('raw')).toBeNull();
    expect(JSON.stringify(state.wheres[0])).toContain('"rt.type","session"');
  });
});

describe('sessionRefreshTokenDriverId', () => {
  it('names the driver of a live token bound to this device or none', async () => {
    const base = { driverId: 'drv_1', deviceId: null, revokedAt: null, expiresAt: future };
    state.results.push([base]);
    expect(await sessionRefreshTokenDriverId('raw', undefined)).toBe('drv_1');
    state.results.push([{ ...base, deviceId: 'dev-a', expiresAt: null }]);
    expect(await sessionRefreshTokenDriverId('raw', 'dev-a')).toBe('drv_1');
    state.results.push([{ ...base, deviceId: 'dev-a' }]);
    expect(await sessionRefreshTokenDriverId('raw', 'dev-b')).toBeNull();
    state.results.push([]);
    expect(await sessionRefreshTokenDriverId('raw', undefined)).toBeNull();
    state.results.push([{ ...base, revokedAt: past }]);
    expect(await sessionRefreshTokenDriverId('raw', undefined)).toBeNull();
    state.results.push([{ ...base, expiresAt: past }]);
    expect(await sessionRefreshTokenDriverId('raw', undefined)).toBeNull();
  });
});

describe('revokeRefreshToken', () => {
  it('revokes only a session token of the driver owner', async () => {
    await revokeRefreshToken('raw', { driverId: 'drv_1' });
    const where = JSON.stringify(state.wheres[0]);
    expect(where).toContain('"rt.driverId","drv_1"');
    expect(where).not.toContain('rt.userId');
    expect(where).toContain('"rt.type","session"');
  });
});
