// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updates, failNext } = vi.hoisted(() => ({
  updates: [] as Array<{ set: unknown; where: unknown }>,
  failNext: { value: false },
}));

vi.mock('@evtivity/database', () => {
  const update = () => {
    const op: { set: unknown; where: unknown } = { set: undefined, where: undefined };
    const chain: Record<string, unknown> = {
      set: (v: unknown) => {
        op.set = v;
        return chain;
      },
      where: (w: unknown) => {
        op.where = w;
        updates.push(op);
        return chain;
      },
      then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) => {
        if (failNext.value) {
          failNext.value = false;
          return Promise.reject(new Error('db down')).then(resolve, reject);
        }
        return Promise.resolve([]).then(resolve, reject);
      },
    };
    return chain;
  };
  return {
    db: { update },
    userTokens: { userId: 'user_id', type: 'type', revokedAt: 'revoked_at' },
  };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
}));

const mocks = vi.hoisted(() => ({
  bumpSessionVersion: vi.fn().mockResolvedValue(2),
  announceSessionChange: vi.fn(),
  invalidatePermissionCache: vi.fn(),
  invalidateSiteAccessCache: vi.fn(),
  revokeAllUserRefreshTokens: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/operator-session.js', () => ({
  bumpSessionVersion: mocks.bumpSessionVersion,
  announceSessionChange: mocks.announceSessionChange,
}));
vi.mock('../middleware/rbac.js', () => ({
  invalidatePermissionCache: mocks.invalidatePermissionCache,
}));
vi.mock('../lib/site-access.js', () => ({
  invalidateSiteAccessCache: mocks.invalidateSiteAccessCache,
}));
vi.mock('../services/refresh-token.service.js', () => ({
  revokeAllUserRefreshTokens: mocks.revokeAllUserRefreshTokens,
}));

import {
  applyUserDeactivation,
  revokeUserEmailLinks,
  USER_EMAIL_LINK_TYPES,
} from '../services/user-status.service.js';

const USER_ID = 'usr_000000000001';

describe('user status service', () => {
  beforeEach(() => {
    updates.length = 0;
    failNext.value = false;
  });

  it('revokes the open emailed links of the user', async () => {
    await revokeUserEmailLinks(USER_ID);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set).toEqual({ revokedAt: expect.any(Date) });
    expect(updates[0]!.where).toEqual({
      and: [
        { eq: ['user_id', USER_ID] },
        { inArray: ['type', [...USER_EMAIL_LINK_TYPES]] },
        { isNull: 'revoked_at' },
      ],
    });
  });

  it('ends sessions, API keys, links, caches and streams of a deactivated user', async () => {
    const log = { warn: vi.fn() };
    await applyUserDeactivation(USER_ID, { log });
    expect(mocks.bumpSessionVersion).toHaveBeenCalledWith(USER_ID);
    expect(mocks.announceSessionChange).toHaveBeenCalledWith(USER_ID);
    expect(mocks.invalidatePermissionCache).toHaveBeenCalledWith(USER_ID);
    expect(mocks.invalidateSiteAccessCache).toHaveBeenCalledWith(USER_ID);
    expect(mocks.revokeAllUserRefreshTokens).toHaveBeenCalledWith(USER_ID);
    expect(updates).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs a failed step and still ends the streams (fail-open)', async () => {
    mocks.bumpSessionVersion.mockRejectedValueOnce(new Error('db down'));
    failNext.value = true;
    const log = { warn: vi.fn() };
    await applyUserDeactivation(USER_ID, { log });
    expect(mocks.announceSessionChange).toHaveBeenCalledWith(USER_ID);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
