// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
  },
  client: { end: vi.fn() },
  chargingStations: {},
  evses: {},
  connectors: {},
  sites: {},
  chargingSessions: {},
  driverPaymentMethods: {},
  reservations: {},
  stationImages: {},
  settings: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
  count: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  notInArray: vi.fn(),
  isNull: vi.fn(),
}));

// -- S3 mock --

const mockGetS3Config = vi.fn();
const mockGenerateDownloadUrl = vi.fn();

vi.mock('../services/s3.service.js', () => ({
  getS3Config: (...args: unknown[]) => mockGetS3Config(...args),
  generateDownloadUrl: (...args: unknown[]) => mockGenerateDownloadUrl(...args),
  generateUploadUrl: vi.fn(),
  deleteObject: vi.fn(),
  buildStationImageS3Key: vi.fn(),
}));

// -- Other mocks --

vi.mock('../../lib/pubsub.js', () => ({
  getPubSub: vi.fn(),
}));

vi.mock('../lib/pubsub.js', () => ({
  getPubSub: vi.fn(),
}));

vi.mock('../lib/ocpp-command.js', () => ({
  sendOcppCommandAndWait: vi.fn(),
  triggerAndWaitForStatus: vi.fn(),
}));

vi.mock('../lib/rate-limiters.js', () => ({
  isStationCheckRateLimited: vi.fn(() => false),
}));

vi.mock('../services/stripe.service.js', () => ({
  getStripeConfig: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../services/tariff.service.js', () => ({
  resolveTariff: vi.fn(() => Promise.resolve(null)),
  isTariffFree: vi.fn(() => false),
}));

vi.mock('@evtivity/lib', () => ({
  dispatchDriverNotification: vi.fn(),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../lib/template-dirs.js', () => ({
  ALL_TEMPLATES_DIRS: [],
}));

import { registerAuth } from '../plugins/auth.js';
import { portalChargerRoutes } from '../routes/portal/charger.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(async (instance) => {
    portalChargerRoutes(instance);
  });
  await app.ready();
  return app;
}

describe('Portal location routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbResults = [];
    dbCallIndex = 0;
    vi.clearAllMocks();
    mockGetS3Config.mockResolvedValue(null);
    mockGenerateDownloadUrl.mockResolvedValue('https://s3.example.com/download');
  });

  // ===================================================================
  // GET /portal/chargers/location/:siteId
  // ===================================================================

  describe('GET /portal/chargers/location/:siteId', () => {
    it('returns site info with correct fields', async () => {
      const site = {
        id: 'site-001',
        name: 'Downtown Charging Hub',
        address: '123 Main St',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94105',
        latitude: '37.7749',
        longitude: '-122.4194',
        hoursOfOperation: 'Mon-Fri 8am-6pm',
        contactName: 'John Doe',
        contactEmail: 'john@example.com',
        contactPhone: '555-1234',
        contactIsPublic: true,
      };

      const counts = {
        stationCount: 5,
        evseCount: 10,
        availableCount: 7,
      };

      // 1. select site, 2. select counts
      setupDbResults([site], [counts]);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/location/site-001',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.siteId).toBe('site-001');
      expect(body.name).toBe('Downtown Charging Hub');
      expect(body.address).toBe('123 Main St');
      expect(body.stationCount).toBe(5);
      expect(body.evseCount).toBe(10);
      expect(body.availableCount).toBe(7);
      expect(body.hoursOfOperation).toBe('Mon-Fri 8am-6pm');
      expect(body.contactName).toBe('John Doe');
      expect(body.contactEmail).toBe('john@example.com');
      expect(body.contactPhone).toBe('555-1234');
    });

    it('hides contact info when contactIsPublic is false', async () => {
      const site = {
        id: 'site-002',
        name: 'Private Site',
        address: '456 Oak Ave',
        city: 'Oakland',
        state: 'CA',
        postalCode: '94612',
        latitude: '37.8044',
        longitude: '-122.2712',
        hoursOfOperation: null,
        contactName: 'Jane Doe',
        contactEmail: 'jane@example.com',
        contactPhone: '555-5678',
        contactIsPublic: false,
      };

      const counts = { stationCount: 2, evseCount: 4, availableCount: 3 };

      setupDbResults([site], [counts]);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/location/site-002',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.contactName).toBeNull();
      expect(body.contactEmail).toBeNull();
      expect(body.contactPhone).toBeNull();
    });

    it('returns 404 for nonexistent site', async () => {
      // 1. select site (empty)
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/location/nonexistent',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('SITE_NOT_FOUND');
    });
  });

  // ===================================================================
  // GET /portal/chargers/location/:siteId/images
  // ===================================================================

  describe('GET /portal/chargers/location/:siteId/images', () => {
    it('returns only driver-visible images', async () => {
      const images = [
        {
          id: 1,
          stationId: 'sta-001',
          fileName: 'front.jpg',
          fileSize: 12345,
          contentType: 'image/jpeg',
          caption: 'Front view',
        },
        {
          id: 2,
          stationId: 'sta-001',
          fileName: 'side.jpg',
          fileSize: 23456,
          contentType: 'image/jpeg',
          caption: null,
        },
      ];

      // 1. select images (filtered by isDriverVisible in query)
      setupDbResults(images);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/location/site-001/images',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(2);
      expect(body[0].fileName).toBe('front.jpg');
      expect(body[1].fileName).toBe('side.jpg');
    });

    it('returns empty array when no driver-visible images exist', async () => {
      // 1. select images (empty)
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/location/site-001/images',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveLength(0);
    });
  });

  // ===================================================================
  // GET /portal/chargers/location/:siteId/images/:imageId/download-url
  // ===================================================================

  describe('GET /portal/chargers/location/:siteId/images/:imageId/download-url', () => {
    it('returns 404 for non-driver-visible images', async () => {
      // 1. select image (empty because query filters by isDriverVisible=true)
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/location/site-001/images/999/download-url',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('IMAGE_NOT_FOUND');
    });

    it('returns download URL for driver-visible images', async () => {
      const image = {
        id: 1,
        s3Key: 'stations/sta-001/uuid-photo.jpg',
        s3Bucket: 'my-bucket',
        isDriverVisible: true,
      };

      const s3Config = { client: {}, bucket: 'my-bucket' };
      mockGetS3Config.mockResolvedValue(s3Config);

      // 1. select image
      setupDbResults([image]);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/location/site-001/images/1/download-url',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.downloadUrl).toBe('https://s3.example.com/download');
      expect(mockGenerateDownloadUrl).toHaveBeenCalledWith(s3Config, 'my-bucket', image.s3Key);
    });

    it('returns 404 when S3 not configured', async () => {
      const image = {
        id: 1,
        s3Key: 'stations/sta-001/uuid-photo.jpg',
        s3Bucket: 'my-bucket',
        isDriverVisible: true,
      };
      mockGetS3Config.mockResolvedValue(null);

      // 1. select image
      setupDbResults([image]);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/location/site-001/images/1/download-url',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('S3_NOT_CONFIGURED');
    });
  });

  // ===================================================================
  // GET /portal/chargers/location/:siteId/popular-times
  // ===================================================================

  describe('GET /portal/chargers/location/:siteId/popular-times', () => {
    it('returns expected shape', async () => {
      const site = { id: 'site-001', timezone: 'America/Los_Angeles' };

      const sessionRows = [
        { dow: 1, hour: 9, totalSessions: 12 },
        { dow: 1, hour: 10, totalSessions: 8 },
        { dow: 3, hour: 17, totalSessions: 20 },
      ];

      // 1. select site, 2. select session aggregation
      setupDbResults([site], sessionRows);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/location/site-001/popular-times?weeks=4',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(3);
      expect(body[0]).toHaveProperty('dow');
      expect(body[0]).toHaveProperty('hour');
      expect(body[0]).toHaveProperty('avgSessions');
      // 12 sessions / 4 weeks = 3.0
      expect(body[0].avgSessions).toBe(3);
      // 20 sessions / 4 weeks = 5.0
      expect(body[2].avgSessions).toBe(5);
    });

    it('returns 404 for nonexistent site', async () => {
      // 1. select site (empty)
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/location/nonexistent/popular-times',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('SITE_NOT_FOUND');
    });
  });

  // ===================================================================
  // GET /portal/chargers/map-config
  // ===================================================================

  describe('GET /portal/chargers/map-config', () => {
    it('returns map configuration', async () => {
      const settingsRows = [
        { key: 'googleMaps.apiKey', value: 'test-api-key' },
        { key: 'googleMaps.defaultLat', value: '40.7128' },
        { key: 'googleMaps.defaultLng', value: '-74.006' },
        { key: 'googleMaps.defaultZoom', value: '14' },
      ];

      // 1. select settings
      setupDbResults(settingsRows);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/map-config',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.apiKey).toBe('test-api-key');
      expect(body.defaultLat).toBe(40.7128);
      expect(body.defaultLng).toBe(-74.006);
      expect(body.defaultZoom).toBe(14);
    });

    it('returns defaults when no settings exist', async () => {
      // 1. select settings (empty)
      setupDbResults([]);

      const response = await app.inject({
        method: 'GET',
        url: '/portal/chargers/map-config',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.apiKey).toBe('');
      expect(body.defaultLat).toBe(37.7749);
      expect(body.defaultLng).toBe(-122.4194);
      expect(body.defaultZoom).toBe(12);
    });
  });
});
