// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const STATION_ID = 'sta_000000000001';

const { results, ops, sendOcppCommandAndWait, getUserSiteIds, drizzle } = vi.hoisted(() => ({
  results: [] as unknown[][],
  ops: [] as Array<{ op: string; args: unknown[] }>,
  sendOcppCommandAndWait: vi.fn(),
  getUserSiteIds: vi.fn(),
  drizzle: {
    eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
    and: vi.fn((...c: unknown[]) => ({ and: c })),
    or: vi.fn((...c: unknown[]) => ({ or: c })),
    ilike: vi.fn((col: unknown, val: unknown) => ({ ilike: [col, val] })),
    notInArray: vi.fn((col: unknown, val: unknown) => ({ notInArray: [col, val] })),
    inArray: vi.fn((col: unknown, val: unknown) => ({ inArray: [col, val] })),
    isNull: vi.fn((col: unknown) => ({ isNull: col })),
    isNotNull: vi.fn((col: unknown) => ({ isNotNull: col })),
    lt: vi.fn((col: unknown, val: unknown) => ({ lt: [col, val] })),
    sql: vi.fn(() => 'sql'),
    desc: vi.fn(),
    count: vi.fn(() => 'count'),
  },
}));

function makeChain(kind: string): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'values',
    'returning',
    'set',
    'onConflictDoNothing',
  ]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      ops.push({ op: `${kind}.${m}`, args });
      return chain;
    });
  }
  let result: Promise<unknown> | null = null;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    result ??= Promise.resolve(results.shift() ?? []);
    return result.then(resolve, reject);
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain('select')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
    delete: vi.fn(() => makeChain('delete')),
  },
  chargingStations: { id: 'cs.id' },
  driverTokens: {
    id: 'dt.id',
    isActive: 'dt.isActive',
    idToken: 'dt.idToken',
    prepaidBalanceCents: 'dt.prepaidBalanceCents',
  },
  drivers: { firstName: 'd.firstName', lastName: 'd.lastName' },
  stationLocalAuthVersions: { stationId: 'v.stationId', localVersion: 'v.localVersion' },
  stationLocalAuthEntries: { id: 'e.id', stationId: 'e.stationId' },
  writeAudit: vi.fn().mockResolvedValue(undefined),
  pgErrorCode: (err: unknown) => (err as { code?: string }).code,
  PG_UNIQUE_VIOLATION: '23505',
  localAuthListAuditLog: {},
}));

vi.mock('drizzle-orm', () => drizzle);
vi.mock('@evtivity/services/ocpp-command', () => ({ sendOcppCommandAndWait }));
vi.mock('../lib/site-access.js', () => ({ getUserSiteIds }));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

import { registerAuth } from '../plugins/auth.js';
import { localAuthListRoutes } from '../routes/local-auth-list.js';

const onlineStation = {
  id: STATION_ID,
  stationId: 'CS-001',
  siteId: 'sit_a',
  isOnline: true,
  ocppProtocol: 'ocpp2.1',
};

describe('local auth list routes - uncovered paths', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(localAuthListRoutes);
    await app.ready();
    headers = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    results.length = 0;
    ops.length = 0;
    getUserSiteIds.mockResolvedValue(null);
  });

  describe('site scoping hides stations outside the user sites', () => {
    const cases: Array<[string, 'GET' | 'POST', Record<string, unknown> | undefined]> = [
      ['', 'GET', undefined],
      ['/available-tokens', 'GET', undefined],
      ['/push', 'POST', undefined],
      ['/add', 'POST', { tokenIds: ['dtk_000000000001'] }],
      ['/remove', 'POST', { entryIds: [1] }],
    ];
    for (const [suffix, method, payload] of cases) {
      it(`${method} local-auth-list${suffix} returns 404 for a station on another site`, async () => {
        getUserSiteIds.mockResolvedValue(['sit_other']);
        results.push([onlineStation]);
        const res = await app.inject({
          method,
          url: `/stations/${STATION_ID}/local-auth-list${suffix}`,
          headers,
          ...(payload != null && { payload }),
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
        expect(getUserSiteIds).toHaveBeenCalledWith('usr_1');
        expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
      });
    }
  });

  it('GET list creates the version row when the station has none', async () => {
    const created = {
      id: 7,
      stationId: STATION_ID,
      localVersion: 0,
      reportedVersion: null,
      lastSyncAt: null,
      lastModifiedAt: null,
      lastVersionCheckAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    results.push([onlineStation], [], [created], [], [{ count: 0 }]);
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/local-auth-list`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ localVersion: 0, entries: [], total: 0 });
    const insertValues = ops.find((o) => o.op === 'insert.values');
    expect(insertValues?.args[0]).toEqual({ stationId: STATION_ID });
  });

  it('GET list returns 500 when the version row cannot be created', async () => {
    results.push([onlineStation], [], []);
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/local-auth-list`,
      headers,
    });
    expect(res.statusCode).toBe(500);
  });

  it('GET available-tokens excludes tokens already on the list and applies the search', async () => {
    results.push(
      [onlineStation],
      [{ driverTokenId: 'dtk_1' }, { driverTokenId: null }, { driverTokenId: 'dtk_2' }],
      [
        {
          id: 'dtk_3',
          idToken: 'TOK3',
          tokenType: 'ISO14443',
          driverFirstName: null,
          driverLastName: null,
        },
      ],
      [{ count: 1 }],
    );
    const res = await app.inject({
      method: 'GET',
      url: `/stations/${STATION_ID}/local-auth-list/available-tokens?search=abc`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [{ id: 'dtk_3', idToken: 'TOK3', tokenType: 'ISO14443', driverName: null }],
      total: 1,
    });
    expect(drizzle.notInArray).toHaveBeenCalledWith('dt.id', ['dtk_1', 'dtk_2']);
    expect(drizzle.ilike).toHaveBeenCalledWith('dt.idToken', '%abc%');
    expect(drizzle.ilike).toHaveBeenCalledWith('d.firstName', '%abc%');
    expect(drizzle.ilike).toHaveBeenCalledWith('d.lastName', '%abc%');
    // Prepaid cards never go on a local list.
    expect(drizzle.isNull).toHaveBeenCalledWith('dt.prepaidBalanceCents');
  });

  describe('POST push', () => {
    interface ReconcileRow {
      entryId: number;
      entryIdToken: string;
      entryTokenType: string;
      entryAuthStatus: string;
      idToken: string;
      tokenType: string;
      isActive: boolean;
      revokedAt: Date | null;
      expiresAt: Date | null;
      driverIsActive: boolean | null;
    }

    function row(over: Partial<ReconcileRow>): ReconcileRow {
      return {
        entryId: 1,
        entryIdToken: 'T1',
        entryTokenType: 'ISO14443',
        entryAuthStatus: 'Accepted',
        idToken: 'T1',
        tokenType: 'ISO14443',
        isActive: true,
        revokedAt: null,
        expiresAt: null,
        driverIsActive: true,
        ...over,
      };
    }

    // station, orphan delete, prepaid entries (+ their delete), joined
    // entries, one update per changed entry, version row, version reservation
    function queuePush(
      rows: ReconcileRow[],
      changedEntries = 0,
      prepaidEntryIds: number[] = [],
    ): void {
      results.push(
        [onlineStation],
        [],
        prepaidEntryIds.map((id) => ({ id })),
      );
      if (prepaidEntryIds.length > 0) results.push([]);
      results.push(rows);
      for (let i = 0; i < changedEntries; i++) results.push([]);
      results.push([{ id: 1, stationId: STATION_ID }], [{ localVersion: 5 }]);
    }

    it('reconciles every entry with its token before pushing', async () => {
      const past = new Date('2020-01-01T00:00:00Z');
      const future = new Date('2099-01-01T00:00:00Z');
      queuePush(
        [
          row({ entryId: 1, idToken: 'DEACT', entryIdToken: 'DEACT', isActive: false }),
          row({ entryId: 2, idToken: 'REACT', entryIdToken: 'REACT', entryAuthStatus: 'Blocked' }),
          row({ entryId: 3, idToken: 'NEW', entryIdToken: 'OLD' }),
          row({ entryId: 4, idToken: 'EXP', entryIdToken: 'EXP', expiresAt: past }),
          row({ entryId: 5, idToken: 'OK', entryIdToken: 'OK', expiresAt: future }),
          row({ entryId: 6, idToken: 'DRV', entryIdToken: 'DRV', driverIsActive: false }),
        ],
        5,
        [7],
      );
      results.push([], []); // lastSyncAt, pushedAt
      sendOcppCommandAndWait.mockResolvedValue({ response: { status: 'Accepted' } });
      const res = await app.inject({
        method: 'POST',
        url: `/stations/${STATION_ID}/local-auth-list/push`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ entriesCount: 6, version: 5 });
      // The prepaid card's entry is dropped, never pushed.
      expect(ops.some((o) => o.op === 'delete.where')).toBe(true);
      expect(drizzle.inArray).toHaveBeenCalledWith('e.id', [7]);
      const info = (status: string) => ({ status });
      expect(sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'SendLocalList', {
        versionNumber: 5,
        updateType: 'Full',
        localAuthorizationList: [
          { idToken: { idToken: 'DEACT', type: 'ISO14443' }, idTokenInfo: info('Blocked') },
          { idToken: { idToken: 'REACT', type: 'ISO14443' }, idTokenInfo: info('Accepted') },
          { idToken: { idToken: 'NEW', type: 'ISO14443' }, idTokenInfo: info('Accepted') },
          { idToken: { idToken: 'EXP', type: 'ISO14443' }, idTokenInfo: info('Expired') },
          {
            idToken: { idToken: 'OK', type: 'ISO14443' },
            idTokenInfo: { status: 'Accepted', cacheExpiryDateTime: future.toISOString() },
          },
          { idToken: { idToken: 'DRV', type: 'ISO14443' }, idTokenInfo: info('Blocked') },
        ],
      });
      // The renamed entry stores the token's current value.
      expect(
        ops.some(
          (o) =>
            o.op === 'update.set' &&
            (o.args[0] as Record<string, unknown>)['idToken'] === 'NEW' &&
            (o.args[0] as Record<string, unknown>)['authStatus'] === 'Accepted',
        ),
      ).toBe(true);
      // The sync time is written after the station accepted, and only the
      // pushed entries are stamped.
      const versionSet = ops.find(
        (o) => o.op === 'update.set' && 'localVersion' in (o.args[0] as Record<string, unknown>),
      );
      expect(versionSet?.args[0]).not.toHaveProperty('lastSyncAt');
      expect(
        ops.some(
          (o) => o.op === 'update.set' && (o.args[0] as Record<string, unknown>)['lastSyncAt'],
        ),
      ).toBe(true);
      expect(drizzle.inArray).toHaveBeenCalledWith('e.id', [1, 2, 3, 4, 5, 6]);
    });

    it('returns 504 COMMAND_TIMEOUT when the station does not answer', async () => {
      queuePush([]);
      sendOcppCommandAndWait.mockResolvedValue({ error: 'No response within 30s', timedOut: true });
      const res = await app.inject({
        method: 'POST',
        url: `/stations/${STATION_ID}/local-auth-list/push`,
        headers,
      });
      expect(res.statusCode).toBe(504);
      expect(res.json()).toEqual({ error: 'No response within 30s', code: 'COMMAND_TIMEOUT' });
    });

    it('returns 502 COMMAND_FAILED on other command errors', async () => {
      queuePush([]);
      sendOcppCommandAndWait.mockResolvedValue({ error: 'Station not connected' });
      const res = await app.inject({
        method: 'POST',
        url: `/stations/${STATION_ID}/local-auth-list/push`,
        headers,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'Station not connected', code: 'COMMAND_FAILED' });
    });

    it('returns 502 PUSH_REJECTED when the station does not accept the list', async () => {
      queuePush([]);
      sendOcppCommandAndWait.mockResolvedValue({ response: { status: 'VersionMismatch' } });
      const res = await app.inject({
        method: 'POST',
        url: `/stations/${STATION_ID}/local-auth-list/push`,
        headers,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        error: 'Station rejected push: VersionMismatch',
        code: 'PUSH_REJECTED',
      });
      expect(
        ops.some(
          (o) => o.op === 'update.set' && (o.args[0] as Record<string, unknown>)['pushedAt'],
        ),
      ).toBe(false);
      // A rejected push keeps the unpushed-changes banner: no sync time.
      expect(
        ops.some(
          (o) => o.op === 'update.set' && (o.args[0] as Record<string, unknown>)['lastSyncAt'],
        ),
      ).toBe(false);
    });

    it('reports Unknown when the station reply has no status', async () => {
      queuePush([]);
      sendOcppCommandAndWait.mockResolvedValue({});
      const res = await app.inject({
        method: 'POST',
        url: `/stations/${STATION_ID}/local-auth-list/push`,
        headers,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('Station rejected push: Unknown');
    });
  });

  it('POST add returns 400 NO_VALID_TOKENS when none of the tokens is active', async () => {
    results.push([onlineStation], []);
    const res = await app.inject({
      method: 'POST',
      url: `/stations/${STATION_ID}/local-auth-list/add`,
      headers,
      payload: { tokenIds: ['dtk_000000000009'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'No valid tokens found', code: 'NO_VALID_TOKENS' });
    expect(ops.some((o) => o.op.startsWith('insert'))).toBe(false);
  });

  it('POST remove returns 400 NO_VALID_ENTRIES when no entry belongs to the station', async () => {
    results.push([onlineStation], []);
    const res = await app.inject({
      method: 'POST',
      url: `/stations/${STATION_ID}/local-auth-list/remove`,
      headers,
      payload: { entryIds: [99] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'No valid entries found', code: 'NO_VALID_ENTRIES' });
    expect(ops.some((o) => o.op.startsWith('delete'))).toBe(false);
  });
});
