// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Smart charging template routes: filter options, list counts, create, update,
// duplicate, delete, push and clear (one operation at a time per template),
// push history and push detail, for all-site and site-restricted users.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

interface Call {
  op: string;
  method: string;
  args: unknown[];
}

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  index: 0,
  calls: [] as Array<{ op: string; method: string; args: unknown[] }>,
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
      'innerJoin',
      'leftJoin',
      'groupBy',
      'for',
      'values',
      'set',
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
      if (result instanceof Error) return Promise.reject(result).then(resolve, reject);
      return Promise.resolve(result).then(resolve, reject);
    };
    return chain;
  }
  const db: Record<string, unknown> = {
    select: vi.fn(() => makeChain('select')),
    selectDistinct: vi.fn(() => makeChain('selectDistinct')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
    delete: vi.fn(() => makeChain('delete')),
  };
  db['transaction'] = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return { ...actual, db, writeAudit: vi.fn().mockResolvedValue(undefined) };
});

const siteIds = vi.hoisted(() => ({ value: null as string[] | null }));
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn(async () => siteIds.value),
  invalidateSiteAccessCache: vi.fn(),
}));

const scoped = vi.hoisted(() => ({ template: null as Record<string, unknown> | null }));
vi.mock('../lib/fleet-operation-scope.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findScopedChargingProfileTemplate: vi.fn(async () => scoped.template),
}));

vi.mock('../lib/charging-profile-push.js', () => ({
  processChargingProfilePush: vi.fn().mockResolvedValue(undefined),
  processChargingProfileClear: vi.fn().mockResolvedValue(undefined),
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

import { writeAudit } from '@evtivity/database';
import {
  processChargingProfilePush,
  processChargingProfileClear,
} from '../lib/charging-profile-push.js';
import { registerAuth } from '../plugins/auth.js';
import { smartChargingRoutes } from '../routes/smart-charging.js';

const NOW = '2026-11-01T00:00:00.000Z';

function template(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cpt_1',
    name: 'Peak',
    description: null,
    ocppVersion: '2.1',
    profileId: 100,
    profilePurpose: 'TxDefaultProfile',
    profileKind: 'Absolute',
    recurrencyKind: null,
    stackLevel: 0,
    evseId: 0,
    chargingRateUnit: 'W',
    schedulePeriods: [{ startPeriod: 0, limit: 11000 }],
    startSchedule: NOW,
    duration: null,
    validFrom: null,
    validTo: null,
    targetFilter: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const createBody = {
  name: 'Peak',
  profilePurpose: 'TxDefaultProfile',
  profileKind: 'Absolute',
  schedulePeriods: [{ startPeriod: 0, limit: 11000 }],
  startSchedule: NOW,
};

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint_name: 'charging_profile_templates_profile_id_unique',
    constraint: 'charging_profile_templates_profile_id_unique',
  });
}

function callsOf(op: string, method: string): Call[] {
  return state.calls.filter((c) => c.op === op && c.method === method);
}

describe('smart charging routes', () => {
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

  beforeEach(() => {
    siteIds.value = null;
    scoped.template = template();
    state.calls = [];
    queue();
  });

  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  describe('GET /smart-charging/filter-options', () => {
    it('returns sites, vendors and models for an all-site user', async () => {
      queue([{ id: 'sit_1', name: 'A' }], [{ id: 'ven_1', name: 'V' }], [{ model: 'M1' }]);
      const res = await send('GET', '/v1/smart-charging/filter-options');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        sites: [{ id: 'sit_1', name: 'A' }],
        vendors: [{ id: 'ven_1', name: 'V' }],
        models: ['M1'],
      });
    });

    it('limits the site query for a restricted user', async () => {
      siteIds.value = ['sit_1'];
      queue([{ id: 'sit_1', name: 'A' }], [], []);
      const res = await send('GET', '/v1/smart-charging/filter-options');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sites: [{ id: 'sit_1', name: 'A' }], vendors: [], models: [] });
      // The site query gets a where clause only for a restricted user.
      expect(callsOf('select', 'where').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /smart-charging/templates', () => {
    it('counts matching stations per template', async () => {
      queue(
        [template({ targetFilter: { siteId: 'sit_1', vendorId: 'ven_1', model: 'M' } })],
        [{ total: 1 }],
        [{ total: 7 }],
      );
      const res = await send('GET', '/v1/smart-charging/templates');
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ matchingStationsCount: number }>; total: number }>();
      expect(body.total).toBe(1);
      expect(body.data[0]?.matchingStationsCount).toBe(7);
    });

    it('answers zero matching stations for a user without sites', async () => {
      siteIds.value = [];
      queue([template({ targetFilter: { siteId: 'sit_1' } })], [{ total: 1 }]);
      const res = await send('GET', '/v1/smart-charging/templates');
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: Array<{ matchingStationsCount: number }> }>().data[0]).toMatchObject({
        matchingStationsCount: 0,
      });
    });

    it('scopes the station count to the user sites and defaults missing totals to 0', async () => {
      siteIds.value = ['sit_1'];
      queue([template({ targetFilter: { siteId: 'sit_1' } })], [], []);
      const res = await send('GET', '/v1/smart-charging/templates');
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ matchingStationsCount: number }>; total: number }>();
      expect(body.total).toBe(0);
      expect(body.data[0]?.matchingStationsCount).toBe(0);
    });
  });

  describe('GET /smart-charging/templates/:id', () => {
    it('returns the scoped template', async () => {
      const res = await send('GET', '/v1/smart-charging/templates/cpt_1');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: 'cpt_1', name: 'Peak' });
    });

    it('answers 404 when the template is out of scope', async () => {
      scoped.template = null;
      const res = await send('GET', '/v1/smart-charging/templates/cpt_x');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    });
  });

  describe('POST /smart-charging/templates', () => {
    it('creates a template with its defaults and audits it', async () => {
      queue([], [template()]);
      const res = await send('POST', '/v1/smart-charging/templates', {
        ...createBody,
        validFrom: '2026-11-01T00:00:00Z',
        validTo: '2026-12-01T00:00:00Z',
        description: 'd',
      });
      expect(res.statusCode).toBe(201);
      const values = callsOf('insert', 'values')[0]?.args[0] as Record<string, unknown>;
      expect(values).toMatchObject({
        name: 'Peak',
        description: 'd',
        ocppVersion: '2.1',
        profileId: 100,
        stackLevel: 0,
        evseId: 0,
        chargingRateUnit: 'W',
        recurrencyKind: null,
        duration: null,
        targetFilter: null,
      });
      expect(values['validFrom']).toBeInstanceOf(Date);
      expect(values['startSchedule']).toBeInstanceOf(Date);
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({ action: 'created' });
    });

    it('answers 201 without an audit row when the insert returns nothing', async () => {
      queue([], []);
      const res = await send('POST', '/v1/smart-charging/templates', createBody);
      expect(res.statusCode).toBe(201);
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('refuses a company-wide template for a restricted user', async () => {
      siteIds.value = ['sit_1'];
      const res = await send('POST', '/v1/smart-charging/templates', createBody);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    });

    it('refuses a target site outside the user scope', async () => {
      siteIds.value = ['sit_1'];
      const res = await send('POST', '/v1/smart-charging/templates', {
        ...createBody,
        targetFilter: { siteId: 'sit_2' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
    });

    it('refuses a template whose rules fail (1.6 purpose)', async () => {
      const res = await send('POST', '/v1/smart-charging/templates', {
        ...createBody,
        ocppVersion: '1.6',
        profilePurpose: 'PriorityCharging',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(res.json<{ error: string }>().error).toContain('not available in OCPP 1.6');
    });

    it('answers 409 when the profile id is already used', async () => {
      queue([{ id: 'cpt_other' }]);
      const res = await send('POST', '/v1/smart-charging/templates', {
        ...createBody,
        profileId: 7,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'profileId 7 is already used by another template',
        code: 'PROFILE_ID_IN_USE',
      });
    });

    it('answers 409 when the insert loses the profile id race', async () => {
      queue([], uniqueViolation());
      const res = await send('POST', '/v1/smart-charging/templates', createBody);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'PROFILE_ID_IN_USE' });
    });

    it('answers 500 for another insert error', async () => {
      queue([], new Error('boom'));
      const res = await send('POST', '/v1/smart-charging/templates', createBody);
      expect(res.statusCode).toBe(500);
    });

    it('refuses an inverted validity window and a Recurring profile without a start', async () => {
      const inverted = await send('POST', '/v1/smart-charging/templates', {
        ...createBody,
        validFrom: '2026-12-01T00:00:00Z',
        validTo: '2026-11-01T00:00:00Z',
      });
      expect(inverted.statusCode).toBe(400);
      const recurring = await send('POST', '/v1/smart-charging/templates', {
        ...createBody,
        profileKind: 'Recurring',
        recurrencyKind: 'Daily',
        startSchedule: undefined,
      });
      expect(recurring.statusCode).toBe(400);
      const unordered = await send('POST', '/v1/smart-charging/templates', {
        ...createBody,
        schedulePeriods: [
          { startPeriod: 0, limit: 1 },
          { startPeriod: 0, limit: 2 },
        ],
      });
      expect(unordered.statusCode).toBe(400);
    });
  });

  describe('PATCH /smart-charging/templates/:id', () => {
    it('updates every sent field and audits before and after', async () => {
      queue([], [template({ name: 'New' })]);
      const res = await send('PATCH', '/v1/smart-charging/templates/cpt_1', {
        name: 'New',
        description: null,
        ocppVersion: '2.1',
        profileId: 200,
        profilePurpose: 'ChargingStationMaxProfile',
        profileKind: 'Recurring',
        recurrencyKind: 'Daily',
        stackLevel: 2,
        evseId: 1,
        chargingRateUnit: 'A',
        schedulePeriods: [{ startPeriod: 0, limit: 16 }],
        startSchedule: '2026-11-02T00:00:00Z',
        duration: 3600,
        validFrom: '2026-11-01T00:00:00Z',
        validTo: null,
        targetFilter: { model: 'M' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'New' });
      const set = callsOf('update', 'set')[0]?.args[0] as Record<string, unknown>;
      expect(set).toMatchObject({
        name: 'New',
        description: null,
        profileId: 200,
        profileKind: 'Recurring',
        recurrencyKind: 'Daily',
        stackLevel: 2,
        evseId: 1,
        chargingRateUnit: 'A',
        duration: 3600,
        validTo: null,
        targetFilter: { model: 'M' },
      });
      expect(set['startSchedule']).toBeInstanceOf(Date);
      expect(set['validFrom']).toBeInstanceOf(Date);
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({ action: 'updated' });
    });

    it('clears dates sent as null', async () => {
      scoped.template = template({ validFrom: NOW, validTo: '2026-12-01T00:00:00.000Z' });
      queue([template()]);
      const res = await send('PATCH', '/v1/smart-charging/templates/cpt_1', {
        validFrom: null,
        validTo: null,
      });
      expect(res.statusCode).toBe(200);
      const set = callsOf('update', 'set')[0]?.args[0] as Record<string, unknown>;
      expect(set['validFrom']).toBeNull();
      expect(set['validTo']).toBeNull();
    });

    it('answers 404 for a missing template and a restricted company-wide edit', async () => {
      scoped.template = null;
      expect((await send('PATCH', '/v1/smart-charging/templates/cpt_1', {})).statusCode).toBe(404);
      scoped.template = template({ targetFilter: { siteId: 'sit_1' } });
      siteIds.value = ['sit_1'];
      const widened = await send('PATCH', '/v1/smart-charging/templates/cpt_1', {
        targetFilter: null,
      });
      expect(widened.statusCode).toBe(404);
      expect(widened.json()).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    });

    it('answers 404 SITE_NOT_FOUND for a new site outside the scope', async () => {
      scoped.template = template({ targetFilter: { siteId: 'sit_1' } });
      siteIds.value = ['sit_1'];
      const res = await send('PATCH', '/v1/smart-charging/templates/cpt_1', {
        targetFilter: { siteId: 'sit_2' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'SITE_NOT_FOUND' });
    });

    it('validates the merged template', async () => {
      const res = await send('PATCH', '/v1/smart-charging/templates/cpt_1', {
        profileKind: 'Recurring',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toBe(
        'recurrencyKind is required when profileKind is Recurring',
      );
    });

    it('answers 409 when another template holds the profile id', async () => {
      queue([{ id: 'cpt_2' }]);
      const res = await send('PATCH', '/v1/smart-charging/templates/cpt_1', { profileId: 5 });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'PROFILE_ID_IN_USE' });
    });

    it('skips the collision query for the same profile id', async () => {
      queue([template()]);
      const res = await send('PATCH', '/v1/smart-charging/templates/cpt_1', { profileId: 100 });
      expect(res.statusCode).toBe(200);
      expect(callsOf('select', 'from')).toHaveLength(0);
    });

    it('answers 409 when the update loses the race and 500 for another error', async () => {
      queue([], uniqueViolation());
      const raced = await send('PATCH', '/v1/smart-charging/templates/cpt_1', { profileId: 5 });
      expect(raced.statusCode).toBe(409);
      queue(new Error('boom'));
      const failed = await send('PATCH', '/v1/smart-charging/templates/cpt_1', { name: 'X' });
      expect(failed.statusCode).toBe(500);
    });

    it('writes no audit row when the update returns nothing', async () => {
      queue([]);
      const res = await send('PATCH', '/v1/smart-charging/templates/cpt_1', { name: 'X' });
      expect(res.statusCode).toBe(200);
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('refuses an inverted validity window', async () => {
      const res = await send('PATCH', '/v1/smart-charging/templates/cpt_1', {
        validFrom: '2026-12-01T00:00:00Z',
        validTo: '2026-11-01T00:00:00Z',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /smart-charging/templates/:id/duplicate', () => {
    it('copies the template with the next free profile id', async () => {
      queue([{ maxId: 41 }], [template({ id: 'cpt_2', name: 'Peak (Copy)', profileId: 42 })]);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/duplicate');
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ id: 'cpt_2', profileId: 42 });
      const values = callsOf('insert', 'values')[0]?.args[0] as Record<string, unknown>;
      expect(values).toMatchObject({ name: 'Peak (Copy)', profileId: 42 });
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'created',
        notes: 'Duplicated from cpt_1',
      });
    });

    it('retries after a lost race with the next id', async () => {
      queue([{ maxId: null }], uniqueViolation(), [{ maxId: null }], [template({ id: 'cpt_3' })]);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/duplicate');
      expect(res.statusCode).toBe(201);
      const values = callsOf('insert', 'values').map(
        (c) => (c.args[0] as { profileId: number }).profileId,
      );
      expect(values).toEqual([1, 2]);
    });

    it('answers 409 after ten lost races', async () => {
      const results: unknown[] = [];
      for (let i = 0; i < 10; i++) results.push([{ maxId: 1 }], uniqueViolation());
      queue(...results);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/duplicate');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'PROFILE_ID_ALLOC_FAILED' });
    });

    it('answers 500 for another insert error', async () => {
      queue([{ maxId: 1 }], new Error('boom'));
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/duplicate');
      expect(res.statusCode).toBe(500);
    });

    it('answers 404 for a restricted user and a company-wide template', async () => {
      siteIds.value = ['sit_1'];
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/duplicate');
      expect(res.statusCode).toBe(404);
      scoped.template = null;
      siteIds.value = null;
      expect((await send('POST', '/v1/smart-charging/templates/cpt_1/duplicate')).statusCode).toBe(
        404,
      );
    });
  });

  describe('DELETE /smart-charging/templates/:id', () => {
    it('deletes and audits the template', async () => {
      queue([]);
      const res = await send('DELETE', '/v1/smart-charging/templates/cpt_1');
      expect(res.statusCode).toBe(204);
      expect(callsOf('delete', 'where')).toHaveLength(1);
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'deleted',
        entityId: null,
        entityIdSnapshot: 'cpt_1',
      });
    });

    it('answers 404 for a missing template and a restricted company-wide one', async () => {
      scoped.template = null;
      expect((await send('DELETE', '/v1/smart-charging/templates/cpt_1')).statusCode).toBe(404);
      scoped.template = template();
      siteIds.value = ['sit_1'];
      expect((await send('DELETE', '/v1/smart-charging/templates/cpt_1')).statusCode).toBe(404);
      expect(callsOf('delete', 'where')).toHaveLength(0);
    });
  });

  describe('GET /smart-charging/templates/:id/matching-stations', () => {
    const station = {
      id: 'sta_1',
      stationId: 'CS-1',
      model: 'M',
      isOnline: true,
      siteName: 'A',
      vendorName: 'V',
    };

    it('lists the online matching stations', async () => {
      scoped.template = template({ targetFilter: { siteId: 'sit_1', vendorId: 'v', model: 'M' } });
      queue([station], [{ total: 1 }]);
      const res = await send('GET', '/v1/smart-charging/templates/cpt_1/matching-stations');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [station], total: 1 });
    });

    it('answers an empty page for a user without sites and 404 out of scope', async () => {
      siteIds.value = [];
      const empty = await send('GET', '/v1/smart-charging/templates/cpt_1/matching-stations');
      expect(empty.json()).toEqual({ data: [], total: 0 });
      siteIds.value = ['sit_1'];
      queue([], []);
      const scopedRes = await send('GET', '/v1/smart-charging/templates/cpt_1/matching-stations');
      expect(scopedRes.json()).toEqual({ data: [], total: 0 });
      scoped.template = null;
      const missing = await send('GET', '/v1/smart-charging/templates/cpt_1/matching-stations');
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('POST /smart-charging/templates/:id/push', () => {
    const targets = [
      { id: 'sta_1', stationId: 'CS-1' },
      { id: 'sta_2', stationId: 'CS-2' },
    ];

    it('starts a push to the target stations and audits it', async () => {
      scoped.template = template({ targetFilter: { siteId: 'sit_1', vendorId: 'v', model: 'M' } });
      // targets, lock, running ops, push insert, station insert
      queue(targets, [], [], [{ id: 'cpp_1' }], []);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/push');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, pushId: 'cpp_1', alreadyRunning: false });
      expect(processChargingProfilePush).toHaveBeenCalledWith(
        'cpp_1',
        targets,
        expect.objectContaining({ id: 'cpt_1' }),
        '2.1',
      );
      const inserts = callsOf('insert', 'values');
      expect(inserts[0]?.args[0]).toEqual({
        templateId: 'cpt_1',
        operation: 'set',
        status: 'active',
        stationCount: 2,
      });
      expect(inserts[1]?.args[0]).toEqual([
        { pushId: 'cpp_1', stationId: 'sta_1', status: 'pending' },
        { pushId: 'cpp_1', stationId: 'sta_2', status: 'pending' },
      ]);
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        action: 'pushed',
        notes: 'Pushed to 2 station(s)',
      });
    });

    it('returns the running push instead of starting a second one', async () => {
      queue(targets, [], [{ id: 'cpp_run', updatedAt: new Date(), lastStationUpdate: null }]);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/push');
      expect(res.json()).toEqual({ success: true, pushId: 'cpp_run', alreadyRunning: true });
      expect(processChargingProfilePush).not.toHaveBeenCalled();
      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('closes a stale operation before starting a new one', async () => {
      const old = new Date(Date.now() - 60 * 60_000);
      queue(
        targets,
        [],
        [{ id: 'cpp_old', updatedAt: old, lastStationUpdate: old }],
        [],
        [],
        [{ id: 'cpp_new' }],
        [],
      );
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/push');
      expect(res.json()).toMatchObject({ pushId: 'cpp_new', alreadyRunning: false });
      const sets = callsOf('update', 'set').map((c) => c.args[0] as Record<string, unknown>);
      expect(sets[0]).toMatchObject({ status: 'failed', errorInfo: 'Interrupted' });
      expect(sets[1]).toMatchObject({ status: 'completed' });
    });

    it('answers 500 when the push insert returns no row', async () => {
      queue(targets, [], [], []);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/push');
      expect(res.statusCode).toBe(500);
    });

    it('logs a background push failure without failing the request', async () => {
      vi.mocked(processChargingProfilePush).mockRejectedValueOnce(new Error('bg'));
      queue(targets, [], [], [{ id: 'cpp_1' }], []);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/push');
      expect(res.statusCode).toBe(200);
    });

    it('answers an empty push id when no station matches', async () => {
      queue([]);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/push');
      expect(res.json()).toEqual({ success: true, pushId: '' });
    });

    it('answers an empty push id for a user without sites', async () => {
      siteIds.value = [];
      scoped.template = template({ targetFilter: { siteId: 'sit_1' } });
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/push');
      expect(res.json()).toEqual({ success: true, pushId: '' });
      expect(callsOf('select', 'from')).toHaveLength(0);
    });

    it('scopes the targets for a restricted user', async () => {
      siteIds.value = ['sit_1'];
      scoped.template = template({ targetFilter: { siteId: 'sit_1' } });
      queue([]);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/push');
      expect(res.json()).toEqual({ success: true, pushId: '' });
    });

    it('refuses an invalid stored template and an out of scope one', async () => {
      scoped.template = template({ startSchedule: null });
      const invalid = await send('POST', '/v1/smart-charging/templates/cpt_1/push');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      scoped.template = null;
      expect((await send('POST', '/v1/smart-charging/templates/cpt_1/push')).statusCode).toBe(404);
    });
  });

  describe('POST /smart-charging/templates/:id/clear', () => {
    const targets = [{ id: 'sta_1', stationId: 'CS-1' }];

    it('starts a clear and audits it as pushed', async () => {
      queue(targets, [], [], [{ id: 'cpp_c' }], []);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/clear');
      expect(res.json()).toEqual({ success: true, pushId: 'cpp_c', alreadyRunning: false });
      expect(processChargingProfileClear).toHaveBeenCalledWith(
        'cpp_c',
        targets,
        { profilePurpose: 'TxDefaultProfile', stackLevel: 0, evseId: 0 },
        '2.1',
      );
      expect(callsOf('insert', 'values')[0]?.args[0]).toMatchObject({ operation: 'clear' });
      expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
        notes: 'Cleared from 1 station(s)',
      });
    });

    it('returns a running operation, an empty id and 404', async () => {
      vi.mocked(processChargingProfileClear).mockRejectedValueOnce(new Error('bg'));
      queue(targets, [], [{ id: 'cpp_run', updatedAt: new Date(), lastStationUpdate: new Date() }]);
      const running = await send('POST', '/v1/smart-charging/templates/cpt_1/clear');
      expect(running.json()).toEqual({ success: true, pushId: 'cpp_run', alreadyRunning: true });
      queue([]);
      const none = await send('POST', '/v1/smart-charging/templates/cpt_1/clear');
      expect(none.json()).toEqual({ success: true, pushId: '' });
      siteIds.value = ['sit_1'];
      const companyWide = await send('POST', '/v1/smart-charging/templates/cpt_1/clear');
      expect(companyWide.statusCode).toBe(404);
    });

    it('logs a background clear failure', async () => {
      vi.mocked(processChargingProfileClear).mockRejectedValueOnce(new Error('bg'));
      queue(targets, [], [], [{ id: 'cpp_c' }], []);
      const res = await send('POST', '/v1/smart-charging/templates/cpt_1/clear');
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /smart-charging/templates/:id/pushes', () => {
    const push = {
      id: 'cpp_1',
      templateId: 'cpt_1',
      operation: 'set',
      status: 'completed',
      stationCount: 5,
      createdAt: NOW,
      updatedAt: NOW,
    };

    it('adds the status counts of each push', async () => {
      queue(
        [push, { ...push, id: 'cpp_2' }],
        [{ total: 2 }],
        [
          { pushId: 'cpp_1', status: 'accepted', count: 3 },
          { pushId: 'cpp_1', status: 'failed', count: 2 },
        ],
      );
      const res = await send('GET', '/v1/smart-charging/templates/cpt_1/pushes');
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<Record<string, number | string>>; total: number }>();
      expect(body.total).toBe(2);
      expect(body.data[0]).toMatchObject({
        stationCount: 5,
        acceptedCount: 3,
        failedCount: 2,
        pendingCount: 0,
      });
      expect(body.data[1]).toMatchObject({ stationCount: 5, acceptedCount: 0 });
    });

    it('counts only the visible stations for a restricted user', async () => {
      siteIds.value = ['sit_1'];
      queue([push], [], [{ pushId: 'cpp_1', status: 'accepted', count: 1 }]);
      const res = await send('GET', '/v1/smart-charging/templates/cpt_1/pushes');
      const body = res.json<{ data: Array<Record<string, number | string>>; total: number }>();
      expect(body.total).toBe(0);
      expect(body.data[0]).toMatchObject({ stationCount: 1, acceptedCount: 1 });
    });

    it('skips the count query for an empty page and answers 404 out of scope', async () => {
      queue([], [{ total: 0 }]);
      const empty = await send('GET', '/v1/smart-charging/templates/cpt_1/pushes');
      expect(empty.json()).toEqual({ data: [], total: 0 });
      scoped.template = null;
      expect((await send('GET', '/v1/smart-charging/templates/cpt_1/pushes')).statusCode).toBe(404);
    });
  });

  describe('GET /smart-charging/pushes/:pushId', () => {
    const push = {
      id: 'cpp_1',
      templateId: 'cpt_1',
      operation: 'set',
      status: 'active',
      stationCount: 4,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const row = {
      id: 1,
      stationId: 'sta_1',
      stationName: 'CS-1',
      status: 'accepted',
      errorInfo: null,
      updatedAt: NOW,
    };

    it('returns the push with counts and station rows', async () => {
      queue([push], [{ status: 'accepted', count: 3 }], [row]);
      const res = await send('GET', '/v1/smart-charging/pushes/cpp_1');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: 'cpp_1',
        acceptedCount: 3,
        rejectedCount: 0,
        stationCount: 4,
        stationsTotal: 4,
        stations: [row],
      });
    });

    it('uses the visible total for a restricted user', async () => {
      siteIds.value = ['sit_1'];
      queue([push], [{ status: 'pending', count: 1 }], [row]);
      const res = await send('GET', '/v1/smart-charging/pushes/cpp_1');
      expect(res.json()).toMatchObject({ stationCount: 1, stationsTotal: 1, pendingCount: 1 });
    });

    it('answers 404 for an unknown push and one with no visible station', async () => {
      queue([]);
      const unknown = await send('GET', '/v1/smart-charging/pushes/cpp_x');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'PUSH_NOT_FOUND' });
      siteIds.value = ['sit_1'];
      queue([push], [], []);
      const hidden = await send('GET', '/v1/smart-charging/pushes/cpp_1');
      expect(hidden.statusCode).toBe(404);
    });
  });
});
