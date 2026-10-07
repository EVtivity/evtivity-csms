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
function makeChain() {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'offset',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
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

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
    execute: vi.fn(() => Promise.resolve([])),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeChain()),
        insert: vi.fn(() => makeChain()),
        update: vi.fn(() => makeChain()),
        delete: vi.fn(() => makeChain()),
      };
      return fn(tx);
    }),
  },
  reports: {},
  reportSchedules: {},
  reportStatusEnum: {
    enumValues: ['pending', 'generating', 'completed', 'failed'] as const,
  },
  reportFrequencyEnum: {
    enumValues: ['daily', 'weekly', 'monthly'] as const,
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
}));

vi.mock('@evtivity/services/report.service', () => ({
  queueReport: vi.fn(() => Promise.resolve('report-123')),
  computeNextRunAtInTz: vi.fn(() => Promise.resolve(new Date('2026-01-02T06:00:00Z'))),
  REPORT_GENERATE_CHANNEL: 'report_generate',
  reportFiltersError: vi.fn((reportType: string, filters: Record<string, unknown>) =>
    reportType === 'nevi' && (filters['quarter'] == null || filters['year'] == null)
      ? 'Filters must include a valid quarter (1-4) and year'
      : null,
  ),
  listReportTypes: vi.fn(() => [
    { type: 'nevi', formats: ['xlsx'], generateFromUi: false },
    { type: 'revenue', formats: ['csv', 'pdf', 'xlsx'], generateFromUi: true },
  ]),
  REPORT_TYPES: [
    'nevi',
    'revenue',
    'energy',
    'sessions',
    'utilization',
    'stationHealth',
    'sustainability',
    'driverActivity',
  ],
}));

const mockPublish = vi.hoisted(() => vi.fn());
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

// Echoes the permission a route requires in a header, so a test can check it.
vi.mock('../middleware/rbac.js', () => ({
  authorize:
    (permission: string) =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: {
        header: (name: string, value: string) => void;
        status: (n: number) => { send: (body: unknown) => Promise<void> };
      },
    ) => {
      reply.header('x-required-permission', permission);
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
}));

// The generate/schedule routes call getUserSiteIds() to validate that
// filters.siteId is in the operator's allowed sites. Stub it to null
// (full access) so tests that don't pass filters.siteId proceed normally.
vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: vi.fn().mockResolvedValue(null),
}));

import { registerAuth } from '../plugins/auth.js';
import { reportRoutes } from '../routes/reports.js';
import { queueReport } from '@evtivity/services/report.service';

const VALID_REPORT_ID = 'rpt_000000000001';
const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  reportRoutes(app);
  await app.ready();
  return app;
}

describe('Report routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
  });

  it('GET /v1/reports returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/reports' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/reports returns paginated reports list', async () => {
    setupDbResults(
      [
        {
          id: 'r1',
          name: 'Revenue Q1',
          reportType: 'revenue',
          status: 'completed',
          format: 'csv',
          fileName: null,
          fileSize: null,
          error: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          completedAt: null,
        },
      ],
      [{ count: 1 }],
    );
    const response = await app.inject({
      method: 'GET',
      url: '/reports',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it('GET /v1/reports/types returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/reports/types' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/reports/types lists the report types with formats and generateFromUi', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/types',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-required-permission']).toBe('reports:read');
    expect(JSON.parse(response.body)).toEqual([
      { type: 'nevi', formats: ['xlsx'], generateFromUi: false },
      { type: 'revenue', formats: ['csv', 'pdf', 'xlsx'], generateFromUi: true },
    ]);
  });

  it('GET /v1/reports/:id returns 404 when report not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: `/reports/${VALID_REPORT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('REPORT_NOT_FOUND');
  });

  it('GET /v1/reports/:id returns report metadata when found', async () => {
    setupDbResults([
      {
        id: VALID_REPORT_ID,
        name: 'Revenue Q1',
        reportType: 'revenue',
        status: 'completed',
        format: 'csv',
        fileName: null,
        fileSize: null,
        error: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        completedAt: null,
        filters: null,
        generatedById: null,
      },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: `/reports/${VALID_REPORT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe(VALID_REPORT_ID);
    expect(body.name).toBe('Revenue Q1');
  });

  it('GET /v1/reports/:id/download returns 404 when file not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: `/reports/${VALID_REPORT_ID}/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('REPORT_NOT_FOUND');
  });

  it('GET /v1/reports/:id/download returns file data with correct content-type', async () => {
    setupDbResults([
      {
        fileData: Buffer.from('test data'),
        fileName: 'report.csv',
        format: 'csv',
      },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: `/reports/${VALID_REPORT_ID}/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv');
    expect(response.headers['content-disposition']).toContain('report.csv');
  });

  it('POST /v1/reports/generate returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/reports/generate',
      payload: { name: 'Test Report', reportType: 'revenue', format: 'csv' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/reports/generate creates report and returns id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/reports/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Test Report', reportType: 'revenue', format: 'csv' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe('report-123');
    expect(body.status).toBe('pending');
  });

  it('POST /v1/reports/generate announces the report to the worker instead of generating it', async () => {
    vi.mocked(queueReport).mockClear();
    mockPublish.mockResolvedValue(undefined);
    await app.inject({
      method: 'POST',
      url: '/reports/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Test Report', reportType: 'revenue', format: 'csv' },
    });

    const dispatch = vi.mocked(queueReport).mock.calls[0]?.[1];
    expect(dispatch).toBeTypeOf('function');
    await dispatch?.('rpt_9');
    expect(mockPublish).toHaveBeenCalledWith(
      'report_generate',
      JSON.stringify({ reportId: 'rpt_9' }),
    );
  });

  it('POST /v1/reports/generate refuses a NEVI report without quarter and year', async () => {
    vi.mocked(queueReport).mockClear();
    const response = await app.inject({
      method: 'POST',
      url: '/reports/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'NEVI', reportType: 'nevi', format: 'xlsx' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('VALIDATION_ERROR');
    expect(queueReport).not.toHaveBeenCalled();
  });

  it('POST /v1/reports/generate queues a NEVI report with quarter and year', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/reports/generate',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'NEVI',
        reportType: 'nevi',
        format: 'xlsx',
        filters: { quarter: 2, year: 2026 },
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('DELETE /v1/reports/:id returns 404 when not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'DELETE',
      url: `/reports/${VALID_REPORT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('REPORT_NOT_FOUND');
  });

  it('DELETE /v1/reports/:id deletes report when found', async () => {
    setupDbResults([{ id: VALID_REPORT_ID }]);
    const response = await app.inject({
      method: 'DELETE',
      url: `/reports/${VALID_REPORT_ID}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });
});

describe('Report schedule routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: VALID_USER_ID, roleId: VALID_ROLE_ID });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
  });

  it('GET /v1/report-schedules returns schedule list', async () => {
    setupDbResults([
      {
        id: 's1',
        name: 'Weekly Revenue',
        reportType: 'revenue',
        format: 'csv',
        frequency: 'weekly',
        dayOfWeek: null,
        dayOfMonth: null,
        filters: null,
        recipientEmails: [],
        isEnabled: true,
        nextRunAt: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/report-schedules',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(1);
  });

  it('POST /v1/report-schedules creates schedule', async () => {
    setupDbResults([
      {
        id: 's1',
        name: 'Weekly Revenue',
        reportType: 'revenue',
        format: 'csv',
        frequency: 'weekly',
        dayOfWeek: null,
        dayOfMonth: null,
        filters: null,
        recipientEmails: [],
        isEnabled: true,
        nextRunAt: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/report-schedules',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Weekly Revenue',
        reportType: 'revenue',
        format: 'csv',
        frequency: 'weekly',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.name).toBe('Weekly Revenue');
  });

  it('POST /v1/report-schedules refuses a NEVI schedule without quarter and year', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/report-schedules',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'NEVI', reportType: 'nevi', format: 'xlsx', frequency: 'monthly' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /v1/report-schedules/:id refuses switching to NEVI without quarter and year', async () => {
    setupDbResults([{ id: 1, reportType: 'revenue', filters: null }]);
    const response = await app.inject({
      method: 'PATCH',
      url: `/report-schedules/1`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reportType: 'nevi' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /v1/report-schedules/:id returns 404 when not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'PATCH',
      url: `/report-schedules/1`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Updated' },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SCHEDULE_NOT_FOUND');
  });

  it('DELETE /v1/report-schedules/:id returns 404 when not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'DELETE',
      url: `/report-schedules/1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SCHEDULE_NOT_FOUND');
  });

  it('DELETE /v1/report-schedules/:id deletes schedule when found', async () => {
    setupDbResults([{ id: VALID_REPORT_ID }]);
    const response = await app.inject({
      method: 'DELETE',
      url: `/report-schedules/1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it('POST /v1/report-schedules/:id/run-now returns 404 when not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'POST',
      url: `/report-schedules/1/run-now`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SCHEDULE_NOT_FOUND');
  });
});
