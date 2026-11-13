// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Conformance (OCTT) routes: trigger a run, list runs with live counts for
// runs in progress, a run with its results and the per-module summary.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  index: 0,
  calls: [] as Array<{ op: string; method: string; args: unknown[] }>,
  allSites: true,
  publish: vi.fn().mockResolvedValue(undefined),
}));

function queue(...results: unknown[]): void {
  state.results = results;
  state.index = 0;
}

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  function makeChain(op: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const method of [
      'from',
      'where',
      'orderBy',
      'limit',
      'offset',
      'groupBy',
      'values',
      'returning',
    ]) {
      chain[method] = vi.fn((...args: unknown[]) => {
        state.calls.push({ op, method, args });
        return chain;
      });
    }
    chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
      const result = state.results[state.index] ?? [];
      state.index++;
      return Promise.resolve(result).then(resolve, reject);
    };
    return chain;
  }
  return {
    ...actual,
    db: { select: vi.fn(() => makeChain('select')), insert: vi.fn(() => makeChain('insert')) },
  };
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: state.publish }),
}));

vi.mock('../lib/site-access.js', () => ({
  requireAllSiteAccess: vi.fn(
    async (
      _request: unknown,
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
      notFound: unknown,
    ) => {
      if (state.allSites) return true;
      await reply.status(404).send(notFound);
      return false;
    },
  ),
  getUserSiteIds: vi.fn().mockResolvedValue(null),
  invalidateSiteAccessCache: vi.fn(),
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
import { octtRoutes } from '../routes/octt.js';

const NOW = '2026-11-01T00:00:00.000Z';

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    status: 'completed',
    ocppVersion: 'all',
    sutType: 'csms',
    totalTests: 10,
    passed: 9,
    failed: 1,
    skipped: 0,
    errors: 0,
    notApplicable: 0,
    durationMs: 1000,
    triggeredBy: 'usr_1',
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

const counts = { total: 4, passed: 2, failed: 1, skipped: 1, errors: 0, notApplicable: 0 };

describe('OCTT routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(octtRoutes, { prefix: '/v1' });
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.allSites = true;
    state.calls = [];
    queue();
  });

  const send = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  describe('POST /octt/runs', () => {
    it('inserts the run with its defaults and publishes it', async () => {
      queue([run({ id: 7, status: 'pending' })]);
      const res = await send('POST', '/v1/octt/runs', {});
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: 7, status: 'pending' });
      const values = state.calls.find((c) => c.method === 'values')?.args[0];
      expect(values).toEqual({ ocppVersion: 'all', sutType: 'csms', triggeredBy: 'usr_1' });
      expect(state.publish).toHaveBeenCalledWith(
        'octt_run',
        JSON.stringify({ runId: 7, ocppVersion: 'all', sutType: 'csms' }),
      );
    });

    it('passes the version and system under test', async () => {
      queue([run({ id: 8, ocppVersion: 'ocpp1.6', sutType: 'cs' })]);
      const res = await send('POST', '/v1/octt/runs', { ocppVersion: 'ocpp1.6', sutType: 'cs' });
      expect(res.statusCode).toBe(201);
      expect(state.publish).toHaveBeenCalledWith(
        'octt_run',
        JSON.stringify({ runId: 8, ocppVersion: 'ocpp1.6', sutType: 'cs' }),
      );
    });

    it('answers 500 INSERT_FAILED when no row comes back', async () => {
      queue([]);
      const res = await send('POST', '/v1/octt/runs', {});
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Failed to create run', code: 'INSERT_FAILED' });
      expect(state.publish).not.toHaveBeenCalled();
    });

    it('answers 404 to a site-restricted user and refuses an unknown version', async () => {
      state.allSites = false;
      const restricted = await send('POST', '/v1/octt/runs', {});
      expect(restricted.statusCode).toBe(404);
      expect(restricted.json()).toMatchObject({ code: 'OCTT_RUN_NOT_FOUND' });
      state.allSites = true;
      const bad = await send('POST', '/v1/octt/runs', { ocppVersion: 'ocpp3' });
      expect(bad.statusCode).toBe(400);
      expect(state.calls).toHaveLength(0);
    });
  });

  describe('GET /octt/runs', () => {
    it('replaces the stored counts of runs in progress with live counts', async () => {
      queue(
        [run({ id: 1, status: 'running' }), run({ id: 2, status: 'pending' }), run({ id: 3 })],
        [{ count: 3 }],
        [{ runId: 1, ...counts }],
      );
      const res = await send('GET', '/v1/octt/runs?status=running&limit=5&offset=0');
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<Record<string, unknown>>; total: number }>();
      expect(body.total).toBe(3);
      expect(body.data[0]).toMatchObject({ totalTests: 4, passed: 2, failed: 1, skipped: 1 });
      // A pending run without results keeps its stored counts.
      expect(body.data[1]).toMatchObject({ totalTests: 10, passed: 9 });
      expect(body.data[2]).toMatchObject({ totalTests: 10 });
    });

    it('skips the live count query when no run is in progress', async () => {
      queue([run()], []);
      const res = await send('GET', '/v1/octt/runs');
      expect(res.json<{ total: number }>().total).toBe(0);
      expect(state.calls.filter((c) => c.method === 'groupBy')).toHaveLength(0);
    });
  });

  describe('GET /octt/runs/:id', () => {
    const result = {
      id: 11,
      runId: 1,
      testId: 'TC_A_01_CSMS',
      testName: 'Boot',
      module: 'A',
      ocppVersion: 'ocpp2.1',
      status: 'passed',
      durationMs: 10,
      steps: null,
      error: null,
      notApplicableItem: null,
      notApplicableReason: null,
      createdAt: NOW,
    };

    it('returns a completed run with its filtered results', async () => {
      queue([run()], [result]);
      const res = await send('GET', '/v1/octt/runs/1?module=A&status=passed');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ run: { id: 1, totalTests: 10 }, results: [result] });
      expect(state.calls.filter((c) => c.op === 'select' && c.method === 'from')).toHaveLength(2);
    });

    it('adds live counts to a running run', async () => {
      queue([run({ status: 'running' })], [], [counts]);
      const res = await send('GET', '/v1/octt/runs/1');
      expect(res.json()).toMatchObject({ run: { totalTests: 4, passed: 2, skipped: 1 } });
    });

    it('keeps the stored counts when the live count returns no row', async () => {
      queue([run({ status: 'pending' })], [], []);
      const res = await send('GET', '/v1/octt/runs/1');
      expect(res.json()).toMatchObject({ run: { totalTests: 10 } });
    });

    it('answers 404 for an unknown run', async () => {
      queue([]);
      const res = await send('GET', '/v1/octt/runs/99');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Run not found', code: 'OCTT_RUN_NOT_FOUND' });
    });
  });

  describe('GET /octt/runs/:id/summary', () => {
    it('returns the per-module summary', async () => {
      const row = { module: 'A', ocppVersion: 'ocpp2.1', ...counts };
      queue([run()], [row]);
      const res = await send('GET', '/v1/octt/runs/1/summary');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([row]);
    });

    it('answers 404 for an unknown run', async () => {
      queue([]);
      const res = await send('GET', '/v1/octt/runs/2/summary');
      expect(res.statusCode).toBe(404);
    });
  });
});
