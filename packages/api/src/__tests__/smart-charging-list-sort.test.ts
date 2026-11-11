// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The server-side sorts of the smart charging lists: the templates, a template's
// pushes, its matching stations and a push's station results.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({ results: [] as unknown[][], index: 0 }));

function queue(...results: unknown[][]): void {
  state.results = results;
  state.index = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const method of [
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
  ]) {
    chain[method] = vi.fn(() => chain);
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    const result = state.results[state.index] ?? [];
    state.index++;
    return Promise.resolve(result).then(resolve, reject);
  };
  return chain;
}

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: { select: vi.fn(() => makeChain()) },
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('../lib/fleet-operation-scope.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findScopedChargingProfileTemplate: vi.fn(async () => ({
    id: 'cpt_1',
    name: 'Peak',
    ocppVersion: '2.1',
    profilePurpose: 'TxDefaultProfile',
    targetFilter: null,
  })),
}));

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

import { registerAuth } from '../plugins/auth.js';
import { smartChargingRoutes } from '../routes/smart-charging.js';

const NOW = new Date().toISOString();

const LISTS: Array<{ url: string; keys: string[]; results: () => unknown[][] }> = [
  {
    url: '/v1/smart-charging/templates',
    keys: [
      'name',
      'description',
      'profilePurpose',
      'profileKind',
      'chargingRateUnit',
      'ocppVersion',
      'createdAt',
    ],
    results: () => [[], [{ total: 0 }]],
  },
  {
    url: '/v1/smart-charging/templates/cpt_1/pushes',
    keys: ['createdAt', 'operation', 'status'],
    results: () => [[], [{ total: 0 }]],
  },
  {
    url: '/v1/smart-charging/templates/cpt_1/matching-stations',
    keys: ['station', 'site', 'vendor', 'model', 'firmwareVersion', 'status'],
    results: () => [[], [{ total: 0 }]],
  },
  {
    url: '/v1/smart-charging/pushes/cpp_1',
    keys: ['station', 'status', 'updatedAt'],
    results: () => [
      [
        {
          id: 'cpp_1',
          templateId: 'cpt_1',
          operation: 'set',
          status: 'active',
          stationCount: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    ],
  },
];

describe('smart charging list sorting', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(smartChargingRoutes, { prefix: '/v1' });
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('accepts every sort key in both directions', async () => {
    for (const list of LISTS) {
      for (const sort of list.keys) {
        for (const order of ['asc', 'desc']) {
          queue(...list.results());
          const res = await get(`${list.url}?sort=${sort}&order=${order}`);
          expect(res.statusCode, `${list.url} ${sort} ${order} ${res.body}`).toBe(200);
        }
      }
    }
  });

  it('refuses a sort key it does not offer and an unknown order', async () => {
    for (const list of LISTS) {
      for (const query of [
        'sort=id',
        'sort=charging_stations.id',
        `sort=${String(list.keys[0])}&order=up`,
      ]) {
        const res = await get(`${list.url}?${query}`);
        expect(res.statusCode, `${list.url} ${query}`).toBe(400);
      }
    }
  });
});
