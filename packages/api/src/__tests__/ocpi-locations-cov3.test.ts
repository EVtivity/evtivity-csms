// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const {
  getUserSiteIdsMock,
  userCanAccessSiteMock,
  allSiteUser,
  createCreditCdrMock,
  sessionInSitesMock,
  inArrayMock,
} = vi.hoisted(() => ({
  getUserSiteIdsMock: vi.fn(),
  userCanAccessSiteMock: vi.fn(),
  allSiteUser: { value: true },
  createCreditCdrMock: vi.fn(),
  sessionInSitesMock: vi.fn((col: unknown, ids: unknown) => ({ sessionInSites: [col, ids] })),
  inArrayMock: vi.fn((col: unknown, value: unknown) => ({ inArray: [col, value] })),
}));

let dbResults: unknown[][] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'from',
    'where',
    'leftJoin',
    'orderBy',
    'limit',
    'offset',
    'set',
    'values',
    'returning',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve, reject);
  // The site row lock of the publish save takes no queued result.
  chain['for'] = vi.fn(() => Promise.resolve([{ id: 'locked' }]));
  return chain;
}

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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    // The publish save runs on the same chain mock.
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const { db: mocked } = await import('@evtivity/database');
      return fn(mocked);
    }),
  },
  sites: { id: 'sites.id', name: 'sites.name' },
  ocpiLocationPublish: { id: 'olp.id', siteId: 'olp.siteId', ocpiLocationId: 'olp.ocpiLocationId' },
  ocpiLocationPublishPartners: {},
  ocpiLocationAudience: vi.fn().mockResolvedValue([]),
  ocpiCdrs: { id: 'cdr.id', ocpiCdrId: 'cdr.ocpiCdrId', chargingSessionId: 'cdr.sessionId' },
  ocpiRoamingSessions: { chargingSessionId: 'ors.sessionId' },
  ocpiPartners: { id: 'op.id' },
  ocpiPartnerEndpoints: {},
  ocpiSyncLog: {},
  createCreditCdr: createCreditCdrMock,
  siteAuditLog: { name: 'site_audit_log' },
  ocpiPartnerAuditLog: { name: 'ocpi_partner_audit_log' },
  sessionAuditLog: { name: 'session_audit_log' },
  writeAudit: vi.fn(),
  PG_UNIQUE_VIOLATION: '23505',
  PG_FOREIGN_KEY_VIOLATION: '23503',
  pgErrorCode: (err: { code?: string }) => err.code,
  pgConstraintName: (err: { constraint_name?: string }) => err.constraint_name,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, value: unknown) => ({ eq: [col, value] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  inArray: inArrayMock,
  ne: vi.fn((col: unknown, value: unknown) => ({ ne: [col, value] })),
  desc: vi.fn(),
  // The list sort renders its direction with sql.raw.
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: getUserSiteIdsMock,
  userCanAccessSite: userCanAccessSiteMock,
  requireAllSiteAccess: vi.fn(
    async (
      _request: unknown,
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
      notFound: unknown,
    ) => {
      if (allSiteUser.value) return true;
      await reply.status(404).send(notFound);
      return false;
    },
  ),
}));

vi.mock('../lib/ocpi-site-scope.js', () => ({ sessionInSites: sessionInSitesMock }));

vi.mock('../lib/ocpi-location-push.js', () => ({
  lostLocationAudience: vi.fn(() => []),
  publishOcpiLocationPush: vi.fn(),
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: vi.fn(), subscribe: vi.fn() }),
}));

import { registerAuth } from '../plugins/auth.js';
import { ocpiLocationRoutes } from '../routes/ocpi-locations.js';
import { ocpiCdrRoutes } from '../routes/ocpi-cdrs.js';
import { ocpiSessionRoutes } from '../routes/ocpi-sessions.js';
import { ocpiPartnerRoutes } from '../routes/ocpi-partners.js';
import { db, writeAudit } from '@evtivity/database';

const SITE_A = 'sit_00000000000a';
const SITE_B = 'sit_00000000000b';

describe('OCPI location routes (cov3)', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    ocpiLocationRoutes(app);
    ocpiCdrRoutes(app);
    ocpiSessionRoutes(app);
    ocpiPartnerRoutes(app);
    await app.ready();
    headers = {
      authorization: `Bearer ${app.jwt.sign({ userId: 'usr_000000000001', roleId: 'r' })}`,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    vi.clearAllMocks();
    allSiteUser.value = true;
    getUserSiteIdsMock.mockResolvedValue([SITE_A]);
    userCanAccessSiteMock.mockImplementation((_u: string, siteId: string) =>
      Promise.resolve(siteId === SITE_A),
    );
  });

  it('lists every site of an all-site user, unpublished by default', async () => {
    getUserSiteIdsMock.mockResolvedValue(null);
    dbResults = [
      [
        { id: SITE_A, name: 'A', address: null, city: null, country: null },
        { id: SITE_B, name: 'B', address: null, city: null, country: null },
      ],
      [{ id: 1, siteId: SITE_B, isPublished: true, publishToAll: false, ocpiLocationId: 'LOC-B' }],
    ];
    const res = await app.inject({ method: 'GET', url: '/ocpi/locations', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: SITE_A,
        isPublished: false,
        publishToAll: true,
        ocpiLocationId: null,
      }),
      expect.objectContaining({
        id: SITE_B,
        isPublished: true,
        publishToAll: false,
        ocpiLocationId: 'LOC-B',
      }),
    ]);
    expect(inArrayMock).not.toHaveBeenCalled();
  });

  it('answers 404 for a site in scope that does not exist', async () => {
    dbResults = [[]];
    const get = await app.inject({ method: 'GET', url: `/ocpi/locations/${SITE_A}`, headers });
    expect(get.statusCode).toBe(404);
    expect(get.json().code).toBe('SITE_NOT_FOUND');
    dbResults = [[]];
    const put = await app.inject({
      method: 'PUT',
      url: `/ocpi/locations/${SITE_A}`,
      headers,
      payload: { isPublished: true },
    });
    expect(put.statusCode).toBe(404);
    expect(put.json().code).toBe('SITE_NOT_FOUND');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('creates the publish row with the partner list on a first save', async () => {
    getUserSiteIdsMock.mockResolvedValue(null);
    // The site, the location id check, the partner check, no publish row yet, the new id.
    dbResults = [[{ id: SITE_A }], [], [{ id: 'opr_000000000001' }], [], [{ id: 9 }]];
    const res = await app.inject({
      method: 'PUT',
      url: `/ocpi/locations/${SITE_A}`,
      headers,
      payload: {
        isPublished: true,
        publishToAll: false,
        ocpiLocationId: 'LOC-A',
        partnerIds: ['opr_000000000001'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const insertChains = vi
      .mocked(db.insert)
      .mock.results.map((r) => r.value as { values: ReturnType<typeof vi.fn> });
    expect(insertChains[0]?.values).toHaveBeenCalledWith({
      siteId: SITE_A,
      isPublished: true,
      publishToAll: false,
      ocpiLocationId: 'LOC-A',
    });
    expect(insertChains[1]?.values).toHaveBeenCalledWith([
      { locationPublishId: 9, partnerId: 'opr_000000000001' },
    ]);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
      action: 'location_published_changed',
      before: { isPublished: false },
      after: { isPublished: true, ocpiLocationId: 'LOC-A' },
    });
  });

  it('clears the partner list without inserting one for an empty list', async () => {
    getUserSiteIdsMock.mockResolvedValue(null);
    dbResults = [[{ id: SITE_A }], [], [{ id: 9 }]];
    const res = await app.inject({
      method: 'PUT',
      url: `/ocpi/locations/${SITE_A}`,
      headers,
      payload: { isPublished: false, partnerIds: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('answers 500 when the publish insert returns no row', async () => {
    dbResults = [[{ id: SITE_A }], [], []];
    const res = await app.inject({
      method: 'PUT',
      url: `/ocpi/locations/${SITE_A}`,
      headers,
      payload: { isPublished: true },
    });
    expect(res.statusCode).toBe(500);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('answers 400 Unknown partner id when a partner was deleted during the save', async () => {
    getUserSiteIdsMock.mockResolvedValue(null);
    dbResults = [[{ id: SITE_A }], [{ id: 'opr_000000000001' }], [{ id: 7, siteId: SITE_A }]];
    vi.mocked(db.insert).mockImplementationOnce(() => {
      const chain = makeChain();
      chain['then'] = (_r: unknown, reject?: (e: unknown) => unknown) =>
        Promise.reject(Object.assign(new Error('fk'), { code: '23503' })).then(undefined, reject);
      return chain as never;
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/ocpi/locations/${SITE_A}`,
      headers,
      payload: { isPublished: true, partnerIds: ['opr_000000000001'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { partnerIds: 'Unknown partner id' },
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('rethrows any other database error as 500', async () => {
    dbResults = [[{ id: SITE_A }], [{ id: 7, siteId: SITE_A }]];
    vi.mocked(db.update).mockImplementationOnce(() => {
      const chain = makeChain();
      chain['then'] = (_r: unknown, reject?: (e: unknown) => unknown) =>
        Promise.reject(new Error('connection lost')).then(undefined, reject);
      return chain as never;
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/ocpi/locations/${SITE_A}`,
      headers,
      payload: { isPublished: true },
    });
    expect(res.statusCode).toBe(500);
  });
});
