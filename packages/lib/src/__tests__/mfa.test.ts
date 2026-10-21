// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  createCappedMfaChallenge,
  createMfaChallenge,
  isMfaChallengeLimited,
  verifyMfaChallenge,
  MFA_CHALLENGE_MAX_ATTEMPTS,
} from '../mfa.js';

interface SqlCall {
  sql: string;
  values: unknown[];
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Tagged-template SQL mock. Each call returns the next queued result array and
// records the joined SQL text plus the interpolated values so tests can assert
// on what was sent to the database.
function createSqlMock(results: unknown[][]): { client: Sql; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  let index = 0;
  const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    calls.push({ sql: strings.join('?'), values });
    const result = results[index] ?? [];
    index += 1;
    return Promise.resolve(result);
  };
  return { client: fn as unknown as Sql, calls };
}

describe('createMfaChallenge', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomInt').mockImplementation(() => 123456);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns the generated code and inserted challenge id', async () => {
    // Only the INSERT runs for a userId challenge: invalidation UPDATE + INSERT = 2 calls.
    const { client } = createSqlMock([[], [{ id: 42 }]]);
    const result = await createMfaChallenge(client, {
      userId: 'usr_1',
      method: 'email',
      purpose: 'sign_in',
    });
    expect(result).toEqual({ challengeId: 42, code: '123456' });
  });

  it('hashes the code with sha256 and never stores the plaintext code', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { userId: 'usr_1', method: 'email', purpose: 'sign_in' });

    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO mfa_challenges'));
    expect(insertCall).toBeDefined();
    const insertValues = insertCall!.values;
    // The hashed code must be present.
    expect(insertValues).toContain(sha256Hex('123456'));
    // The plaintext code must NOT be present anywhere in the inserted values.
    expect(insertValues).not.toContain('123456');
  });

  it('sets a 5-minute TTL expiry as an ISO string', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { userId: 'usr_1', method: 'email', purpose: 'sign_in' });

    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO mfa_challenges'))!;
    const expectedExpiry = new Date('2026-06-01T00:05:00.000Z').toISOString();
    expect(insertCall.values).toContain(expectedExpiry);
  });

  it('passes userId, null driverId, and method to the insert', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { userId: 'usr_9', method: 'sms', purpose: 'sign_in' });

    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO mfa_challenges'))!;
    expect(insertCall.values).toContain('usr_9');
    expect(insertCall.values).toContain('sms');
    // driverId defaults to null.
    expect(insertCall.values).toContain(null);
  });

  it('invalidates prior unused challenges for a user before inserting', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { userId: 'usr_5', method: 'email', purpose: 'sign_in' });

    const updateCall = calls.find(
      (c) => c.sql.includes('UPDATE mfa_challenges') && c.sql.includes('user_id'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.values).toContain('usr_5');
    // The invalidation UPDATE runs before the INSERT.
    const updateIdx = calls.indexOf(updateCall!);
    const insertIdx = calls.findIndex((c) => c.sql.includes('INSERT INTO mfa_challenges'));
    expect(updateIdx).toBeLessThan(insertIdx);
  });

  it('invalidates prior unused challenges for a driver before inserting', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 7 }]]);
    const result = await createMfaChallenge(client, {
      driverId: 'drv_3',
      method: 'email',
      purpose: 'sign_in',
    });

    expect(result.challengeId).toBe(7);
    const updateCall = calls.find(
      (c) => c.sql.includes('UPDATE mfa_challenges') && c.sql.includes('driver_id'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.values).toContain('drv_3');

    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO mfa_challenges'))!;
    // userId defaults to null, driverId is set.
    expect(insertCall.values).toContain('drv_3');
  });

  it('does not run a user invalidation when only driverId is supplied', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { driverId: 'drv_x', method: 'email', purpose: 'sign_in' });

    const userUpdate = calls.find(
      (c) => c.sql.includes('UPDATE mfa_challenges') && c.sql.includes('user_id'),
    );
    expect(userUpdate).toBeUndefined();
  });

  it('does not run a driver invalidation when only userId is supplied', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { userId: 'usr_x', method: 'email', purpose: 'sign_in' });

    const driverUpdate = calls.find(
      (c) => c.sql.includes('UPDATE mfa_challenges') && c.sql.includes('driver_id'),
    );
    expect(driverUpdate).toBeUndefined();
  });

  it('throws when the insert returns no row', async () => {
    // INSERT (second call) returns an empty result set.
    const { client } = createSqlMock([[], []]);
    await expect(
      createMfaChallenge(client, { userId: 'usr_1', method: 'email', purpose: 'sign_in' }),
    ).rejects.toThrow('Failed to create MFA challenge');
  });
});

describe('verifyMfaChallenge', () => {
  const hashed = { code_hash: sha256Hex('123456') };

  it('verifies a matching code and marks the challenge used', async () => {
    const { client, calls } = createSqlMock([[hashed], [{ id: 1 }]]);
    expect(
      await verifyMfaChallenge(client, 1, '123456', {
        userId: 'usr_1',
        method: 'email',
        purpose: 'sign_in',
      }),
    ).toBe('verified');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain('SET attempts = attempts + 1');
    expect(calls[0]!.sql).toContain('used_at IS NULL');
    expect(calls[0]!.sql).toContain('expires_at > now()');
    expect(calls[0]!.sql).toContain('attempts <');
    expect(calls[0]!.values).toEqual([
      1,
      MFA_CHALLENGE_MAX_ATTEMPTS,
      'usr_1',
      null,
      'email',
      'sign_in',
      null,
    ]);
    expect(calls[1]!.sql).toContain('SET used_at = NOW()');
    expect(calls[1]!.sql).toContain('used_at IS NULL');
  });

  it('binds a driver challenge to the driver', async () => {
    const { client, calls } = createSqlMock([[hashed], [{ id: 1 }]]);
    expect(
      await verifyMfaChallenge(client, 1, '123456', {
        driverId: 'drv_1',
        method: 'email',
        purpose: 'sign_in',
      }),
    ).toBe('verified');
    expect(calls[0]!.values).toEqual([
      1,
      MFA_CHALLENGE_MAX_ATTEMPTS,
      null,
      'drv_1',
      'email',
      'sign_in',
      null,
    ]);
  });

  it('binds the challenge to the method it was sent for', async () => {
    const { client, calls } = createSqlMock([[], []]);
    expect(
      await verifyMfaChallenge(client, 1, '123456', {
        userId: 'usr_1',
        method: 'sms',
        purpose: 'sign_in',
      }),
    ).toBe('invalid');
    expect(calls[0]!.sql).toContain('method =');
    expect(calls[0]!.values).toContain('sms');
    expect(calls[1]!.sql).toContain('method =');
  });

  it('answers invalid for a wrong code and leaves the challenge unused', async () => {
    const { client, calls } = createSqlMock([[hashed]]);
    expect(
      await verifyMfaChallenge(client, 1, '000000', {
        userId: 'usr_1',
        method: 'email',
        purpose: 'sign_in',
      }),
    ).toBe('invalid');
    expect(calls).toHaveLength(1);
  });

  it('answers invalid for an unknown, used, expired or foreign challenge', async () => {
    const { client } = createSqlMock([[], []]);
    expect(
      await verifyMfaChallenge(client, 9, '123456', {
        userId: 'usr_1',
        method: 'email',
        purpose: 'sign_in',
      }),
    ).toBe('invalid');
  });

  it('answers exhausted when the challenge has no tries left', async () => {
    const { client, calls } = createSqlMock([[], [{ '?column?': 1 }]]);
    expect(
      await verifyMfaChallenge(client, 1, '123456', {
        userId: 'usr_1',
        method: 'email',
        purpose: 'sign_in',
      }),
    ).toBe('exhausted');
    expect(calls[1]!.sql).toContain('attempts >=');
  });

  it('answers invalid when another request used the challenge first', async () => {
    const { client } = createSqlMock([[hashed], []]);
    expect(
      await verifyMfaChallenge(client, 1, '123456', {
        userId: 'usr_1',
        method: 'email',
        purpose: 'sign_in',
      }),
    ).toBe('invalid');
  });

  it('refuses without a principal and sends no query', async () => {
    const { client, calls } = createSqlMock([]);
    expect(
      await verifyMfaChallenge(client, 1, '123456', { method: 'email', purpose: 'sign_in' }),
    ).toBe('invalid');
    expect(calls).toHaveLength(0);
  });

  it('never sends the plaintext code', async () => {
    const { client, calls } = createSqlMock([[hashed], [{ id: 1 }]]);
    await verifyMfaChallenge(client, 1, '123456', {
      userId: 'usr_1',
      method: 'email',
      purpose: 'sign_in',
    });
    for (const call of calls) expect(call.values).not.toContain('123456');
  });

  it('answers invalid when the stored hash has another length', async () => {
    const { client } = createSqlMock([[{ code_hash: 'abcd' }]]);
    expect(
      await verifyMfaChallenge(client, 1, '123456', {
        userId: 'usr_1',
        method: 'email',
        purpose: 'sign_in',
      }),
    ).toBe('invalid');
  });
});

describe('createCappedMfaChallenge', () => {
  const cap = { max: 5, windowMinutes: 15 };

  function withBegin(results: unknown[][]): { client: Sql; calls: SqlCall[] } {
    const mock = createSqlMock(results);
    const client = Object.assign(mock.client, {
      begin: async (fn: (tx: Sql) => Promise<unknown>) => fn(mock.client),
    }) as unknown as Sql;
    return { client, calls: mock.calls };
  }

  beforeEach(() => {
    vi.spyOn(crypto, 'randomInt').mockImplementation(() => 123456);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('locks the account, counts, and sends a code under the cap', async () => {
    const { client, calls } = withBegin([[], [{ count: 4, retry_after: 300 }], [], [{ id: 8 }]]);
    const result = await createCappedMfaChallenge(
      client,
      { driverId: 'drv_1', method: 'sms', purpose: 'sign_in' },
      cap,
    );
    expect(result).toEqual({ challengeId: 8, code: '123456' });
    expect(calls[0]?.sql).toContain('pg_advisory_xact_lock');
    expect(calls[0]?.values).toEqual(['mfa_send:driver:drv_1']);
    expect(calls.some((c) => c.sql.includes('INSERT INTO mfa_challenges'))).toBe(true);
  });

  it('sends nothing at the cap and names the newest open challenge', async () => {
    const { client, calls } = withBegin([[], [{ count: 5, retry_after: 240 }], [{ id: 6 }]]);
    const result = await createCappedMfaChallenge(
      client,
      { userId: 'usr_1', method: 'email', purpose: 'sign_in' },
      cap,
    );
    expect(result).toEqual({ limited: true, retryAfterSeconds: 240, openChallengeId: 6 });
    expect(isMfaChallengeLimited(result)).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO mfa_challenges'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('UPDATE mfa_challenges'))).toBe(false);
  });

  it('caps the codes to one destination across accounts under its own lock', async () => {
    const destCap = { ...cap, destinationMax: 3, destinationWindowMinutes: 60 };
    const { client, calls } = withBegin([
      [],
      [{ count: 1, retry_after: 300 }],
      [],
      [{ count: 3, retry_after: 1200 }],
    ]);
    const result = await createCappedMfaChallenge(
      client,
      {
        driverId: 'drv_1',
        method: 'phone_change',
        purpose: 'sign_in',
        destination: '+15550001111',
      },
      destCap,
    );
    expect(result).toEqual({ limited: true, retryAfterSeconds: 1200, openChallengeId: null });
    expect(calls[2]?.values).toEqual([`mfa_send:dest:${sha256Hex('+15550001111')}`]);
    expect(calls.some((c) => c.sql.includes('INSERT INTO mfa_challenges'))).toBe(false);
  });

  it('refuses a challenge without an account', async () => {
    const { client } = withBegin([]);
    await expect(
      createCappedMfaChallenge(client, { method: 'email', purpose: 'sign_in' }, cap),
    ).rejects.toThrow('An MFA challenge needs a user or a driver');
  });
});

describe('challenge destination', () => {
  it('stores the hash of the destination, never the number', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, {
      userId: 'usr_1',
      method: 'phone',
      purpose: 'sign_in',
      destination: '+15551234567',
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO mfa_challenges'))!;
    expect(insert.values).toContain(sha256Hex('+15551234567'));
    expect(insert.values).not.toContain('+15551234567');
  });

  it('checks a code against the destination it names', async () => {
    const { client, calls } = createSqlMock([[], []]);
    await verifyMfaChallenge(client, 1, '123456', {
      userId: 'usr_1',
      method: 'phone',
      purpose: 'sign_in',
      destination: '+15550000000',
    });
    expect(calls[0]?.sql).toContain('destination_hash IS NOT DISTINCT FROM');
    expect(calls[0]?.values).toContain(sha256Hex('+15550000000'));
  });

  it('matches only challenges without a destination when none is named', async () => {
    const { client, calls } = createSqlMock([[], []]);
    await verifyMfaChallenge(client, 1, '123456', {
      userId: 'usr_1',
      method: 'sms',
      purpose: 'sign_in',
    });
    expect(calls[0]?.values).toContain(null);
  });
});

describe('challenge purpose', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores the purpose and voids only the open codes of the same purpose', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { userId: 'usr_1', method: 'email', purpose: 'proof' });
    expect(calls[0]?.sql).toContain('purpose = ?');
    expect(calls[0]?.values).toEqual(['usr_1', 'proof']);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO mfa_challenges'))!;
    expect(insert.sql).toContain('purpose');
    expect(insert.values).toContain('proof');
  });

  it('checks a code only against challenges of its purpose', async () => {
    const { client, calls } = createSqlMock([[], []]);
    const result = await verifyMfaChallenge(client, 1, '123456', {
      userId: 'usr_1',
      method: 'email',
      purpose: 'proof',
    });
    expect(result).toBe('invalid');
    expect(calls[0]?.sql).toContain('AND purpose = ?');
    expect(calls[0]?.values).toContain('proof');
  });

  it('counts sign-in codes apart from the codes of a session', async () => {
    const mock = createSqlMock([[], [{ count: 0, retry_after: null }], [], [{ id: 3 }]]);
    const client = Object.assign(mock.client, {
      begin: async (fn: (tx: Sql) => Promise<unknown>) => fn(mock.client),
    }) as unknown as Sql;
    await createCappedMfaChallenge(
      client,
      { userId: 'usr_1', method: 'email', purpose: 'proof' },
      { max: 5, windowMinutes: 15 },
    );
    expect(mock.calls[1]?.sql).toContain("(purpose = 'sign_in') = ?");
    expect(mock.calls[1]?.values).toContain(false);
  });

  it('counts only other accounts toward the cap of a confirmed number', async () => {
    vi.spyOn(crypto, 'randomInt').mockImplementation(() => 123456);
    const mock = createSqlMock([
      [],
      [{ count: 0, retry_after: null }],
      [],
      [{ count: 0, retry_after: null }],
      [],
      [{ id: 4 }],
    ]);
    const client = Object.assign(mock.client, {
      begin: async (fn: (tx: Sql) => Promise<unknown>) => fn(mock.client),
    }) as unknown as Sql;
    const result = await createCappedMfaChallenge(
      client,
      { userId: 'usr_1', method: 'sms', purpose: 'sign_in', destination: '+15550001111' },
      {
        max: 5,
        windowMinutes: 15,
        destinationMax: 3,
        destinationWindowMinutes: 60,
        destinationScope: 'other_accounts',
      },
    );
    expect(result).toEqual({ challengeId: 4, code: '123456' });
    const destCount = mock.calls[3]!;
    expect(destCount.sql).toContain('destination_hash = ?');
    expect(destCount.sql).toContain('AND NOT (');
    expect(destCount.values).toContain(true);
    expect(destCount.values).toContain('usr_1');
    // Other accounts' setup codes go to a number they never proved: left out.
    expect(destCount.sql).toContain("purpose = 'setup'");
  });
});
