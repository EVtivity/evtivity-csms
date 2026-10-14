// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { mockGetCompanyPriceDisplay, mockWriteAudit } = vi.hoisted(() => ({
  mockGetCompanyPriceDisplay: vi.fn(),
  mockWriteAudit: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

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
  },
  stationMessageTemplates: {
    state: 'state',
    language: 'language',
    body: 'body',
    updatedAt: 'updatedAt',
    updatedBy: 'updatedBy',
  },
  stationMessageTemplateAuditLog: { _name: 'stationMessageTemplateAuditLog' },
  writeAudit: mockWriteAudit,
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  getCompanyPriceDisplay: mockGetCompanyPriceDisplay,
  getCompanyTaxBasis: vi.fn().mockResolvedValue('net'),
  getStationMessagePricingFormat: vi.fn(() => Promise.resolve('compact')),
  getStationMessageBrandLine: vi.fn(() => Promise.resolve('')),
}));

vi.mock('@evtivity/services/station-message.service', () => ({
  requestStationMessageRepush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  return {
    ...actual,
    clearStationMessageCache: vi.fn(),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { requestStationMessageRepush } from '@evtivity/services/station-message.service';
import { stationMessageTemplateRoutes } from '../routes/station-message-templates.js';
import {
  STATION_MESSAGE_DEFAULTS,
  clearStationMessageCache as clearStationMessageCacheImport,
} from '@evtivity/lib';
import * as databaseModule from '@evtivity/database';

const clearStationMessageCache = clearStationMessageCacheImport as unknown as ReturnType<
  typeof vi.fn
>;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  stationMessageTemplateRoutes(app);
  await app.ready();
  return app;
}

describe('Station message template routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'usr_test', roleId: 'rol_test' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    clearStationMessageCache.mockClear();
    vi.mocked(requestStationMessageRepush).mockClear();
    mockGetCompanyPriceDisplay.mockResolvedValue('gross');
    mockWriteAudit.mockClear();
  });

  describe('GET /v1/station-message-templates', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/station-message-templates' });
      expect(res.statusCode).toBe(401);
    });

    it('returns the list of templates', async () => {
      const rows = [
        {
          state: 'available',
          language: 'en',
          body: 'Available body',
          updatedAt: '2026-01-01T00:00:00Z',
          updatedBy: 'usr_test',
        },
        {
          state: 'occupied',
          language: 'de',
          body: 'Occupied body',
          updatedAt: '2026-01-02T00:00:00Z',
          updatedBy: null,
        },
      ];
      setupDbResults(rows);
      const res = await app.inject({
        method: 'GET',
        url: '/station-message-templates',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].state).toBe('available');
      expect(body.data[1].language).toBe('de');
    });
  });

  describe('PUT /v1/station-message-templates/:state', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/station-message-templates/available',
        payload: { body: 'New' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for an unknown state', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/station-message-templates/bogus-state?language=en',
        headers: { authorization: `Bearer ${token}` },
        payload: { body: 'New' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 without a language or with an unsupported one', async () => {
      for (const url of [
        '/station-message-templates/available',
        '/station-message-templates/available?language=fr',
      ]) {
        const res = await app.inject({
          method: 'PUT',
          url,
          headers: { authorization: `Bearer ${token}` },
          payload: { body: 'New' },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('upserts and clears the renderer cache', async () => {
      const upserted = {
        state: 'available',
        language: 'de',
        body: 'New body',
        updatedAt: '2026-01-01T00:00:00Z',
        updatedBy: 'usr_test',
      };
      setupDbResults([{ body: 'Old body' }], [upserted]);
      const res = await app.inject({
        method: 'PUT',
        url: '/station-message-templates/available?language=de',
        headers: { authorization: `Bearer ${token}` },
        payload: { body: 'New body' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.body).toBe('New body');
      expect(body.state).toBe('available');
      expect(body.language).toBe('de');
      expect(clearStationMessageCache).toHaveBeenCalledTimes(1);
      expect(requestStationMessageRepush).toHaveBeenCalledTimes(1);
      expect(mockWriteAudit).toHaveBeenCalledTimes(1);
      expect(mockWriteAudit.mock.calls[0]).toEqual([
        {
          table: { _name: 'stationMessageTemplateAuditLog' },
          idColumn: 'station_message_template_id',
        },
        expect.objectContaining({
          entityId: 'available',
          entityIdSnapshot: 'available',
          action: 'updated',
          actor: 'operator',
          actorUserId: 'usr_test',
          before: { language: 'de', body: 'Old body' },
          after: { language: 'de', body: 'New body' },
        }),
        expect.anything(),
        expect.anything(),
      ]);
    });

    it('writes no audit row when the body did not change', async () => {
      setupDbResults(
        [{ body: 'Same body' }],
        [
          {
            state: 'available',
            language: 'en',
            body: 'Same body',
            updatedAt: '2026-01-01T00:00:00Z',
            updatedBy: 'usr_test',
          },
        ],
      );
      const res = await app.inject({
        method: 'PUT',
        url: '/station-message-templates/available?language=en',
        headers: { authorization: `Bearer ${token}` },
        payload: { body: 'Same body' },
      });
      expect(res.statusCode).toBe(200);
      expect(mockWriteAudit).not.toHaveBeenCalled();
    });

    it('refuses a template with helpers, partials or prototype paths, without saving', async () => {
      for (const body of [
        '{{#with this}}{{constructor.constructor}}{{/with}}',
        '{{lookup this "constructor"}}',
        '{{> partial}}',
        '{{__proto__}}',
        '{{#each list}}x{{/each}}',
      ]) {
        clearStationMessageCache.mockClear();
        const res = await app.inject({
          method: 'PUT',
          url: '/station-message-templates/available?language=en',
          headers: { authorization: `Bearer ${token}` },
          payload: { body },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_ERROR');
        expect(clearStationMessageCache).not.toHaveBeenCalled();
      }
    });

    it('does not re-render station screens for a one-shot template', async () => {
      setupDbResults(
        [],
        [
          {
            state: 'payment_failed',
            language: 'en',
            body: 'Declined',
            updatedAt: '2026-01-01T00:00:00Z',
            updatedBy: 'usr_test',
          },
        ],
      );
      const res = await app.inject({
        method: 'PUT',
        url: '/station-message-templates/payment_failed?language=en',
        headers: { authorization: `Bearer ${token}` },
        payload: { body: 'Declined' },
      });
      expect(res.statusCode).toBe(200);
      expect(requestStationMessageRepush).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /v1/station-message-templates/:state', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/station-message-templates/available',
      });
      expect(res.statusCode).toBe(401);
    });

    it('resets to seed default and clears the renderer cache', async () => {
      const { db } = databaseModule;
      const insertMock = db.insert as unknown as ReturnType<typeof vi.fn>;
      insertMock.mockClear();
      const reset = {
        state: 'unavailable',
        language: 'de',
        body: STATION_MESSAGE_DEFAULTS.de.unavailable,
        updatedAt: '2026-01-01T00:00:00Z',
        updatedBy: 'usr_test',
      };
      setupDbResults([{ body: 'Custom' }], [reset]);
      const res = await app.inject({
        method: 'DELETE',
        url: '/station-message-templates/unavailable?language=de',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.body).toBe(STATION_MESSAGE_DEFAULTS.de.unavailable);
      expect(body.language).toBe('de');
      const chain = insertMock.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> };
      expect(chain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'unavailable',
          language: 'de',
          body: STATION_MESSAGE_DEFAULTS.de.unavailable,
        }),
      );
      expect(clearStationMessageCache).toHaveBeenCalledTimes(1);
      expect(mockWriteAudit).toHaveBeenCalledTimes(1);
      expect(mockWriteAudit.mock.calls[0]?.[1]).toMatchObject({
        entityId: 'unavailable',
        action: 'reset',
        before: { language: 'de', body: 'Custom' },
        after: { language: 'de', body: STATION_MESSAGE_DEFAULTS.de.unavailable },
      });
    });

    it('returns 400 without a language', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/station-message-templates/unavailable',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/station-message-templates/preview', () => {
    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/station-message-templates/preview',
        payload: { state: 'available', body: 'hi' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('renders with default sample variables', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/station-message-templates/preview',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          state: 'available',
          language: 'en',
          body: '{{companyName}}\n{{stationOcppId}}',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rendered).toBe('EVtivity\nCS-1234');
    });

    it('renders sample prices as stations show them, in the chosen language', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/station-message-templates/preview',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          state: 'available',
          language: 'de',
          body: STATION_MESSAGE_DEFAULTS.de.available,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rendered).toBe(
        'EVtivity\nCS-1234\n0,357\u00a0€/kWh + 0,0238\u00a0€/Min. + 0,119\u00a0€/Min. Standzeit\ninkl. 19 % MwSt.\nZum Starten einstecken',
      );
    });

    it('shows net sample prices with an excl. note for net display', async () => {
      mockGetCompanyPriceDisplay.mockResolvedValue('net');
      const res = await app.inject({
        method: 'POST',
        url: '/station-message-templates/preview',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          state: 'available',
          language: 'en',
          body: STATION_MESSAGE_DEFAULTS.en.available,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rendered).toBe(
        'EVtivity\nCS-1234\n€0.30/kWh + €0.02/min + €0.10/min idle\nexcl. 19% tax\nPlug in to start',
      );
    });

    it('returns 400 without a language', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/station-message-templates/preview',
        headers: { authorization: `Bearer ${token}` },
        payload: { state: 'available', body: 'hi' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('renders variables unescaped and never runs helpers or reads prototype paths', async () => {
      const render = async (body: string): Promise<string> => {
        const res = await app.inject({
          method: 'POST',
          url: '/station-message-templates/preview',
          headers: { authorization: `Bearer ${token}` },
          payload: { state: 'charging', language: 'en', body, sampleContext: { x: 'a&b<c>' } },
        });
        expect(res.statusCode).toBe(200);
        return res.json().rendered as string;
      };
      expect(await render('{{x}}|{{#if x}}y{{else}}n{{/if}}')).toBe('a&b<c>|y');
      expect(await render('{{#with this}}{{constructor.constructor}}{{/with}}')).toBe('');
      expect(await render('{{lookup this "x"}}')).toBe('');
      expect(await render('[{{toString}}]')).toBe('[]');
    });

    it('honors sampleContext overrides', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/station-message-templates/preview',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          state: 'charging',
          language: 'en',
          body: 'Charging {{energyKwh}} kWh',
          sampleContext: { energyKwh: '99.9' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rendered).toBe('Charging 99.9 kWh');
    });
  });
});
