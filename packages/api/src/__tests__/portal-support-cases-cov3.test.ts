// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  index: 0,
}));

const mocks = vi.hoisted(() => {
  function chain(result: unknown): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of [
      'select',
      'from',
      'where',
      'leftJoin',
      'innerJoin',
      'orderBy',
      'limit',
      'offset',
    ]) {
      c[m] = () => c;
    }
    c['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve(result ?? []).then(resolve, reject);
    return c;
  }
  return {
    db: {
      select: vi.fn(() => {
        const r = state.results[state.index];
        state.index++;
        return chain(r);
      }),
    },
    addDriverMessage: vi.fn(),
    createSupportCase: vi.fn(),
    recordDriverAiFeedback: vi.fn(),
    recordSupportCaseAttachmentAdded: vi.fn(),
    requestDriverAiAnalysis: vi.fn(),
    requestSupportAttachmentUpload: vi.fn(),
    confirmSupportAttachment: vi.fn(),
    supportAttachmentDownloadUrl: vi.fn(),
    availability: vi.fn(),
    allowCase: vi.fn(),
  };
});

vi.mock('@evtivity/database', () => {
  const t = (name: string) =>
    new Proxy<Record<string, unknown>>(
      { __table: name },
      { get: (target, prop: string) => target[prop] ?? `${name}.${prop}` },
    );
  return {
    db: mocks.db,
    client: {},
    supportCases: t('supportCases'),
    supportCaseMessages: t('supportCaseMessages'),
    supportCaseAttachments: t('supportCaseAttachments'),
    supportCaseSessions: t('supportCaseSessions'),
    supportCaseStatusEnum: {
      enumValues: [
        'open',
        'in_progress',
        'waiting_on_driver',
        'resolved',
        'closed',
        'ai_assist',
      ] as const,
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
    supportCaseMessageSenderEnum: {
      enumValues: ['driver', 'operator', 'system', 'assistant'] as const,
    },
    chargingSessions: t('chargingSessions'),
    chargingStations: t('chargingStations'),
  };
});

vi.mock('@evtivity/services/support-case.service', () => ({
  addDriverMessage: mocks.addDriverMessage,
  createSupportCase: mocks.createSupportCase,
  recordDriverAiFeedback: mocks.recordDriverAiFeedback,
  recordSupportCaseAttachmentAdded: mocks.recordSupportCaseAttachmentAdded,
  requestDriverAiAnalysis: mocks.requestDriverAiAnalysis,
}));
vi.mock('../services/ai/attachments/support-attachments.js', () => ({
  confirmSupportAttachment: mocks.confirmSupportAttachment,
  requestSupportAttachmentUpload: mocks.requestSupportAttachmentUpload,
  supportAttachmentDownloadUrl: mocks.supportAttachmentDownloadUrl,
}));
vi.mock('../lib/driver-ai-availability.js', () => ({
  readDriverAiAvailability: mocks.availability,
}));
vi.mock('../services/ai/engine/limits.js', () => ({
  allowDriverAiCase: mocks.allowCase,
}));

import { registerAuth } from '../plugins/auth.js';
import { portalSupportCaseRoutes } from '../routes/portal/support-cases.js';

const DRIVER_ID = 'drv_000000000001';
const OTHER_DRIVER = 'drv_000000000009';
const CASE_ID = 'cas_000000000001';
const T = new Date('2026-10-13T10:00:00Z');

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
  mocks.availability.mockResolvedValue({ available: true, perMinute: 2 });
  mocks.allowCase.mockResolvedValue(true);
});

function req(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    headers: { authorization: auth },
    ...(payload != null ? { payload } : {}),
  });
}

const caseRow = {
  id: CASE_ID,
  caseNumber: 'CASE-00007',
  subject: 'Stopped',
  description: 'It stopped',
  status: 'open',
  category: 'charging_failure',
  priority: 'medium',
  driverId: DRIVER_ID,
  stationId: 'sta_000000000001',
  stationName: 'CS-0001',
  resolvedAt: null,
  createdAt: T,
  updatedAt: T,
  aiConsent: 'granted',
  aiState: 'awaiting_feedback',
  aiStateReason: 'not-a-reason',
  aiAnsweredAt: T,
  aiFeedbackAt: null,
  aiDriverActions: ['retry_start', 'made_up_code'],
  aiNeedsOperator: false,
  resolutionSource: null,
};

describe('GET /portal/support-cases', () => {
  it('returns the page and the total of the driver cases', async () => {
    const item = {
      id: CASE_ID,
      caseNumber: 'CASE-00007',
      subject: 'Stopped',
      status: 'open',
      category: 'charging_failure',
      priority: 'medium',
      createdAt: T,
      updatedAt: T,
    };
    state.results = [[item], [{ count: 3 }]];
    const res = await req('GET', '/portal/support-cases?page=2&limit=1');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }>; total: number }>();
    expect(body.total).toBe(3);
    expect(body.data.map((d) => d.id)).toEqual([CASE_ID]);
  });

  it('answers a total of 0 when the count returns no row', async () => {
    state.results = [[], []];
    const res = await req('GET', '/portal/support-cases');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], total: 0 });
  });
});

describe('GET /portal/support-cases/:id', () => {
  it('answers 404 for an unknown case', async () => {
    state.results = [[]];
    const res = await req('GET', `/portal/support-cases/${CASE_ID}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Support case not found', code: 'SUPPORT_CASE_NOT_FOUND' });
  });

  it("answers 404 for another driver's case", async () => {
    state.results = [[{ ...caseRow, driverId: OTHER_DRIVER }]];
    const res = await req('GET', `/portal/support-cases/${CASE_ID}`);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SUPPORT_CASE_NOT_FOUND');
    expect(mocks.db.select).toHaveBeenCalledTimes(1);
  });

  it('returns sessions, messages with their attachments and the AI block', async () => {
    state.results = [
      [caseRow],
      [{ id: 'ses_000000000001', transactionId: 'tx-1' }],
      [
        { id: 1, senderType: 'driver', body: 'hello', createdAt: T },
        { id: 2, senderType: 'operator', body: 'reply', createdAt: T },
      ],
      [
        {
          id: 10,
          messageId: 1,
          fileName: 'a.png',
          fileSize: 1,
          contentType: 'image/png',
          createdAt: T,
        },
        {
          id: 11,
          messageId: 1,
          fileName: 'b.png',
          fileSize: 2,
          contentType: 'image/png',
          createdAt: T,
        },
      ],
    ];
    const res = await req('GET', `/portal/support-cases/${CASE_ID}`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      sessions: unknown[];
      messages: Array<{ id: number; attachments: Array<{ id: number }> }>;
      ai: Record<string, unknown>;
      stationName: string;
    }>();
    expect(body.stationName).toBe('CS-0001');
    expect(body.sessions).toEqual([{ id: 'ses_000000000001', transactionId: 'tx-1' }]);
    expect(body.messages.map((m) => [m.id, m.attachments.map((a) => a.id)])).toEqual([
      [1, [10, 11]],
      [2, []],
    ]);
    expect(body.ai).toEqual({
      consent: 'granted',
      state: 'awaiting_feedback',
      reason: null,
      answeredAt: T.toISOString(),
      feedbackAt: null,
      resolutionSource: null,
      driverActions: ['retry_start'],
      needsOperator: false,
    });
  });

  it('reads no attachments when the case has no messages', async () => {
    state.results = [
      [{ ...caseRow, aiDriverActions: null, aiConsent: null, aiState: null }],
      [],
      [],
    ];
    const res = await req('GET', `/portal/support-cases/${CASE_ID}`);
    expect(res.statusCode).toBe(200);
    expect(mocks.db.select).toHaveBeenCalledTimes(3);
    const body = res.json<{ messages: unknown[]; ai: Record<string, unknown> }>();
    expect(body.messages).toEqual([]);
    expect(body.ai).toMatchObject({ consent: null, state: null, driverActions: [] });
  });
});

describe('POST /portal/support-cases', () => {
  const body = { subject: 'No start', description: 'Nothing', category: 'charging_failure' };
  const created = {
    id: CASE_ID,
    caseNumber: 'CASE-00007',
    subject: 'No start',
    status: 'open',
    category: 'charging_failure',
    priority: 'medium',
    createdAt: T,
    updatedAt: T,
    aiState: null,
    aiStateReason: null,
  };

  it('answers 404 SESSION_NOT_FOUND for an unknown session', async () => {
    state.results = [[]];
    const res = await req('POST', '/portal/support-cases', {
      ...body,
      sessionId: 'ses_000000000001',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_FOUND');
    expect(mocks.createSupportCase).not.toHaveBeenCalled();
  });

  it('answers 404 STATION_NOT_FOUND for an unknown station', async () => {
    state.results = [[]];
    const res = await req('POST', '/portal/support-cases', { ...body, stationId: 'CS-9999' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('STATION_NOT_FOUND');
    expect(mocks.createSupportCase).not.toHaveBeenCalled();
  });

  it('stores the session station when no station is sent', async () => {
    state.results = [[{ driverId: DRIVER_ID, stationId: 'sta_000000000005' }]];
    mocks.createSupportCase.mockResolvedValue(created);
    const res = await req('POST', '/portal/support-cases', {
      ...body,
      sessionId: 'ses_000000000001',
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.createSupportCase).toHaveBeenCalledWith(
      expect.objectContaining({
        stationId: 'sta_000000000005',
        sessionIds: ['ses_000000000001'],
        driverId: DRIVER_ID,
        priority: 'medium',
        aiConsent: null,
        aiSkipReason: null,
      }),
    );
    expect(mocks.requestDriverAiAnalysis).not.toHaveBeenCalled();
  });

  it('passes a declined consent without asking the rate limit', async () => {
    mocks.createSupportCase.mockResolvedValue(created);
    const res = await req('POST', '/portal/support-cases', {
      ...body,
      aiConsent: { decision: 'declined', noticeVersion: 1, language: 'en' },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.allowCase).not.toHaveBeenCalled();
    expect(mocks.createSupportCase).toHaveBeenCalledWith(
      expect.objectContaining({
        aiConsent: { decision: 'declined', noticeVersion: 1, language: 'en' },
        aiSkipReason: null,
        stationId: null,
        sessionIds: [],
      }),
    );
    expect(res.json<{ ai: unknown }>().ai).toEqual({ state: null, reason: null });
  });

  it('requests the analysis of a queued case', async () => {
    mocks.createSupportCase.mockResolvedValue({
      ...created,
      status: 'ai_assist',
      aiState: 'queued',
    });
    const res = await req('POST', '/portal/support-cases', {
      ...body,
      aiConsent: { decision: 'granted', noticeVersion: 1, language: 'en' },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.allowCase).toHaveBeenCalledWith(DRIVER_ID, 2);
    expect(mocks.requestDriverAiAnalysis).toHaveBeenCalledWith(CASE_ID, expect.anything());
  });
});

describe('POST /portal/support-cases/:id/messages', () => {
  const url = `/portal/support-cases/${CASE_ID}/messages`;

  it('answers 404 for an unknown case', async () => {
    state.results = [[]];
    const res = await req('POST', url, { body: 'hi' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SUPPORT_CASE_NOT_FOUND');
    expect(mocks.addDriverMessage).not.toHaveBeenCalled();
  });

  it("answers 404 for another driver's case", async () => {
    state.results = [[{ id: CASE_ID, driverId: OTHER_DRIVER }]];
    const res = await req('POST', url, { body: 'hi' });
    expect(res.statusCode).toBe(404);
    expect(mocks.addDriverMessage).not.toHaveBeenCalled();
  });

  it('adds the driver message through the service', async () => {
    const supportCase = { id: CASE_ID, driverId: DRIVER_ID };
    state.results = [[supportCase]];
    mocks.addDriverMessage.mockResolvedValue({
      id: 4,
      caseId: CASE_ID,
      senderType: 'driver',
      senderId: DRIVER_ID,
      body: 'hi',
      isInternal: false,
      createdAt: T,
    });
    const res = await req('POST', url, { body: 'hi' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: number }>().id).toBe(4);
    expect(mocks.addDriverMessage).toHaveBeenCalledWith(
      expect.objectContaining({ supportCase, driverId: DRIVER_ID, body: 'hi' }),
    );
  });
});

describe('POST /portal/support-cases/:id/ai-feedback', () => {
  const url = `/portal/support-cases/${CASE_ID}/ai-feedback`;

  it("answers 404 for another driver's case", async () => {
    state.results = [[{ driverId: OTHER_DRIVER }]];
    const res = await req('POST', url, { satisfied: true });
    expect(res.statusCode).toBe(404);
    expect(mocks.recordDriverAiFeedback).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown case', async () => {
    state.results = [[]];
    const res = await req('POST', url, { satisfied: true });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SUPPORT_CASE_NOT_FOUND');
  });

  it('answers 409 when the case is not waiting for feedback', async () => {
    state.results = [[{ driverId: DRIVER_ID }]];
    mocks.recordDriverAiFeedback.mockResolvedValue('not_awaiting');
    const res = await req('POST', url, { satisfied: false });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('SUPPORT_CASE_AI_NOT_AWAITING_FEEDBACK');
    expect(mocks.db.select).toHaveBeenCalledTimes(1);
  });

  it('answers 404 when the case is gone after the feedback', async () => {
    state.results = [[{ driverId: DRIVER_ID }], []];
    mocks.recordDriverAiFeedback.mockResolvedValue('recorded');
    const res = await req('POST', url, { satisfied: true });
    expect(res.statusCode).toBe(404);
  });

  it('returns the case status and AI block after the feedback', async () => {
    state.results = [
      [{ driverId: DRIVER_ID }],
      [
        {
          id: CASE_ID,
          status: 'resolved',
          aiConsent: 'granted',
          aiState: 'resolved',
          aiStateReason: null,
          aiAnsweredAt: T,
          aiFeedbackAt: T,
          aiDriverActions: [],
          aiNeedsOperator: null,
          resolutionSource: 'ai',
        },
      ],
    ];
    mocks.recordDriverAiFeedback.mockResolvedValue('recorded');
    const res = await req('POST', url, { satisfied: true });
    expect(res.statusCode).toBe(200);
    expect(mocks.recordDriverAiFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: CASE_ID, driverId: DRIVER_ID, satisfied: true }),
    );
    const body = res.json<{ id: string; status: string; ai: Record<string, unknown> }>();
    expect(body.status).toBe('resolved');
    expect(body.ai).toMatchObject({
      resolutionSource: 'ai',
      feedbackAt: T.toISOString(),
      needsOperator: null,
    });
  });
});

describe('POST /portal/support-cases/:id/messages/:messageId/attachments/upload-url', () => {
  const url = `/portal/support-cases/${CASE_ID}/messages/3/attachments/upload-url`;
  const payload = { fileName: 'a.png', contentType: 'image/png', fileSize: 10 };

  it("answers 404 for another driver's case", async () => {
    state.results = [[{ driverId: OTHER_DRIVER }]];
    const res = await req('POST', url, payload);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SUPPORT_CASE_NOT_FOUND');
  });

  it('answers 404 MESSAGE_NOT_FOUND when the message is not the driver own', async () => {
    state.results = [[{ driverId: DRIVER_ID }], []];
    const res = await req('POST', url, payload);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MESSAGE_NOT_FOUND');
    expect(mocks.requestSupportAttachmentUpload).not.toHaveBeenCalled();
  });

  it('returns the upload target from the service', async () => {
    state.results = [[{ driverId: DRIVER_ID }], [{ id: 3 }]];
    mocks.requestSupportAttachmentUpload.mockResolvedValue({
      uploadUrl: 'https://s3.example/upload',
      uploadMethod: 'POST',
      fields: {},
      uploadHeaders: {},
      s3Key: 'quarantine/k',
      expiresAt: T,
    });
    const res = await req('POST', url, payload);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ s3Key: string }>().s3Key).toBe('quarantine/k');
    expect(mocks.requestSupportAttachmentUpload).toHaveBeenCalledWith(CASE_ID, 3, payload);
  });
});

describe('POST /portal/support-cases/:id/messages/:messageId/attachments', () => {
  const url = `/portal/support-cases/${CASE_ID}/messages/3/attachments`;

  it('answers 404 for an unknown case', async () => {
    state.results = [[]];
    const res = await req('POST', url, { s3Key: 'k' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SUPPORT_CASE_NOT_FOUND');
  });

  it('answers 404 MESSAGE_NOT_FOUND for a message that is not the driver own', async () => {
    state.results = [[{ driverId: DRIVER_ID }], []];
    const res = await req('POST', url, { s3Key: 'k' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MESSAGE_NOT_FOUND');
    expect(mocks.confirmSupportAttachment).not.toHaveBeenCalled();
  });
});

describe('GET .../attachments/:attachmentId/download-url', () => {
  const url = `/portal/support-cases/${CASE_ID}/messages/3/attachments/5/download-url`;

  it("answers 404 for another driver's case", async () => {
    state.results = [[{ driverId: OTHER_DRIVER }]];
    const res = await req('GET', url);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('SUPPORT_CASE_NOT_FOUND');
  });

  it('answers 404 MESSAGE_NOT_FOUND for an internal message', async () => {
    state.results = [[{ driverId: DRIVER_ID }], [{ isInternal: true }]];
    const res = await req('GET', url);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MESSAGE_NOT_FOUND');
  });

  it('answers 404 MESSAGE_NOT_FOUND for an unknown message', async () => {
    state.results = [[{ driverId: DRIVER_ID }], []];
    const res = await req('GET', url);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MESSAGE_NOT_FOUND');
  });

  it('answers 404 ATTACHMENT_NOT_FOUND for an unknown attachment', async () => {
    state.results = [[{ driverId: DRIVER_ID }], [{ isInternal: false }], []];
    const res = await req('GET', url);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('ATTACHMENT_NOT_FOUND');
    expect(mocks.supportAttachmentDownloadUrl).not.toHaveBeenCalled();
  });

  it('returns the presigned download URL', async () => {
    const attachment = { id: 5, messageId: 3, s3Key: 'clean/k' };
    state.results = [[{ driverId: DRIVER_ID }], [{ isInternal: false }], [attachment]];
    mocks.supportAttachmentDownloadUrl.mockResolvedValue('https://s3.example/get');
    const res = await req('GET', url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ downloadUrl: 'https://s3.example/get' });
    expect(mocks.supportAttachmentDownloadUrl).toHaveBeenCalledWith(attachment);
  });
});
