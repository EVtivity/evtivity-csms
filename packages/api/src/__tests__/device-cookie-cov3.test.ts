// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Sign-in device cookies against a recorded query builder: the device of a
// valid cookie, the failure ceiling, the device try and its lock audit, a new
// device with the eviction and the cookie, and the revocation.

import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface Op {
  kind: string;
  table: unknown;
  calls: [string, unknown[]][];
}

interface CookieRead {
  status: string;
  value?: string;
}

const state = vi.hoisted(() => {
  const cookie: CookieRead = { status: 'missing' };
  return { results: [] as unknown[], ops: [] as Op[], cookie };
});
const writeAudit = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('drizzle-orm', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings.join('?'),
    values,
  });
  return {
    sql,
    and: (...c: unknown[]) => ({ and: c }),
    eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
    desc: (a: unknown) => ({ desc: a }),
    notInArray: (a: unknown, b: unknown) => ({ notInArray: [a, b] }),
  };
});

vi.mock('@evtivity/database', () => {
  function chain(kind: string, table: unknown): unknown {
    const op: Op = { kind, table, calls: [] };
    state.ops.push(op);
    const proxy: Record<string, unknown> = {};
    for (const name of ['from', 'where', 'set', 'values', 'returning', 'orderBy', 'limit']) {
      proxy[name] = (...args: unknown[]) => {
        op.calls.push([name, args]);
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
      select: (c: unknown) => chain('select', c),
      update: (t: unknown) => chain('update', t),
      insert: (t: unknown) => chain('insert', t),
      delete: (t: unknown) => chain('delete', t),
    },
    signInDevices: {
      id: 'd.id',
      userId: 'd.userId',
      driverId: 'd.driverId',
      tokenHash: 'd.tokenHash',
      failedCount: 'd.failedCount',
      lockedUntil: 'd.lockedUntil',
      lastUsedAt: 'd.lastUsedAt',
    },
    userAuditLog: { name: 'userAuditLog' },
    driverAuditLog: { name: 'driverAuditLog' },
    writeAudit,
  };
});
vi.mock('../lib/auth-cookies.js', () => ({
  readSignedCookie: (_req: unknown, name: string) => ({ ...state.cookie, name }),
  isSecureRequest: () => true,
}));
vi.mock('../lib/auth-audit.js', () => ({ authRequestOrigin: () => ({ ip: '10.0.0.2' }) }));
vi.mock('../lib/sign-in-backoff.js', () => ({
  SIGN_IN_FREE_FAILURES: 5,
  lockValues: () => ({ count: 'next', until: 'until' }),
}));

import {
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  DEVICE_FAILURE_CEILING,
  clearDeviceFailures,
  knownSignInDevice,
  recordDeviceFailure,
  rememberSignInDevice,
  revokeSignInDevices,
  takeDeviceAttempt,
} from '../lib/device-cookie.js';

const request = { log: { warn: vi.fn() } } as unknown as FastifyRequest;
const user = { userId: 'usr_1' };
const driver = { driverId: 'drv_1' };
const hashOf = (raw: string): string => crypto.createHash('sha256').update(raw).digest('hex');

function callArg(op: Op | undefined, name: string): unknown {
  return op?.calls.find((c) => c[0] === name)?.[1][0];
}

beforeEach(() => {
  state.results = [];
  state.ops = [];
  state.cookie = { status: 'missing' };
});

describe('knownSignInDevice', () => {
  it('answers null without a valid cookie, without reading the database', async () => {
    state.cookie = { status: 'invalid' };
    expect(await knownSignInDevice(request, 'csms', user)).toBeNull();
    expect(state.ops).toEqual([]);
  });

  it('answers null for a cookie of another account', async () => {
    state.cookie = { status: 'valid', value: 'raw' };
    state.results.push([]);
    expect(await knownSignInDevice(request, 'portal', driver)).toBeNull();
    const where = JSON.stringify(callArg(state.ops[0], 'where'));
    expect(where).toContain(hashOf('raw'));
    expect(where).toContain('d.driverId');
  });

  it('returns the device below the ceiling and null at it', async () => {
    state.cookie = { status: 'valid', value: 'raw' };
    state.results.push([{ id: 4 }], [{ failures: DEVICE_FAILURE_CEILING - 1 }]);
    expect(await knownSignInDevice(request, 'csms', user)).toEqual({ id: 4 });
    state.results.push([{ id: 4 }], [{ failures: DEVICE_FAILURE_CEILING }]);
    expect(await knownSignInDevice(request, 'csms', user)).toBeNull();
    state.results.push([{ id: 4 }], []);
    expect(await knownSignInDevice(request, 'csms', user)).toEqual({ id: 4 });
  });
});

describe('device tries', () => {
  it('grants a try with the new count, refuses while locked', async () => {
    const until = new Date('2026-01-01T00:00:30Z');
    state.results.push([{ failures: 5, lockedUntil: until }]);
    expect(await takeDeviceAttempt({ id: 1 })).toEqual({
      granted: true,
      failures: 5,
      lockedUntil: until,
    });
    expect(callArg(state.ops[0], 'set')).toEqual({ failedCount: 'next', lockedUntil: 'until' });
    state.results.push([]);
    expect(await takeDeviceAttempt({ id: 1 })).toEqual({
      granted: false,
      failures: 0,
      lockedUntil: null,
    });
  });

  it('audits only a lock the count set, in the account history', async () => {
    const until = new Date('2026-01-01T00:00:30Z');
    await recordDeviceFailure(request, user, { granted: true, failures: 4, lockedUntil: until });
    await recordDeviceFailure(request, user, { granted: true, failures: 6, lockedUntil: null });
    expect(writeAudit).not.toHaveBeenCalled();

    await recordDeviceFailure(request, user, { granted: true, failures: 5, lockedUntil: until });
    await recordDeviceFailure(request, driver, { granted: true, failures: 7, lockedUntil: until });
    const calls = writeAudit.mock.calls as unknown as [
      { table: { name: string } },
      Record<string, unknown>,
    ][];
    expect(calls.map(([cfg, row]) => [cfg.table.name, row['entityId']])).toEqual([
      ['userAuditLog', 'usr_1'],
      ['driverAuditLog', 'drv_1'],
    ]);
    expect(calls[0]?.[1]).toMatchObject({
      action: 'account_locked',
      notes: 'Password sign-in of a known device locked',
      after: { factor: 'device', failures: 5, lockedUntil: until.toISOString(), ip: '10.0.0.2' },
    });
  });

  it('clears the count of a device', async () => {
    await clearDeviceFailures({ id: 3 });
    expect(callArg(state.ops[0], 'set')).toEqual({ failedCount: 0, lockedUntil: null });
    expect(callArg(state.ops[0], 'where')).toEqual({ eq: ['d.id', 3] });
  });
});

describe('rememberSignInDevice', () => {
  function makeReply(): { reply: FastifyReply; setCookie: ReturnType<typeof vi.fn> } {
    const setCookie = vi.fn();
    return { reply: { setCookie } as unknown as FastifyReply, setCookie };
  }

  it('refreshes the known device of this browser without a new cookie', async () => {
    state.cookie = { status: 'valid', value: 'raw' };
    state.results.push([{ id: 8 }]);
    const { reply, setCookie } = makeReply();
    await rememberSignInDevice(request, reply, 'csms', user);
    expect(state.ops.map((o) => o.kind)).toEqual(['select', 'update']);
    expect(callArg(state.ops[1], 'set')).toMatchObject({
      failedCount: 0,
      lockedUntil: null,
      lastUsedAt: expect.any(Date),
    });
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('gives a new browser a device, evicts past the limit and sets the cookie', async () => {
    state.results.push([], [{ id: 1 }, { id: 2 }]);
    const { reply, setCookie } = makeReply();
    await rememberSignInDevice(request, reply, 'portal', driver);
    expect(state.ops.map((o) => o.kind)).toEqual(['insert', 'select', 'delete']);
    const values = callArg(state.ops[0], 'values') as { driverId: string; tokenHash: string };
    expect(values.driverId).toBe('drv_1');
    expect(callArg(state.ops[1], 'limit')).toBe(10);
    expect(JSON.stringify(callArg(state.ops[2], 'where'))).toContain('"notInArray":["d.id",[1,2]]');
    const [name, raw, options] = setCookie.mock.calls[0] as [string, string, unknown];
    expect(name).toBe('portal_device');
    expect(hashOf(raw)).toBe(values.tokenHash);
    expect(options).toEqual({
      httpOnly: true,
      secure: true,
      signed: true,
      sameSite: 'strict',
      path: '/v1/portal/auth',
      maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
    });
  });

  it('stores a new operator device under the user', async () => {
    state.results.push([], []);
    const { reply, setCookie } = makeReply();
    await rememberSignInDevice(request, reply, 'csms', user);
    expect((callArg(state.ops[0], 'values') as { userId: string }).userId).toBe('usr_1');
    expect(setCookie.mock.calls[0]?.[0]).toBe('csms_device');
  });
});

describe('revokeSignInDevices', () => {
  it('deletes every device of the account', async () => {
    await revokeSignInDevices(user);
    expect(state.ops.map((o) => o.kind)).toEqual(['delete']);
    expect(callArg(state.ops[0], 'where')).toEqual({ eq: ['d.userId', 'usr_1'] });
  });
});
