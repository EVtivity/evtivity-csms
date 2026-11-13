// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// POST /v1/portal/support-cases/:id/close: the driver closes the own case
// (resolved); the service owns the change (closeSupportCaseByDriver).

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
    closeSupportCaseByDriver: vi.fn(),
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
  closeSupportCaseByDriver: mocks.closeSupportCaseByDriver,
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

describe('POST /portal/support-cases/:id/close', () => {
  beforeEach(() => {
    mocks.closeSupportCaseByDriver.mockReset();
  });

  it('closes the own case and answers the new status', async () => {
    mocks.closeSupportCaseByDriver.mockResolvedValue({
      outcome: 'closed',
      supportCase: { ...caseRow, status: 'resolved', resolutionSource: 'driver' },
    });
    const res = await req('POST', `/portal/support-cases/${CASE_ID}/close`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: CASE_ID, status: 'resolved', resolutionSource: 'driver' });
    expect(mocks.closeSupportCaseByDriver).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: CASE_ID, driverId: DRIVER_ID }),
    );
  });

  it('answers an already closed case unchanged with 200', async () => {
    mocks.closeSupportCaseByDriver.mockResolvedValue({
      outcome: 'unchanged',
      supportCase: { ...caseRow, status: 'closed', resolutionSource: 'operator' },
    });
    const res = await req('POST', `/portal/support-cases/${CASE_ID}/close`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: CASE_ID, status: 'closed', resolutionSource: 'operator' });
  });

  it("answers another driver's or an unknown case with 404", async () => {
    mocks.closeSupportCaseByDriver.mockResolvedValue({ outcome: 'not_found' });
    const res = await req('POST', `/portal/support-cases/${CASE_ID}/close`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'SUPPORT_CASE_NOT_FOUND' });
  });

  it('takes the driver from the token, never from the body', async () => {
    mocks.closeSupportCaseByDriver.mockResolvedValue({ outcome: 'not_found' });
    await req('POST', `/portal/support-cases/${CASE_ID}/close`, { driverId: OTHER_DRIVER });
    expect(mocks.closeSupportCaseByDriver).toHaveBeenCalledWith(
      expect.objectContaining({ driverId: DRIVER_ID }),
    );
  });

  it('refuses a request without a driver session', async () => {
    const res = await app.inject({ method: 'POST', url: `/portal/support-cases/${CASE_ID}/close` });
    expect(res.statusCode).toBe(401);
    expect(mocks.closeSupportCaseByDriver).not.toHaveBeenCalled();
  });

  it('refuses an operator token', async () => {
    const operator = `Bearer ${app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_1' })}`;
    const res = await app.inject({
      method: 'POST',
      url: `/portal/support-cases/${CASE_ID}/close`,
      headers: { authorization: operator },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    expect(res.statusCode).toBeLessThan(404);
    expect(mocks.closeSupportCaseByDriver).not.toHaveBeenCalled();
  });
});
