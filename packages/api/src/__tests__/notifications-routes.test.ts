// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OCPP_NOTIFICATION_EVENT_TYPES } from '@evtivity/lib/notification-events';

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
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
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
  like: vi.fn(),
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

const { mockLoadSubjectTemplate } = vi.hoisted(() => ({
  mockLoadSubjectTemplate: vi.fn(),
}));

vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  return {
    // The template rules are the behavior under test, so they stay real.
    assertTemplateAllowed: actual.assertTemplateAllowed,
    compileAllowedTemplate: actual.compileAllowedTemplate,
    // Sample money values are formatted like the dispatcher formats them.
    formatLocalizedVariables: actual.formatLocalizedVariables,
    notificationMoney: actual.notificationMoney,
    notificationUnitPrice: actual.notificationUnitPrice,
    notificationTaxRate: actual.notificationTaxRate,
    loadSubjectTemplate: mockLoadSubjectTemplate,
    decryptString: vi.fn().mockReturnValue('decrypted'),
    wrapEmailHtml: vi.fn(
      (html: string, _company: string, _wrapper: string | null, _vars: unknown) =>
        `<wrapper>${html}</wrapper>`,
    ),
  };
});

import { registerAuth } from '../plugins/auth.js';
import {
  notificationRoutes,
  DRIVER_EVENT_TYPES,
  SYSTEM_EVENT_TYPES,
} from '../routes/notifications.js';

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
    expect(body).toContain('session.EndRequestFailed');
    for (const event of OCPP_NOTIFICATION_EVENT_TYPES) {
      expect(body, event).toContain(event);
    }
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
    expect(body.code).toBe('EMAIL_NOT_CONFIGURED');
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
    expect(body.code).toBe('SMS_NOT_CONFIGURED');
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

  it('PUT /v1/driver-event-settings turns a driver event type off', async () => {
    setupDbResults([
      {
        id: '2',
        eventType: 'session.Receipt',
        isEnabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const response = await app.inject({
      method: 'PUT',
      url: '/driver-event-settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { eventType: 'session.Receipt', isEnabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).isEnabled).toBe(false);
  });

  it.each([
    'driver.ForgotPassword',
    'driver.AccountVerification',
    'driver.PortalInvite',
    'mfa.VerificationCode',
  ])('PUT /v1/driver-event-settings refuses to turn off %s', async (eventType) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/driver-event-settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { eventType, isEnabled: false },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('NOTIFICATION_EVENT_REQUIRED');
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

  it('GET /v1/notification-templates returns the subject file in the requested language', async () => {
    setupDbResults([]);
    mockLoadSubjectTemplate.mockResolvedValueOnce('{{{companyName}}} - 결제 확인');
    const response = await app.inject({
      method: 'GET',
      url: '/notification-templates?eventType=payment.Complete&channel=email&language=ko',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).subject).toBe('{{{companyName}}} - 결제 확인');
    const [eventType, language, dirs] = mockLoadSubjectTemplate.mock.calls.at(-1) as [
      string,
      string,
      string[],
    ];
    expect(eventType).toBe('payment.Complete');
    expect(language).toBe('ko');
    expect(dirs).toHaveLength(2);
  });

  it('GET /v1/notification-templates never looks up a subject for an unsafe event type', async () => {
    setupDbResults([]);
    mockLoadSubjectTemplate.mockClear();
    const response = await app.inject({
      method: 'GET',
      url: '/notification-templates?eventType=..%2F..%2Fetc&channel=email&language=en',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(mockLoadSubjectTemplate).not.toHaveBeenCalled();
    expect(JSON.parse(response.body).subject).toBe('{{{companyName}}} - ../../etc Notification');
  });

  it('GET /v1/notification-templates returns no subject for sms', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'GET',
      url: '/notification-templates?eventType=payment.Complete&channel=sms&language=ko',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).subject).toBeNull();
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

  it('POST /v1/notification-templates/preview formats sample money in the template language', async () => {
    setupDbResults(
      [{ value: 'TestCo' }],
      [{ value: null }],
      [{ value: 'EUR' }],
      [{ key: 'company.name', value: 'TestCo' }],
    );
    const response = await app.inject({
      method: 'POST',
      url: '/notification-templates/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        eventType: 'payment.Complete',
        channel: 'sms',
        language: 'de',
        bodyHtml:
          'Bezahlt: {{amountFormatted}} ({{amountCents}} {{currency}}), {{taxRatePercent}} %',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { bodyHtml: string };
    expect(body.bodyHtml).toMatch(/^Bezahlt: 12,50\s€ \(1250 [A-Z]{3}\), 19 %$/);
  });

  it('POST /v1/notification-templates/preview renders if/else blocks used by shipped templates', async () => {
    setupDbResults([{ value: 'TestCo' }], [{ value: null }], [{ value: 'USD' }], []);
    const response = await app.inject({
      method: 'POST',
      url: '/notification-templates/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        eventType: 'reservation.CancelledForMaintenance',
        channel: 'email',
        language: 'en',
        subject: 'Hello',
        bodyHtml:
          '{{#if firstName}}Hi {{firstName}},{{else}}Hello,{{/if}}{{#unless reason}} none{{/unless}}',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ bodyHtml: string }>();
    expect(body.bodyHtml).toContain('Hi John,');
    expect(body.bodyHtml).toContain('none');
  });

  it('PUT /v1/notification-templates rejects a template that outgoing email would refuse', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/notification-templates',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        eventType: 'station.Connected',
        channel: 'email',
        language: 'en',
        subject: '{{lookup a b}}',
        bodyHtml: '{{> header}}',
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string; details: Record<string, string> }>();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details).toEqual({
      subject: 'Helpers are not allowed in templates',
      bodyHtml: 'Partials are not allowed in templates',
    });
  });

  it('PUT /v1/ocpp-event-settings rejects a disallowed templateHtml', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/ocpp-event-settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        eventType: 'station.Connected',
        channel: 'email',
        recipient: '$admin',
        templateHtml: '{{#each items}}x{{/each}}',
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string; details: Record<string, string> }>();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details['templateHtml']).toContain('block helpers');
  });

  it('POST /v1/notification-templates/preview returns 400 for a disallowed block helper', async () => {
    setupDbResults([{ value: 'TestCo' }], [{ value: null }], [{ value: 'USD' }], []);
    const response = await app.inject({
      method: 'POST',
      url: '/notification-templates/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        eventType: 'station.Connected',
        channel: 'email',
        language: 'en',
        subject: 'Hello',
        bodyHtml: '{{#each items}}x{{/each}}',
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string; details: Record<string, string> }>();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details).toEqual({
      bodyHtml: 'Only {{#if}} and {{#unless}} block helpers are allowed in templates',
    });
  });

  it('POST /v1/notification-templates/preview returns 400 for a subject that does not parse', async () => {
    setupDbResults([{ value: 'TestCo' }], [{ value: null }], [{ value: 'USD' }], []);
    const response = await app.inject({
      method: 'POST',
      url: '/notification-templates/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        eventType: 'station.Connected',
        channel: 'email',
        language: 'en',
        subject: 'Hello {{companyName',
        bodyHtml: '<p>ok</p>',
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string; details: Record<string, string> }>();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(body.details)).toEqual(['subject']);
  });

  it('POST /v1/email-wrapper/preview renders a draft layout with company details', async () => {
    setupDbResults([
      { key: 'company.name', value: 'TestCo' },
      { key: 'company.city', value: 'Austin' },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/email-wrapper/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        wrapperTemplate:
          '<h1>{{companyName}}</h1>{{{content}}}{{#if companyCity}}<i>{{companyCity}}</i>{{/if}}',
      },
    });
    expect(response.statusCode).toBe(200);
    const { html } = response.json<{ html: string }>();
    expect(html).toContain('<h1>TestCo</h1>');
    expect(html).toContain('Hi John,');
    expect(html).toContain('<i>Austin</i>');
  });

  it('POST /v1/email-wrapper/preview returns 400 VALIDATION_ERROR for an invalid layout', async () => {
    setupDbResults([]);
    const response = await app.inject({
      method: 'POST',
      url: '/email-wrapper/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: { wrapperTemplate: '<p>{{#if companyName}}unclosed</p>' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string; details: { wrapperTemplate: string } }>();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.wrapperTemplate).toEqual(expect.any(String));
  });

  it('POST /v1/email-wrapper/preview rejects a layout over 100 kB', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/email-wrapper/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: { wrapperTemplate: 'x'.repeat(100_001) },
    });
    expect(response.statusCode).toBe(400);
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

describe('notification event type lists', () => {
  // report.Scheduled is the scheduled report email the worker renders; it is not a notification event.
  const NOT_NOTIFICATION_EVENTS = new Set(['report.Scheduled']);

  // Driver and system templates ship in the api and ocpp packages. OCPP and station events
  // are listed in OCPP_EVENT_TYPES.
  const TEMPLATE_ROOTS = ['../templates', '../../../ocpp/src/templates'];
  const OCPP_FAMILIES = new Set(['ocpp', 'station']);

  function templateEventTypes(language: string): string[] {
    return TEMPLATE_ROOTS.flatMap((root) => {
      const dir = fileURLToPath(new URL(`${root}/${language}`, import.meta.url));
      return readdirSync(dir, { withFileTypes: true })
        .filter((family) => family.isDirectory() && !OCPP_FAMILIES.has(family.name))
        .flatMap((family) =>
          readdirSync(`${dir}/${family.name}`, { withFileTypes: true })
            .filter((event) => event.isDirectory())
            .map((event) => `${family.name}.${event.name}`),
        );
    });
  }

  it('lists every event with shipped templates in exactly one list', () => {
    for (const language of ['en', 'de', 'es', 'ko', 'zh', 'zh-TW']) {
      for (const event of templateEventTypes(language)) {
        if (NOT_NOTIFICATION_EVENTS.has(event)) continue;
        const count =
          DRIVER_EVENT_TYPES.filter((e) => e === event).length +
          SYSTEM_EVENT_TYPES.filter((e) => e === event).length;
        expect(count, `${language}: ${event}`).toBe(1);
      }
    }
  });

  function ocppTemplateEventTypes(language: string): string[] {
    const dir = fileURLToPath(new URL(`../../../ocpp/src/templates/${language}`, import.meta.url));
    return [...OCPP_FAMILIES].flatMap((family) =>
      readdirSync(`${dir}/${family}`, { withFileTypes: true })
        .filter((event) => event.isDirectory())
        .map((event) => `${family}.${event.name}`),
    );
  }

  it('lists every OCPP and station event with shipped templates in the OCPP list, and only those', () => {
    const listed: readonly string[] = OCPP_NOTIFICATION_EVENT_TYPES;
    for (const language of ['en', 'de', 'es', 'ko', 'zh', 'zh-TW']) {
      expect([...ocppTemplateEventTypes(language)].sort(), language).toEqual([...listed].sort());
    }
  });

  it('keeps operator and site host events out of the driver list', () => {
    for (const event of DRIVER_EVENT_TYPES) {
      expect(event).not.toMatch(/^(operator|site)\./);
    }
    for (const event of SYSTEM_EVENT_TYPES) {
      expect(event).not.toMatch(/^(driver|payment|token|watch|maintenance|mfa)\./);
    }
  });
});
