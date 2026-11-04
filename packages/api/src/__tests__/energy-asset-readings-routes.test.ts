// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// The reading route an EMS pushes battery and solar readings to: what it
// stores, and every refusal (telemetry, timestamps, ranges, site, rate limit).

const { state, writer, siteIdsMock, hierarchyMock, configMock } = vi.hoisted(() => {
  class LoadTreeValidationError extends Error {
    public readonly field: string;
    constructor(message: string, field: string) {
      super(message);
      this.field = field;
    }
  }
  return {
    state: { results: [] as unknown[][], index: 0 },
    writer: {
      LoadTreeValidationError,
      createEnergyAsset: vi.fn(),
      updateEnergyAsset: vi.fn(),
      deleteEnergyAsset: vi.fn(),
      recordEnergyAssetReading: vi.fn(),
    },
    siteIdsMock: vi.fn(),
    hierarchyMock: vi.fn(),
    configMock: { ENERGY_ASSETS_ALLOW_SIMULATED: false },
  };
});

function setupDbResults(...results: unknown[][]): void {
  state.results = results;
  state.index = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = state.results[state.index] ?? [];
      state.index++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: { select: vi.fn(() => makeChain()) },
  siteEnergyAssets: {},
  energyAssetReadings: {},
  markSitePlanStale: vi.fn().mockResolvedValue(true),
  ...writer,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@evtivity/services/load-management.service', () => ({
  getSitePowerStatus: vi.fn().mockResolvedValue({ totalDrawKw: 0, stations: [] }),
  buildSiteHierarchy: hierarchyMock,
}));

vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>();
  // One object the test flips: the routes read the gate at request time.
  Object.assign(configMock, actual.config, { ENERGY_ASSETS_ALLOW_SIMULATED: false });
  return { ...actual, config: configMock };
});

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: siteIdsMock,
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (n: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

import { registerAuth } from '../plugins/auth.js';
import { energyAssetReadingRoutes } from '../routes/energy-asset-readings.js';

const SITE = 'sit_a';
const USER = 'usr_000000000001';
const created = '2026-11-03T00:00:00.000Z';

const batteryRow = {
  id: 'ena_bat',
  siteId: SITE,
  type: 'battery',
  name: 'Battery',
  capacityKwh: 500,
  peakKwp: null,
  inverterKw: '250',
  maxDischargeKw: '250',
  maxChargeKw: '200',
  phases: 3,
  connectionTransformerId: null,
  connectionPanelId: 'pnl_a',
  gridCharging: 'possible',
  reservePercent: 10,
  telemetry: 'api',
  readingTtlSeconds: 60,
  createdAt: created,
  updatedAt: created,
};

const readingUrl = `/sites/${SITE}/energy-assets/ena_bat/reading`;

describe('energy asset reading route', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };
  let keyAuth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await app.register(rateLimit, { global: false });
    await registerAuth(app);
    energyAssetReadingRoutes(app);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: USER, roleId: 'rol_1' })}` };
    keyAuth = {
      authorization: `Bearer ${app.jwt.sign({ userId: USER, roleId: 'rol_1', apiKeyId: '41' })}`,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    siteIdsMock.mockReset().mockResolvedValue(null);
    hierarchyMock.mockReset().mockResolvedValue([]);
    for (const fn of Object.values(writer)) {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    }
    writer.recordEnergyAssetReading.mockResolvedValue(true);
    configMock.ENERGY_ASSETS_ALLOW_SIMULATED = false;
  });

  const fresh = (overrides: Record<string, unknown> = {}) => ({
    reportedAt: new Date().toISOString(),
    powerKw: 120,
    availableKw: 200,
    socPercent: 80,
    ...overrides,
  });

  it('stores an API key reading with the key id and answers 204', async () => {
    setupDbResults([batteryRow]);
    const res = await app.inject({
      method: 'PUT',
      url: readingUrl,
      headers: keyAuth,
      payload: fresh(),
    });
    expect(res.statusCode).toBe(204);
    expect(writer.recordEnergyAssetReading).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'ena_bat',
        powerKw: 120,
        availableKw: 200,
        socPercent: 80,
        source: 'api',
        apiKeyId: '41',
      }),
    );
  });

  it('stores a session reading with no key id', async () => {
    setupDbResults([batteryRow]);
    const res = await app.inject({
      method: 'PUT',
      url: readingUrl,
      headers: auth,
      payload: fresh({ availableKw: undefined, socPercent: undefined }),
    });
    expect(res.statusCode).toBe(204);
    expect(writer.recordEnergyAssetReading).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: null, availableKw: null, socPercent: null }),
    );
  });

  it('answers 409 when a newer reading is already stored', async () => {
    setupDbResults([batteryRow]);
    writer.recordEnergyAssetReading.mockResolvedValue(false);
    const res = await app.inject({
      method: 'PUT',
      url: readingUrl,
      headers: keyAuth,
      payload: fresh(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(
      expect.objectContaining({ code: 'ENERGY_ASSET_READING_OUTDATED', field: 'reportedAt' }),
    );
  });

  it('refuses an asset whose telemetry is not api', async () => {
    for (const telemetry of ['none', 'simulated']) {
      setupDbResults([{ ...batteryRow, telemetry }]);
      const res = await app.inject({
        method: 'PUT',
        url: readingUrl,
        headers: keyAuth,
        payload: fresh(),
      });
      expect(res.statusCode, telemetry).toBe(400);
      expect(res.json()).toEqual(
        expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'telemetry' }),
      );
    }
    expect(writer.recordEnergyAssetReading).not.toHaveBeenCalled();
  });

  it('refuses a reading more than 30 seconds in the future or older than the TTL', async () => {
    for (const reportedAt of [
      new Date(Date.now() + 31_000).toISOString(),
      new Date(Date.now() - 61_000).toISOString(),
    ]) {
      setupDbResults([batteryRow]);
      const res = await app.inject({
        method: 'PUT',
        url: readingUrl,
        headers: keyAuth,
        payload: fresh({ reportedAt }),
      });
      expect(res.statusCode, reportedAt).toBe(400);
      expect(res.json()).toEqual(expect.objectContaining({ field: 'reportedAt' }));
    }
    // 20 seconds ahead is clock skew, accepted.
    setupDbResults([batteryRow]);
    const skew = await app.inject({
      method: 'PUT',
      url: readingUrl,
      headers: keyAuth,
      payload: fresh({ reportedAt: new Date(Date.now() + 20_000).toISOString() }),
    });
    expect(skew.statusCode).toBe(204);
  });

  it('refuses values out of range before any read', async () => {
    for (const payload of [
      fresh({ powerKw: 100_001 }),
      fresh({ powerKw: -100_001 }),
      fresh({ socPercent: 101 }),
      fresh({ socPercent: -1 }),
      fresh({ availableKw: -1 }),
      fresh({ reportedAt: 'yesterday' }),
    ]) {
      const res = await app.inject({ method: 'PUT', url: readingUrl, headers: keyAuth, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(writer.recordEnergyAssetReading).not.toHaveBeenCalled();
  });

  it('answers 404 for an asset of another site or outside the scope', async () => {
    setupDbResults([]);
    const other = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE}/energy-assets/ena_other_site/reading`,
      headers: keyAuth,
      payload: fresh(),
    });
    expect(other.statusCode).toBe(404);
    expect(other.json().code).toBe('ENERGY_ASSET_NOT_FOUND');
    siteIdsMock.mockResolvedValue(['sit_other']);
    const outside = await app.inject({
      method: 'PUT',
      url: readingUrl,
      headers: keyAuth,
      payload: fresh(),
    });
    expect(outside.statusCode).toBe(404);
    expect(writer.recordEnergyAssetReading).not.toHaveBeenCalled();
  });

  it('limits readings to 60 a minute per asset and caller', async () => {
    const limited = {
      authorization: `Bearer ${app.jwt.sign({ userId: USER, roleId: 'rol_1', apiKeyId: '99' })}`,
    };
    const url = `/sites/${SITE}/energy-assets/ena_limit/reading`;
    let last = 0;
    for (let i = 0; i < 61; i++) {
      setupDbResults([{ ...batteryRow, id: 'ena_limit' }]);
      const res = await app.inject({ method: 'PUT', url, headers: limited, payload: fresh() });
      last = res.statusCode;
      if (i < 60) expect(res.statusCode).toBe(204);
    }
    expect(last).toBe(429);
    // Another caller on the same asset keeps its own budget.
    setupDbResults([{ ...batteryRow, id: 'ena_limit' }]);
    const other = await app.inject({ method: 'PUT', url, headers: auth, payload: fresh() });
    expect(other.statusCode).toBe(204);
  });
});
