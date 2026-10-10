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
  PG_UNIQUE_VIOLATION: '23505',
  pgErrorCode: (err: { code?: string }) => err.code,
  pgConstraintName: (err: { constraint_name?: string }) => err.constraint_name,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, value: unknown) => ({ eq: [col, value] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  inArray: inArrayMock,
  ne: vi.fn((col: unknown, value: unknown) => ({ ne: [col, value] })),
  desc: vi.fn(),
  sql: vi.fn(),
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
import { db } from '@evtivity/database';

const SITE_A = 'sit_00000000000a';
const SITE_B = 'sit_00000000000b';

describe('OCPI routes, site scope', () => {
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

  describe('OCPI locations', () => {
    it('lists only the user sites', async () => {
      dbResults = [[{ id: SITE_A, name: 'A', address: null, city: null, country: null }], []];
      const res = await app.inject({ method: 'GET', url: '/ocpi/locations', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
      expect(inArrayMock).toHaveBeenCalledWith('sites.id', [SITE_A]);
      expect(inArrayMock).toHaveBeenCalledWith('olp.siteId', [SITE_A]);
    });

    it('returns an empty list without querying for a user with no sites', async () => {
      getUserSiteIdsMock.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url: '/ocpi/locations', headers });
      expect(res.json()).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('answers 404 for another site and writes nothing', async () => {
      const get = await app.inject({ method: 'GET', url: `/ocpi/locations/${SITE_B}`, headers });
      expect(get.statusCode).toBe(404);
      expect(get.json()).toEqual({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
      const put = await app.inject({
        method: 'PUT',
        url: `/ocpi/locations/${SITE_B}`,
        headers,
        payload: { isPublished: true },
      });
      expect(put.statusCode).toBe(404);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('OCPI location id and partner ids', () => {
    const publishRow = { id: 7, siteId: SITE_A, isPublished: true, publishToAll: false };

    it('omits partnerIds for a site-restricted user', async () => {
      dbResults = [[{ id: SITE_A, name: 'A' }], [publishRow]];
      const res = await app.inject({ method: 'GET', url: `/ocpi/locations/${SITE_A}`, headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('partnerIds');
    });

    it('returns partnerIds to an all-site user', async () => {
      getUserSiteIdsMock.mockResolvedValue(null);
      dbResults = [[{ id: SITE_A, name: 'A' }], [publishRow], [{ partnerId: 'opr_000000000001' }]];
      const res = await app.inject({ method: 'GET', url: `/ocpi/locations/${SITE_A}`, headers });
      expect(res.json().partnerIds).toEqual(['opr_000000000001']);
    });

    it('refuses an OCPI location id another row uses, before any write', async () => {
      dbResults = [[{ id: SITE_A }], [{ id: 3 }]];
      const res = await app.inject({
        method: 'PUT',
        url: `/ocpi/locations/${SITE_A}`,
        headers,
        payload: { isPublished: true, ocpiLocationId: 'LOC-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { ocpiLocationId: 'OCPI location id is already in use' },
      });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('refuses an OCPI location id equal to another site id with the same body', async () => {
      dbResults = [[{ id: SITE_A }]];
      const res = await app.inject({
        method: 'PUT',
        url: `/ocpi/locations/${SITE_A}`,
        headers,
        payload: { isPublished: true, ocpiLocationId: SITE_B },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toEqual({ ocpiLocationId: 'OCPI location id is already in use' });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('answers 400 when a concurrent write took the id (unique index)', async () => {
      dbResults = [[{ id: SITE_A }], [], [publishRow]];
      vi.mocked(db.update).mockImplementationOnce(() => {
        const chain = makeChain();
        chain['then'] = (_r: unknown, reject?: (e: unknown) => unknown) =>
          Promise.reject(
            Object.assign(new Error('dup'), {
              code: '23505',
              constraint_name: 'uq_ocpi_location_publish_location_id',
            }),
          ).then(undefined, reject);
        return chain as never;
      });
      const res = await app.inject({
        method: 'PUT',
        url: `/ocpi/locations/${SITE_A}`,
        headers,
        payload: { isPublished: true, ocpiLocationId: 'LOC-1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('refuses an unknown partner id for an all-site user', async () => {
      getUserSiteIdsMock.mockResolvedValue(null);
      dbResults = [[{ id: SITE_A }], [{ id: 'opr_000000000001' }]];
      const res = await app.inject({
        method: 'PUT',
        url: `/ocpi/locations/${SITE_A}`,
        headers,
        payload: { isPublished: true, partnerIds: ['opr_000000000001', 'opr_000000000009'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toEqual({ partnerIds: 'Unknown partner id: opr_000000000009' });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('refuses every site-id-shaped location id alike, whether that site exists or not', async () => {
      dbResults = [[{ id: SITE_A }]];
      const res = await app.inject({
        method: 'PUT',
        url: `/ocpi/locations/${SITE_A}`,
        headers,
        payload: { isPublished: true, ocpiLocationId: 'sit_doesnotexist0' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toEqual({ ocpiLocationId: 'OCPI location id is already in use' });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('accepts the site own id as its location id', async () => {
      getUserSiteIdsMock.mockResolvedValue(null);
      dbResults = [[{ id: SITE_A }], [], [publishRow]];
      const res = await app.inject({
        method: 'PUT',
        url: `/ocpi/locations/${SITE_A}`,
        headers,
        payload: { isPublished: true, ocpiLocationId: SITE_A },
      });
      expect(res.statusCode).toBe(200);
    });

    it('ignores publishToAll from a site-restricted user and keeps the stored value', async () => {
      dbResults = [[{ id: SITE_A }], [publishRow]];
      const res = await app.inject({
        method: 'PUT',
        url: `/ocpi/locations/${SITE_A}`,
        headers,
        payload: { isPublished: true, publishToAll: false },
      });
      expect(res.statusCode).toBe(200);
      const set = vi.mocked(db.update).mock.results[0]?.value as { set: ReturnType<typeof vi.fn> };
      expect(set.set.mock.calls[0]?.[0]).not.toHaveProperty('publishToAll');
    });

    it('keeps the stored partner list when a site-restricted user sends partnerIds', async () => {
      dbResults = [[{ id: SITE_A }], [publishRow]];
      const res = await app.inject({
        method: 'PUT',
        url: `/ocpi/locations/${SITE_A}`,
        headers,
        payload: { isPublished: true, partnerIds: ['opr_000000000009'] },
      });
      expect(res.statusCode).toBe(200);
      expect(db.update).toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('OCPI CDRs and sessions', () => {
    it('filters CDRs and sessions to sessions at the user sites', async () => {
      dbResults = [[], [{ count: 0 }], [], [{ count: 0 }]];
      const cdrs = await app.inject({ method: 'GET', url: '/ocpi/cdrs', headers });
      const sessions = await app.inject({ method: 'GET', url: '/ocpi/sessions', headers });
      expect(cdrs.statusCode).toBe(200);
      expect(sessions.statusCode).toBe(200);
      expect(sessionInSitesMock).toHaveBeenCalledWith('cdr.sessionId', [SITE_A]);
      expect(sessionInSitesMock).toHaveBeenCalledWith('ors.sessionId', [SITE_A]);
    });

    it('does not filter for an all-site user', async () => {
      getUserSiteIdsMock.mockResolvedValue(null);
      dbResults = [[], [{ count: 0 }]];
      await app.inject({ method: 'GET', url: '/ocpi/cdrs', headers });
      expect(sessionInSitesMock).not.toHaveBeenCalled();
    });

    it('answers 404 to a credit for a CDR outside the user sites', async () => {
      dbResults = [[]];
      const res = await app.inject({
        method: 'POST',
        url: '/ocpi/cdrs/credit',
        headers,
        payload: { originalCdrId: 'cdr-b', reason: 'refund' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'CDR not found', code: 'CDR_NOT_FOUND' });
      expect(createCreditCdrMock).not.toHaveBeenCalled();
    });

    it('credits a CDR of the user sites', async () => {
      dbResults = [[{ id: 'cdr_1' }]];
      createCreditCdrMock.mockResolvedValue({ status: 'created', cdrId: 'credit-1' });
      const res = await app.inject({
        method: 'POST',
        url: '/ocpi/cdrs/credit',
        headers,
        payload: { originalCdrId: 'cdr-a', reason: 'refund' },
      });
      expect(res.statusCode).toBe(201);
      expect(createCreditCdrMock).toHaveBeenCalledWith('cdr-a', 'refund');
    });
  });

  describe('OCPI partners', () => {
    it('answers 404 to a site-restricted user on partner routes', async () => {
      allSiteUser.value = false;
      for (const url of ['/ocpi/partners', '/ocpi/partners/opr_000000000001', '/ocpi/sync-log']) {
        const res = await app.inject({ method: 'GET', url, headers });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'Partner not found', code: 'PARTNER_NOT_FOUND' });
      }
      const del = await app.inject({
        method: 'DELETE',
        url: '/ocpi/partners/opr_000000000001',
        headers,
      });
      expect(del.statusCode).toBe(404);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });
  });
});
