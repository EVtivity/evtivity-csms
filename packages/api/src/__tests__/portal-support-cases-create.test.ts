// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  index: 0,
  inserts: [] as unknown[],
  insertValues: [] as unknown[],
  published: [] as Array<{ channel: string; message: string }>,
  availability: { available: false, perMinute: 2 },
  allowCase: true,
}));

const mocks = vi.hoisted(() => {
  function chain(result: unknown): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'returning', 'leftJoin', 'innerJoin']) {
      c[m] = () => c;
    }
    c['values'] = (v: unknown) => {
      state.insertValues.push(v);
      return c;
    };
    c['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve(result ?? []).then(resolve, reject);
    return c;
  }
  function next(): unknown {
    const r = state.results[state.index];
    state.index++;
    return r;
  }
  return {
    db: {
      select: vi.fn(() => chain(next())),
      insert: vi.fn((table: unknown) => {
        state.inserts.push(table);
        return chain(next());
      }),
      execute: vi.fn(() => Promise.resolve([{ val: '7' }])),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbRef.db)),
    },
    writeAudit: vi.fn(() => Promise.resolve()),
    confirmSupportAttachment: vi.fn(),
  };
});
const dbRef = vi.hoisted((): { db: unknown } => ({ db: null }));
dbRef.db = mocks.db;

vi.mock('@evtivity/database', () => {
  const t = (name: string) =>
    new Proxy<Record<string, unknown>>(
      { __table: name },
      {
        get: (target, prop: string) => target[prop] ?? `${name}.${prop}`,
      },
    );
  return {
    db: mocks.db,
    client: {},
    writeAudit: mocks.writeAudit,
    redactAuditPayload: (value: unknown) => value,
    supportCaseAuditLog: t('supportCaseAuditLog'),
    supportCaseReads: t('supportCaseReads'),
    supportCases: t('supportCases'),
    supportCaseMessages: t('supportCaseMessages'),
    supportCaseAttachments: t('supportCaseAttachments'),
    supportCaseSessions: t('supportCaseSessions'),
    supportCaseStatusEnum: {
      enumValues: ['open', 'in_progress', 'waiting_on_driver', 'resolved', 'closed'] as const,
    },
    supportCaseCategoryEnum: {
      enumValues: [
        'billing_dispute',
        'charging_failure',
        'connector_damage',
        'account_issue',
        'payment_problem',
        'reservation_issue',
        'general_inquiry',
      ] as const,
    },
    supportCasePriorityEnum: { enumValues: ['low', 'medium', 'high', 'urgent'] as const },
    supportCaseMessageSenderEnum: { enumValues: ['driver', 'operator', 'system'] as const },
    chargingSessions: t('chargingSessions'),
    chargingStations: t('chargingStations'),
  };
});

vi.mock('@evtivity/services/support-case-notify', () => ({
  notifySupportCaseEvent: vi.fn(),
  dispatchOperatorNotification: vi.fn(),
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({
    publish: (channel: string, message: string) => {
      state.published.push({ channel, message });
      return Promise.resolve();
    },
  }),
}));
vi.mock('../services/ai/attachments/support-attachments.js', () => ({
  confirmSupportAttachment: mocks.confirmSupportAttachment,
  requestSupportAttachmentUpload: vi.fn(),
  supportAttachmentDownloadUrl: vi.fn(),
}));
vi.mock('../lib/driver-ai-availability.js', () => ({
  readDriverAiAvailability: () => Promise.resolve(state.availability),
}));
vi.mock('../services/ai/engine/limits.js', () => ({
  allowDriverAiCase: () => Promise.resolve(state.allowCase),
}));

import rateLimit from '@fastify/rate-limit';
import { registerAuth } from '../plugins/auth.js';
import { portalSupportCaseRoutes } from '../routes/portal/support-cases.js';

const DRIVER_ID = 'drv_000000000001';
const SESSION_ID = 'ses_000000000001';
const SESSION_STATION = 'sta_000000000001';
const OTHER_STATION = 'sta_000000000002';

describe('POST /portal/support-cases station and session', () => {
  let app: FastifyInstance;
  let auth: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.register(async (instance) => {
      portalSupportCaseRoutes(instance);
    });
    await app.ready();
    auth = `Bearer ${app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.results = [];
    state.index = 0;
    state.inserts = [];
    state.insertValues = [];
    state.published = [];
    state.availability = { available: false, perMinute: 2 };
    state.allowCase = true;
    mocks.writeAudit.mockClear();
  });

  const body = {
    subject: 'Charger stopped',
    description: 'It stopped mid-session',
    category: 'charging_failure',
    sessionId: SESSION_ID,
    stationId: 'CS-0002',
  };

  it('returns 404 STATION_NOT_FOUND when the station differs from the session station', async () => {
    state.results = [
      [{ driverId: DRIVER_ID, stationId: SESSION_STATION }],
      [{ id: OTHER_STATION }],
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/portal/support-cases',
      headers: { authorization: auth },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
    expect(state.inserts).toHaveLength(0);
  });

  it('creates the case when the station matches the session station', async () => {
    state.results = [
      [{ driverId: DRIVER_ID, stationId: SESSION_STATION }],
      [{ id: SESSION_STATION }],
      [
        {
          id: 'cas_000000000001',
          caseNumber: 'CASE-00007',
          subject: body.subject,
          description: body.description,
          status: 'open',
          category: 'charging_failure',
          priority: 'medium',
          createdByDriver: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      [],
      [],
    ];
    const res = await app.inject({
      method: 'POST',
      url: '/portal/support-cases',
      headers: { authorization: auth },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(state.inserts).toHaveLength(3);
    // TC-AI-DR-28: the portal create is audited with the driver as actor.
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'created', actor: 'driver', actorDriverId: DRIVER_ID }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("returns 404 SESSION_NOT_FOUND for another driver's session", async () => {
    state.results = [[{ driverId: 'drv_000000000009', stationId: SESSION_STATION }]];
    const res = await app.inject({
      method: 'POST',
      url: '/portal/support-cases',
      headers: { authorization: auth },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_FOUND');
    expect(state.inserts).toHaveLength(0);
  });
});

describe('POST /portal/support-cases driver AI consent', () => {
  let app: FastifyInstance;
  let auth: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.register(async (instance) => {
      portalSupportCaseRoutes(instance);
    });
    await app.ready();
    auth = `Bearer ${app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.results = [];
    state.index = 0;
    state.inserts = [];
    state.insertValues = [];
    state.published = [];
    state.availability = { available: true, perMinute: 2 };
    state.allowCase = true;
    mocks.writeAudit.mockClear();
  });

  const body = {
    subject: 'No start',
    description: 'It will not start',
    category: 'charging_failure',
  };
  const consent = (decision: 'granted' | 'declined', noticeVersion = 1) => ({
    ...body,
    aiConsent: { decision, noticeVersion, language: 'de' },
  });
  function created(fields: Record<string, unknown>): unknown[] {
    return [
      {
        id: 'cas_000000000001',
        caseNumber: 'CASE-00007',
        subject: body.subject,
        description: body.description,
        status: 'open',
        category: 'charging_failure',
        priority: 'medium',
        createdByDriver: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        aiState: null,
        aiStateReason: null,
        ...fields,
      },
    ];
  }
  function post(payload: unknown) {
    return app.inject({
      method: 'POST',
      url: '/portal/support-cases',
      headers: { authorization: auth },
      payload: payload as Record<string, unknown>,
    });
  }
  const caseValues = (): Record<string, unknown> =>
    state.insertValues[0] as Record<string, unknown>;

  it('TC-AI-DR-07 an outdated notice version answers 409 and writes nothing', async () => {
    const res = await post(consent('granted', 2));
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('DRIVER_AI_NOTICE_OUTDATED');
    expect(state.inserts).toHaveLength(0);
    expect(state.published).toHaveLength(0);
  });

  it('TC-AI-DR-06 granted while the feature is off makes a normal open case without consent', async () => {
    state.availability = { available: false, perMinute: 2 };
    state.results = [created({}), [], []];
    const res = await post(consent('granted'));
    expect(res.statusCode).toBe(200);
    expect(caseValues()).toMatchObject({ status: 'open' });
    expect(caseValues()).not.toHaveProperty('aiConsent');
    expect(state.published).toHaveLength(0);
    expect(res.json<{ ai: unknown }>().ai).toEqual({ state: null, reason: null });
  });

  it('TC-AI-DR-08 a create without aiConsent makes a normal case', async () => {
    state.results = [created({}), [], []];
    const res = await post(body);
    expect(res.statusCode).toBe(200);
    expect(caseValues()).not.toHaveProperty('aiConsent');
    expect(state.published).toHaveLength(0);
  });

  it('TC-AI-DR-04 declined records the consent and publishes nothing', async () => {
    state.results = [created({ aiConsent: 'declined' }), [], []];
    const res = await post(consent('declined'));
    expect(res.statusCode).toBe(200);
    expect(caseValues()).toMatchObject({
      status: 'open',
      aiConsent: 'declined',
      aiConsentLanguage: 'de',
      aiConsentNoticeVersion: 1,
    });
    expect(caseValues()['aiConsentAt']).toBeInstanceOf(Date);
    // The consent audit row is inserted in the case transaction (fail-closed).
    expect(state.insertValues).toContainEqual(
      expect.objectContaining({ action: 'ai_consent_declined', actor: 'driver' }),
    );
    expect(state.published).toHaveLength(0);
  });

  it('TC-AI-DR-05 granted queues the case and publishes one analysis request', async () => {
    state.results = [created({ status: 'ai_assist', aiState: 'queued' }), [], []];
    const res = await post(consent('granted'));
    expect(res.statusCode).toBe(200);
    expect(caseValues()).toMatchObject({
      status: 'ai_assist',
      aiState: 'queued',
      aiConsent: 'granted',
    });
    expect(state.published).toEqual([
      { channel: 'driver_ai_requests', message: JSON.stringify({ caseId: 'cas_000000000001' }) },
    ]);
    expect(res.json<{ ai: unknown }>().ai).toEqual({ state: 'queued', reason: null });
  });

  it('TC-AI-DR-18 over the per-minute limit the case goes to operators as skipped/rate_limited', async () => {
    state.allowCase = false;
    state.results = [
      created({ status: 'open', aiState: 'skipped', aiStateReason: 'rate_limited' }),
      [],
      [],
    ];
    const res = await post(consent('granted'));
    expect(res.statusCode).toBe(200);
    expect(caseValues()).toMatchObject({
      status: 'open',
      aiState: 'skipped',
      aiStateReason: 'rate_limited',
    });
    expect(state.published).toHaveLength(0);
    expect(res.json<{ ai: unknown }>().ai).toEqual({ state: 'skipped', reason: 'rate_limited' });
  });
});

describe('POST /portal/support-cases route rate limit', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
    await registerAuth(app);
    app.register(async (instance) => {
      portalSupportCaseRoutes(instance);
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.results = [];
    state.index = 0;
    state.inserts = [];
    state.insertValues = [];
    state.published = [];
    state.availability = { available: true, perMinute: 2 };
    state.allowCase = true;
  });

  // An outdated notice answers 409 before any write, so each call only counts.
  const outdated = {
    subject: 'No start',
    description: 'It will not start',
    category: 'charging_failure',
    aiConsent: { decision: 'granted', noticeVersion: 99, language: 'en' },
  };
  const post = (driverId: string) =>
    app.inject({
      method: 'POST',
      url: '/portal/support-cases',
      headers: { authorization: `Bearer ${app.jwt.sign({ driverId, type: 'driver' })}` },
      payload: outdated,
    });

  it('TC-AI-DR-05 allows 10 new cases per driver per hour, then answers 429', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post('drv_rate_a')).statusCode, `call ${String(i + 1)}`).toBe(409);
    }
    expect((await post('drv_rate_a')).statusCode).toBe(429);
    // Another driver has its own bucket.
    expect((await post('drv_rate_b')).statusCode).toBe(409);
  });
});

describe('POST /portal/support-cases/:id/messages/:messageId/attachments', () => {
  let app: FastifyInstance;
  let auth: string;
  const CASE_ID = 'cas_000000000001';
  const attachment = {
    id: 5,
    messageId: 3,
    fileName: 'photo.png',
    fileSize: 2048,
    contentType: 'image/png',
    createdAt: new Date('2026-10-13T10:00:00Z'),
  };
  const url = `/portal/support-cases/${CASE_ID}/messages/3/attachments`;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.register(async (instance) => {
      portalSupportCaseRoutes(instance);
    });
    await app.ready();
    auth = `Bearer ${app.jwt.sign({ driverId: DRIVER_ID, type: 'driver' })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // The case is the driver's, the message the driver's own.
    state.results = [[{ driverId: DRIVER_ID }], [{ id: 3 }]];
    state.index = 0;
    mocks.writeAudit.mockClear();
    mocks.confirmSupportAttachment.mockReset();
  });

  it('audits a new attachment with the driver as actor', async () => {
    mocks.confirmSupportAttachment.mockResolvedValue({ attachment, created: true });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: auth },
      payload: { s3Key: 'quarantine/key' },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ idColumn: 'support_case_id' }),
      expect.objectContaining({
        entityId: CASE_ID,
        action: 'attachment_added',
        actor: 'driver',
        actorDriverId: DRIVER_ID,
        after: { messageId: 3, fileName: 'photo.png', fileSize: 2048, contentType: 'image/png' },
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('writes no second row when the same upload is confirmed again', async () => {
    mocks.confirmSupportAttachment.mockResolvedValue({ attachment, created: false });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: auth },
      payload: { s3Key: 'quarantine/key' },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});
