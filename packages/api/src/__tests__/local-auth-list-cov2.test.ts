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
  driverTokens: { id: 'dt.id', isActive: 'dt.isActive', idToken: 'dt.idToken' },
  drivers: { firstName: 'd.firstName', lastName: 'd.lastName' },
  stationLocalAuthVersions: { stationId: 'v.stationId', localVersion: 'v.localVersion' },
  stationLocalAuthEntries: { id: 'e.id', stationId: 'e.stationId' },
  writeAudit: vi.fn().mockResolvedValue(undefined),
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
  });

  describe('POST push', () => {
    function queuePush(entries: Array<{ entryId: number; isActive: boolean }>): void {
      results.push(
        [onlineStation],
        [], // delete orphaned
        entries,
      );
      if (entries.some((e) => !e.isActive)) results.push([]); // block update
      results.push(
        [{ idToken: 'T1', tokenType: 'ISO14443', authStatus: 'Blocked' }],
        [{ id: 1, stationId: STATION_ID }], // version row exists
        [{ localVersion: 5 }],
      );
    }

    it('blocks entries whose token was deactivated before pushing', async () => {
      queuePush([
        { entryId: 1, isActive: false },
        { entryId: 2, isActive: true },
        { entryId: 3, isActive: false },
      ]);
      results.push([]); // pushedAt update
      sendOcppCommandAndWait.mockResolvedValue({ response: { status: 'Accepted' } });
      const res = await app.inject({
        method: 'POST',
        url: `/stations/${STATION_ID}/local-auth-list/push`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(drizzle.inArray).toHaveBeenCalledWith('e.id', [1, 3]);
      const blockSet = ops.find(
        (o) => o.op === 'update.set' && (o.args[0] as Record<string, unknown>)['authStatus'],
      );
      expect(blockSet?.args[0]).toEqual({ authStatus: 'Blocked' });
      expect(sendOcppCommandAndWait).toHaveBeenCalledWith('CS-001', 'SendLocalList', {
        versionNumber: 5,
        updateType: 'Full',
        localAuthorizationList: [
          { idToken: { idToken: 'T1', type: 'ISO14443' }, idTokenInfo: { status: 'Blocked' } },
        ],
      });
    });

    it('returns 504 COMMAND_TIMEOUT when the station does not answer', async () => {
      queuePush([]);
      sendOcppCommandAndWait.mockResolvedValue({ error: 'No response within 30s' });
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
