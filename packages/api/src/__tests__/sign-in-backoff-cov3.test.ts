// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The per-account sign-in backoff against a recorded query builder: taking a
// try per factor and table, the lock audit, clearing, the code send under the
// resend cap, the 429 reply and the TOTP replay guard.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

interface Op {
  kind: string;
  table: unknown;
  calls: [string, unknown[]][];
}

const state = vi.hoisted(() => ({ results: [] as unknown[], ops: [] as Op[] }));

const mocks = vi.hoisted(() => ({
  writeAudit: vi.fn(() => Promise.resolve()),
  createCappedMfaChallenge: vi.fn(),
  dispatchSystemNotification: vi.fn(() => Promise.resolve()),
}));

vi.mock('drizzle-orm', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings.join('?'),
    values,
  });
  return {
    sql,
    and: (...c: unknown[]) => ({ and: c }),
    or: (...c: unknown[]) => ({ or: c }),
    eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
    gt: (a: unknown, b: unknown) => ({ gt: [a, b] }),
    lt: (a: unknown, b: unknown) => ({ lt: [a, b] }),
    isNull: (a: unknown) => ({ isNull: a }),
  };
});

vi.mock('@evtivity/database', () => {
  function chain(kind: string, table: unknown): unknown {
    const op: Op = { kind, table, calls: [] };
    state.ops.push(op);
    const proxy: Record<string, unknown> = {};
    for (const name of ['from', 'where', 'set', 'returning']) {
      proxy[name] = (...args: unknown[]) => {
        if (name === 'from') op.table = args[0];
        op.calls.push([name, args]);
        return proxy;
      };
    }
    proxy['then'] = (resolve: (v: unknown) => void) => {
      resolve(state.results.shift() ?? []);
    };
    return proxy;
  }
  const col = (t: string) =>
    new Proxy(
      { __table: t },
      {
        get: (target, p) => (p === '__table' ? target['__table'] : `${t}.${String(p)}`),
      },
    );
  return {
    client: { client: true },
    db: {
      select: (c: unknown) => chain('select', c),
      update: (t: unknown) => chain('update', t),
    },
    users: col('users'),
    drivers: col('drivers'),
    userAuditLog: { name: 'userAuditLog' },
    driverAuditLog: { name: 'driverAuditLog' },
    writeAudit: mocks.writeAudit,
  };
});

vi.mock('@evtivity/lib', () => ({
  createCappedMfaChallenge: mocks.createCappedMfaChallenge,
  dispatchSystemNotification: mocks.dispatchSystemNotification,
  isMfaChallengeLimited: (c: { limited?: boolean }) => c.limited === true,
}));
vi.mock('../lib/mfa-contact.js', () => ({
  mfaCodeDestination: (method: string, contact: { phone?: string }) =>
    method === 'sms' ? contact.phone : undefined,
  mfaCodeRecipient: (method: string, contact: { email?: string; phone?: string }) =>
    method === 'sms' ? { phone: contact.phone } : { email: contact.email },
}));
vi.mock('../lib/auth-audit.js', () => ({
  authRequestOrigin: () => ({ ip: '10.0.0.1' }),
}));

import {
  MFA_DESTINATION_MAX,
  MFA_RESEND_MAX,
  acceptTotpStep,
  clearSignInFailures,
  createAccountMfaChallenge,
  isLocked,
  lockSecondsAfter,
  lockValues,
  recordAttemptFailure,
  secondsUntil,
  sendMfaResendLimited,
  sendSignInMfaCode,
  signInLocks,
  takeSignInAttempt,
  takeUnknownSignInAttempt,
} from '../lib/sign-in-backoff.js';

const user = { userId: 'usr_1' };
const driver = { driverId: 'drv_1' };
const request = { log: { warn: vi.fn() } } as unknown as FastifyRequest;

function setOf(op: Op | undefined): Record<string, unknown> {
  return (op?.calls.find((c) => c[0] === 'set')?.[1][0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  state.results = [];
  state.ops = [];
});

describe('pure rules', () => {
  it('locks after the free failures, doubling to the cap', () => {
    expect(lockSecondsAfter(4)).toBe(0);
    expect(lockSecondsAfter(5)).toBe(30);
    expect(lockSecondsAfter(6)).toBe(60);
    expect(lockSecondsAfter(100)).toBe(900);
  });

  it('reads lock times', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked(new Date('2026-01-01T00:00:10Z'), now)).toBe(true);
    expect(isLocked(new Date('2025-12-31T00:00:00Z'), now)).toBe(false);
    expect(secondsUntil(new Date('2026-01-01T00:00:02.100Z'), now)).toBe(3);
    expect(secondsUntil(new Date('2025-12-31T00:00:00Z'), now)).toBe(1);
  });

  it('builds the decayed count and lock time SQL', () => {
    const v = lockValues('c' as never, 'u' as never) as unknown as {
      count: { sql: string };
      until: { sql: string };
    };
    expect(v.count.sql).toContain('CASE WHEN');
    expect(v.until.sql).toContain('THEN NULL WHEN');
  });
});

describe('signInLocks', () => {
  it('reads the operator and driver locks, null for an unknown account', async () => {
    const locks = { loginLockedUntil: null, mfaLockedUntil: null, proofLockedUntil: null };
    state.results.push([locks], []);
    expect(await signInLocks(user)).toEqual(locks);
    expect(await signInLocks(driver)).toBeNull();
    expect(state.ops.map((o) => (o.table as { __table: string }).__table)).toEqual([
      'users',
      'drivers',
    ]);
  });
});

describe('takeSignInAttempt', () => {
  it('grants a try and counts it on the factor columns of each table', async () => {
    const until = new Date('2026-01-01T00:00:30Z');
    state.results.push([{ count: 5, until }]);
    expect(await takeSignInAttempt(user, 'password')).toEqual({
      granted: true,
      account: user,
      factor: 'password',
      failures: 5,
      lockedUntil: until,
    });
    expect(Object.keys(setOf(state.ops[0]))).toEqual(['failedLoginCount', 'loginLockedUntil']);

    state.results.push([{ count: 1, until: null }]);
    await takeSignInAttempt(user, 'mfa');
    expect(Object.keys(setOf(state.ops[1]))).toEqual(['mfaFailedCount', 'mfaLockedUntil']);

    state.results.push([{ count: 1, until: null }]);
    await takeSignInAttempt(user, 'proof');
    expect(Object.keys(setOf(state.ops[2]))).toEqual(['proofFailedCount', 'proofLockedUntil']);

    for (const factor of ['password', 'mfa', 'proof'] as const) {
      state.results.push([{ count: 2, until: null }]);
      expect(await takeSignInAttempt(driver, factor)).toMatchObject({ granted: true, failures: 2 });
    }
    expect(state.ops.slice(3).map((o) => (o.table as { __table: string }).__table)).toEqual([
      'drivers',
      'drivers',
      'drivers',
    ]);
    expect(Object.keys(setOf(state.ops[5]))).toEqual(['proofFailedCount', 'proofLockedUntil']);
  });

  it('refuses while locked, naming the lock of the factor', async () => {
    const login = new Date('2026-01-01T00:01:00Z');
    const mfa = new Date('2026-01-01T00:02:00Z');
    const proof = new Date('2026-01-01T00:03:00Z');
    const locks = { loginLockedUntil: login, mfaLockedUntil: mfa, proofLockedUntil: proof };
    state.results.push([], [locks]);
    expect(await takeSignInAttempt(user, 'password')).toEqual({
      granted: false,
      lockedUntil: login,
    });
    state.results.push([], [locks]);
    expect(await takeSignInAttempt(driver, 'mfa')).toEqual({ granted: false, lockedUntil: mfa });
    state.results.push([], [locks]);
    expect(await takeSignInAttempt(user, 'proof')).toEqual({ granted: false, lockedUntil: proof });
    // The account vanished between the two reads.
    state.results.push([], []);
    expect(await takeSignInAttempt(user, 'proof')).toEqual({ granted: false, lockedUntil: null });
  });

  it('runs the same UPDATE for an unknown email', async () => {
    await takeUnknownSignInAttempt('user');
    await takeUnknownSignInAttempt('driver');
    expect(state.ops.map((o) => [o.kind, (o.table as { __table: string }).__table])).toEqual([
      ['update', 'users'],
      ['update', 'drivers'],
    ]);
  });
});

describe('recordAttemptFailure', () => {
  const until = new Date('2026-01-01T00:00:30Z');

  it('audits nothing below the lock or without a lock time', async () => {
    expect(
      await recordAttemptFailure(request, {
        granted: true,
        account: user,
        factor: 'password',
        failures: 4,
        lockedUntil: until,
      }),
    ).toBeNull();
    expect(
      await recordAttemptFailure(request, {
        granted: true,
        account: user,
        factor: 'password',
        failures: 6,
        lockedUntil: null,
      }),
    ).toBeNull();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('audits the lock with a note per factor in the right history', async () => {
    const cases = [
      [user, 'password', 'userAuditLog', 'Password sign-in locked'],
      [driver, 'mfa', 'driverAuditLog', 'MFA code entry locked'],
      [driver, 'proof', 'driverAuditLog', 'Factor proofs of the signed-in session locked'],
    ] as const;
    for (const [account, factor] of cases) {
      expect(
        await recordAttemptFailure(request, {
          granted: true,
          account,
          factor,
          failures: 5,
          lockedUntil: until,
        }),
      ).toBe(until);
    }
    const calls = mocks.writeAudit.mock.calls as unknown as [
      { table: { name: string } },
      Record<string, unknown>,
    ][];
    expect(calls.map(([cfg, row]) => [cfg.table.name, row['notes']])).toEqual(
      cases.map(([, , table, note]) => [table, note]),
    );
    expect(calls[0]?.[1]).toMatchObject({
      entityId: 'usr_1',
      action: 'account_locked',
      actor: 'system',
      after: { factor: 'password', failures: 5, lockedUntil: until.toISOString(), ip: '10.0.0.1' },
    });
  });
});

describe('clearSignInFailures', () => {
  it('resets the factor count on each table', async () => {
    await clearSignInFailures(user, 'mfa');
    await clearSignInFailures(driver, 'password');
    expect(setOf(state.ops[0])).toEqual({ mfaFailedCount: 0, mfaLockedUntil: null });
    expect(setOf(state.ops[1])).toEqual({ failedLoginCount: 0, loginLockedUntil: null });
    expect((state.ops[1]?.table as { __table: string }).__table).toBe('drivers');
  });
});

describe('MFA codes', () => {
  it('creates a challenge under the caps with the destination scope', async () => {
    mocks.createCappedMfaChallenge.mockResolvedValue({ challengeId: 1, code: '123456' });
    await createAccountMfaChallenge(user, 'sms', {
      purpose: 'proof',
      destination: '+12015550177',
      destinationProven: true,
    });
    expect(mocks.createCappedMfaChallenge).toHaveBeenLastCalledWith(
      { client: true },
      { userId: 'usr_1', method: 'sms', purpose: 'proof', destination: '+12015550177' },
      {
        max: MFA_RESEND_MAX,
        windowMinutes: 15,
        destinationMax: MFA_DESTINATION_MAX,
        destinationWindowMinutes: 60,
        destinationScope: 'other_accounts',
      },
    );
    await createAccountMfaChallenge(driver, 'email', { purpose: 'setup' });
    expect(mocks.createCappedMfaChallenge).toHaveBeenLastCalledWith(
      { client: true },
      { driverId: 'drv_1', method: 'email', purpose: 'setup' },
      expect.objectContaining({ destinationScope: 'all' }),
    );
  });

  it('sends a sign-in code and returns its challenge id', async () => {
    mocks.createCappedMfaChallenge.mockResolvedValue({ challengeId: 42, code: '654321' });
    const id = await sendSignInMfaCode(
      user,
      'email',
      { email: 'a@example.com', phone: null, language: 'en' },
      '/tpl',
    );
    expect(id).toBe(42);
    expect(mocks.dispatchSystemNotification).toHaveBeenCalledWith(
      { client: true },
      'mfa.VerificationCode',
      { email: 'a@example.com' },
      { code: '654321' },
      '/tpl',
    );
  });

  it('sends nothing over the cap and keeps the open challenge, else none', async () => {
    mocks.createCappedMfaChallenge.mockResolvedValueOnce({ limited: true, openChallengeId: 9 });
    expect(
      await sendSignInMfaCode(driver, 'sms', { email: null, phone: '+1', language: 'en' }, '/tpl'),
    ).toBe(9);
    mocks.createCappedMfaChallenge.mockResolvedValueOnce({ limited: true, openChallengeId: null });
    expect(
      await sendSignInMfaCode(driver, 'sms', { email: null, phone: '+1', language: 'en' }, '/tpl'),
    ).toBeUndefined();
    expect(mocks.dispatchSystemNotification).not.toHaveBeenCalled();
  });

  it('answers 429 MFA_RESEND_LIMITED with Retry-After', async () => {
    const reply = {
      header: vi.fn(),
      status: vi.fn(),
      send: vi.fn(() => Promise.resolve()),
    };
    reply.status.mockReturnValue(reply);
    await sendMfaResendLimited(reply as unknown as FastifyReply, 120);
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '120');
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Too many codes sent. Try again later.',
      code: 'MFA_RESEND_LIMITED',
      retryAfterSeconds: 120,
    });
  });
});

describe('acceptTotpStep', () => {
  it('accepts a later step once, for operators and drivers', async () => {
    state.results.push([{ id: 'usr_1' }], [], [{ id: 'drv_1' }], []);
    expect(await acceptTotpStep(user, 100)).toBe(true);
    expect(await acceptTotpStep(user, 100)).toBe(false);
    expect(await acceptTotpStep(driver, 100)).toBe(true);
    expect(await acceptTotpStep(driver, 99)).toBe(false);
    expect(setOf(state.ops[0])).toEqual({ totpLastStep: 100 });
    expect((state.ops[2]?.table as { __table: string }).__table).toBe('drivers');
  });
});
