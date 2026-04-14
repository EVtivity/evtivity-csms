// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
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
  notifications: {},
  notificationTemplates: {},
  driverEventSettings: {},
  ocppEventSettings: {},
  settings: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
  asc: vi.fn(),
  inArray: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  between: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('File not found')),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({}),
    }),
  },
}));

vi.mock('@evtivity/lib', () => ({
  decryptString: vi.fn().mockReturnValue('decrypted'),
  wrapEmailHtml: vi.fn(
    (html: string, _company: string, _wrapper: string | null, _vars: unknown) =>
      `<wrapper>${html}</wrapper>`,
  ),
}));

import { registerAuth } from '../plugins/auth.js';
import { notificationRoutes } from '../routes/notifications.js';

const VALID_USER_ID = 'usr_000000000001';
const VALID_ROLE_ID = 'rol_000000000001';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  notificationRoutes(app);
  await app.ready();
  return app;
}

describe('Notification routes', () => {
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

  // --- Auth requirements ---

  it('GET /v1/ocpp-event-types returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/ocpp-event-types' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/ocpp-event-settings returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/ocpp-event-settings' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/notifications returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/notifications' });
    expect(response.statusCode).toBe(401);
  });

  it('GET /v1/driver-event-settings returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/driver-event-settings' });
    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/notifications/test returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/notifications/test',
      payload: { channel: 'email', recipient: 'test@example.com' },
    });
    expect(response.statusCode).toBe(401);
  });

  // --- Happy paths ---

  it('GET /v1/ocpp-event-types returns all event types', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ocpp-event-types',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('station.Connected');
    expect(body).toContain('ocpp.TransactionEvent');
    expect(body).toContain('session.Started');
    expect(body).toContain('driver.Welcome');
  });

  it('GET /v1/ocpp-event-settings returns all settings', async () => {
    setupDbResults([
      {
        id: '1',
        eventType: 'station.Connected',
        recipient: 'admin@test.com',
        channel: 'email',
        templateHtml: null,
        language: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/ocpp-event-settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
  });

  it('PUT /v1/ocpp-event-settings upserts a setting', async () => {
    setupDbResults([
      {
        id: '1',
        eventType: 'station.Connected',
        recipient: 'admin@test.com',
        channel: 'email',
        templateHtml: null,
        language: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const response = await app.inject({
      method: 'PUT',
      url: '/ocpp-event-settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { eventType: 'station.Connected', recipient: 'admin@test.com' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.eventType).toBe('station.Connected');
  });

  it('PUT /v1/ocpp-event-settings validates schema', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/ocpp-event-settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('DELETE /v1/ocpp-event-settings deletes a setting', async () => {
    setupDbResults([{ id: '1' }]);
    const response = await app.inject({
      method: 'DELETE',
      url: '/ocpp-event-settings?eventType=station.Connected&channel=email',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it('DELETE /v1/ocpp-event-settings returns 404 when not found', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'DELETE',
      url: '/ocpp-event-settings?eventType=nonexistent&channel=email',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('GET /v1/notifications returns paginated notification history', async () => {
    // data query and count query run in parallel
    setupDbResults(
      [
        {
          id: '1',
          eventType: 'station.Connected',
          channel: 'email',
          recipient: 'admin@example.com',
          status: 'sent',
          metadata: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
      [{ count: 1 }],
    );
    const response = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('POST /v1/notifications/test validates body schema', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/notifications/test',
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: 'invalid', recipient: 'test@example.com' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /v1/notifications/test email returns 400 when SMTP not configured', async () => {
    // settings query returns no smtp.host
    setupDbResults([]);
    const response = await app.inject({
      method: 'POST',
      url: '/notifications/test',
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: 'email', recipient: 'test@example.com' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('SMTP_NOT_CONFIGURED');
  });

  it('POST /v1/notifications/test sms returns 400 when Twilio not configured', async () => {
    // settings query returns rows but no twilio config
    setupDbResults([{ key: 'smtp.host', value: 'mail.example.com' }]);
    const response = await app.inject({
      method: 'POST',
      url: '/notifications/test',
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: 'sms', recipient: '+15551234567' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('TWILIO_NOT_CONFIGURED');
  });

  it('GET /v1/driver-event-settings returns all driver event settings', async () => {
    setupDbResults([
      {
        id: '1',
        eventType: 'session.Started',
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: '2',
        eventType: 'session.Completed',
        isEnabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/driver-event-settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
  });

  it('PUT /v1/driver-event-settings upserts a driver event setting', async () => {
    setupDbResults([
      {
        id: '1',
        eventType: 'session.Started',
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const response = await app.inject({
      method: 'PUT',
      url: '/driver-event-settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { eventType: 'session.Started', isEnabled: true },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.eventType).toBe('session.Started');
    expect(body.isEnabled).toBe(true);
  });

  it('PUT /v1/driver-event-settings validates schema', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/driver-event-settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('GET /v1/notification-templates returns a DB template when found', async () => {
    setupDbResults([
      {
        eventType: 'station.Connected',
        channel: 'email',
        language: 'en',
        subject: 'Test Subject',
        bodyHtml: '<p>Hello</p>',
      },
    ]);
    const response = await app.inject({
      method: 'GET',
      url: '/notification-templates?eventType=station.Connected&channel=email&language=en',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.eventType).toBe('station.Connected');
    expect(body.isCustomized).toBe(true);
    expect(body.subject).toBe('Test Subject');
  });

  it('GET /v1/notification-templates returns generated default when no DB row and no file', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/notification-templates?eventType=station.Connected&channel=email&language=en',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.isCustomized).toBe(false);
    expect(body.eventType).toBe('station.Connected');
  });

  it('PUT /v1/notification-templates upserts a template', async () => {
    setupDbResults([
      {
        id: 1,
        eventType: 'station.Connected',
        channel: 'email',
        language: 'en',
        subject: 'New Subject',
        bodyHtml: '<p>New Body</p>',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    const response = await app.inject({
      method: 'PUT',
      url: '/notification-templates',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        eventType: 'station.Connected',
        channel: 'email',
        language: 'en',
        subject: 'New Subject',
        bodyHtml: '<p>New Body</p>',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.subject).toBe('New Subject');
  });

  it('DELETE /v1/notification-templates deletes a template', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'DELETE',
      url: '/notification-templates?eventType=station.Connected&channel=email&language=en',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it('POST /v1/notification-templates/preview returns rendered template', async () => {
    // company name, wrapper template, currency, all settings (4 queries)
    setupDbResults(
      [{ value: 'TestCo' }],
      [{ value: null }],
      [{ value: 'USD' }],
      [
        { key: 'company.name', value: 'TestCo' },
        { key: 'company.currency', value: 'USD' },
      ],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/notification-templates/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        eventType: 'station.Connected',
        channel: 'email',
        language: 'en',
        subject: '{{companyName}} - Test',
        bodyHtml: '<p>Station {{stationId}} connected</p>',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('subject');
    expect(body).toHaveProperty('bodyHtml');
    // Subject should be rendered with Handlebars
    expect(body.subject).toContain('TestCo');
  });

  it('GET /v1/ocpp-event-template returns 404 when no template found', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ocpp-event-template?eventType=station.Connected&channel=email&language=en',
      headers: { authorization: `Bearer ${token}` },
    });
    // readFile is mocked to reject, so both primary and fallback fail -> 404
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('TEMPLATE_NOT_FOUND');
  });
});
