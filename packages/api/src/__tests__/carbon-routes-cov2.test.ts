// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { executeMock, getUserSiteIdsMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  getUserSiteIdsMock: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  db: { execute: executeMock },
  carbonIntensityFactors: {},
}));

// A recording sql tag: each fragment keeps its text and bound values so the
// test can read the WHERE clause the route builds.
interface Frag {
  strings?: string[];
  values?: unknown[];
  join?: Frag[];
  sep?: Frag;
}
vi.mock('drizzle-orm', () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]): Frag => ({
      strings: [...strings],
      values,
    }),
    {
      join: (join: Frag[], sep: Frag): Frag => ({ join, sep }),
      raw: vi.fn(),
    },
  );
  return { eq: vi.fn(), and: vi.fn(), asc: vi.fn(), sql };
});

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

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: getUserSiteIdsMock,
  invalidateSiteAccessCache: vi.fn(),
}));

import { registerAuth } from '../plugins/auth.js';
import { carbonRoutes } from '../routes/carbon.js';

/** Renders a recorded fragment to text with bound values as [value]. */
function render(f: unknown): string {
  if (f == null || typeof f !== 'object') return `[${String(f)}]`;
  const frag = f as Frag;
  if (frag.join != null) return frag.join.map(render).join(render(frag.sep).replace(/\[|\]/g, ''));
  const strings = frag.strings ?? [];
  let out = strings[0] ?? '';
  (frag.values ?? []).forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? '');
  });
  return out;
}

const whereOf = (call: number): string => {
  const frag = executeMock.mock.calls[call]?.[0] as Frag;
  return render(frag.values?.[0]);
};

describe('carbon routes (cov2)', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    carbonRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    executeMock.mockReset().mockResolvedValue([]);
    getUserSiteIdsMock.mockReset().mockResolvedValue(null);
  });

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('report applies the date range, site and site-access filters as bound values', async () => {
    getUserSiteIdsMock.mockResolvedValue(['sit_a', 'sit_b']);
    executeMock
      .mockResolvedValueOnce([
        { month: '2026-01', co2_avoided_kg: '10.123', energy_wh: '50000', session_count: 3 },
        { month: '2026-02', co2_avoided_kg: 11.77, energy_wh: 25000, session_count: '2' },
      ])
      .mockResolvedValueOnce([
        {
          site_id: 'sit_a',
          site_name: 'Main',
          co2_avoided_kg: '21.893',
          energy_wh: '75000',
          session_count: 5,
        },
      ]);

    const res = await get('/carbon/report?from=2026-01-01&to=2026-02-28&siteId=sit_a');

    expect(res.statusCode).toBe(200);
    const where = whereOf(0);
    expect(where).toContain("cs.status = 'completed' AND cs.co2_avoided_kg IS NOT NULL");
    expect(where).toContain('cs.ended_at >= [2026-01-01]::timestamptz');
    expect(where).toContain('cs.ended_at <= [2026-02-28T23:59:59.999Z]::timestamptz');
    expect(where).toContain('st.site_id = [sit_a]');
    expect(where).toContain('st.site_id IN ([sit_a], [sit_b])');
    // Both aggregations share one predicate.
    expect(whereOf(1)).toBe(where);

    expect(res.json()).toEqual({
      monthlySummary: [
        { month: '2026-01', co2AvoidedKg: 10.123, energyWh: 50000, sessionCount: 3 },
        { month: '2026-02', co2AvoidedKg: 11.77, energyWh: 25000, sessionCount: 2 },
      ],
      siteBreakdown: [
        {
          siteId: 'sit_a',
          siteName: 'Main',
          co2AvoidedKg: 21.893,
          energyWh: 75000,
          sessionCount: 5,
        },
      ],
      cumulativeTotal: {
        co2AvoidedKg: 21.89,
        energyWh: 75000,
        sessionCount: 5,
        treesEquivalent: 1,
      },
    });
  });

  it('report returns empty totals without querying for an operator with no sites', async () => {
    getUserSiteIdsMock.mockResolvedValue([]);
    const res = await get('/carbon/report');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      monthlySummary: [],
      siteBreakdown: [],
      cumulativeTotal: { co2AvoidedKg: 0, energyWh: 0, sessionCount: 0, treesEquivalent: 0 },
    });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('export returns only the header for an operator with no sites', async () => {
    getUserSiteIdsMock.mockResolvedValue([]);
    const res = await get('/carbon/report/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="sustainability-report.csv"',
    );
    // Same file shape as an export with data: the UTF-8 BOM keeps the CO₂ header readable in Excel.
    expect(res.body.split('\n')[0]).toBe('﻿Month,Site,CO₂ Avoided (kg),Energy (kWh),Sessions');
    expect(res.body.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('export writes one row per month and site with kWh and escapes formula site names', async () => {
    executeMock.mockResolvedValueOnce([
      {
        month: '2026-01',
        site_name: 'Main',
        co2_kg: '1.005',
        energy_wh: '12345',
        session_count: 2,
      },
      {
        month: '2026-02',
        site_name: '=cmd|calc',
        co2_kg: 3,
        energy_wh: 1000,
        session_count: '1',
      },
    ]);

    const res = await get('/carbon/report/export?siteId=sit_z');

    expect(res.statusCode).toBe(200);
    expect(whereOf(0)).toContain('st.site_id = [sit_z]');
    expect(whereOf(0)).not.toContain('IN (');
    const lines = res.body.split(/\r?\n/);
    // buildCsv starts with a UTF-8 BOM so Excel reads the CO₂ subscript.
    expect(lines[0]).toBe('﻿Month,Site,CO₂ Avoided (kg),Energy (kWh),Sessions');
    expect(lines[1]).toBe('2026-01,Main,1.00,12.35,2');
    expect(lines[2]).toContain("'=cmd|calc");
    expect(lines[2]).toContain('3.00,1.00,1');
  });
});
