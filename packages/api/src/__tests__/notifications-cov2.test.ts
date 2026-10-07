// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// DB mock helpers
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
function setupDbResults(...results: unknown[][]) {
  dbResults = results;
  dbCallIndex = 0;
}
const chains: Record<string, ReturnType<typeof vi.fn>>[] = [];
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
  chains.push(chain as Record<string, ReturnType<typeof vi.fn>>);
  return chain;
}

const {
  mockReadFile,
  mockSendMail,
  mockCreateTransport,
  mockDecrypt,
  mockPublish,
  ilikeSpy,
  eqSpy,
} = vi.hoisted(() => {
  const sendMail = vi.fn();
  return {
    mockReadFile: vi.fn(),
    mockSendMail: sendMail,
    mockCreateTransport: vi.fn(() => ({ sendMail })),
    mockDecrypt: vi.fn(),
    mockPublish: vi.fn(),
    ilikeSpy: vi.fn((col: unknown, pattern: unknown) => ({ ilike: [col, pattern] })),
    eqSpy: vi.fn((col: unknown, value: unknown) => ({ eq: [col, value] })),
  };
});

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
  },
  notifications: {
    recipient: 'n.recipient',
    eventType: 'n.eventType',
    channel: 'n.channel',
    status: 'n.status',
  },
  notificationTemplates: {},
  driverEventSettings: {},
  ocppEventSettings: {},
  settings: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: eqSpy,
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  ilike: ilikeSpy,
  desc: vi.fn(),
  count: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ readFile: mockReadFile }));

vi.mock('nodemailer', () => ({ default: { createTransport: mockCreateTransport } }));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

vi.mock('@evtivity/lib', async () => {
  const actual = await vi.importActual<typeof import('@evtivity/lib')>('@evtivity/lib');
  return {
    assertTemplateAllowed: actual.assertTemplateAllowed,
    compileAllowedTemplate: actual.compileAllowedTemplate,
    formatLocalizedVariables: actual.formatLocalizedVariables,
    notificationMoney: actual.notificationMoney,
    notificationUnitPrice: actual.notificationUnitPrice,
    notificationTaxRate: actual.notificationTaxRate,
    loadSubjectTemplate: vi.fn().mockResolvedValue(null),
    decryptString: mockDecrypt,
    wrapEmailHtml: vi.fn((html: string) => `<wrapper>${html}</wrapper>`),
  };
});

import { registerAuth } from '../plugins/auth.js';
import { notificationRoutes } from '../routes/notifications.js';
import { config } from '../lib/config.js';

const TS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  notificationRoutes(app);
  await app.ready();
  return app;
}

describe('Notification routes: validation, test sends, templates', () => {
  let app: FastifyInstance;
  let token: string;
  const originalKey = config.SETTINGS_ENCRYPTION_KEY;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    setupDbResults();
    chains.length = 0;
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockSendMail.mockResolvedValue({});
    mockDecrypt.mockReturnValue('plain-secret');
    mockPublish.mockResolvedValue(undefined);
  });

  afterEach(() => {
    config.SETTINGS_ENCRYPTION_KEY = originalKey;
    vi.unstubAllGlobals();
  });

  function req(method: 'GET' | 'PUT' | 'POST', url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload != null ? { payload } : {}),
    });
  }

  describe('PUT /ocpp-event-settings recipient validation', () => {
    it.each([
      ['no-at-sign.example.com'],
      ['@example.com'],
      ['a@b@c.com'],
      ['user@'],
      ['user@domain'],
      ['user name@example.com'],
    ])('rejects email recipient %s', async (recipient) => {
      const res = await req('PUT', '/ocpp-event-settings', {
        eventType: 'station.Connected',
        recipient,
        channel: 'email',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'recipient must be a valid email address for email channel',
        code: 'VALIDATION_ERROR',
      });
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it.each([['not a url'], ['ftp://hooks.example.com/x']])(
      'rejects webhook recipient %s',
      async (recipient) => {
        const res = await req('PUT', '/ocpp-event-settings', {
          eventType: 'station.Connected',
          recipient,
          channel: 'webhook',
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('recipient must be a valid http(s) URL for webhook channel');
      },
    );

    it('accepts an https webhook, stores template and language, and invalidates the OCPP cache', async () => {
      const saved = {
        id: 1,
        eventType: 'station.Faulted',
        recipient: 'https://hooks.example.com/x',
        channel: 'webhook',
        templateHtml: '<p>{{stationId}}</p>',
        language: 'de',
        ...TS,
      };
      setupDbResults([saved]);
      const res = await req('PUT', '/ocpp-event-settings', {
        eventType: 'station.Faulted',
        recipient: 'https://hooks.example.com/x',
        channel: 'webhook',
        templateHtml: '<p>{{stationId}}</p>',
        language: 'de',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ channel: 'webhook', language: 'de' });
      const insertChain = chains[0];
      expect(insertChain?.['onConflictDoUpdate']).toHaveBeenCalledWith(
        expect.objectContaining({
          set: expect.objectContaining({
            recipient: 'https://hooks.example.com/x',
            templateHtml: '<p>{{stationId}}</p>',
            language: 'de',
          }),
        }),
      );
      expect(mockPublish).toHaveBeenCalledWith(
        'cache_invalidate',
        JSON.stringify({ cache: 'ocppEventSettings' }),
      );
    });

    it('still saves when the cache invalidation publish fails', async () => {
      mockPublish.mockRejectedValue(new Error('redis down'));
      setupDbResults([
        {
          id: 2,
          eventType: 'station.Connected',
          recipient: '$admin',
          channel: 'email',
          templateHtml: null,
          language: null,
          ...TS,
        },
      ]);
      const res = await req('PUT', '/ocpp-event-settings', {
        eventType: 'station.Connected',
        recipient: '$admin',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().recipient).toBe('$admin');
    });
  });

  describe('GET /ocpp-event-template', () => {
    it('returns the file content for the requested language', async () => {
      mockReadFile.mockResolvedValueOnce('<p>Hallo</p>');
      const res = await req(
        'GET',
        '/ocpp-event-template?eventType=station.Connected&channel=email&language=de',
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ template: '<p>Hallo</p>' });
      const path = String(mockReadFile.mock.calls[0]?.[0]);
      expect(path).toMatch(/[\\/]de[\\/]station[\\/]Connected[\\/]email\.hbs$/);
    });

    it('falls back to English when the language file is missing', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValueOnce('<p>Hi</p>');
      const res = await req(
        'GET',
        '/ocpp-event-template?eventType=station.Connected&channel=email&language=ko',
      );
      expect(res.json()).toEqual({ template: '<p>Hi</p>' });
      expect(String(mockReadFile.mock.calls[1]?.[0])).toMatch(/[\\/]en[\\/]station[\\/]/);
    });

    it('never reads a file for an unknown channel or a traversal event type', async () => {
      const bad1 = await req(
        'GET',
        '/ocpp-event-template?eventType=station.Connected&channel=html&language=en',
      );
      const bad2 = await req(
        'GET',
        '/ocpp-event-template?eventType=..%2F..%2Fetc.passwd&channel=email&language=en',
      );
      const bad3 = await req('GET', '/ocpp-event-template?eventType=&channel=email&language=en');
      expect(bad1.statusCode).toBe(404);
      expect(bad2.statusCode).toBe(404);
      expect(bad3.statusCode).toBe(404);
      expect(bad1.json().code).toBe('TEMPLATE_NOT_FOUND');
      expect(mockReadFile).not.toHaveBeenCalled();
    });
  });

  describe('GET /notifications filters', () => {
    it('builds search and filter conditions and returns the total', async () => {
      const row = {
        id: 1,
        eventType: 'session.Started',
        channel: 'sms',
        recipient: '+1555',
        status: 'failed',
        metadata: null,
        createdAt: TS.createdAt,
      };
      setupDbResults([row], [{ count: 9 }]);
      const res = await req(
        'GET',
        '/notifications?search=abc&channel=sms&status=failed&eventType=session.Started',
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [row], total: 9 });
      expect(ilikeSpy).toHaveBeenCalledWith('n.recipient', '%abc%');
      expect(ilikeSpy).toHaveBeenCalledWith('n.status', '%abc%');
      expect(eqSpy).toHaveBeenCalledWith('n.channel', 'sms');
      expect(eqSpy).toHaveBeenCalledWith('n.status', 'failed');
      expect(eqSpy).toHaveBeenCalledWith('n.eventType', 'session.Started');
    });
  });

  describe('POST /notifications/test', () => {
    it('rejects an invalid email recipient before reading settings', async () => {
      const res = await req('POST', '/notifications/test', {
        channel: 'email',
        recipient: 'bad',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('recipient must be a valid email address');
      expect(chains).toHaveLength(0);
    });

    it.each([[''], [`${'a'.repeat(250)}@x.io`]])(
      'rejects an empty or over-long email recipient',
      async (recipient) => {
        const res = await req('POST', '/notifications/test', { channel: 'email', recipient });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_ERROR');
        expect(chains).toHaveLength(0);
      },
    );

    it('rejects an invalid phone recipient', async () => {
      const res = await req('POST', '/notifications/test', { channel: 'sms', recipient: 'abc' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('recipient must be a valid phone number');
    });

    it('sends a test email with decrypted SMTP credentials on port 465', async () => {
      setupDbResults([
        { key: 'smtp.host', value: 'smtp.example.com' },
        { key: 'smtp.port', value: 465 },
        { key: 'smtp.username', value: 'mailer' },
        { key: 'smtp.passwordEnc', value: 'cipher' },
        { key: 'smtp.from', value: 'noreply@example.com' },
      ]);
      const res = await req('POST', '/notifications/test', {
        channel: 'email',
        recipient: 'ops@example.com',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(mockDecrypt).toHaveBeenCalledWith('cipher', originalKey);
      expect(mockCreateTransport).toHaveBeenCalledWith({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        auth: { user: 'mailer', pass: 'plain-secret' },
      });
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'noreply@example.com', to: 'ops@example.com' }),
      );
    });

    it('uses an empty password when decryption fails and no auth without a username', async () => {
      mockDecrypt.mockImplementation(() => {
        throw new Error('bad key');
      });
      setupDbResults([
        { key: 'smtp.host', value: 'smtp.example.com' },
        { key: 'smtp.passwordEnc', value: 'cipher' },
      ]);
      const res = await req('POST', '/notifications/test', {
        channel: 'email',
        recipient: 'ops@example.com',
      });
      expect(res.statusCode).toBe(200);
      expect(mockCreateTransport).toHaveBeenCalledWith({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: undefined,
      });
      expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ from: '' }));
    });

    it('returns 500 EMAIL_SEND_FAILED with the SMTP error message', async () => {
      mockSendMail.mockRejectedValue(new Error('535 auth failed'));
      setupDbResults([{ key: 'smtp.host', value: 'smtp.example.com' }]);
      const res = await req('POST', '/notifications/test', {
        channel: 'email',
        recipient: 'ops@example.com',
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: '535 auth failed', code: 'EMAIL_SEND_FAILED' });
    });

    it('returns Unknown error when the SMTP failure is not an Error', async () => {
      mockSendMail.mockRejectedValue('boom');
      setupDbResults([{ key: 'smtp.host', value: 'smtp.example.com' }]);
      const res = await req('POST', '/notifications/test', {
        channel: 'email',
        recipient: 'ops@example.com',
      });
      expect(res.json()).toEqual({ error: 'Unknown error', code: 'EMAIL_SEND_FAILED' });
    });

    it('skips decryption when no encryption key is configured', async () => {
      config.SETTINGS_ENCRYPTION_KEY = '';
      setupDbResults([
        { key: 'smtp.host', value: 'smtp.example.com' },
        { key: 'smtp.username', value: 'mailer' },
        { key: 'smtp.passwordEnc', value: 'cipher' },
      ]);
      const res = await req('POST', '/notifications/test', {
        channel: 'email',
        recipient: 'ops@example.com',
      });
      expect(res.statusCode).toBe(200);
      expect(mockDecrypt).not.toHaveBeenCalled();
      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'mailer', pass: '' } }),
      );
    });

    const twilioSettings = [
      { key: 'twilio.accountSid', value: 'AC123' },
      { key: 'twilio.authTokenEnc', value: 'cipher' },
      { key: 'twilio.fromNumber', value: '+15550001111' },
    ];

    it('posts the SMS to Twilio with basic auth from the decrypted token', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
      vi.stubGlobal('fetch', fetchMock);
      setupDbResults(twilioSettings);
      const res = await req('POST', '/notifications/test', {
        channel: 'sms',
        recipient: '+1 555 123 4567',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string }];
      expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        `Basic ${Buffer.from('AC123:plain-secret').toString('base64')}`,
      );
      const params = new URLSearchParams(init.body);
      expect(params.get('To')).toBe('+1 555 123 4567');
      expect(params.get('From')).toBe('+15550001111');
    });

    it('returns 500 SMS_SEND_FAILED with the Twilio response text', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('invalid To') }),
      );
      mockDecrypt.mockImplementation(() => {
        throw new Error('bad');
      });
      setupDbResults(twilioSettings);
      const res = await req('POST', '/notifications/test', {
        channel: 'sms',
        recipient: '+15551234567',
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'invalid To', code: 'SMS_SEND_FAILED' });
    });

    it('returns 500 SMS_SEND_FAILED when the request throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
      setupDbResults([{ key: 'twilio.accountSid', value: 'AC1' }]);
      const res = await req('POST', '/notifications/test', {
        channel: 'sms',
        recipient: '+15551234567',
      });
      expect(res.json()).toEqual({ error: 'timeout', code: 'SMS_SEND_FAILED' });
    });

    it('returns Unknown error when the SMS failure is not an Error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(42));
      setupDbResults([{ key: 'twilio.accountSid', value: 'AC1' }]);
      const res = await req('POST', '/notifications/test', {
        channel: 'sms',
        recipient: '+15551234567',
      });
      expect(res.json()).toEqual({ error: 'Unknown error', code: 'SMS_SEND_FAILED' });
    });
  });

  describe('system event settings (removed)', () => {
    it('no longer serves GET or PUT /system-event-settings', async () => {
      const getRes = await req('GET', '/system-event-settings');
      expect(getRes.statusCode).toBe(404);
      const putRes = await req('PUT', '/system-event-settings', {
        eventType: 'site.PayoutOnboarding',
      });
      expect(putRes.statusCode).toBe(404);
    });
  });

  describe('GET /notification-templates file fallback', () => {
    it('returns the default .hbs body when no DB row exists', async () => {
      setupDbResults([]);
      mockReadFile.mockResolvedValueOnce('<p>file body</p>');
      const res = await req(
        'GET',
        '/notification-templates?eventType=session.Started&channel=sms&language=es',
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        eventType: 'session.Started',
        channel: 'sms',
        language: 'es',
        subject: null,
        bodyHtml: '<p>file body</p>',
        isCustomized: false,
      });
    });
  });
});
