// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';

// --- DB mock: every db.select/insert/update/delete call takes the next queued
// result at creation time and records the chain methods it received. ---

interface DbCall {
  op: 'select' | 'insert' | 'update' | 'delete';
  table: unknown;
  methods: Record<string, unknown[][]>;
}

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  index: 0,
  calls: [] as Array<{
    op: 'select' | 'insert' | 'update' | 'delete';
    table: unknown;
    methods: Record<string, unknown[][]>;
  }>,
}));

function queue(...results: unknown[]): void {
  state.results = results;
  state.index = 0;
}

const mocks = vi.hoisted(() => {
  function makeChain(op: 'select' | 'insert' | 'update' | 'delete', table: unknown) {
    const entry = {
      op,
      table,
      methods: {} as Record<string, unknown[][]>,
    };
    state.calls.push(entry);
    const result = state.results[state.index];
    state.index++;
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
      'onConflictDoNothing',
    ];
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        if (m === 'from' && entry.table === undefined) entry.table = args[0];
        (entry.methods[m] ??= []).push(args);
        return chain;
      };
    }
    chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
      if (result instanceof Error) return Promise.reject(result).then(resolve, reject);
      return Promise.resolve(result ?? []).then(resolve, reject);
    };
    return chain;
  }
  return {
    db: {
      select: vi.fn(() => makeChain('select', undefined)),
      insert: vi.fn((t: unknown) => makeChain('insert', t)),
      update: vi.fn((t: unknown) => makeChain('update', t)),
      delete: vi.fn((t: unknown) => makeChain('delete', t)),
      execute: vi.fn(),
    },
    writeAudit: vi.fn(),
    dispatchDriverNotification: vi.fn(),
    notifySupportCaseEvent: vi.fn(),
    getUserSiteIds: vi.fn(),
    getS3Config: vi.fn(),
    generateUploadUrl: vi.fn(),
    generateDownloadUrl: vi.fn(),
    deleteObject: vi.fn(),
    buildS3Key: vi.fn(),
    refundPaymentRecord: vi.fn(),
    handleSupportAiAssist: vi.fn(),
    eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
    ilike: vi.fn((a: unknown, b: unknown) => ({ ilike: [a, b] })),
    inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  };
});

vi.mock('@evtivity/database', () => {
  const t = (name: string, cols: string[]) => {
    const o: Record<string, string> = { __table: name };
    for (const c of cols) o[c] = `${name}.${c}`;
    return o;
  };
  return {
    db: mocks.db,
    client: { __client: true },
    writeAudit: mocks.writeAudit,
    supportCaseAuditLog: { __table: 'supportCaseAuditLog' },
    supportCases: t('supportCases', [
      'id',
      'caseNumber',
      'subject',
      'status',
      'category',
      'priority',
      'assignedTo',
      'driverId',
      'stationId',
      'createdAt',
    ]),
    supportCaseMessages: t('supportCaseMessages', ['id', 'caseId', 'senderType', 'createdAt']),
    supportCaseAttachments: t('supportCaseAttachments', ['id', 'messageId', 's3Key', 's3Bucket']),
    supportCaseSessions: t('supportCaseSessions', ['caseId', 'sessionId']),
    supportCaseReads: t('supportCaseReads', ['userId', 'caseId', 'lastReadAt']),
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
    drivers: t('drivers', ['id', 'firstName', 'lastName', 'email']),
    users: t('users', ['id', 'firstName', 'lastName']),
    chargingSessions: t('chargingSessions', ['id', 'stationId', 'transactionId']),
    chargingStations: t('chargingStations', ['id', 'siteId', 'stationId']),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: mocks.eq,
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  ilike: mocks.ilike,
  sql: vi.fn(() => 'sql'),
  desc: vi.fn(),
  count: vi.fn(),
  inArray: mocks.inArray,
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
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('@evtivity/lib', () => ({
  dispatchDriverNotification: mocks.dispatchDriverNotification,
  formatCurrencyAmount: (cents: number, currency: string) =>
    `${(cents / 100).toFixed(2)} ${currency}`,
  notificationMoney: (cents: number, currency: string) => `money:${String(cents)}:${currency}`,
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: vi.fn(() => ({ __pubsub: true })),
  setPubSub: vi.fn(),
}));

vi.mock('../lib/support-case-events.js', () => ({
  notifySupportCaseEvent: mocks.notifySupportCaseEvent,
}));

vi.mock('../services/s3.service.js', () => ({
  getS3Config: mocks.getS3Config,
  generateUploadUrl: mocks.generateUploadUrl,
  generateDownloadUrl: mocks.generateDownloadUrl,
  deleteObject: mocks.deleteObject,
  buildS3Key: mocks.buildS3Key,
}));

vi.mock('@evtivity/payments', () => ({
  refundPaymentRecord: mocks.refundPaymentRecord,
}));

vi.mock('../lib/payments.js', () => ({
  paymentContext: vi.fn(() => ({ __ctx: true })),
}));

vi.mock('../lib/site-access.js', () => ({
  getUserSiteIds: mocks.getUserSiteIds,
  invalidateSiteAccessCache: vi.fn(),
}));

vi.mock('../services/ai/support-assist.service.js', () => ({
  handleSupportAiAssist: mocks.handleSupportAiAssist,
}));

import { registerAuth } from '../plugins/auth.js';
import { supportCaseRoutes } from '../routes/support-cases.js';

const USER_ID = 'usr_000000000001';
const ROLE_ID = 'rol_000000000001';
const CASE_ID = 'cas_000000000001';
const DRIVER_ID = 'drv_000000000001';
const STATION_ID = 'sta_000000000001';
const SESSION_ID = 'ses_000000000001';
const SESSION_ID_2 = 'ses_000000000002';
const ASSIGNEE_ID = 'usr_000000000002';
const NOW = '2026-01-01T00:00:00.000Z';

const S3 = { bucket: 'evtivity-bucket', region: 'us-east-1' };

function baseCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CASE_ID,
    caseNumber: 'CASE-00001',
    subject: 'Charger broken',
    description: 'It does not start',
    status: 'open',
    category: 'charging_failure',
    priority: 'medium',
    driverId: DRIVER_ID,
    stationId: null,
    assignedTo: null,
    createdByDriver: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function detailCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseCase(overrides),
    driverName: null,
    driverEmail: null,
    stationName: null,
    assignedToName: null,
    resolvedAt: null,
    closedAt: null,
  };
}

function paymentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pay_1',
    sessionId: SESSION_ID,
    driverId: DRIVER_ID,
    status: 'refunded',
    currency: 'USD',
    capturedAmountCents: 1500,
    refundedAmountCents: 1500,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app);
  await app.register(cookie);
  app.register(async (instance) => {
    supportCaseRoutes(instance);
  });
  await app.ready();
  return app;
}

function callsOf(op: DbCall['op'], tableName?: string): DbCall[] {
  return state.calls.filter(
    (c) =>
      c.op === op &&
      (tableName == null || (c.table as { __table?: string } | undefined)?.__table === tableName),
  );
}

function firstArg(call: DbCall | undefined, method: string): unknown {
  return call?.methods[method]?.[0]?.[0];
}

function auditActions(): string[] {
  return mocks.writeAudit.mock.calls.map((c) => (c[1] as { action: string }).action);
}

describe('support case routes', () => {
  let app: FastifyInstance;
  let auth: string;

  beforeAll(async () => {
    app = await buildApp();
    auth = `Bearer ${app.jwt.sign({ userId: USER_ID, roleId: ROLE_ID })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    state.calls = [];
    queue();
    mocks.getUserSiteIds.mockReset().mockResolvedValue(null);
    mocks.getS3Config.mockReset().mockResolvedValue(S3);
    mocks.writeAudit.mockReset().mockResolvedValue(undefined);
    mocks.dispatchDriverNotification.mockReset().mockResolvedValue(undefined);
    mocks.notifySupportCaseEvent.mockReset().mockResolvedValue(undefined);
    mocks.db.execute.mockReset().mockResolvedValue([{ val: '42' }]);
    mocks.refundPaymentRecord.mockReset();
    mocks.handleSupportAiAssist.mockReset();
    mocks.generateUploadUrl.mockReset().mockResolvedValue('https://s3/upload');
    mocks.generateDownloadUrl.mockReset().mockResolvedValue('https://s3/download');
    mocks.deleteObject.mockReset().mockResolvedValue(undefined);
    mocks.buildS3Key
      .mockReset()
      .mockImplementation(
        (caseId: string, messageId: number, fileId: string, name: string) =>
          `support-cases/${caseId}/${String(messageId)}/${fileId}/${name}`,
      );
  });

  function inject(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: auth },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  }

  // ---------------------------------------------------------------- list
  describe('GET /support-cases', () => {
    it('applies status, category, priority, assignee and search filters with pagination', async () => {
      queue(
        [{ ...baseCase(), driverName: 'A B', assignedToName: null, isRead: true }],
        [{ count: 7 }],
      );

      const res = await inject(
        'GET',
        `/support-cases?page=2&limit=5&status=open&category=billing_dispute&priority=high&assignedTo=${ASSIGNEE_ID}&search=CASE-1`,
      );

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Array<{ id: string }>; total: number }>();
      expect(body.total).toBe(7);
      expect(body.data[0]?.id).toBe(CASE_ID);
      expect(mocks.eq).toHaveBeenCalledWith('supportCases.status', 'open');
      expect(mocks.eq).toHaveBeenCalledWith('supportCases.category', 'billing_dispute');
      expect(mocks.eq).toHaveBeenCalledWith('supportCases.priority', 'high');
      expect(mocks.eq).toHaveBeenCalledWith('supportCases.assignedTo', ASSIGNEE_ID);
      expect(mocks.ilike).toHaveBeenCalledWith('supportCases.subject', '%CASE-1%');
      expect(mocks.ilike).toHaveBeenCalledWith('supportCases.caseNumber', '%CASE-1%');
      const dataQuery = state.calls[0];
      expect(firstArg(dataQuery, 'limit')).toBe(5);
      expect(firstArg(dataQuery, 'offset')).toBe(5);
    });

    it('returns total 0 when the count query yields no row and applies no filters', async () => {
      queue([], []);
      const res = await inject('GET', '/support-cases');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(mocks.eq).not.toHaveBeenCalledWith('supportCases.status', expect.anything());
      expect(mocks.ilike).not.toHaveBeenCalled();
      expect(firstArg(state.calls[0], 'where')).toBeUndefined();
    });

    it('restricts to the accessible sites when the operator has site limits', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a', 'sit_b']);
      queue([], [{ count: 0 }]);
      const res = await inject('GET', '/support-cases');
      expect(res.statusCode).toBe(200);
      expect(mocks.inArray).toHaveBeenCalledWith('sql', ['sit_a', 'sit_b']);
      expect(firstArg(state.calls[0], 'where')).toBeDefined();
    });

    it('limits to station-less cases when the operator has no sites', async () => {
      mocks.getUserSiteIds.mockResolvedValue([]);
      queue([], [{ count: 0 }]);
      const res = await inject('GET', '/support-cases');
      expect(res.statusCode).toBe(200);
      expect(mocks.inArray).not.toHaveBeenCalled();
      expect(firstArg(state.calls[0], 'where')).toEqual({ and: ['sql'] });
    });

    it('rejects an invalid status filter', async () => {
      const res = await inject('GET', '/support-cases?status=bogus');
      expect(res.statusCode).toBe(400);
      expect(state.calls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- unread
  describe('GET /support-cases/unread-count', () => {
    it('counts only cases assigned to the current operator, filtered by site', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([{ count: 4 }]);
      const res = await inject('GET', '/support-cases/unread-count');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ count: 4 });
      expect(mocks.eq).toHaveBeenCalledWith('supportCases.assignedTo', USER_ID);
      expect(mocks.inArray).toHaveBeenCalledWith('sql', ['sit_a']);
    });

    it('returns 0 for an operator with no sites and no rows', async () => {
      mocks.getUserSiteIds.mockResolvedValue([]);
      queue([]);
      const res = await inject('GET', '/support-cases/unread-count');
      expect(res.json()).toEqual({ count: 0 });
      const where = firstArg(state.calls[0], 'where') as { and: unknown[] };
      expect(where.and).toHaveLength(4);
    });
  });

  // ------------------------------------------------------ attachment storage
  describe('GET /support-cases/attachment-storage', () => {
    it('answers configured when an S3 configuration resolves', async () => {
      const res = await inject('GET', '/support-cases/attachment-storage');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ configured: true });
    });

    it('answers not configured without an S3 configuration', async () => {
      mocks.getS3Config.mockResolvedValue(null);
      const res = await inject('GET', '/support-cases/attachment-storage');
      expect(res.json()).toEqual({ configured: false });
    });

    it('answers not configured when the configuration cannot be read', async () => {
      mocks.getS3Config.mockRejectedValue(new Error('SETTINGS_ENCRYPTION_KEY is required'));
      const res = await inject('GET', '/support-cases/attachment-storage');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ configured: false });
    });
  });

  // ---------------------------------------------------------------- detail
  describe('GET /support-cases/:id', () => {
    it('returns 404 when the case does not exist', async () => {
      queue([]);
      const res = await inject('GET', `/support-cases/${CASE_ID}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: 'Support case not found',
        code: 'SUPPORT_CASE_NOT_FOUND',
      });
    });

    it('returns 404 when the case station is on a site the operator cannot access', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([baseCase({ stationId: STATION_ID })], [{ siteId: 'sit_other' }]);
      const res = await inject('GET', `/support-cases/${CASE_ID}`);
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SUPPORT_CASE_NOT_FOUND');
      expect(mocks.eq).toHaveBeenCalledWith('chargingStations.id', STATION_ID);
      // No session/message queries after the access denial.
      expect(state.calls).toHaveLength(2);
    });

    it('returns 404 for a station-linked case when the operator has no sites', async () => {
      mocks.getUserSiteIds.mockResolvedValue([]);
      queue([baseCase({ stationId: STATION_ID })]);
      const res = await inject('GET', `/support-cases/${CASE_ID}`);
      expect(res.statusCode).toBe(404);
      expect(state.calls).toHaveLength(1);
    });

    it('returns the case with sessions and messages, grouping attachments per message', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue(
        [
          {
            ...baseCase({ stationId: STATION_ID }),
            driverName: 'Jane Doe',
            driverEmail: 'jane@example.com',
            stationName: 'CS-1',
            assignedToName: null,
            resolvedAt: null,
            closedAt: null,
          },
        ],
        [{ siteId: 'sit_a' }],
        [{ id: SESSION_ID, transactionId: 'tx-1', stationName: 'CS-1', driverName: 'Jane Doe' }],
        [
          {
            id: 1,
            senderType: 'driver',
            senderId: DRIVER_ID,
            body: 'help',
            isInternal: false,
            createdAt: NOW,
          },
          {
            id: 2,
            senderType: 'operator',
            senderId: USER_ID,
            body: 'on it',
            isInternal: false,
            createdAt: NOW,
          },
        ],
        [
          {
            id: 10,
            messageId: 1,
            fileName: 'a.png',
            fileSize: 10,
            contentType: 'image/png',
            createdAt: NOW,
          },
          {
            id: 11,
            messageId: 1,
            fileName: 'b.png',
            fileSize: 20,
            contentType: 'image/png',
            createdAt: NOW,
          },
        ],
      );

      const res = await inject('GET', `/support-cases/${CASE_ID}`);

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        driverEmail: string;
        sessions: Array<{ id: string; transactionId: string }>;
        messages: Array<{ id: number; attachments: Array<{ id: number }> }>;
      }>();
      expect(body.driverEmail).toBe('jane@example.com');
      expect(body.sessions).toEqual([
        expect.objectContaining({ id: SESSION_ID, transactionId: 'tx-1' }),
      ]);
      expect(body.messages.map((m) => m.attachments.map((a) => a.id))).toEqual([[10, 11], []]);
      expect(mocks.inArray).toHaveBeenCalledWith('supportCaseAttachments.messageId', [1, 2]);
    });

    it('skips the attachment query when the case has no messages', async () => {
      queue([detailCase()], [], []);
      const res = await inject('GET', `/support-cases/${CASE_ID}`);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ messages: unknown[] }>().messages).toEqual([]);
      expect(state.calls).toHaveLength(3);
    });

    it('treats a case whose station no longer exists as accessible', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([detailCase({ stationId: STATION_ID })], [], [], []);
      const res = await inject('GET', `/support-cases/${CASE_ID}`);
      expect(res.statusCode).toBe(200);
    });

    it('treats a station without a site as accessible', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([detailCase({ stationId: STATION_ID })], [{ siteId: null }], [], []);
      const res = await inject('GET', `/support-cases/${CASE_ID}`);
      expect(res.statusCode).toBe(200);
    });

    it('rejects a malformed case id', async () => {
      const res = await inject('GET', '/support-cases/not-an-id');
      expect(res.statusCode).toBe(400);
      expect(state.calls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- read
  describe('POST /support-cases/:id/read', () => {
    it('returns 404 when the case does not exist', async () => {
      queue([]);
      const res = await inject('POST', `/support-cases/${CASE_ID}/read`);
      expect(res.statusCode).toBe(404);
      expect(callsOf('insert')).toHaveLength(0);
    });

    it('returns 404 when the case is on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([{ stationId: STATION_ID }], [{ siteId: 'sit_b' }]);
      const res = await inject('POST', `/support-cases/${CASE_ID}/read`);
      expect(res.statusCode).toBe(404);
      expect(callsOf('insert')).toHaveLength(0);
    });

    it('upserts the read marker for the operator', async () => {
      queue([{ stationId: null }], []);
      const res = await inject('POST', `/support-cases/${CASE_ID}/read`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      const insert = callsOf('insert', 'supportCaseReads')[0];
      expect(firstArg(insert, 'values')).toEqual(
        expect.objectContaining({ userId: USER_ID, caseId: CASE_ID, lastReadAt: expect.any(Date) }),
      );
      expect(firstArg(insert, 'onConflictDoUpdate')).toEqual(
        expect.objectContaining({
          target: ['supportCaseReads.userId', 'supportCaseReads.caseId'],
        }),
      );
    });
  });

  // ---------------------------------------------------------------- create
  describe('POST /support-cases', () => {
    const validBody = {
      subject: 'Overcharged',
      description: 'I was charged twice',
      category: 'billing_dispute',
    };

    it('creates a case with linked sessions, notifies the driver and writes audits', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      const created = baseCase({
        caseNumber: 'CASE-00042',
        subject: 'Overcharged',
        category: 'billing_dispute',
        stationId: STATION_ID,
      });
      queue(
        [{ siteId: 'sit_a' }], // station access
        [{ sessionId: SESSION_ID, siteId: 'sit_a' }], // session sites
        [created], // insert case
        [], // insert sessions
        [], // insert message
      );

      const res = await inject('POST', '/support-cases', {
        ...validBody,
        priority: 'high',
        driverId: DRIVER_ID,
        stationId: STATION_ID,
        sessionIds: [SESSION_ID],
        assignedTo: ASSIGNEE_ID,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ caseNumber: string }>().caseNumber).toBe('CASE-00042');

      const caseInsert = callsOf('insert', 'supportCases')[0];
      expect(firstArg(caseInsert, 'values')).toEqual({
        caseNumber: 'CASE-00042',
        subject: 'Overcharged',
        description: 'I was charged twice',
        category: 'billing_dispute',
        priority: 'high',
        driverId: DRIVER_ID,
        stationId: STATION_ID,
        assignedTo: ASSIGNEE_ID,
        createdByDriver: false,
      });
      expect(firstArg(callsOf('insert', 'supportCaseSessions')[0], 'values')).toEqual([
        { caseId: CASE_ID, sessionId: SESSION_ID },
      ]);
      expect(firstArg(callsOf('insert', 'supportCaseMessages')[0], 'values')).toEqual({
        caseId: CASE_ID,
        senderType: 'operator',
        senderId: USER_ID,
        body: 'I was charged twice',
        isInternal: false,
      });
      expect(mocks.dispatchDriverNotification).toHaveBeenCalledWith(
        { __client: true },
        'supportCase.Created',
        DRIVER_ID,
        { caseNumber: 'CASE-00042', subject: 'Overcharged', category: 'billing_dispute' },
        expect.anything(),
        { __pubsub: true },
      );
      expect(mocks.notifySupportCaseEvent).toHaveBeenCalledWith(
        'supportCase.created',
        CASE_ID,
        DRIVER_ID,
      );
      expect(auditActions()).toEqual(['created', 'sessions_linked']);
      expect(mocks.writeAudit.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({ after: { sessionIds: [SESSION_ID] }, actorUserId: USER_ID }),
      );
    });

    it('defaults priority to medium and skips notifications without a driver', async () => {
      mocks.db.execute.mockResolvedValue([]);
      queue([baseCase({ driverId: null, caseNumber: 'CASE-00001' })], []);

      const res = await inject('POST', '/support-cases', validBody);

      expect(res.statusCode).toBe(200);
      expect(firstArg(callsOf('insert', 'supportCases')[0], 'values')).toEqual(
        expect.objectContaining({
          caseNumber: 'CASE-00001',
          priority: 'medium',
          driverId: null,
          stationId: null,
          assignedTo: null,
        }),
      );
      expect(callsOf('insert', 'supportCaseSessions')).toHaveLength(0);
      expect(mocks.dispatchDriverNotification).not.toHaveBeenCalled();
      expect(mocks.notifySupportCaseEvent).toHaveBeenCalledWith(
        'supportCase.created',
        CASE_ID,
        null,
      );
      expect(auditActions()).toEqual(['created']);
    });

    it('returns 404 STATION_NOT_FOUND for a station on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([{ siteId: 'sit_b' }]);
      const res = await inject('POST', '/support-cases', { ...validBody, stationId: STATION_ID });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Station not found', code: 'STATION_NOT_FOUND' });
      expect(callsOf('insert')).toHaveLength(0);
    });

    it('returns 404 SESSION_NOT_FOUND when a linked session is on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([
        { sessionId: SESSION_ID, siteId: 'sit_a' },
        { sessionId: SESSION_ID_2, siteId: 'sit_b' },
      ]);
      const res = await inject('POST', '/support-cases', {
        ...validBody,
        sessionIds: [SESSION_ID, SESSION_ID_2],
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      expect(callsOf('insert')).toHaveLength(0);
      expect(mocks.db.execute).not.toHaveBeenCalled();
    });

    it('skips the session site check for an unrestricted operator', async () => {
      queue([baseCase()], [], []);
      const res = await inject('POST', '/support-cases', {
        ...validBody,
        sessionIds: [SESSION_ID],
      });
      expect(res.statusCode).toBe(200);
      expect(callsOf('select')).toHaveLength(0);
      expect(callsOf('insert', 'supportCaseSessions')).toHaveLength(1);
    });

    it('returns 500 when the insert returns no row', async () => {
      queue([]);
      const res = await inject('POST', '/support-cases', validBody);
      expect(res.statusCode).toBe(500);
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });

    it('rejects a body without a category', async () => {
      const res = await inject('POST', '/support-cases', { subject: 'x', description: 'y' });
      expect(res.statusCode).toBe(400);
      expect(state.calls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- update
  describe('PATCH /support-cases/:id', () => {
    it('returns 404 when the case does not exist', async () => {
      queue([]);
      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, { status: 'closed' });
      expect(res.statusCode).toBe(404);
      expect(callsOf('update')).toHaveLength(0);
    });

    it('returns 404 when the case is on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue([]);
      queue([baseCase({ stationId: STATION_ID })]);
      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, { status: 'closed' });
      expect(res.statusCode).toBe(404);
      expect(callsOf('update')).toHaveLength(0);
    });

    it('resolves a case: sets resolvedAt, posts system messages, notifies and audits', async () => {
      const existing = baseCase();
      const updated = baseCase({
        status: 'resolved',
        priority: 'urgent',
        category: 'general_inquiry',
      });
      queue([existing], [updated], []);

      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, {
        status: 'resolved',
        priority: 'urgent',
        category: 'general_inquiry',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('resolved');
      const set = firstArg(callsOf('update', 'supportCases')[0], 'set') as Record<string, unknown>;
      expect(set).toEqual(
        expect.objectContaining({
          status: 'resolved',
          priority: 'urgent',
          category: 'general_inquiry',
          resolvedAt: expect.any(Date),
          updatedAt: expect.any(Date),
        }),
      );
      expect(set).not.toHaveProperty('closedAt');
      const msgs = firstArg(callsOf('insert', 'supportCaseMessages')[0], 'values') as Array<{
        body: string;
        senderType: string;
      }>;
      expect(msgs.map((m) => m.body)).toEqual([
        'Status changed from open to resolved',
        'Priority changed from medium to urgent',
        'Category changed from charging_failure to general_inquiry',
      ]);
      expect(msgs.every((m) => m.senderType === 'system')).toBe(true);
      expect(mocks.dispatchDriverNotification).toHaveBeenCalledWith(
        { __client: true },
        'supportCase.Resolved',
        DRIVER_ID,
        { caseNumber: 'CASE-00001', subject: 'Charger broken', category: 'charging_failure' },
        expect.anything(),
        { __pubsub: true },
      );
      expect(mocks.notifySupportCaseEvent).toHaveBeenCalledWith(
        'supportCase.updated',
        CASE_ID,
        DRIVER_ID,
      );
      expect(auditActions()).toEqual(['status_changed', 'priority_changed', 'category_changed']);
      expect(mocks.writeAudit.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ before: { status: 'open' }, after: { status: 'resolved' } }),
      );
    });

    it('closing a case sets closedAt and does not send the resolved notification', async () => {
      queue([baseCase()], [baseCase({ status: 'closed' })], []);
      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, { status: 'closed' });
      expect(res.statusCode).toBe(200);
      const set = firstArg(callsOf('update')[0], 'set') as Record<string, unknown>;
      expect(set['closedAt']).toBeInstanceOf(Date);
      expect(set).not.toHaveProperty('resolvedAt');
      expect(mocks.dispatchDriverNotification).not.toHaveBeenCalled();
    });

    it('does not notify on resolve when the case has no driver', async () => {
      queue([baseCase({ driverId: null })], [baseCase({ status: 'resolved' })], []);
      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, { status: 'resolved' });
      expect(res.statusCode).toBe(200);
      expect(mocks.dispatchDriverNotification).not.toHaveBeenCalled();
      expect(mocks.notifySupportCaseEvent).toHaveBeenCalledWith(
        'supportCase.updated',
        CASE_ID,
        null,
      );
    });

    it('records nothing when the values do not change', async () => {
      queue([baseCase()], [baseCase()]);
      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, {
        status: 'open',
        priority: 'medium',
        category: 'charging_failure',
        assignedTo: null,
      });
      expect(res.statusCode).toBe(200);
      expect(firstArg(callsOf('update')[0], 'set')).toEqual({ updatedAt: expect.any(Date) });
      expect(callsOf('insert')).toHaveLength(0);
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });

    it('assigns to a named operator', async () => {
      queue(
        [baseCase()],
        [{ firstName: 'Ann', lastName: 'Lee' }],
        [baseCase({ assignedTo: ASSIGNEE_ID })],
        [],
      );
      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, { assignedTo: ASSIGNEE_ID });
      expect(res.statusCode).toBe(200);
      expect(mocks.eq).toHaveBeenCalledWith('users.id', ASSIGNEE_ID);
      const msgs = firstArg(callsOf('insert', 'supportCaseMessages')[0], 'values') as Array<{
        body: string;
      }>;
      expect(msgs.map((m) => m.body)).toEqual(['Assigned to Ann Lee']);
      expect(mocks.writeAudit.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          action: 'assigned',
          before: { assignedTo: null },
          after: { assignedTo: ASSIGNEE_ID },
        }),
      );
    });

    it('labels an unknown assignee and trims partial names', async () => {
      queue([baseCase()], [], [baseCase({ assignedTo: ASSIGNEE_ID })], []);
      await inject('PATCH', `/support-cases/${CASE_ID}`, { assignedTo: ASSIGNEE_ID });
      const msgs = firstArg(callsOf('insert', 'supportCaseMessages')[0], 'values') as Array<{
        body: string;
      }>;
      expect(msgs[0]?.body).toBe('Assigned to Unknown');

      state.calls = [];
      queue([baseCase()], [{ firstName: 'Ann', lastName: null }], [baseCase()], []);
      await inject('PATCH', `/support-cases/${CASE_ID}`, { assignedTo: ASSIGNEE_ID });
      const msgs2 = firstArg(callsOf('insert', 'supportCaseMessages')[0], 'values') as Array<{
        body: string;
      }>;
      expect(msgs2[0]?.body).toBe('Assigned to Ann');
    });

    it('unassigns a case', async () => {
      queue([baseCase({ assignedTo: ASSIGNEE_ID })], [baseCase()], []);
      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, { assignedTo: null });
      expect(res.statusCode).toBe(200);
      expect(firstArg(callsOf('update')[0], 'set')).toEqual(
        expect.objectContaining({ assignedTo: null }),
      );
      const msgs = firstArg(callsOf('insert', 'supportCaseMessages')[0], 'values') as Array<{
        body: string;
      }>;
      expect(msgs[0]?.body).toBe('Assignment removed');
    });

    it('links and unlinks sessions after checking site access', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue(
        [baseCase()],
        [
          { sessionId: SESSION_ID, siteId: 'sit_a' },
          { sessionId: SESSION_ID_2, siteId: null },
        ],
        [], // insert sessions
        [], // delete sessions
        [baseCase()],
      );
      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, {
        addSessionIds: [SESSION_ID, SESSION_ID_2],
        removeSessionIds: ['ses_000000000003'],
      });
      expect(res.statusCode).toBe(200);
      const ins = callsOf('insert', 'supportCaseSessions')[0];
      expect(firstArg(ins, 'values')).toEqual([
        { caseId: CASE_ID, sessionId: SESSION_ID },
        { caseId: CASE_ID, sessionId: SESSION_ID_2 },
      ]);
      expect(ins?.methods['onConflictDoNothing']).toHaveLength(1);
      expect(callsOf('delete', 'supportCaseSessions')).toHaveLength(1);
      expect(mocks.inArray).toHaveBeenCalledWith('supportCaseSessions.sessionId', [
        'ses_000000000003',
      ]);
      expect(auditActions()).toEqual(['sessions_linked', 'sessions_unlinked']);
      expect(mocks.writeAudit.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({ before: { sessionIds: ['ses_000000000003'] } }),
      );
    });

    it('links sessions without a site check for an unrestricted operator', async () => {
      queue([baseCase()], [], [baseCase()]);
      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, {
        addSessionIds: [SESSION_ID],
      });
      expect(res.statusCode).toBe(200);
      expect(callsOf('select')).toHaveLength(1);
      expect(callsOf('insert', 'supportCaseSessions')).toHaveLength(1);
    });

    it('returns 404 SESSION_NOT_FOUND when adding a session from another site', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([baseCase()], [{ sessionId: SESSION_ID, siteId: 'sit_b' }]);
      const res = await inject('PATCH', `/support-cases/${CASE_ID}`, {
        status: 'closed',
        addSessionIds: [SESSION_ID],
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      expect(callsOf('insert')).toHaveLength(0);
      expect(callsOf('update')).toHaveLength(0);
      expect(mocks.writeAudit).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------- messages
  describe('POST /support-cases/:id/messages', () => {
    const msgRow = {
      id: 7,
      senderType: 'operator',
      senderId: USER_ID,
      body: 'hello',
      isInternal: false,
      createdAt: NOW,
    };

    it('returns 404 when the case does not exist', async () => {
      queue([]);
      const res = await inject('POST', `/support-cases/${CASE_ID}/messages`, { body: 'x' });
      expect(res.statusCode).toBe(404);
      expect(callsOf('insert')).toHaveLength(0);
    });

    it('returns 404 when the case is on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([baseCase({ stationId: STATION_ID })], [{ siteId: 'sit_b' }]);
      const res = await inject('POST', `/support-cases/${CASE_ID}/messages`, { body: 'x' });
      expect(res.statusCode).toBe(404);
      expect(callsOf('insert')).toHaveLength(0);
    });

    it('posts a public reply and notifies the driver', async () => {
      queue([baseCase()], [msgRow]);
      const res = await inject('POST', `/support-cases/${CASE_ID}/messages`, { body: 'hello' });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ id: number }>().id).toBe(7);
      expect(firstArg(callsOf('insert', 'supportCaseMessages')[0], 'values')).toEqual({
        caseId: CASE_ID,
        senderType: 'operator',
        senderId: USER_ID,
        body: 'hello',
        isInternal: false,
      });
      expect(mocks.dispatchDriverNotification).toHaveBeenCalledWith(
        { __client: true },
        'supportCase.OperatorReply',
        DRIVER_ID,
        { caseNumber: 'CASE-00001', subject: 'Charger broken', category: 'charging_failure' },
        expect.anything(),
        { __pubsub: true },
      );
      expect(mocks.notifySupportCaseEvent).toHaveBeenCalledWith(
        'supportCase.newMessage',
        CASE_ID,
        DRIVER_ID,
      );
      expect(mocks.writeAudit.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          action: 'message_added',
          after: { messageId: 7, isInternal: false },
        }),
      );
    });

    it('keeps internal notes away from the driver', async () => {
      queue([baseCase()], [{ ...msgRow, isInternal: true }]);
      const res = await inject('POST', `/support-cases/${CASE_ID}/messages`, {
        body: 'note',
        isInternal: true,
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.dispatchDriverNotification).not.toHaveBeenCalled();
      expect(mocks.notifySupportCaseEvent).toHaveBeenCalledWith(
        'supportCase.newMessage',
        CASE_ID,
        null,
      );
    });

    it('rejects an empty body', async () => {
      const res = await inject('POST', `/support-cases/${CASE_ID}/messages`, { body: '' });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------- upload url
  describe('POST /support-cases/:id/messages/:messageId/attachments/upload-url', () => {
    const url = `/support-cases/${CASE_ID}/messages/5/attachments/upload-url`;
    const body = { fileName: 'receipt.pdf', contentType: 'application/pdf', fileSize: 1024 };

    it('returns 404 when the case does not exist', async () => {
      queue([]);
      const res = await inject('POST', url, body);
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SUPPORT_CASE_NOT_FOUND');
    });

    it('returns 404 when the case is on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue([]);
      queue([{ stationId: STATION_ID }]);
      const res = await inject('POST', url, body);
      expect(res.statusCode).toBe(404);
      expect(mocks.generateUploadUrl).not.toHaveBeenCalled();
    });

    it('returns 404 MESSAGE_NOT_FOUND when the message is not on this case', async () => {
      queue([{ stationId: null }], []);
      const res = await inject('POST', url, body);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
      expect(mocks.eq).toHaveBeenCalledWith('supportCaseMessages.id', 5);
      expect(mocks.eq).toHaveBeenCalledWith('supportCaseMessages.caseId', CASE_ID);
    });

    it('returns 400 when S3 is not configured', async () => {
      mocks.getS3Config.mockResolvedValue(null);
      queue([{ stationId: null }], [{ id: 5 }]);
      const res = await inject('POST', url, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'S3 not configured', code: 'STORAGE_NOT_CONFIGURED' });
    });

    it('returns a presigned URL scoped to the case and message', async () => {
      queue([{ stationId: null }], [{ id: 5 }]);
      const res = await inject('POST', url, body);
      expect(res.statusCode).toBe(200);
      const fileId = mocks.buildS3Key.mock.calls[0]?.[2] as string;
      expect(mocks.buildS3Key).toHaveBeenCalledWith(CASE_ID, 5, fileId, 'receipt.pdf');
      expect(fileId).toMatch(/^[0-9a-f-]{36}$/);
      const key = `support-cases/${CASE_ID}/5/${fileId}/receipt.pdf`;
      expect(mocks.generateUploadUrl).toHaveBeenCalledWith(S3, key, 'application/pdf');
      expect(res.json()).toEqual({
        uploadUrl: 'https://s3/upload',
        s3Key: key,
        s3Bucket: 'evtivity-bucket',
      });
    });

    it('rejects files larger than 10 MB', async () => {
      const res = await inject('POST', url, { ...body, fileSize: 10 * 1024 * 1024 + 1 });
      expect(res.statusCode).toBe(400);
      expect(state.calls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- confirm
  describe('POST /support-cases/:id/messages/:messageId/attachments', () => {
    const url = `/support-cases/${CASE_ID}/messages/5/attachments`;
    const body = {
      fileName: 'receipt.pdf',
      fileSize: 1024,
      contentType: 'application/pdf',
      s3Key: `support-cases/${CASE_ID}/5/abc/receipt.pdf`,
      s3Bucket: 'evtivity-bucket',
    };
    const attachmentRow = {
      id: 9,
      messageId: 5,
      fileName: 'receipt.pdf',
      fileSize: 1024,
      contentType: 'application/pdf',
      createdAt: NOW,
    };

    it('returns 404 when the case does not exist', async () => {
      queue([]);
      const res = await inject('POST', url, body);
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when the case is on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([{ stationId: STATION_ID }], [{ siteId: 'sit_b' }]);
      const res = await inject('POST', url, body);
      expect(res.statusCode).toBe(404);
      expect(callsOf('insert')).toHaveLength(0);
    });

    it('returns 404 when the message is not on this case', async () => {
      queue([{ stationId: null }], []);
      const res = await inject('POST', url, body);
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('MESSAGE_NOT_FOUND');
    });

    it('rejects an s3Key outside this case and message', async () => {
      queue([{ stationId: null }], [{ id: 5 }]);
      const res = await inject('POST', url, {
        ...body,
        s3Key: 'support-cases/cas_000000000099/5/abc/receipt.pdf',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('VALIDATION_ERROR');
      expect(callsOf('insert')).toHaveLength(0);
    });

    it('rejects an s3Key whose message id only shares a prefix', async () => {
      queue([{ stationId: null }], [{ id: 5 }]);
      const res = await inject('POST', url, {
        ...body,
        s3Key: `support-cases/${CASE_ID}/55/abc/receipt.pdf`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a bucket that differs from the configured one', async () => {
      queue([{ stationId: null }], [{ id: 5 }]);
      const res = await inject('POST', url, { ...body, s3Bucket: 'other-bucket' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Attachment metadata does not match issued upload URL',
        code: 'VALIDATION_ERROR',
      });
    });

    it('records the attachment and writes an audit entry', async () => {
      queue([{ stationId: null }], [{ id: 5 }], [attachmentRow]);
      const res = await inject('POST', url, body);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ id: number }>().id).toBe(9);
      expect(firstArg(callsOf('insert', 'supportCaseAttachments')[0], 'values')).toEqual({
        messageId: 5,
        fileName: 'receipt.pdf',
        fileSize: 1024,
        contentType: 'application/pdf',
        s3Key: body.s3Key,
        s3Bucket: 'evtivity-bucket',
      });
      expect(mocks.writeAudit.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          action: 'attachment_added',
          entityId: CASE_ID,
          after: { messageId: 5, fileName: 'receipt.pdf', fileSize: 1024 },
        }),
      );
    });

    it('accepts any bucket when S3 settings are absent but the key prefix matches', async () => {
      mocks.getS3Config.mockResolvedValue(null);
      queue([{ stationId: null }], [{ id: 5 }], [attachmentRow]);
      const res = await inject('POST', url, { ...body, s3Bucket: 'other-bucket' });
      expect(res.statusCode).toBe(200);
      expect(firstArg(callsOf('insert', 'supportCaseAttachments')[0], 'values')).toEqual(
        expect.objectContaining({ s3Bucket: 'other-bucket' }),
      );
    });
  });

  // ---------------------------------------------------------------- download
  describe('GET .../attachments/:attachmentId/download-url', () => {
    const url = `/support-cases/${CASE_ID}/messages/5/attachments/9/download-url`;

    it('returns 404 when the case does not exist', async () => {
      queue([]);
      const res = await inject('GET', url);
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SUPPORT_CASE_NOT_FOUND');
    });

    it('returns 404 when the case is on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue([]);
      queue([{ stationId: STATION_ID }]);
      const res = await inject('GET', url);
      expect(res.statusCode).toBe(404);
      expect(mocks.generateDownloadUrl).not.toHaveBeenCalled();
    });

    it('returns 404 ATTACHMENT_NOT_FOUND when the attachment is not on this case', async () => {
      queue([{ stationId: null }], []);
      const res = await inject('GET', url);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Attachment not found', code: 'ATTACHMENT_NOT_FOUND' });
      expect(mocks.eq).toHaveBeenCalledWith('supportCaseAttachments.id', 9);
      expect(mocks.eq).toHaveBeenCalledWith('supportCaseAttachments.messageId', 5);
      expect(mocks.eq).toHaveBeenCalledWith('supportCaseMessages.caseId', CASE_ID);
    });

    it('returns 400 when S3 is not configured', async () => {
      mocks.getS3Config.mockResolvedValue(null);
      queue([{ stationId: null }], [{ s3Key: 'k', s3Bucket: 'b' }]);
      const res = await inject('GET', url);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('STORAGE_NOT_CONFIGURED');
    });

    it('returns a presigned download URL for the stored object', async () => {
      queue([{ stationId: null }], [{ s3Key: 'stored-key', s3Bucket: 'stored-bucket' }]);
      const res = await inject('GET', url);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ downloadUrl: 'https://s3/download' });
      expect(mocks.generateDownloadUrl).toHaveBeenCalledWith(S3, 'stored-bucket', 'stored-key');
    });
  });

  // ---------------------------------------------------------------- delete
  describe('DELETE .../attachments/:attachmentId', () => {
    const url = `/support-cases/${CASE_ID}/messages/5/attachments/9`;

    it('returns 404 when the case does not exist', async () => {
      queue([]);
      const res = await inject('DELETE', url);
      expect(res.statusCode).toBe(404);
      expect(callsOf('delete')).toHaveLength(0);
    });

    it('returns 404 when the case is on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      queue([{ stationId: STATION_ID }], [{ siteId: 'sit_b' }]);
      const res = await inject('DELETE', url);
      expect(res.statusCode).toBe(404);
      expect(callsOf('delete')).toHaveLength(0);
    });

    it('returns 404 when the attachment is not on this case', async () => {
      queue([{ stationId: null }], []);
      const res = await inject('DELETE', url);
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ATTACHMENT_NOT_FOUND');
      expect(mocks.deleteObject).not.toHaveBeenCalled();
      expect(callsOf('delete')).toHaveLength(0);
    });

    it('deletes the S3 object and the row', async () => {
      queue([{ stationId: null }], [{ s3Key: 'stored-key', s3Bucket: 'stored-bucket' }], []);
      const res = await inject('DELETE', url);
      expect(res.statusCode).toBe(204);
      expect(mocks.deleteObject).toHaveBeenCalledWith(S3, 'stored-bucket', 'stored-key');
      expect(callsOf('delete', 'supportCaseAttachments')).toHaveLength(1);
      expect(mocks.eq).toHaveBeenCalledWith('supportCaseAttachments.id', 9);
    });

    it('deletes the row even when S3 is not configured', async () => {
      mocks.getS3Config.mockResolvedValue(null);
      queue([{ stationId: null }], [{ s3Key: 'k', s3Bucket: 'b' }], []);
      const res = await inject('DELETE', url);
      expect(res.statusCode).toBe(204);
      expect(mocks.deleteObject).not.toHaveBeenCalled();
      expect(callsOf('delete', 'supportCaseAttachments')).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------- refund
  describe('POST /support-cases/:id/refund', () => {
    const url = `/support-cases/${CASE_ID}/refund`;

    function refundQueue(sessionStation: unknown[] = [{ siteId: 'sit_a', transactionId: 'tx-9' }]) {
      queue([baseCase()], [{ sessionId: SESSION_ID }], sessionStation, []);
    }

    it('returns 404 when the case does not exist', async () => {
      queue([]);
      const res = await inject('POST', url, { sessionId: SESSION_ID });
      expect(res.statusCode).toBe(404);
      expect(mocks.refundPaymentRecord).not.toHaveBeenCalled();
    });

    it('returns 404 when the case is on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue([]);
      queue([baseCase({ stationId: STATION_ID })]);
      const res = await inject('POST', url, { sessionId: SESSION_ID });
      expect(res.statusCode).toBe(404);
      expect(mocks.refundPaymentRecord).not.toHaveBeenCalled();
    });

    it('returns 400 SESSION_NOT_LINKED when the session is not on the case', async () => {
      queue([baseCase()], []);
      const res = await inject('POST', url, { sessionId: SESSION_ID });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'Session not linked to this case',
        code: 'SESSION_NOT_LINKED',
      });
      expect(mocks.refundPaymentRecord).not.toHaveBeenCalled();
    });

    it('returns 400 SESSION_NOT_LINKED when the session station is on another site', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      refundQueue([{ siteId: 'sit_b', transactionId: 'tx-9' }]);
      const res = await inject('POST', url, { sessionId: SESSION_ID });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_LINKED');
      expect(mocks.refundPaymentRecord).not.toHaveBeenCalled();
    });

    it.each([
      [{ status: 'not_found' }, 400, 'NO_CAPTURED_PAYMENT', 'No captured payment to refund'],
      [
        { status: 'no_captured_payment' },
        400,
        'NO_CAPTURED_PAYMENT',
        'No captured payment to refund',
      ],
      [{ status: 'missing_payment_id' }, 400, 'MISSING_PAYMENT_INTENT', 'Payment intent missing'],
      [
        { status: 'not_configured' },
        400,
        'PAYMENT_PROVIDER_NOT_CONFIGURED',
        'No payment provider configured',
      ],
      [
        { status: 'nothing_refundable' },
        400,
        'REFUND_EXCEEDS_REMAINING',
        'No remaining refundable amount on this payment',
      ],
      [
        { status: 'exceeds_remaining', remainingCents: 250, currency: 'EUR' },
        400,
        'REFUND_EXCEEDS_REMAINING',
        'Refund amount exceeds remaining 2.50 EUR',
      ],
      [
        {
          status: 'top_up_unknown',
          unlistedCents: 500,
          refundableCents: 1000,
          currency: 'USD',
        },
        409,
        'REFUND_TOP_UP_UNKNOWN',
        "This payment includes a top-up charge of 5.00 USD with no recorded payment id. Refund up to 10.00 USD here and refund the top-up in the payment provider's dashboard.",
      ],
      [
        { status: 'operation_pending' },
        409,
        'PAYMENT_OPERATION_PENDING',
        "The payment has an operation waiting for the provider's confirmation. Try again later.",
      ],
    ])('maps refund outcome %o to %i %s', async (outcome, status, code, error) => {
      refundQueue();
      mocks.refundPaymentRecord.mockResolvedValue(outcome);
      const res = await inject('POST', url, { sessionId: SESSION_ID });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error, code });
      expect(callsOf('insert')).toHaveLength(0);
      expect(mocks.writeAudit).not.toHaveBeenCalled();
      expect(mocks.dispatchDriverNotification).not.toHaveBeenCalled();
    });

    it('issues a partial refund, posts a timeline message, notifies the driver and audits', async () => {
      refundQueue();
      mocks.refundPaymentRecord.mockResolvedValue({
        status: 'refunded',
        record: paymentRecord({ status: 'partially_refunded', refundedAmountCents: 500 }),
        refundStatus: 'succeeded',
        refundedNowCents: 500,
        pendingCents: 0,
      });

      const res = await inject('POST', url, { sessionId: SESSION_ID, amountCents: 500 });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.objectContaining({
          id: 'pay_1',
          refundStatus: 'succeeded',
          refundedAmountCents: 500,
        }),
      );
      expect(mocks.refundPaymentRecord).toHaveBeenCalledWith(
        { sessionId: SESSION_ID, amountCents: 500 },
        { __ctx: true },
      );
      expect(firstArg(callsOf('insert', 'supportCaseMessages')[0], 'values')).toEqual({
        caseId: CASE_ID,
        senderType: 'system',
        senderId: USER_ID,
        body: 'Refund of 5.00 USD issued for session tx-9',
        isInternal: false,
      });
      expect(mocks.dispatchDriverNotification).toHaveBeenCalledWith(
        { __client: true },
        'payment.Refunded',
        DRIVER_ID,
        {
          amountCents: 500,
          amountFormatted: 'money:500:USD',
          currency: 'USD',
          transactionId: SESSION_ID,
        },
        expect.anything(),
        { __pubsub: true },
      );
      expect(mocks.notifySupportCaseEvent).toHaveBeenCalledWith(
        'supportCase.updated',
        CASE_ID,
        DRIVER_ID,
      );
      expect(mocks.writeAudit.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          action: 'refund_issued',
          after: { sessionId: SESSION_ID, amountCents: 500, currency: 'USD' },
        }),
      );
    });

    it('records a pending refund without notifying the driver yet', async () => {
      refundQueue([]);
      mocks.refundPaymentRecord.mockResolvedValue({
        status: 'refunded',
        record: paymentRecord({ currency: 'EUR' }),
        refundStatus: 'pending',
        refundedNowCents: 0,
        pendingCents: 1500,
      });

      const res = await inject('POST', url, { sessionId: SESSION_ID });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ refundStatus: string }>().refundStatus).toBe('pending');
      expect(mocks.refundPaymentRecord).toHaveBeenCalledWith(
        { sessionId: SESSION_ID },
        { __ctx: true },
      );
      const msg = firstArg(callsOf('insert', 'supportCaseMessages')[0], 'values') as {
        body: string;
      };
      // No station row: the label falls back to the session id.
      expect(msg.body).toBe(
        `Refund of 15.00 EUR requested for session ${SESSION_ID}; awaiting the payment provider's confirmation`,
      );
      expect(mocks.dispatchDriverNotification).not.toHaveBeenCalled();
      expect(mocks.writeAudit.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          after: { sessionId: SESSION_ID, amountCents: 1500, currency: 'EUR' },
        }),
      );
    });

    it('still succeeds when the timeline message insert fails', async () => {
      queue([baseCase()], [{ sessionId: SESSION_ID }], [], new Error('db down'));
      mocks.refundPaymentRecord.mockResolvedValue({
        status: 'refunded',
        record: paymentRecord({ driverId: null }),
        refundStatus: 'succeeded',
        refundedNowCents: 1500,
        pendingCents: 0,
      });
      const res = await inject('POST', url, { sessionId: SESSION_ID });
      expect(res.statusCode).toBe(200);
      expect(mocks.dispatchDriverNotification).not.toHaveBeenCalled();
      expect(auditActions()).toEqual(['refund_issued']);
    });

    it('rejects a non-positive amount', async () => {
      const res = await inject('POST', url, { sessionId: SESSION_ID, amountCents: 0 });
      expect(res.statusCode).toBe(400);
      expect(state.calls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- ai assist
  describe('POST /support-cases/:id/ai-assist', () => {
    const url = `/support-cases/${CASE_ID}/ai-assist`;

    it('returns 404 CASE_NOT_FOUND for a case on an inaccessible site', async () => {
      mocks.getUserSiteIds.mockResolvedValue([]);
      queue([{ id: CASE_ID, stationId: STATION_ID }]);
      const res = await inject('POST', url, {});
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Case not found', code: 'CASE_NOT_FOUND' });
      expect(mocks.handleSupportAiAssist).not.toHaveBeenCalled();
    });

    it('forwards the bearer header and returns the draft', async () => {
      queue([{ id: CASE_ID, stationId: null }]);
      mocks.handleSupportAiAssist.mockResolvedValue({ draft: 'Hi', apiCallsMade: 2 });
      const res = await inject('POST', url, { isInternalNote: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ draft: 'Hi', apiCallsMade: 2 });
      expect(mocks.handleSupportAiAssist).toHaveBeenCalledWith(
        expect.anything(),
        USER_ID,
        CASE_ID,
        true,
        auth,
      );
    });

    it('returns 500 for an unexpected assist error', async () => {
      queue([{ id: CASE_ID, stationId: null }]);
      mocks.handleSupportAiAssist.mockRejectedValue(new Error('boom'));
      const res = await inject('POST', url, {});
      expect(res.statusCode).toBe(500);
    });
  });

  it('rejects requests without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/support-cases' });
    expect(res.statusCode).toBe(401);
    expect(state.calls).toHaveLength(0);
  });
});
