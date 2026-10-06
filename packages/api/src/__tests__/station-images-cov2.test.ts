// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_STATION_ID = 'sta_000000000001';

// -- DB mock helpers --

let dbResults: (unknown[] | Error)[] = [];
let dbCallIndex = 0;

function setupDbResults(...results: (unknown[] | Error)[]) {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'onConflictDoNothing',
    'delete',
    'insert',
    'update',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      if (r instanceof Error) return Promise.reject(r).then(resolve, reject);
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  chain['catch'] = (reject?: (r: unknown) => unknown) => Promise.resolve([]).catch(reject);
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
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('@evtivity/database', () => {
  const makeTxStub = () => ({
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  });
  return {
    db: {
      select: vi.fn(() => makeChain()),
      insert: vi.fn(() => makeChain()),
      update: vi.fn(() => makeChain()),
      delete: vi.fn(() => makeChain()),
      execute: vi.fn(() => Promise.resolve([])),
      transaction: vi.fn(async (cb: (tx: ReturnType<typeof makeTxStub>) => Promise<unknown>) =>
        cb(makeTxStub()),
      ),
    },
    stationImages: {},
    chargingStations: {},
    writeAudit: vi.fn().mockResolvedValue(undefined),
    pgErrorCode: (err: unknown) => (err as { code?: string }).code,
    PG_FOREIGN_KEY_VIOLATION: '23503',
    siteAuditLog: {},
    stationAuditLog: {},
    driverAuditLog: {},
    fleetAuditLog: {},
    userAuditLog: {},
    vehicleAuditLog: {},
    supportCaseAuditLog: {},
    ocpiPartnerAuditLog: {},
    certificateAuditLog: {},
    roleAuditLog: {},
    apiKeyAuditLog: {},
    settingAuditLog: {},
    smartChargingTemplateAuditLog: {},
    configTemplateAuditLog: {},
    firmwareCampaignAuditLog: {},
    stationImageAuditLog: {},
    localAuthListAuditLog: {},
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  notInArray: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}));

// -- S3 mock --

const mockGetS3Config = vi.fn();
const mockGenerateUploadUrl = vi.fn();
const mockGenerateDownloadUrl = vi.fn();
const mockDeleteObject = vi.fn();
const mockBuildStationImageS3Key = vi.fn();

vi.mock('../services/s3.service.js', () => ({
  getS3Config: (...args: unknown[]) => mockGetS3Config(...args),
  generateUploadUrl: (...args: unknown[]) => mockGenerateUploadUrl(...args),
  generateDownloadUrl: (...args: unknown[]) => mockGenerateDownloadUrl(...args),
  deleteObject: (...args: unknown[]) => mockDeleteObject(...args),
  buildStationImageS3Key: (...args: unknown[]) => mockBuildStationImageS3Key(...args),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
  checkStationSiteAccess: vi.fn().mockResolvedValue(true),
}));

import { registerAuth } from '../plugins/auth.js';
import { stationImageRoutes } from '../routes/station-images.js';
import { checkStationSiteAccess } from '../lib/site-access.js';
import { db, writeAudit } from '@evtivity/database';

const IMAGE = {
  id: 5,
  stationId: VALID_STATION_ID,
  fileName: 'photo.jpg',
  fileSize: 1000,
  contentType: 'image/jpeg',
  s3Key: 'stations/sta_000000000001/k.jpg',
  s3Bucket: 'bucket-a',
  caption: null,
  tags: [],
  isDriverVisible: false,
  isMainImage: false,
  sortOrder: 1,
  uploadedBy: 'test-id',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const confirmBody = {
  fileName: 'photo.jpg',
  fileSize: 1000,
  contentType: 'image/jpeg',
  s3Key: 'stations/sta_000000000001/k.jpg',
  s3Bucket: 'bucket-a',
};

describe('Station image routes (site scope and edge cases)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(async (instance) => {
      stationImageRoutes(instance);
    });
    await app.ready();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    vi.mocked(checkStationSiteAccess).mockResolvedValue(true);
    mockGetS3Config.mockResolvedValue(null);
    mockDeleteObject.mockResolvedValue(undefined);
  });

  const headers = () => ({ authorization: `Bearer ${token}` });

  describe('station outside the user site scope', () => {
    beforeEach(() => {
      vi.mocked(checkStationSiteAccess).mockResolvedValue(false);
    });

    it('list returns an empty array without querying images', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/images`,
        headers: headers(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it.each([
      [
        'POST',
        `/stations/${VALID_STATION_ID}/images/upload-url`,
        { fileName: 'a.jpg', contentType: 'image/jpeg', fileSize: 10 },
      ],
      ['POST', `/stations/${VALID_STATION_ID}/images`, confirmBody],
      ['PATCH', `/stations/${VALID_STATION_ID}/images/5`, { caption: 'x' }],
      ['DELETE', `/stations/${VALID_STATION_ID}/images/5`, undefined],
      ['GET', `/stations/${VALID_STATION_ID}/images/5/download-url`, undefined],
      ['PATCH', `/stations/${VALID_STATION_ID}/images/reorder`, { imageIds: [1, 2] }],
      ['POST', `/stations/${VALID_STATION_ID}/images/5/set-main`, undefined],
    ] as const)('%s %s returns 404 STATION_NOT_FOUND', async (method, url, payload) => {
      const res = await app.inject({
        method,
        url,
        headers: headers(),
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
      expect(mockGetS3Config).not.toHaveBeenCalled();
    });
  });

  it('confirm upload maps a foreign key violation to 404 STATION_NOT_FOUND', async () => {
    const fk = Object.assign(new Error('fk'), { code: '23503' });
    setupDbResults([{ maxOrder: 2 }], fk);
    const res = await app.inject({
      method: 'POST',
      url: `/stations/${VALID_STATION_ID}/images`,
      headers: headers(),
      payload: confirmBody,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('confirm upload rethrows other insert errors as 500', async () => {
    const other = Object.assign(new Error('deadlock'), { code: '40P01' });
    setupDbResults([{ maxOrder: 2 }], other);
    const res = await app.inject({
      method: 'POST',
      url: `/stations/${VALID_STATION_ID}/images`,
      headers: headers(),
      payload: confirmBody,
    });
    expect(res.statusCode).toBe(500);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('confirm upload with isMainImage clears the previous main image first', async () => {
    // update (clear main), select max sort, insert
    setupDbResults([], [{ maxOrder: 4 }], [{ ...IMAGE, isMainImage: true, sortOrder: 5 }]);
    const res = await app.inject({
      method: 'POST',
      url: `/stations/${VALID_STATION_ID}/images`,
      headers: headers(),
      payload: { ...confirmBody, isMainImage: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 5, isMainImage: true, sortOrder: 5 });
    const updateChain = vi.mocked(db.update).mock.results[0]?.value as {
      set: ReturnType<typeof vi.fn>;
    };
    expect(updateChain.set).toHaveBeenCalledWith({ isMainImage: false });
    const insertChain = vi.mocked(db.insert).mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ sortOrder: 5, isMainImage: true, uploadedBy: 'test-id' }),
    );
  });

  describe('PATCH image metadata', () => {
    it('with isMainImage clears other main images and applies every field', async () => {
      // update clear, select before, update returning
      setupDbResults([], [IMAGE], [{ ...IMAGE, isMainImage: true, caption: 'Front' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/images/5`,
        headers: headers(),
        payload: {
          isMainImage: true,
          caption: 'Front',
          tags: ['front'],
          isDriverVisible: true,
          sortOrder: 3,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ isMainImage: true, caption: 'Front' });
      const clear = vi.mocked(db.update).mock.results[0]?.value as {
        set: ReturnType<typeof vi.fn>;
      };
      expect(clear.set).toHaveBeenCalledWith({ isMainImage: false });
      const apply = vi.mocked(db.update).mock.results[1]?.value as {
        set: ReturnType<typeof vi.fn>;
      };
      expect(apply.set).toHaveBeenCalledWith({
        caption: 'Front',
        tags: ['front'],
        isDriverVisible: true,
        isMainImage: true,
        sortOrder: 3,
      });
      expect(writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'updated', before: IMAGE }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('with a null caption stores null', async () => {
      setupDbResults([IMAGE], [{ ...IMAGE, caption: null }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/images/5`,
        headers: headers(),
        payload: { caption: null },
      });
      expect(res.statusCode).toBe(200);
      const apply = vi.mocked(db.update).mock.results[0]?.value as {
        set: ReturnType<typeof vi.fn>;
      };
      expect(apply.set).toHaveBeenCalledWith({ caption: null });
    });

    it('with an empty body returns the existing image without updating', async () => {
      setupDbResults([IMAGE]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/images/5`,
        headers: headers(),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: 5, fileName: 'photo.jpg' });
      expect(db.update).not.toHaveBeenCalled();
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('with an empty body returns 404 IMAGE_NOT_FOUND for an unknown image', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/images/99`,
        headers: headers(),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Image not found', code: 'IMAGE_NOT_FOUND' });
    });

    it('returns 404 IMAGE_NOT_FOUND when the update matches no row', async () => {
      setupDbResults([], []);
      const res = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/images/99`,
        headers: headers(),
        payload: { caption: 'x' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Image not found', code: 'IMAGE_NOT_FOUND' });
      expect(writeAudit).not.toHaveBeenCalled();
    });
  });
});
