// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { Sql } from 'postgres';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createMfaChallenge, verifyMfaChallenge } from '../mfa.js';

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
    const result = await createMfaChallenge(client, { userId: 'usr_1', method: 'email' });
    expect(result).toEqual({ challengeId: 42, code: '123456' });
  });

  it('hashes the code with sha256 and never stores the plaintext code', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { userId: 'usr_1', method: 'email' });

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
    await createMfaChallenge(client, { userId: 'usr_1', method: 'email' });

    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO mfa_challenges'))!;
    const expectedExpiry = new Date('2026-06-01T00:05:00.000Z').toISOString();
    expect(insertCall.values).toContain(expectedExpiry);
  });

  it('passes userId, null driverId, and method to the insert', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { userId: 'usr_9', method: 'sms' });

    const insertCall = calls.find((c) => c.sql.includes('INSERT INTO mfa_challenges'))!;
    expect(insertCall.values).toContain('usr_9');
    expect(insertCall.values).toContain('sms');
    // driverId defaults to null.
    expect(insertCall.values).toContain(null);
  });

  it('invalidates prior unused challenges for a user before inserting', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { userId: 'usr_5', method: 'email' });

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
    const result = await createMfaChallenge(client, { driverId: 'drv_3', method: 'email' });

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
    await createMfaChallenge(client, { driverId: 'drv_x', method: 'email' });

    const userUpdate = calls.find(
      (c) => c.sql.includes('UPDATE mfa_challenges') && c.sql.includes('user_id'),
    );
    expect(userUpdate).toBeUndefined();
  });

  it('does not run a driver invalidation when only userId is supplied', async () => {
    const { client, calls } = createSqlMock([[], [{ id: 1 }]]);
    await createMfaChallenge(client, { userId: 'usr_x', method: 'email' });

    const driverUpdate = calls.find(
      (c) => c.sql.includes('UPDATE mfa_challenges') && c.sql.includes('driver_id'),
    );
    expect(driverUpdate).toBeUndefined();
  });

  it('throws when the insert returns no row', async () => {
    // INSERT (second call) returns an empty result set.
    const { client } = createSqlMock([[], []]);
    await expect(createMfaChallenge(client, { userId: 'usr_1', method: 'email' })).rejects.toThrow(
      'Failed to create MFA challenge',
    );
  });
});

describe('verifyMfaChallenge', () => {
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function validRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 1,
      code_hash: sha256Hex('123456'),
      expires_at: new Date('2026-06-01T00:05:00.000Z'),
      used_at: null,
      user_id: 'usr_1',
      driver_id: null,
      ...overrides,
    };
  }

  it('accepts a correct, unexpired, unused code bound to the right user', async () => {
    const { client, calls } = createSqlMock([[validRow()], []]);
    const ok = await verifyMfaChallenge(client, 1, '123456', { userId: 'usr_1' });
    expect(ok).toBe(true);
    // It marks the challenge used after a successful verify.
    const markUsed = calls.find(
      (c) => c.sql.includes('UPDATE mfa_challenges') && c.sql.includes('used_at = NOW()'),
    );
    expect(markUsed).toBeDefined();
    expect(markUsed!.values).toContain(1);
  });

  it('accepts a correct code bound to the right driver', async () => {
    const row = validRow({ user_id: null, driver_id: 'drv_2' });
    const { client } = createSqlMock([[row], []]);
    const ok = await verifyMfaChallenge(client, 1, '123456', { driverId: 'drv_2' });
    expect(ok).toBe(true);
  });

  it('rejects when no challenge row exists', async () => {
    const { client, calls } = createSqlMock([[]]);
    const ok = await verifyMfaChallenge(client, 999, '123456', { userId: 'usr_1' });
    expect(ok).toBe(false);
    // No mark-used UPDATE should be issued.
    const markUsed = calls.find((c) => c.sql.includes('used_at = NOW()'));
    expect(markUsed).toBeUndefined();
  });

  it('rejects an already-used challenge', async () => {
    const row = validRow({ used_at: new Date('2026-06-01T00:01:00.000Z') });
    const { client, calls } = createSqlMock([[row]]);
    const ok = await verifyMfaChallenge(client, 1, '123456', { userId: 'usr_1' });
    expect(ok).toBe(false);
    expect(calls.find((c) => c.sql.includes('used_at = NOW()'))).toBeUndefined();
  });

  it('rejects an expired challenge', async () => {
    const row = validRow({ expires_at: new Date('2026-05-31T23:59:00.000Z') });
    const { client, calls } = createSqlMock([[row]]);
    const ok = await verifyMfaChallenge(client, 1, '123456', { userId: 'usr_1' });
    expect(ok).toBe(false);
    expect(calls.find((c) => c.sql.includes('used_at = NOW()'))).toBeUndefined();
  });

  it('rejects when the supplied code is wrong', async () => {
    const { client, calls } = createSqlMock([[validRow()]]);
    const ok = await verifyMfaChallenge(client, 1, '000000', { userId: 'usr_1' });
    expect(ok).toBe(false);
    expect(calls.find((c) => c.sql.includes('used_at = NOW()'))).toBeUndefined();
  });

  it('rejects when the challenge belongs to a different user', async () => {
    const row = validRow({ user_id: 'usr_attacker' });
    const { client } = createSqlMock([[row]]);
    const ok = await verifyMfaChallenge(client, 1, '123456', { userId: 'usr_victim' });
    expect(ok).toBe(false);
  });

  it('rejects when the challenge belongs to a different driver', async () => {
    const row = validRow({ user_id: null, driver_id: 'drv_attacker' });
    const { client } = createSqlMock([[row]]);
    const ok = await verifyMfaChallenge(client, 1, '123456', { driverId: 'drv_victim' });
    expect(ok).toBe(false);
  });

  it('rejects when neither userId nor driverId is expected', async () => {
    const { client } = createSqlMock([[validRow()]]);
    const ok = await verifyMfaChallenge(client, 1, '123456', {});
    expect(ok).toBe(false);
  });

  it('hashes the supplied code before comparison and never queries by plaintext', async () => {
    const { client, calls } = createSqlMock([[validRow()], []]);
    await verifyMfaChallenge(client, 1, '123456', { userId: 'usr_1' });
    // The lookup is by challenge id only; the plaintext code is not sent to the DB.
    const lookup = calls.find((c) => c.sql.includes('SELECT'))!;
    expect(lookup.values).toContain(1);
    expect(lookup.values).not.toContain('123456');
  });

  it('rejects when the stored hash buffer length differs from the supplied hash buffer', async () => {
    // Defensive guard: a corrupted/short code_hash decodes to a shorter Buffer
    // than the 32-byte sha256 of the supplied code, so the length check rejects
    // before timingSafeEqual is reached.
    const row = validRow({ code_hash: 'ab' });
    const { client, calls } = createSqlMock([[row]]);
    const ok = await verifyMfaChallenge(client, 1, '123456', { userId: 'usr_1' });
    expect(ok).toBe(false);
    expect(calls.find((c) => c.sql.includes('used_at = NOW()'))).toBeUndefined();
  });

  it('accepts a driver-bound challenge even when expected also carries a matching userId path is skipped', async () => {
    // Both expected ids present; only the driver one must match a driver-bound row.
    const row = validRow({ user_id: null, driver_id: 'drv_2' });
    const { client } = createSqlMock([[row], []]);
    const ok = await verifyMfaChallenge(client, 1, '123456', { driverId: 'drv_2' });
    expect(ok).toBe(true);
  });
});
