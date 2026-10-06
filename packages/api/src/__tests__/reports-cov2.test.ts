// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

const { results, ops, getUserSiteIds, queueReport, computeNextRunAtInTz, eq } = vi.hoisted(() => ({
  results: [] as unknown[][],
  ops: [] as Array<{ op: string; args: unknown[] }>,
  getUserSiteIds: vi.fn(),
  queueReport: vi.fn(),
  computeNextRunAtInTz: vi.fn(),
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
}));

function makeChain(kind: string): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'values',
    'returning',
    'set',
  ]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      ops.push({ op: `${kind}.${m}`, args });
      return chain;
    });
  }
  let p: Promise<unknown> | null = null;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    p ??= Promise.resolve(results.shift() ?? []);
    return p.then(resolve, reject);
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain('select')),
    insert: vi.fn(() => makeChain('insert')),
    update: vi.fn(() => makeChain('update')),
    delete: vi.fn(() => makeChain('delete')),
  },
  reports: { reportType: 'reports.reportType' },
  reportSchedules: { id: 'rs.id' },
  reportStatusEnum: { enumValues: ['pending', 'generating', 'completed', 'failed'] as const },
  reportFrequencyEnum: { enumValues: ['daily', 'weekly', 'monthly'] as const },
}));

vi.mock('drizzle-orm', () => ({
  eq,
  desc: vi.fn(),
  count: vi.fn(),
  sql: Object.assign(
    vi.fn(() => 'now()'),
    { raw: vi.fn(), join: vi.fn(() => 'joined') },
  ),
}));

vi.mock('@evtivity/services/report.service', () => ({
  queueReport,
  computeNextRunAtInTz,
  reportFiltersError: () => null,
  REPORT_TYPES: ['revenue', 'energy', 'sessions'],
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
}));

vi.mock('../lib/site-access.js', () => ({ getUserSiteIds }));

import { registerAuth } from '../plugins/auth.js';
import { reportRoutes } from '../routes/reports.js';

const NEXT_RUN = new Date('2026-02-01T06:00:00.000Z');

function scheduleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '5',
    name: 'Weekly revenue',
    reportType: 'revenue',
    format: 'csv',
    frequency: 'weekly',
    dayOfWeek: 1,
    dayOfMonth: null,
    filters: null,
    recipientEmails: [],
    isEnabled: true,
    nextRunAt: NEXT_RUN.toISOString(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('report routes - filters, site guards, schedule updates', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    await app.register(rateLimit, { global: false });
    reportRoutes(app);
    await app.ready();
    headers = { authorization: `Bearer ${app.jwt.sign({ userId: 'usr_1', roleId: 'rol_1' })}` };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    results.length = 0;
    ops.length = 0;
    getUserSiteIds.mockResolvedValue(['sit_a']);
    queueReport.mockResolvedValue('rpt_new');
    computeNextRunAtInTz.mockResolvedValue(NEXT_RUN);
  });

  it('GET /reports filters by report type', async () => {
    results.push([], [{ count: 0 }]);
    const res = await app.inject({ method: 'GET', url: '/reports?reportType=energy', headers });
    expect(res.statusCode).toBe(200);
    expect(eq).toHaveBeenCalledWith('reports.reportType', 'energy');
  });

  describe('POST /reports/generate', () => {
    it('returns 404 SITE_NOT_FOUND for a site filter outside the user sites', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/reports/generate',
        headers,
        payload: { name: 'R', reportType: 'revenue', format: 'csv', filters: { siteId: 'sit_b' } },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Site not found', code: 'SITE_NOT_FOUND' });
      expect(queueReport).not.toHaveBeenCalled();
    });

    it('queues a report for an allowed site and limits each user to 10 a minute', async () => {
      const payload = {
        name: 'R',
        reportType: 'revenue',
        format: 'csv',
        filters: { siteId: 'sit_a' },
      };
      const first = await app.inject({
        method: 'POST',
        url: '/reports/generate',
        headers,
        payload,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ id: 'rpt_new', status: 'pending' });
      expect(first.headers['x-ratelimit-limit']).toBe('10');
      expect(queueReport).toHaveBeenCalledWith(
        {
          name: 'R',
          reportType: 'revenue',
          format: 'csv',
          filters: { siteId: 'sit_a' },
          userId: 'usr_1',
        },
        expect.any(Function),
      );
      let last = 0;
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/reports/generate',
          headers,
          payload,
        });
        last = res.statusCode;
      }
      expect(last).toBe(429);
    });
  });

  it('POST /report-schedules returns 404 SITE_NOT_FOUND for a site outside the user sites', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/report-schedules',
      headers,
      payload: {
        name: 'S',
        reportType: 'revenue',
        format: 'csv',
        frequency: 'daily',
        filters: { siteId: 'sit_b' },
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('SITE_NOT_FOUND');
    expect(ops.some((o) => o.op.startsWith('insert'))).toBe(false);
  });

  describe('PATCH /report-schedules/:id', () => {
    it('returns 404 SCHEDULE_NOT_FOUND when the schedule does not exist', async () => {
      results.push([]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/report-schedules/5',
        headers,
        payload: { name: 'X' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Schedule not found', code: 'SCHEDULE_NOT_FOUND' });
    });

    it('returns 404 SITE_NOT_FOUND when new filters target another site', async () => {
      results.push([{ id: '5' }]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/report-schedules/5',
        headers,
        payload: { filters: { siteId: 'sit_b' } },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
      expect(ops.some((o) => o.op.startsWith('update'))).toBe(false);
    });

    it('updates every given field and recomputes the next run on a frequency change', async () => {
      const updated = scheduleRow({ name: 'Monthly', frequency: 'monthly', dayOfMonth: 3 });
      results.push([{ id: '5' }], [updated]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/report-schedules/5',
        headers,
        payload: {
          name: 'Monthly',
          reportType: 'energy',
          format: 'pdf',
          frequency: 'monthly',
          dayOfWeek: 2,
          dayOfMonth: 3,
          filters: { siteId: 'sit_a' },
          recipientEmails: ['ops@example.com'],
          isEnabled: false,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: '5', name: 'Monthly', frequency: 'monthly' });
      expect(computeNextRunAtInTz).toHaveBeenCalledWith('monthly', 2, 3);
      const set = ops.find((o) => o.op === 'update.set');
      expect(set?.args[0]).toEqual({
        updatedAt: 'now()',
        name: 'Monthly',
        reportType: 'energy',
        format: 'pdf',
        frequency: 'monthly',
        dayOfWeek: 2,
        dayOfMonth: 3,
        filters: { siteId: 'sit_a' },
        recipientEmails: ['ops@example.com'],
        isEnabled: false,
        nextRunAt: NEXT_RUN,
      });
    });

    it('does not recompute the next run when the frequency is unchanged', async () => {
      results.push([{ id: '5' }], [scheduleRow({ isEnabled: false })]);
      const res = await app.inject({
        method: 'PATCH',
        url: '/report-schedules/5',
        headers,
        payload: { isEnabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(computeNextRunAtInTz).not.toHaveBeenCalled();
      expect(ops.find((o) => o.op === 'update.set')?.args[0]).toEqual({
        updatedAt: 'now()',
        isEnabled: false,
      });
    });
  });

  describe('POST /report-schedules/:id/run-now', () => {
    it('returns 404 SITE_NOT_FOUND when the stored filter targets a site the user lost', async () => {
      results.push([scheduleRow({ filters: { siteId: 'sit_b' } })]);
      const res = await app.inject({
        method: 'POST',
        url: '/report-schedules/5/run-now',
        headers,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
      expect(queueReport).not.toHaveBeenCalled();
    });

    it('queues the schedule with empty filters when it has none', async () => {
      results.push([scheduleRow()]);
      const res = await app.inject({
        method: 'POST',
        url: '/report-schedules/5/run-now',
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: 'rpt_new', status: 'pending' });
      expect(queueReport).toHaveBeenCalledWith(
        {
          name: 'Weekly revenue',
          reportType: 'revenue',
          format: 'csv',
          filters: {},
          userId: 'usr_1',
        },
        expect.any(Function),
      );
    });
  });
});
