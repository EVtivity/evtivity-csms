// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// The battery and solar routes: site scope, the writer called in the
// caller's name with the process gate for simulated telemetry, and the supply
// the list shows.

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

const siteExistsMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../lib/site-exists.js', () => ({ siteExists: siteExistsMock }));
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
import { energyAssetRoutes } from '../routes/energy-assets.js';

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

const solarRow = {
  ...batteryRow,
  id: 'ena_sol',
  type: 'solar',
  name: 'Canopy',
  capacityKwh: null,
  peakKwp: 100,
  inverterKw: '90',
  maxDischargeKw: null,
  maxChargeKw: null,
  connectionPanelId: null,
  gridCharging: 'never',
};

describe('energy asset routes', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await app.register(rateLimit, { global: false });
    await registerAuth(app);
    energyAssetRoutes(app);
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ userId: USER, roleId: 'rol_1' })}` };
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

  const caller = expect.objectContaining({ actor: 'operator', actorUserId: USER });

  it('GET lists assets with the tree supply, or the reading state of an uncounted one', async () => {
    const now = new Date();
    setupDbResults(
      [batteryRow, solarRow],
      [
        {
          assetId: 'ena_sol',
          reportedAt: now,
          receivedAt: now,
          powerKw: '40',
          availableKw: null,
          socPercent: null,
          source: 'api',
          apiKeyId: null,
        },
      ],
    );
    hierarchyMock.mockResolvedValue([
      {
        type: 'panel',
        id: 'pnl_root',
        children: [
          {
            type: 'panel',
            id: 'pnl_a',
            children: [],
            energyAssets: [
              { id: 'ena_bat', state: 'stale', creditKw: 0, loadKw: 200, creditApplied: true },
            ],
          },
        ],
      },
    ]);
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/energy-assets`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const [battery, solar] = res.json();
    expect(battery).toEqual(
      expect.objectContaining({
        inverterKw: 250,
        reading: null,
        supply: { state: 'stale', counted: true, creditKw: 0, loadKw: 200 },
      }),
    );
    expect(solar).toEqual(
      expect.objectContaining({
        reading: expect.objectContaining({ powerKw: 40, source: 'api' }),
        supply: { state: 'fresh', counted: false, creditKw: 0, loadKw: 0 },
      }),
    );
    expect(hierarchyMock).toHaveBeenCalledWith(
      SITE,
      [],
      expect.objectContaining({ allowSimulatedEnergyAssets: false }),
    );
  });

  it('GET answers 404 SITE_NOT_FOUND outside the caller scope', async () => {
    siteIdsMock.mockResolvedValue(['sit_other']);
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE}/energy-assets`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('SITE_NOT_FOUND');
  });

  it('POST answers 404 SITE_NOT_FOUND for a site that does not exist', async () => {
    siteExistsMock.mockResolvedValueOnce(false);
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE}/energy-assets`,
      headers: auth,
      payload: { type: 'solar', name: 'Canopy', peakKwp: 100 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
    expect(writer.createEnergyAsset).not.toHaveBeenCalled();
  });

  it('POST creates through the writer with the simulated gate of the process', async () => {
    configMock.ENERGY_ASSETS_ALLOW_SIMULATED = true;
    writer.createEnergyAsset.mockResolvedValue(solarRow);
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE}/energy-assets`,
      headers: auth,
      payload: { type: 'solar', name: 'Canopy', peakKwp: 100, inverterKw: 90 },
    });
    expect(res.statusCode).toBe(201);
    expect(writer.createEnergyAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: SITE,
        type: 'solar',
        peakKwp: 100,
        inverterKw: '90',
        telemetry: 'none',
        reservePercent: 10,
        readingTtlSeconds: 60,
      }),
      caller,
      { allowSimulated: true },
    );
    expect(writer.createEnergyAsset.mock.calls[0]?.[0]).not.toHaveProperty('gridCharging');
  });

  it('POST answers a writer refusal with 400 and the field', async () => {
    writer.createEnergyAsset.mockRejectedValue(
      new writer.LoadTreeValidationError(
        'Simulated readings are not allowed on this installation',
        'telemetry',
      ),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE}/energy-assets`,
      headers: auth,
      payload: { type: 'battery', name: 'B', telemetry: 'simulated' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(
      expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'telemetry' }),
    );
  });

  it('POST answers the unrated grid-charging battery refusal with the maxChargeKw field', async () => {
    writer.createEnergyAsset.mockRejectedValue(
      new writer.LoadTreeValidationError(
        'A connected battery that may charge from the grid needs a maximum charge power or an inverter rating',
        'maxChargeKw',
      ),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE}/energy-assets`,
      headers: auth,
      payload: { type: 'battery', name: 'B', connectionPanelId: 'pnl_a' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(
      expect.objectContaining({ code: 'VALIDATION_ERROR', field: 'maxChargeKw' }),
    );
  });

  it('POST refuses a TTL outside 15 to 600 seconds and a reserve above 100', async () => {
    for (const payload of [
      { type: 'battery', name: 'B', readingTtlSeconds: 5 },
      { type: 'battery', name: 'B', readingTtlSeconds: 601 },
      { type: 'battery', name: 'B', reservePercent: 101 },
      { type: 'battery', name: 'B', maxChargeKw: 0 },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE}/energy-assets`,
        headers: auth,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(writer.createEnergyAsset).not.toHaveBeenCalled();
  });

  it('PATCH updates through the writer with the row it read', async () => {
    setupDbResults([batteryRow]);
    writer.updateEnergyAsset.mockResolvedValue({ ...batteryRow, connectionPanelId: null });
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE}/energy-assets/ena_bat`,
      headers: auth,
      payload: { connectionPanelId: null, inverterKw: null },
    });
    expect(res.statusCode).toBe(200);
    expect(writer.updateEnergyAsset).toHaveBeenCalledWith(
      {
        siteId: SITE,
        assetId: 'ena_bat',
        existing: batteryRow,
        set: { connectionPanelId: null, inverterKw: null },
      },
      caller,
      { allowSimulated: false },
    );
  });

  it('PATCH and DELETE answer 404 ENERGY_ASSET_NOT_FOUND outside the scope or for an unknown id', async () => {
    siteIdsMock.mockResolvedValue(['sit_other']);
    const outside = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE}/energy-assets/ena_bat`,
      headers: auth,
    });
    expect(outside.statusCode).toBe(404);
    expect(outside.json().code).toBe('ENERGY_ASSET_NOT_FOUND');
    siteIdsMock.mockResolvedValue(null);
    setupDbResults([]);
    const missing = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE}/energy-assets/ena_x`,
      headers: auth,
      payload: { name: 'X' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('ENERGY_ASSET_NOT_FOUND');
  });

  it('DELETE deletes through the writer', async () => {
    setupDbResults([batteryRow]);
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE}/energy-assets/ena_bat`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(writer.deleteEnergyAsset).toHaveBeenCalledWith(
      { siteId: SITE, asset: batteryRow },
      caller,
    );
  });
});
