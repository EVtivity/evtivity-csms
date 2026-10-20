// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const { state, getSsoConfig, revokeAllUserRefreshTokens, revokeAllUserSessions, publish } =
  vi.hoisted(() => ({
    state: { results: [] as unknown[][], updates: [] as Array<Record<string, unknown>> },
    getSsoConfig: vi.fn(),
    revokeAllUserRefreshTokens: vi.fn().mockResolvedValue(undefined),
    revokeAllUserSessions: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@evtivity/database', () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'returning']) c[m] = () => c;
    c['set'] = (values: Record<string, unknown>) => {
      state.updates.push(values);
      return c;
    };
    c['then'] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(state.results.shift() ?? []).then(resolve);
    return c;
  };
  return {
    db: { select: () => chain(), update: () => chain() },
    getSsoConfig,
    users: { id: 'id', sessionVersion: 'session_version', authSource: 'auth_source' },
    userTokens: {},
  };
});
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ publish }) }));
vi.mock('../services/refresh-token.service.js', () => ({
  createRefreshToken: vi.fn().mockResolvedValue({ rawToken: 'refresh', expiresAt: new Date() }),
  revokeAllUserRefreshTokens,
  revokeAllUserSessions,
}));

import { verifyPassword } from '../lib/password-verify.js';
import { isLocked, lockSecondsAfter, secondsUntil } from '../lib/sign-in-backoff.js';
import {
  endUserSessions,
  passwordAuthBlocked,
  signOperatorAccessToken,
  ssoManagedUser,
} from '../lib/operator-session.js';

describe('verifyPassword', () => {
  it('answers false without throwing for an empty, missing or malformed hash', async () => {
    expect(await verifyPassword('', 'Password123')).toBe(false);
    expect(await verifyPassword(null, 'Password123')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'Password123')).toBe(false);
    const warn = vi.fn();
    expect(await verifyPassword('$argon2id$broken', 'Password123', { warn })).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('checks a real argon2 hash', async () => {
    const argon2 = (await import('argon2')).default;
    const hash = await argon2.hash('Password123');
    expect(await verifyPassword(hash, 'Password123')).toBe(true);
    expect(await verifyPassword(hash, 'Wrong123')).toBe(false);
  });
});

describe('sign-in backoff', () => {
  it('locks from the fifth failure, doubling from 30 s up to 15 minutes', () => {
    expect(lockSecondsAfter(4)).toBe(0);
    expect(lockSecondsAfter(5)).toBe(30);
    expect(lockSecondsAfter(6)).toBe(60);
    expect(lockSecondsAfter(8)).toBe(240);
    expect(lockSecondsAfter(50)).toBe(900);
  });

  it('tells a lock in the future apart from an ended one', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked(new Date('2026-10-14T11:59:59Z'), now)).toBe(false);
    expect(isLocked(new Date('2026-10-14T12:00:30Z'), now)).toBe(true);
    expect(secondsUntil(new Date('2026-10-14T12:00:30Z'), now)).toBe(30);
    expect(secondsUntil(new Date('2026-10-14T12:00:00.100Z'), now)).toBe(1);
  });
});

describe('operator sessions', () => {
  beforeEach(() => {
    state.results = [];
    state.updates = [];
    getSsoConfig.mockReset();
  });

  it('signs the session version into the access token', async () => {
    const app = Fastify();
    await app.register((await import('@fastify/jwt')).default, { secret: 'x'.repeat(32) });
    const token = signOperatorAccessToken(
      app,
      { id: 'usr_1', roleId: 'rol_1', sessionVersion: 7 },
      900,
    );
    const claims = app.jwt.verify<Record<string, number | string>>(token);
    expect(claims).toMatchObject({ userId: 'usr_1', roleId: 'rol_1', sv: 7 });
    expect(Number(claims['exp']) - Number(claims['iat'])).toBe(900);
    await app.close();
  });

  it('ends sessions: version, refresh tokens or API keys, and the cache_invalidate message', async () => {
    state.results = [[{ sessionVersion: 3 }]];
    expect(await endUserSessions('usr_1', { apiKeys: true })).toBe(3);
    expect(revokeAllUserRefreshTokens).toHaveBeenCalledWith('usr_1');
    expect(revokeAllUserSessions).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      'cache_invalidate',
      JSON.stringify({ kind: 'active', userId: 'usr_1' }),
    );

    state.results = [[{ sessionVersion: 4 }]];
    expect(await endUserSessions('usr_1', { apiKeys: false })).toBe(4);
    expect(revokeAllUserSessions).toHaveBeenCalledWith('usr_1');
  });

  it('blocks password auth for an SSO account only while SSO is enabled', async () => {
    getSsoConfig.mockResolvedValue({ enabled: true });
    expect(await passwordAuthBlocked({ authSource: 'sso' })).toBe(true);
    expect(await passwordAuthBlocked({ authSource: 'password' })).toBe(false);
    getSsoConfig.mockResolvedValue(null);
    expect(await passwordAuthBlocked({ authSource: 'sso' })).toBe(false);
  });

  it('reads the account source for ssoManagedUser', async () => {
    getSsoConfig.mockResolvedValue({ enabled: true });
    state.results = [[{ authSource: 'sso' }]];
    expect(await ssoManagedUser('usr_1')).toBe(true);
    state.results = [[]];
    expect(await ssoManagedUser('usr_2')).toBe(false);
  });
});
