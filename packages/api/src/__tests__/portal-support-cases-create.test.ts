// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  index: 0,
  inserts: [] as unknown[],
}));

const mocks = vi.hoisted(() => {
  function chain(result: unknown): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'values', 'returning', 'leftJoin', 'innerJoin']) {
      c[m] = () => c;
    }
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
    },
  };
});

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

vi.mock('../lib/support-case-events.js', () => ({ notifySupportCaseEvent: vi.fn() }));
vi.mock('../services/support-notification.service.js', () => ({
  dispatchOperatorNotification: vi.fn(),
}));

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
