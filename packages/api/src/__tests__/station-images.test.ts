// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const VALID_STATION_ID = 'sta_000000000001';

// -- DB mock helpers --

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]) {
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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  stationImages: {},
  chargingStations: {},
}));

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

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(async (instance) => {
    stationImageRoutes(instance);
  });
  await app.ready();
  return app;
}

describe('Station image routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'test-id', roleId: 'test-role' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    vi.clearAllMocks();
    mockGetS3Config.mockResolvedValue(null);
    mockGenerateUploadUrl.mockResolvedValue('https://s3.example.com/upload');
    mockGenerateDownloadUrl.mockResolvedValue('https://s3.example.com/download');
    mockDeleteObject.mockResolvedValue(undefined);
    mockBuildStationImageS3Key.mockReturnValue('stations/sta_000000000001/uuid-photo.jpg');
  });

  // ===================================================================
  // GET /stations/:id/images
  // ===================================================================

  describe('GET /stations/:id/images', () => {
    it('returns 401 without token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/images`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns images array', async () => {
      const image = {
        id: 1,
        stationId: VALID_STATION_ID,
        fileName: 'photo.jpg',
        fileSize: 12345,
        contentType: 'image/jpeg',
        s3Key: 'stations/sta_000000000001/uuid-photo.jpg',
        s3Bucket: 'my-bucket',
        caption: 'Front view',
        tags: ['exterior'],
        isDriverVisible: true,
        isMainImage: false,
        sortOrder: 0,
        uploadedBy: 'test-id',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. select images
      setupDbResults([image]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/images`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(1);
      expect(body[0].fileName).toBe('photo.jpg');
    });
  });

  // ===================================================================
  // POST /stations/:id/images/upload-url
  // ===================================================================

  describe('POST /stations/:id/images/upload-url', () => {
    it('returns presigned URL when S3 configured', async () => {
      const s3Config = { client: {}, bucket: 'my-bucket' };
      mockGetS3Config.mockResolvedValue(s3Config);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/images/upload-url`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: 'photo.jpg',
          contentType: 'image/jpeg',
          fileSize: 12345,
        }),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.uploadUrl).toBe('https://s3.example.com/upload');
      expect(body.s3Key).toBeDefined();
      expect(body.s3Bucket).toBe('my-bucket');
    });

    it('returns 400 when S3 not configured', async () => {
      mockGetS3Config.mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/images/upload-url`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          fileName: 'photo.jpg',
          contentType: 'image/jpeg',
          fileSize: 12345,
        }),
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('S3_NOT_CONFIGURED');
    });
  });

  // ===================================================================
  // POST /stations/:id/images (confirm upload)
  // ===================================================================

  describe('POST /stations/:id/images', () => {
    const confirmBody = {
      fileName: 'photo.jpg',
      fileSize: 12345,
      contentType: 'image/jpeg',
      s3Key: 'stations/sta_000000000001/uuid-photo.jpg',
      s3Bucket: 'my-bucket',
    };

    it('confirms upload and inserts row', async () => {
      const insertedImage = {
        id: 1,
        stationId: VALID_STATION_ID,
        ...confirmBody,
        caption: null,
        tags: [],
        isDriverVisible: false,
        isMainImage: false,
        sortOrder: 1,
        uploadedBy: 'test-id',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. select max sort order, 2. insert returning
      setupDbResults([{ maxOrder: 0 }], [insertedImage]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/images`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(confirmBody),
      });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.fileName).toBe('photo.jpg');
      expect(body.sortOrder).toBe(1);
    });

    it('with isMainImage clears previous main', async () => {
      const insertedImage = {
        id: 2,
        stationId: VALID_STATION_ID,
        ...confirmBody,
        caption: null,
        tags: [],
        isDriverVisible: false,
        isMainImage: true,
        sortOrder: 2,
        uploadedBy: 'test-id',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. update clear main, 2. select max sort order, 3. insert returning
      setupDbResults([], [{ maxOrder: 1 }], [insertedImage]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/images`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...confirmBody, isMainImage: true }),
      });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.isMainImage).toBe(true);
    });
  });

  // ===================================================================
  // PATCH /stations/:id/images/:imageId
  // ===================================================================

  describe('PATCH /stations/:id/images/:imageId', () => {
    it('updates metadata and returns updated image', async () => {
      const updatedImage = {
        id: 1,
        stationId: VALID_STATION_ID,
        fileName: 'photo.jpg',
        caption: 'Updated caption',
        tags: ['new-tag'],
        isDriverVisible: true,
        isMainImage: false,
        sortOrder: 0,
      };

      // 1. update returning
      setupDbResults([updatedImage]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/images/1`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ caption: 'Updated caption' }),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.caption).toBe('Updated caption');
    });

    it('returns 404 if image not found', async () => {
      // 1. update returning (empty)
      setupDbResults([]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/images/999`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ caption: 'Does not exist' }),
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('IMAGE_NOT_FOUND');
    });
  });

  // ===================================================================
  // DELETE /stations/:id/images/:imageId
  // ===================================================================

  describe('DELETE /stations/:id/images/:imageId', () => {
    it('deletes from S3 and DB', async () => {
      const image = {
        id: 1,
        stationId: VALID_STATION_ID,
        s3Key: 'stations/sta_000000000001/uuid-photo.jpg',
        s3Bucket: 'my-bucket',
      };
      const s3Config = { client: {}, bucket: 'my-bucket' };
      mockGetS3Config.mockResolvedValue(s3Config);

      // 1. select image, 2. delete from DB
      setupDbResults([image], []);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/images/1`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(mockDeleteObject).toHaveBeenCalledWith(s3Config, 'my-bucket', image.s3Key);
    });

    it('returns 404 if image not found', async () => {
      // 1. select image (empty)
      setupDbResults([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/stations/${VALID_STATION_ID}/images/999`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('IMAGE_NOT_FOUND');
    });
  });

  // ===================================================================
  // GET /stations/:id/images/:imageId/download-url
  // ===================================================================

  describe('GET /stations/:id/images/:imageId/download-url', () => {
    it('returns download URL', async () => {
      const image = {
        id: 1,
        stationId: VALID_STATION_ID,
        s3Key: 'stations/sta_000000000001/uuid-photo.jpg',
        s3Bucket: 'my-bucket',
      };
      const s3Config = { client: {}, bucket: 'my-bucket' };
      mockGetS3Config.mockResolvedValue(s3Config);

      // 1. select image
      setupDbResults([image]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/images/1/download-url`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.downloadUrl).toBe('https://s3.example.com/download');
    });

    it('returns 404 if image not found', async () => {
      // 1. select image (empty)
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/images/999/download-url`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('IMAGE_NOT_FOUND');
    });

    it('returns 400 when S3 not configured', async () => {
      const image = {
        id: 1,
        stationId: VALID_STATION_ID,
        s3Key: 'stations/sta_000000000001/uuid-photo.jpg',
        s3Bucket: 'my-bucket',
      };
      mockGetS3Config.mockResolvedValue(null);

      // 1. select image
      setupDbResults([image]);

      const response = await app.inject({
        method: 'GET',
        url: `/stations/${VALID_STATION_ID}/images/1/download-url`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('S3_NOT_CONFIGURED');
    });
  });

  // ===================================================================
  // PATCH /stations/:id/images/reorder
  // ===================================================================

  describe('PATCH /stations/:id/images/reorder', () => {
    it('sets sortOrder for each image', async () => {
      // One update per imageId (3 images)
      setupDbResults([], [], []);

      const response = await app.inject({
        method: 'PATCH',
        url: `/stations/${VALID_STATION_ID}/images/reorder`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ imageIds: [3, 1, 2] }),
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });
  });

  // ===================================================================
  // POST /stations/:id/images/:imageId/set-main
  // ===================================================================

  describe('POST /stations/:id/images/:imageId/set-main', () => {
    it('clears old main and sets new main', async () => {
      const image = {
        id: 1,
        stationId: VALID_STATION_ID,
        isMainImage: false,
      };

      // 1. select image, 2. update clear old main, 3. update set new main
      setupDbResults([image], [], []);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/images/1/set-main`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });

    it('returns 404 if image not found', async () => {
      // 1. select image (empty)
      setupDbResults([]);

      const response = await app.inject({
        method: 'POST',
        url: `/stations/${VALID_STATION_ID}/images/999/set-main`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('IMAGE_NOT_FOUND');
    });
  });
});
