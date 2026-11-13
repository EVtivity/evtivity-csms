// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The MFA factor writer against a recorded query builder: recovery codes
// (issue, consume, count, delete) and WebAuthn credentials (register, rename,
// remove, record use), with their audit rows, notices and session ends.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Op {
  kind: string;
  table: unknown;
  calls: [string, unknown[]][];
}

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  ops: [] as Op[],
}));

const mocks = vi.hoisted(() => ({
  writeAudit: vi.fn(() => Promise.resolve()),
  sendSecurityNotice: vi.fn(),
  endUserSessions: vi.fn(() => Promise.resolve(7)),
  endDriverSessions: vi.fn(() => Promise.resolve()),
  hash: vi.fn((code: string) => Promise.resolve(`h:${code}`)),
  verify: vi.fn((hash: string, code: string) => {
    if (hash === 'broken') return Promise.reject(new Error('bad hash'));
    return Promise.resolve(hash === `h:${code}`);
  }),
}));

vi.mock('drizzle-orm', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings.join('?'),
    values,
  });
  return {
    sql,
    and: (...c: unknown[]) => ({ and: c }),
    eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
    isNull: (a: unknown) => ({ isNull: a }),
    asc: (a: unknown) => ({ asc: a }),
    desc: (a: unknown) => ({ desc: a }),
    count: (a?: unknown) => ({ count: a ?? '*' }),
  };
});

vi.mock('@evtivity/database', () => {
  function chain(kind: string, table: unknown): unknown {
    const op: Op = { kind, table, calls: [] };
    state.ops.push(op);
    const proxy: Record<string, unknown> = {};
    for (const name of [
      'from',
      'where',
      'for',
      'orderBy',
      'limit',
      'set',
      'values',
      'returning',
      'onConflictDoNothing',
    ]) {
      proxy[name] = (...args: unknown[]) => {
        if (name === 'from') op.table = args[0];
        op.calls.push([name, args]);
        return proxy;
      };
    }
    proxy['then'] = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      const next = state.results.shift();
      if (next instanceof Error) reject(next);
      else resolve(next ?? []);
    };
    return proxy;
  }
  const executor = {
    select: (cols?: unknown) => chain('select', cols),
    insert: (t: unknown) => chain('insert', t),
    update: (t: unknown) => chain('update', t),
    delete: (t: unknown) => chain('delete', t),
  };
  const col = (t: string) =>
    new Proxy(
      { __table: t },
      {
        get: (target, p) => (p === '__table' ? target['__table'] : `${t}.${String(p)}`),
      },
    );
  return {
    db: {
      ...executor,
      transaction: (fn: (tx: typeof executor) => Promise<unknown>) => fn(executor),
    },
    users: col('users'),
    drivers: col('drivers'),
    mfaRecoveryCodes: col('mfaRecoveryCodes'),
    webauthnCredentials: col('webauthnCredentials'),
    userAuditLog: { name: 'userAuditLog' },
    driverAuditLog: { name: 'driverAuditLog' },
    writeAudit: mocks.writeAudit,
  };
});

vi.mock('argon2', () => ({ default: { hash: mocks.hash, verify: mocks.verify } }));
vi.mock('../lib/operator-session.js', () => ({ endUserSessions: mocks.endUserSessions }));
vi.mock('../services/refresh-token.service.js', () => ({
  endDriverSessions: mocks.endDriverSessions,
}));
vi.mock('../lib/security-notice.js', () => ({
  sendSecurityNotice: mocks.sendSecurityNotice,
  factorFlags: (f: string) => ({ factorPasskey: f === 'passkey' }),
}));

import {
  MAX_WEBAUTHN_CREDENTIALS,
  accountUserHandle,
  consumeRecoveryCode,
  countRecoveryCodes,
  countWebauthnCredentials,
  deleteRecoveryCodes,
  deleteWebauthnCredentials,
  findWebauthnCredential,
  issueRecoveryCodes,
  listWebauthnCredentials,
  mfaFactorCounts,
  recordWebauthnCredentialUse,
  recoveryCodesUsedUp,
  registerWebauthnCredential,
  removeWebauthnCredential,
  renameWebauthnCredential,
  webauthnCredentialsForCeremony,
} from '../services/mfa-factor.service.js';
import type { MfaFactorContext } from '../services/mfa-factor.service.js';

const warn = vi.fn();
const ctx: MfaFactorContext = {
  actor: {
    actor: 'operator',
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  log: { warn },
};
const user = { userId: 'usr_1' };
const driver = { driverId: 'drv_1' };

function auditCalls(): [{ table: { name: string } }, Record<string, unknown>][] {
  return mocks.writeAudit.mock.calls as unknown as [
    { table: { name: string } },
    Record<string, unknown>,
  ][];
}

function tableOf(op: Op | undefined): unknown {
  return (op?.table as { __table?: string } | undefined)?.__table;
}

beforeEach(() => {
  state.results = [];
  state.ops = [];
});

describe('recovery code counts', () => {
  it('counts unused codes and reads 0 when no row comes back', async () => {
    state.results.push([{ n: 4 }]);
    expect(await countRecoveryCodes(user)).toBe(4);
    state.results.push([]);
    expect(await countRecoveryCodes(driver)).toBe(0);
    // The operator and driver conditions name their own column.
    const where0 = state.ops[0]?.calls.find((c) => c[0] === 'where')?.[1][0];
    const where1 = state.ops[1]?.calls.find((c) => c[0] === 'where')?.[1][0];
    expect(JSON.stringify(where0)).toContain('mfaRecoveryCodes.userId');
    expect(JSON.stringify(where1)).toContain('mfaRecoveryCodes.driverId');
  });

  it('reads used up only when codes exist and none is unused', async () => {
    state.results.push([{ total: 10, unused: 0 }]);
    expect(await recoveryCodesUsedUp(user)).toBe(true);
    state.results.push([{ total: 10, unused: 3 }]);
    expect(await recoveryCodesUsedUp(user)).toBe(false);
    state.results.push([]);
    expect(await recoveryCodesUsedUp(driver)).toBe(false);
  });
});

describe('issueRecoveryCodes', () => {
  it('replaces the codes under the row lock, audits and sends no notice on generate', async () => {
    const codes = await issueRecoveryCodes(user, 'generated', ctx);
    expect(codes).toHaveLength(10);
    expect(mocks.hash).toHaveBeenCalledTimes(10);
    expect(state.ops.map((o) => o.kind)).toEqual(['select', 'delete', 'insert']);
    expect(state.ops[0]?.calls.map((c) => c[0])).toContain('for');
    const values = state.ops[2]?.calls.find((c) => c[0] === 'values')?.[1][0] as {
      userId: string;
      codeHash: string;
    }[];
    expect(values).toHaveLength(10);
    expect(values[0]?.userId).toBe('usr_1');
    expect(values[0]?.codeHash).toBe(`h:${codes[0]?.replace('-', '') ?? ''}`);
    const [cfg, row] = auditCalls()[0] ?? [];
    expect(cfg?.table.name).toBe('userAuditLog');
    expect(row).toMatchObject({ action: 'recovery_codes_generated', after: { count: 10 } });
    expect(mocks.sendSecurityNotice).not.toHaveBeenCalled();
  });

  it('notifies the driver on regenerate and audits in the driver history', async () => {
    await issueRecoveryCodes(driver, 'regenerated', ctx);
    const [cfg, row] = auditCalls()[0] ?? [];
    expect(cfg?.table.name).toBe('driverAuditLog');
    expect(row).toMatchObject({ entityId: 'drv_1', action: 'recovery_codes_regenerated' });
    expect(mocks.sendSecurityNotice).toHaveBeenCalledWith(
      driver,
      'security.RecoveryCodesRegenerated',
      {},
      ctx.log,
    );
  });
});

describe('consumeRecoveryCode', () => {
  it('uses a matching code once, audits and notifies with the remaining count', async () => {
    state.results.push(
      [
        { id: 1, codeHash: 'broken' },
        { id: 2, codeHash: 'h:abcdefghjk' },
      ],
      [{ id: 2 }],
      [{ n: 8 }],
    );
    const result = await consumeRecoveryCode(user, 'ABCDE-FGHJK', ctx);
    expect(result).toEqual({ used: true, remaining: 8 });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Recovery code hash could not be checked, treating it as no match',
    );
    const update = state.ops.find((o) => o.kind === 'update');
    expect(update?.calls.find((c) => c[0] === 'set')?.[1][0]).toMatchObject({
      usedAt: expect.any(Date),
    });
    expect(auditCalls()[0]?.[1]).toMatchObject({
      action: 'recovery_code_used',
      after: { remaining: 8 },
    });
    expect(mocks.sendSecurityNotice).toHaveBeenCalledWith(
      user,
      'security.RecoveryCodeUsed',
      { remaining: '8' },
      ctx.log,
    );
  });

  it('refuses a wrong code without an update', async () => {
    state.results.push([{ id: 1, codeHash: 'h:zzzzzzzzzz' }]);
    expect(await consumeRecoveryCode(user, 'abcde-fghjk', ctx)).toEqual({
      used: false,
      remaining: 1,
    });
    expect(state.ops.some((o) => o.kind === 'update')).toBe(false);
  });

  it('never checks a code of the wrong length', async () => {
    state.results.push([{ id: 1, codeHash: 'h:abc' }]);
    expect(await consumeRecoveryCode(user, 'abc', ctx)).toEqual({ used: false, remaining: 1 });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('answers not used when a parallel request claimed the code first', async () => {
    state.results.push([{ id: 3, codeHash: 'h:abcdefghjk' }], [], [{ n: 0 }]);
    expect(await consumeRecoveryCode(driver, 'abcdefghjk', ctx)).toEqual({
      used: false,
      remaining: 0,
    });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.sendSecurityNotice).not.toHaveBeenCalled();
  });
});

describe('deletes', () => {
  it('deletes codes and credentials with the given executor or the db', async () => {
    const tx = { delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) };
    await deleteRecoveryCodes(user, tx as never);
    await deleteWebauthnCredentials(driver, tx as never);
    expect(tx.delete).toHaveBeenCalledTimes(2);
    await deleteRecoveryCodes(driver);
    await deleteWebauthnCredentials(user);
    expect(state.ops.map((o) => [o.kind, tableOf(o)])).toEqual([
      ['delete', 'mfaRecoveryCodes'],
      ['delete', 'webauthnCredentials'],
    ]);
  });
});

describe('credential reads', () => {
  it('counts, lists and finds credentials', async () => {
    state.results.push([{ n: 2 }]);
    expect(await countWebauthnCredentials(user)).toBe(2);
    state.results.push([]);
    expect(await countWebauthnCredentials(driver)).toBe(0);

    state.results.push([{ n: 3 }], [{ n: 1 }]);
    expect(await mfaFactorCounts(user)).toEqual({ recoveryCodesRemaining: 3, passkeyCount: 1 });

    state.results.push([{ id: 1, name: 'Key' }]);
    expect(await listWebauthnCredentials(user)).toEqual([{ id: 1, name: 'Key' }]);
    state.results.push([{ id: 1, credentialId: 'c1' }]);
    expect(await webauthnCredentialsForCeremony(driver)).toEqual([{ id: 1, credentialId: 'c1' }]);

    state.results.push([{ id: 9, credentialId: 'c9' }]);
    expect(await findWebauthnCredential('c9')).toEqual({ id: 9, credentialId: 'c9' });
    state.results.push([]);
    expect(await findWebauthnCredential('nope')).toBeNull();

    state.results.push([{ userHandle: 'uh' }]);
    expect(await accountUserHandle(user)).toBe('uh');
    state.results.push([]);
    expect(await accountUserHandle(driver)).toBeNull();
  });
});

const newCredential = {
  credentialId: 'cred-1',
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  transports: ['usb'],
  deviceType: 'singleDevice',
  backedUp: false,
  aaguid: null,
  userHandle: 'uh',
  name: 'YubiKey',
};

describe('registerWebauthnCredential', () => {
  it('registers the first factor and notices that MFA turned on', async () => {
    const summary = { id: 5, name: 'YubiKey', deviceType: 'singleDevice' };
    state.results.push([{ mfaEnabled: false, mfaMethod: null }], [{ n: 0 }], [summary]);
    const outcome = await registerWebauthnCredential(user, newCredential, ctx);
    expect(outcome).toEqual({ status: 'registered', credential: summary, firstFactor: true });
    const insert = state.ops.find((o) => o.kind === 'insert');
    const values = insert?.calls.find((c) => c[0] === 'values')?.[1][0] as Record<string, unknown>;
    expect(values['userId']).toBe('usr_1');
    expect(Buffer.isBuffer(values['publicKey'])).toBe(true);
    expect(auditCalls()[0]?.[1]).toMatchObject({
      action: 'webauthn_credential_added',
      after: { credentialId: 5, name: 'YubiKey', deviceType: 'singleDevice' },
    });
    expect(mocks.sendSecurityNotice).toHaveBeenCalledWith(
      user,
      'security.FactorAdded',
      { mfaTurnedOn: true, factorPasskey: true },
      ctx.log,
    );
  });

  it('is no first factor when the driver has a method, or a missing row and passkeys', async () => {
    state.results.push([{ mfaEnabled: true, mfaMethod: 'totp' }], [{ n: 0 }], [{ id: 6 }]);
    expect(await registerWebauthnCredential(driver, newCredential, ctx)).toMatchObject({
      firstFactor: false,
    });
    state.results.push([], [{ n: 2 }], [{ id: 7 }]);
    expect(await registerWebauthnCredential(driver, newCredential, ctx)).toMatchObject({
      firstFactor: false,
    });
    state.results.push([], [], [{ id: 8 }]);
    expect(await registerWebauthnCredential(driver, newCredential, ctx)).toMatchObject({
      firstFactor: true,
    });
  });

  it('refuses past the limit and a duplicate id, with no audit or notice', async () => {
    state.results.push([{ mfaEnabled: false, mfaMethod: null }], [{ n: MAX_WEBAUTHN_CREDENTIALS }]);
    expect(await registerWebauthnCredential(user, newCredential, ctx)).toEqual({
      status: 'limit_reached',
    });
    expect(state.ops.some((o) => o.kind === 'insert')).toBe(false);
    state.results.push([{ mfaEnabled: false, mfaMethod: null }], [{ n: 1 }], []);
    expect(await registerWebauthnCredential(user, newCredential, ctx)).toEqual({
      status: 'duplicate',
    });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.sendSecurityNotice).not.toHaveBeenCalled();
  });
});

describe('renameWebauthnCredential', () => {
  it('answers null for a credential of another account or one gone before the update', async () => {
    state.results.push([]);
    expect(await renameWebauthnCredential(user, 1, 'New', ctx)).toBeNull();
    state.results.push([{ name: 'Old' }], []);
    expect(await renameWebauthnCredential(user, 1, 'New', ctx)).toBeNull();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it('audits a changed name with the old one, and not an unchanged one', async () => {
    state.results.push([{ name: 'Old' }], [{ id: 1, name: 'New' }]);
    expect(await renameWebauthnCredential(driver, 1, 'New', ctx)).toEqual({ id: 1, name: 'New' });
    expect(auditCalls()[0]?.[1]).toMatchObject({
      action: 'webauthn_credential_renamed',
      after: { credentialId: 1, name: 'New' },
      before: { credentialId: 1, name: 'Old' },
    });
    state.results.push([{ name: 'Same' }], [{ id: 1, name: 'Same' }]);
    await renameWebauthnCredential(driver, 1, 'Same', ctx);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
  });
});

describe('removeWebauthnCredential', () => {
  it('answers not_found for an unknown credential or a missing account', async () => {
    const check = vi.fn(() => Promise.resolve(null));
    state.results.push([{ mfaEnabled: false, mfaMethod: null }], [{ id: 2, name: 'A' }]);
    expect(await removeWebauthnCredential(user, 1, { lastFactorCheck: check }, ctx)).toEqual({
      status: 'not_found',
    });
    state.results.push([], [{ id: 1, name: 'A' }]);
    expect(await removeWebauthnCredential(user, 1, { lastFactorCheck: check }, ctx)).toEqual({
      status: 'not_found',
    });
    expect(check).not.toHaveBeenCalled();
    expect(state.ops.some((o) => o.kind === 'delete')).toBe(false);
  });

  it('refuses the last factor when the check gives a reason, deleting nothing', async () => {
    state.results.push([{ mfaEnabled: false, mfaMethod: null }], [{ id: 1, name: 'A' }]);
    const outcome = await removeWebauthnCredential(
      user,
      1,
      { lastFactorCheck: () => Promise.resolve('mfa_required' as const) },
      ctx,
    );
    expect(outcome).toEqual({ status: 'refused', reason: 'mfa_required' });
    expect(state.ops.some((o) => o.kind === 'delete')).toBe(false);
    expect(mocks.endUserSessions).not.toHaveBeenCalled();
  });

  it('removes the last factor of an operator with its codes, ends sessions and audits MFA off', async () => {
    state.results.push([{ mfaEnabled: false, mfaMethod: null }], [{ id: 1, name: 'A' }]);
    const outcome = await removeWebauthnCredential(
      user,
      1,
      { lastFactorCheck: () => Promise.resolve(null) },
      ctx,
    );
    expect(outcome).toEqual({ status: 'removed', sessionVersion: 7, lastFactor: true });
    expect(state.ops.filter((o) => o.kind === 'delete').map(tableOf)).toEqual([
      'webauthnCredentials',
      'mfaRecoveryCodes',
    ]);
    expect(mocks.endUserSessions).toHaveBeenCalledWith('usr_1', { apiKeys: false });
    expect(auditCalls().map(([, r]) => r['action'])).toEqual([
      'webauthn_credential_removed',
      'mfa_disabled',
    ]);
    expect(auditCalls()[0]?.[1]).toMatchObject({ before: { credentialId: 1, name: 'A' } });
    expect(mocks.sendSecurityNotice).toHaveBeenCalledWith(
      user,
      'security.FactorRemoved',
      { mfaTurnedOff: true, byAdmin: false },
      ctx.log,
    );
  });

  it('removes one of several driver credentials without the check or the codes', async () => {
    const check = vi.fn(() => Promise.resolve('x' as const));
    state.results.push(
      [{ mfaEnabled: true, mfaMethod: 'totp' }],
      [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ],
    );
    const outcome = await removeWebauthnCredential(driver, 2, { lastFactorCheck: check }, ctx);
    expect(outcome).toEqual({ status: 'removed', sessionVersion: null, lastFactor: false });
    expect(check).not.toHaveBeenCalled();
    expect(state.ops.filter((o) => o.kind === 'delete').map(tableOf)).toEqual([
      'webauthnCredentials',
    ]);
    expect(mocks.endDriverSessions).toHaveBeenCalledWith('drv_1');
    expect(auditCalls().map(([, r]) => r['action'])).toEqual(['webauthn_credential_removed']);
  });
});

describe('recordWebauthnCredentialUse', () => {
  it('stores the counter guarded on the old one and reports whether it won', async () => {
    state.results.push([{ id: 1 }]);
    expect(
      await recordWebauthnCredentialUse({ id: 1, counter: 4 }, { newCounter: 5, backedUp: true }),
    ).toBe(true);
    const set = state.ops[0]?.calls.find((c) => c[0] === 'set')?.[1][0];
    expect(set).toMatchObject({ counter: 5, backedUp: true, lastUsedAt: expect.any(Date) });
    expect(JSON.stringify(state.ops[0]?.calls.find((c) => c[0] === 'where')?.[1][0])).toContain(
      '"webauthnCredentials.counter",4',
    );
    state.results.push([]);
    expect(
      await recordWebauthnCredentialUse({ id: 1, counter: 4 }, { newCounter: 5, backedUp: true }),
    ).toBe(false);
  });
});
