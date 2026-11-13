// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The SSO subject bind: the guarded UPDATE and its audit, the pending bind kept
// against an MFA token in Redis, voided by an unlink, completed once.

import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

interface UpdateState {
  updateResult: unknown;
  updateError: Error | null;
  set: Record<string, unknown> | null;
  where: unknown;
}

const state = vi.hoisted(() => {
  const s: UpdateState = { updateResult: [], updateError: null, set: null, where: null };
  return s;
});

const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  const multiCalls: unknown[][] = [];
  const r = {
    store,
    multiCalls,
    fail: false,
    getdel: vi.fn((key: string) => {
      if (r.fail) return Promise.reject(new Error('redis down'));
      const v = store.get(key) ?? null;
      store.delete(key);
      return Promise.resolve(v);
    }),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    multi: vi.fn(() => {
      const m = {
        set: (...args: unknown[]) => {
          multiCalls.push(args);
          store.set(args[0] as string, args[1] as string);
          return m;
        },
        exec: () => Promise.resolve([]),
      };
      return m;
    }),
  };
  return r;
});

const writeAudit = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ and: c }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
}));
vi.mock('@evtivity/database', () => ({
  db: {
    update: () => ({
      set: (s: Record<string, unknown>) => {
        state.set = s;
        return {
          where: (w: unknown) => {
            state.where = w;
            return {
              returning: () =>
                state.updateError != null
                  ? Promise.reject(state.updateError)
                  : Promise.resolve(state.updateResult),
            };
          },
        };
      },
    }),
  },
  pgErrorCode: (err: unknown) => (err as { code?: string }).code,
  PG_UNIQUE_VIOLATION: '23505',
  userAuditLog: { name: 'userAuditLog' },
  users: { id: 'users.id', ssoSubject: 'users.ssoSubject', ssoLinkAllowed: 'users.ssoLinkAllowed' },
  writeAudit,
}));
vi.mock('@evtivity/lib', () => ({ createRedisClient: () => redis }));
vi.mock('../lib/config.js', () => ({ config: { REDIS_URL: 'redis://test' } }));

import {
  SSO_LINK_KEY_PREFIX,
  bearerToken,
  completePendingSsoLink,
  linkSsoSubject,
  rememberPendingSsoLink,
  voidPendingSsoLink,
} from '../lib/sso-link.js';

const log = { warn: vi.fn() };
const keyOf = (token: string): string =>
  `${SSO_LINK_KEY_PREFIX}${crypto.createHash('sha256').update(token).digest('hex')}`;

beforeEach(() => {
  state.updateResult = [{ id: 'usr_1' }];
  state.updateError = null;
  state.set = null;
  redis.store.clear();
  redis.multiCalls.length = 0;
  redis.fail = false;
});

describe('linkSsoSubject', () => {
  it('binds once, clears the link permission and audits', async () => {
    expect(await linkSsoSubject('usr_1', 'idp|sub', log)).toBe(true);
    expect(state.set).toMatchObject({
      ssoSubject: 'idp|sub',
      ssoLinkAllowed: false,
      updatedAt: expect.any(Date),
    });
    expect(JSON.stringify(state.where)).toContain('"users.ssoLinkAllowed",true');
    expect(writeAudit).toHaveBeenCalledWith(
      { table: { name: 'userAuditLog' }, idColumn: 'user_id' },
      expect.objectContaining({
        entityId: 'usr_1',
        action: 'updated',
        actorLabel: 'sso',
        after: { ssoLinked: true },
      }),
      expect.anything(),
      log,
    );
  });

  it('binds nothing when no row matched', async () => {
    state.updateResult = [];
    expect(await linkSsoSubject('usr_1', 's', log)).toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('answers false for a subject another account holds and rethrows other errors', async () => {
    state.updateError = Object.assign(new Error('dup'), { code: '23505' });
    expect(await linkSsoSubject('usr_1', 's', log)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      { userId: 'usr_1' },
      'SSO subject already bound to another account, not linking',
    );
    state.updateError = Object.assign(new Error('boom'), { code: '57P01' });
    await expect(linkSsoSubject('usr_1', 's', log)).rejects.toThrow('boom');
  });
});

describe('pending binds', () => {
  it('keeps the bind under the token hash and the user key for 15 minutes', async () => {
    await rememberPendingSsoLink('tok', 'usr_1', 'sub');
    expect(redis.multiCalls).toEqual([
      [keyOf('tok'), JSON.stringify({ userId: 'usr_1', subject: 'sub' }), 'EX', 900],
      [`${SSO_LINK_KEY_PREFIX}user:usr_1`, keyOf('tok'), 'EX', 900],
    ]);
  });

  it('completes a bind once for the same account', async () => {
    await rememberPendingSsoLink('tok', 'usr_1', 'sub');
    await completePendingSsoLink('tok', 'usr_1', log);
    expect(state.set).toMatchObject({ ssoSubject: 'sub' });
    state.set = null;
    await completePendingSsoLink('tok', 'usr_1', log);
    expect(state.set).toBeNull();
  });

  it('binds nothing for another account or a malformed record', async () => {
    await rememberPendingSsoLink('tok', 'usr_1', 'sub');
    await completePendingSsoLink('tok', 'usr_2', log);
    expect(state.set).toBeNull();
    redis.store.set(keyOf('t2'), JSON.stringify({ userId: 'usr_1', subject: 5 }));
    await completePendingSsoLink('t2', 'usr_1', log);
    expect(state.set).toBeNull();
  });

  it('logs a failed completion and never throws', async () => {
    redis.store.set(keyOf('t3'), '{not json');
    await completePendingSsoLink('t3', 'usr_1', log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_1' }),
      'The SSO subject of the completed MFA step was not bound',
    );
  });

  it('voids the pending bind of an account', async () => {
    await rememberPendingSsoLink('tok', 'usr_1', 'sub');
    await voidPendingSsoLink('usr_1', log);
    expect(redis.del).toHaveBeenCalledWith(keyOf('tok'));
    await completePendingSsoLink('tok', 'usr_1', log);
    expect(state.set).toBeNull();
    // Nothing pending: no delete.
    await voidPendingSsoLink('usr_9', log);
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it('logs a void that Redis refused', async () => {
    redis.fail = true;
    await voidPendingSsoLink('usr_1', log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_1' }),
      'The pending SSO bind was not voided; the session version ends it',
    );
  });
});

describe('bearerToken', () => {
  it('reads the raw Bearer token, else an empty string', () => {
    const req = (authorization?: string): FastifyRequest =>
      ({
        headers: authorization === undefined ? {} : { authorization },
      }) as unknown as FastifyRequest;
    expect(bearerToken(req('Bearer abc.def'))).toBe('abc.def');
    expect(bearerToken(req('bearer   xyz'))).toBe('xyz');
    expect(bearerToken(req())).toBe('');
  });
});
