// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
type Chain = Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
const chains: { kind: string; chain: Chain }[] = [];
function makeChain(kind: string): Chain {
  const chain = {} as Chain;
  for (const m of ['from', 'where', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const r = dbResults[dbCallIndex] ?? [];
    dbCallIndex++;
    return Promise.resolve(r).then(resolve, reject);
  };
  chains.push({ kind, chain });
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain('select')),
    selectDistinct: vi.fn(() => makeChain('selectDistinct')),
    delete: vi.fn(() => makeChain('delete')),
  },
  vehicles: {},
  vehicleEfficiencyLookup: {},
  vehicleAuditLog: {},
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray) => strings.join('?')),
}));

import { sql } from 'drizzle-orm';
import { writeAudit } from '@evtivity/database';
import { registerAuth } from '../plugins/auth.js';
import { portalVehicleRoutes } from '../routes/portal/vehicles.js';

const DRIVER_ID = 'drv_000000000001';
const VEHICLE_ID = 'veh_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(portalVehicleRoutes);
  await app.ready();
  return app;
}

function sqlTexts(): string[] {
  return vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
}

describe('Portal vehicle routes, uncovered paths', () => {
  let app: FastifyInstance;
  let auth: { authorization: string };

  beforeAll(async () => {
    app = await buildApp();
    auth = { authorization: `Bearer ${app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    chains.length = 0;
  });

  describe('DELETE /portal/vehicles/:id', () => {
    it('deletes the vehicle and audits the full row as the driver', async () => {
      const full = { id: VEHICLE_ID, driverId: DRIVER_ID, make: 'Tesla', model: 'Model 3' };
      setupDbResults([{ id: VEHICLE_ID, driverId: DRIVER_ID }], [full], []);
      const res = await app.inject({
        method: 'DELETE',
        url: `/portal/vehicles/${VEHICLE_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(204);
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({ idColumn: 'vehicle_id' }),
        {
          entityId: null,
          entityIdSnapshot: VEHICLE_ID,
          action: 'deleted',
          actor: 'driver',
          actorDriverId: DRIVER_ID,
          before: full,
        },
        expect.anything(),
        expect.anything(),
      );
    });

    it('skips the audit when the full row vanished before the delete', async () => {
      setupDbResults([{ id: VEHICLE_ID, driverId: DRIVER_ID }], [], []);
      const res = await app.inject({
        method: 'DELETE',
        url: `/portal/vehicles/${VEHICLE_ID}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(204);
      expect(chains.some((c) => c.kind === 'delete')).toBe(true);
      expect(writeAudit).not.toHaveBeenCalled();
    });
  });

  describe('GET /portal/vehicles/efficiency', () => {
    it('returns the default when the driver has no vehicle', async () => {
      setupDbResults([]);
      const res = await app.inject({
        method: 'GET',
        url: '/portal/vehicles/efficiency',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ efficiencyMiPerKwh: 3.5 });
    });

    it('returns the default when the vehicle has no model', async () => {
      setupDbResults([{ make: 'Tesla', model: null, year: null }]);
      const res = await app.inject({
        method: 'GET',
        url: '/portal/vehicles/efficiency',
        headers: auth,
      });
      expect(res.json()).toEqual({ efficiencyMiPerKwh: 3.5 });
      expect(chains).toHaveLength(1);
    });

    it('matches the year-specific lookup row for a vehicle with a year', async () => {
      setupDbResults(
        [{ make: 'Tesla', model: 'Model 3', year: '2024' }],
        [{ efficiencyMiPerKwh: '4.10' }],
      );
      const res = await app.inject({
        method: 'GET',
        url: '/portal/vehicles/efficiency',
        headers: auth,
      });
      expect(res.json()).toEqual({ efficiencyMiPerKwh: 4.1 });
      expect(sqlTexts().some((t) => t.includes('OR') && t.includes('IS NULL'))).toBe(true);
    });

    it('uses only the year-null row when the vehicle has no year', async () => {
      setupDbResults([{ make: 'BMW', model: 'i4', year: null }], [{ efficiencyMiPerKwh: '3.2' }]);
      const res = await app.inject({
        method: 'GET',
        url: '/portal/vehicles/efficiency',
        headers: auth,
      });
      expect(res.json()).toEqual({ efficiencyMiPerKwh: 3.2 });
      expect(sqlTexts().some((t) => t.trim() === '? IS NULL')).toBe(true);
    });

    it('returns the default when no lookup row matches', async () => {
      setupDbResults([{ make: 'Rare', model: 'Car', year: '1999' }], []);
      const res = await app.inject({
        method: 'GET',
        url: '/portal/vehicles/efficiency',
        headers: auth,
      });
      expect(res.json()).toEqual({ efficiencyMiPerKwh: 3.5 });
    });
  });

  describe('GET /portal/vehicles/lookup', () => {
    it('filters models by make', async () => {
      setupDbResults([{ make: 'BMW' }, { make: 'Tesla' }], [{ make: 'Tesla', model: 'Model S' }]);
      const res = await app.inject({
        method: 'GET',
        url: '/portal/vehicles/lookup?make=Tesla',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        makes: ['BMW', 'Tesla'],
        models: [{ make: 'Tesla', model: 'Model S' }],
      });
      expect(chains[1]?.chain['where']).toHaveBeenCalled();
    });

    it('returns every model without a make filter', async () => {
      setupDbResults([{ make: 'Tesla' }], [{ make: 'Tesla', model: 'Model S' }]);
      const res = await app.inject({
        method: 'GET',
        url: '/portal/vehicles/lookup',
        headers: auth,
      });
      expect(res.json().models).toEqual([{ make: 'Tesla', model: 'Model S' }]);
      expect(chains[1]?.chain['where']).not.toHaveBeenCalled();
    });
  });
});
