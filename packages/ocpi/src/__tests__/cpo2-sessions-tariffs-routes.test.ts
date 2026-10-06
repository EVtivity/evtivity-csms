// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { OcpiPartnerInfo } from '../middleware/ocpi-auth.js';

// Each awaited select chain resolves to the next queued result. The CDR route
// starts the rows query before the count query.
let selectResults: unknown[][] = [];
const limitArgs: number[] = [];
const offsetArgs: number[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['limit'] = vi.fn((n: number) => {
    limitArgs.push(n);
    return chain;
  });
  chain['offset'] = vi.fn((n: number) => {
    offsetArgs.push(n);
    return chain;
  });
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return chain;
}

const { mockListSessions, mockRenderTariffs } = vi.hoisted(() => ({
  mockListSessions: vi.fn(),
  mockRenderTariffs: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: vi.fn(() => makeChain()) },
}));
vi.mock('../services/cpo-sessions.js', () => ({ listPartnerCpoSessions: mockListSessions }));
vi.mock('../services/published-tariffs.js', () => ({ renderPartnerTariffs: mockRenderTariffs }));

let partner: OcpiPartnerInfo | undefined;
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: async (request: { ocpiPartner?: OcpiPartnerInfo }) => {
    if (partner != null) request.ocpiPartner = partner;
  },
}));

const { cpoSessionRoutes, cpoCdrRoutes } = await import('../routes/cpo/sessions.js');
const { cpoTariffRoutes } = await import('../routes/cpo/tariffs.js');

const PARTNER: OcpiPartnerInfo = {
  partnerId: 'opr_000000000001',
  partnerName: 'Partner One',
  countryCode: 'NL',
  partyId: 'EMS',
  allowPrivateNetwork: false,
  tokenId: 1,
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  cpoSessionRoutes(app);
  cpoCdrRoutes(app);
  cpoTariffRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  selectResults = [];
  limitArgs.length = 0;
  offsetArgs.length = 0;
  partner = { ...PARTNER };
  mockListSessions.mockReset();
  mockRenderTariffs.mockReset();
});

describe('GET /cpo/sessions', () => {
  it('answers 2000 when the token has no registered partner', async () => {
    partner = { ...PARTNER, partnerId: null };
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/sessions' });
    expect(res.json()).toMatchObject({ status_code: 2000, status_message: 'Not authenticated' });
    expect(mockListSessions).not.toHaveBeenCalled();
  });

  it('passes default pagination and returns the sessions with headers', async () => {
    mockListSessions.mockResolvedValue({ total: 2, sessions: [{ id: 'S1' }, { id: 'S2' }] });
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status_code: 1000, data: [{ id: 'S1' }, { id: 'S2' }] });
    expect(mockListSessions).toHaveBeenCalledWith(PARTNER.partnerId, '2.2.1', {
      offset: 0,
      limit: 50,
    });
    expect(res.headers['x-total-count']).toBe('2');
    expect(res.headers['x-limit']).toBe('50');
    expect(res.headers['link']).toBeUndefined();
  });

  it('forwards the date filters and sets a next Link when more remain', async () => {
    mockListSessions.mockResolvedValue({ total: 25, sessions: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.3.0/cpo/sessions?offset=10&limit=5&date_from=2026-09-01T00:00:00Z&date_to=2026-09-02T00:00:00Z',
    });
    expect(mockListSessions).toHaveBeenCalledWith(PARTNER.partnerId, '2.3.0', {
      offset: 10,
      limit: 5,
      dateFrom: new Date('2026-09-01T00:00:00Z'),
      dateTo: new Date('2026-09-02T00:00:00Z'),
    });
    const link = String(res.headers['link']);
    expect(link).toMatch(/^<http:\/\/localhost(:\d+)?\/ocpi\/2\.3\.0\/cpo\/sessions\?/);
    expect(link).toContain('offset=15');
    expect(link).toContain('limit=5');
    expect(link).toContain('date_from=2026-09-01T00%3A00%3A00Z');
    expect(link).toContain('date_to=2026-09-02T00%3A00%3A00Z');
    expect(link.endsWith('>; rel="next"')).toBe(true);
  });

  it('clamps the limit to 1000, a negative offset to 0, and drops invalid dates', async () => {
    mockListSessions.mockResolvedValue({ total: 0, sessions: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/cpo/sessions?offset=-4&limit=5000&date_from=garbage&date_to=nope',
    });
    expect(mockListSessions).toHaveBeenCalledWith(PARTNER.partnerId, '2.2.1', {
      offset: 0,
      limit: 1000,
    });
    expect(res.headers['x-limit']).toBe('1000');
  });

  it('falls back to the default limit for zero or non-numeric values', async () => {
    mockListSessions.mockResolvedValue({ total: 0, sessions: [] });
    await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/sessions?limit=0&offset=abc' });
    await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/sessions?limit=-3&date_from=' });
    expect(mockListSessions.mock.calls[0]?.[2]).toEqual({ offset: 0, limit: 50 });
    expect(mockListSessions.mock.calls[1]?.[2]).toEqual({ offset: 0, limit: 1 });
  });

  it('sets no Link on the last page (offset + limit equal to total)', async () => {
    mockListSessions.mockResolvedValue({ total: 10, sessions: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/cpo/sessions?offset=5&limit=5',
    });
    expect(res.headers['link']).toBeUndefined();
    expect(res.headers['x-total-count']).toBe('10');
  });
});

describe('GET /cpo/cdrs', () => {
  it('answers 2000 without a registered partner', async () => {
    partner = undefined;
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/cdrs' });
    expect(res.json()).toMatchObject({ status_code: 2000 });
  });

  it('returns the stored CDR data of each row with pagination headers', async () => {
    selectResults = [[{ cdrData: { id: 'CDR1' } }, { cdrData: { id: 'CDR2' } }], [{ count: 7 }]];
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/cpo/cdrs?limit=2&offset=2&date_from=2026-01-01&date_to=2026-12-31',
    });
    expect(res.json()).toMatchObject({ status_code: 1000, data: [{ id: 'CDR1' }, { id: 'CDR2' }] });
    expect(limitArgs).toEqual([2]);
    expect(offsetArgs).toEqual([2]);
    expect(res.headers['x-total-count']).toBe('7');
    expect(String(res.headers['link'])).toContain('offset=4');
  });

  it('treats a missing count row as zero', async () => {
    selectResults = [[], []];
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.3.0/cpo/cdrs' });
    expect(res.json()).toMatchObject({ status_code: 1000, data: [] });
    expect(res.headers['x-total-count']).toBe('0');
  });
});

describe('GET /cpo/tariffs', () => {
  const tariffs = [
    { id: 'T3', last_updated: '2026-09-03T00:00:00.000Z' },
    { id: 'T2', last_updated: '2026-09-02T00:00:00.000Z' },
    { id: 'T1', last_updated: '2026-09-01T00:00:00.000Z' },
  ];

  it('answers 2000 without a registered partner', async () => {
    partner = { ...PARTNER, partnerId: null };
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1/cpo/tariffs' });
    expect(res.json()).toMatchObject({ status_code: 2000 });
    expect(mockRenderTariffs).not.toHaveBeenCalled();
  });

  it('renders the partner tariffs for the requested version', async () => {
    mockRenderTariffs.mockResolvedValue(tariffs);
    const res = await app.inject({ method: 'GET', url: '/ocpi/2.3.0/cpo/tariffs' });
    expect(mockRenderTariffs).toHaveBeenCalledWith(PARTNER.partnerId, '2.3.0');
    expect(res.json<{ data: Array<{ id: string }> }>().data.map((t) => t.id)).toEqual([
      'T3',
      'T2',
      'T1',
    ]);
    expect(res.headers['x-total-count']).toBe('3');
  });

  it('filters on last_updated: date_from inclusive, date_to exclusive', async () => {
    mockRenderTariffs.mockResolvedValue(tariffs);
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/cpo/tariffs?date_from=2026-09-02T00:00:00Z&date_to=2026-09-03T00:00:00Z',
    });
    expect(res.json<{ data: Array<{ id: string }> }>().data.map((t) => t.id)).toEqual(['T2']);
    expect(res.headers['x-total-count']).toBe('1');
  });

  it('slices the page and links to the next one', async () => {
    mockRenderTariffs.mockResolvedValue(tariffs);
    const res = await app.inject({
      method: 'GET',
      url: '/ocpi/2.2.1/cpo/tariffs?offset=1&limit=1',
    });
    expect(res.json<{ data: Array<{ id: string }> }>().data.map((t) => t.id)).toEqual(['T2']);
    expect(String(res.headers['link'])).toContain('offset=2');
    expect(res.headers['x-total-count']).toBe('3');
  });
});
