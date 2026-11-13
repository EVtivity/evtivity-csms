// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const tables = vi.hoisted(() => ({
  users: { __t: 'users', id: 'u.id', firstName: 'u.f', lastName: 'u.l', email: 'u.e' },
  drivers: { __t: 'drivers', id: 'd.id', firstName: 'd.f', lastName: 'd.l', email: 'd.e' },
  refreshTokens: { __t: 'refresh_tokens', id: 'r.id', name: 'r.name' },
}));

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getUserSiteIds: vi.fn(),
  visibleUserIds: vi.fn(),
  resolveNames: vi.fn(),
  byTable: new Map<unknown, unknown[]>(),
  selectFrom: [] as unknown[],
}));

vi.mock('@evtivity/database', async () => {
  const rawTimestamp = await import('@evtivity/database/src/lib/raw-timestamp.js');
  const keys = [
    'site',
    'station',
    'driver',
    'user',
    'support_case',
    'setting',
    'station_image',
    'local_auth_list',
    'reservation',
    'maintenance_event',
    'session',
    'ai_insight',
    'ai_proposal',
    'ai_conversation',
    'payment',
    'sim',
    'payment_terminal',
    'vehicle_departure',
  ];
  const select = () => {
    const c: Record<string, unknown> = {};
    c['from'] = (table: unknown) => {
      mocks.selectFrom.push(table);
      return {
        where: () => Promise.resolve(mocks.byTable.get(table) ?? []),
      };
    };
    return c;
  };
  return {
    ...rawTimestamp,
    db: { execute: mocks.execute, select },
    AUDIT_TABLES: Object.fromEntries(keys.map((k) => [k, {}])),
    users: tables.users,
    drivers: tables.drivers,
    refreshTokens: tables.refreshTokens,
    supportCases: {},
  };
});

vi.mock('../middleware/rbac.js', () => ({
  authorize: () => async (request: { jwtVerify: () => Promise<void> }) => {
    await request.jwtVerify();
  },
  requestHasPermission: () => Promise.resolve(true),
}));
vi.mock('../lib/site-access.js', () => ({ getUserSiteIds: mocks.getUserSiteIds }));
vi.mock('../lib/user-management-scope.js', () => ({ visibleUserIds: mocks.visibleUserIds }));
vi.mock('../lib/audit-entity-names.js', () => ({ resolveAuditEntityNames: mocks.resolveNames }));
vi.mock('../lib/support-case-scope.js', async () => {
  const { sql } = await import('drizzle-orm');
  return { supportCaseSiteCondition: vi.fn(() => sql`case_visible_marker`) };
});
vi.mock('../lib/support-case-redaction.js', async () => {
  const { sql } = await import('drizzle-orm');
  return {
    supportCaseAuditSessionCondition: vi.fn(() => sql`case_session_marker`),
    redactSupportCaseAuditRows: async (rows: unknown[]) => rows,
  };
});

import { registerAuth } from '../plugins/auth.js';
import { auditRoutes } from '../routes/audit.js';

const dialect = new PgDialect();
function executed(): Array<{ sql: string; params: unknown[] }> {
  return mocks.execute.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL));
}

const VIEWER = 'usr_000000000001';

let app: FastifyInstance;
let auth: string;

beforeAll(async () => {
  app = Fastify();
  await registerAuth(app);
  app.register(async (instance) => {
    auditRoutes(instance);
  });
  await app.ready();
  auth = `Bearer ${app.jwt.sign({ userId: VIEWER, roleId: 'rol_1' })}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mocks.execute.mockReset().mockResolvedValue([]);
  mocks.getUserSiteIds.mockReset().mockResolvedValue(null);
  mocks.visibleUserIds.mockReset().mockResolvedValue(null);
  mocks.resolveNames.mockReset().mockResolvedValue(undefined);
  mocks.byTable.clear();
  mocks.selectFrom = [];
});

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: auth } });
}

function row(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    entity_type: 'station',
    entity_id: 'sta_1',
    entity_id_snapshot: 'sta_1',
    action: 'updated',
    actor: 'operator',
    actor_user_id: null,
    actor_driver_id: null,
    actor_api_key_id: null,
    actor_label: null,
    before: null,
    after: null,
    notes: null,
    via_ai: null,
    created_at: '2026-10-10 10:00:00+00',
    ...fields,
  };
}

describe('GET /audit actor names', () => {
  it('resolves operator, driver and API key names in batched reads', async () => {
    mocks.byTable.set(tables.users, [
      { id: 'usr_a', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
      { id: 'usr_b', firstName: null, lastName: null, email: 'b@example.com' },
    ]);
    mocks.byTable.set(tables.drivers, [
      { id: 'drv_a', firstName: '', lastName: null, email: 'drv@example.com' },
    ]);
    mocks.byTable.set(tables.refreshTokens, [
      { id: 7, name: 'CI key' },
      { id: 8, name: null },
    ]);
    mocks.execute
      .mockResolvedValueOnce([
        row({ id: 1, actor_user_id: 'usr_a' }),
        row({ id: 2, actor_user_id: 'usr_b' }),
        row({ id: 3, actor_user_id: 'usr_gone' }),
        row({ id: 4, actor: 'driver', actor_driver_id: 'drv_a' }),
        row({ id: 5, actor: 'api_key', actor_api_key_id: '7' }),
        row({ id: 6, actor: 'api_key', actor_api_key_id: '8' }),
        row({ id: 7, actor: 'system', actor_label: 'cron' }),
        row({ id: 8, actor: 'driver', actor_driver_id: 'drv_gone' }),
        row({ id: 9, actor: 'api_key', actor_api_key_id: 'not-a-number' }),
      ])
      .mockResolvedValueOnce([{ total: 9 }]);
    const res = await get('/audit');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ id: number; actorName: string | null }>;
      total: number;
    }>();
    expect(body.total).toBe(9);
    expect(body.data.map((d) => [d.id, d.actorName])).toEqual([
      [1, 'Ada Lovelace'],
      [2, 'b@example.com'],
      [3, null],
      [4, 'drv@example.com'],
      [5, 'CI key'],
      [6, null],
      [7, null],
      [8, null],
      [9, null],
    ]);
    expect(mocks.selectFrom).toEqual([tables.users, tables.drivers, tables.refreshTokens]);
    expect(mocks.resolveNames).toHaveBeenCalledWith(expect.any(Array), null, expect.anything());
  });

  it('reads no names when no row has an actor id', async () => {
    mocks.execute
      .mockResolvedValueOnce([row({ actor: 'system' })])
      .mockResolvedValueOnce([{ total: 1 }]);
    const res = await get('/audit');
    expect(res.statusCode).toBe(200);
    expect(mocks.selectFrom).toEqual([]);
  });
});

describe('GET /audit hides operators a restricted viewer may not see', () => {
  it('drops the hidden actor, the hidden AI confirmer and the hidden ICCID entry', async () => {
    mocks.getUserSiteIds.mockResolvedValue(['sit_1']);
    mocks.visibleUserIds.mockResolvedValue(new Set(['usr_seen']));
    mocks.byTable.set(tables.users, [
      { id: 'usr_seen', firstName: 'Seen', lastName: 'User', email: 's@example.com' },
    ]);
    mocks.execute
      .mockResolvedValueOnce([
        row({
          id: 1,
          actor_user_id: 'usr_hidden',
          actor_api_key_id: '5',
          via_ai: { channel: 'proposal', proposalId: 'aip_1', confirmedBy: 'usr_hidden' },
          before: { iccidEnteredBy: 'usr_hidden', iccidEnteredWithAllSites: true, name: 'A' },
          after: { iccidEnteredBy: 'usr_seen', iccidEnteredWithAllSites: false },
        }),
        row({
          id: 2,
          actor_user_id: 'usr_seen',
          via_ai: { channel: 'proposal', confirmedBy: 'usr_seen' },
          before: { iccidEnteredBy: 'usr_seen' },
          after: { iccidEnteredBy: 'usr_hidden' },
        }),
        row({
          id: 3,
          entity_type: 'site',
          before: { iccidEnteredBy: 'usr_hidden' },
        }),
      ])
      .mockResolvedValueOnce([{ total: 3 }]);
    const res = await get('/audit?entityTypes=station,site');
    expect(res.statusCode).toBe(200);
    const [first, second, third] = res.json<{ data: Array<Record<string, unknown>> }>().data;
    expect(mocks.visibleUserIds).toHaveBeenCalledWith(
      [
        'usr_hidden',
        'usr_hidden',
        'usr_hidden',
        'usr_seen',
        'usr_seen',
        'usr_seen',
        'usr_seen',
        'usr_hidden',
      ],
      VIEWER,
      ['sit_1'],
    );
    expect(first).toMatchObject({ actorUserId: null, actorApiKeyId: null, actorName: null });
    expect(first?.['viaAi']).toEqual({ channel: 'proposal', proposalId: 'aip_1' });
    expect(first?.['before']).toEqual({
      iccidEnteredBy: null,
      iccidEnteredWithAllSites: null,
      name: 'A',
    });
    expect(first?.['after']).toEqual({
      iccidEnteredBy: 'usr_seen',
      iccidEnteredWithAllSites: false,
    });
    expect(second).toMatchObject({ actorUserId: 'usr_seen', actorName: 'Seen User' });
    expect(second?.['viaAi']).toMatchObject({ confirmedBy: 'usr_seen' });
    expect(second?.['after']).toEqual({ iccidEnteredBy: null, iccidEnteredWithAllSites: null });
    // Only station snapshots name an ICCID entry.
    expect(third?.['before']).toEqual({ iccidEnteredBy: 'usr_hidden' });
  });

  it('answers an empty page for an actor filter on an operator the viewer cannot see', async () => {
    mocks.getUserSiteIds.mockResolvedValue(['sit_1']);
    mocks.visibleUserIds.mockResolvedValue(new Set());
    const res = await get('/audit?entityType=station&actorUserId=usr_other');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], total: 0 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('answers an empty page for a viewer with no sites', async () => {
    mocks.getUserSiteIds.mockResolvedValue([]);
    const res = await get('/audit');
    expect(res.json()).toEqual({ data: [], total: 0 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('GET /audit filters and site conditions', () => {
  it('adds every filter to each branch', async () => {
    mocks.visibleUserIds.mockResolvedValue(null);
    const res = await get(
      '/audit?entityType=setting&action=updated&actor=operator&actorUserId=usr_x&actorDriverId=drv_x' +
        '&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&entityId=company.name',
    );
    expect(res.statusCode).toBe(200);
    const [data, count] = executed();
    for (const q of [data, count]) {
      expect(q?.sql).toContain('action::text = $');
      expect(q?.sql).toContain('actor::text = $');
      expect(q?.sql).toContain('actor_user_id = $');
      expect(q?.sql).toContain('actor_driver_id = $');
      expect(q?.sql).toContain('created_at >= $');
      expect(q?.sql).toContain('created_at <= $');
      expect(q?.sql).toContain('"setting_key" = $');
      expect(q?.params).toEqual(
        expect.arrayContaining([
          'updated',
          'operator',
          'usr_x',
          'drv_x',
          '2026-01-01T00:00:00Z',
          '2026-02-01T00:00:00Z',
          'company.name',
        ]),
      );
    }
  });

  it('builds a site condition for each sited entity type', async () => {
    mocks.getUserSiteIds.mockResolvedValue(['sit_1']);
    mocks.visibleUserIds.mockResolvedValue(new Set());
    const types = [
      'site',
      'station',
      'local_auth_list',
      'station_image',
      'reservation',
      'session',
      'maintenance_event',
      'ai_proposal',
      'ai_insight',
      'payment',
      'sim',
      'payment_terminal',
      'vehicle_departure',
      'support_case',
      'ai_conversation',
      'driver',
    ];
    const res = await get(`/audit?entityTypes=${types.join(',')}`);
    expect(res.statusCode).toBe(200);
    const data = executed()[0]?.sql ?? '';
    expect(data).toContain(
      'FROM charging_stations cs WHERE cs.id = "station_audit_log"."station_id"',
    );
    expect(data).toContain('"local_auth_list_audit_log"."station_id"');
    expect(data).toContain('FROM station_images si');
    expect(data).toContain(
      'FROM reservations r WHERE r.id = "reservation_audit_log"."reservation_id"',
    );
    expect(data).toContain(
      'FROM charging_sessions s WHERE s.id = "session_audit_log"."session_id"',
    );
    expect(data).toContain('FROM maintenance_events m');
    expect(data).toContain('FROM ai_proposals p');
    expect(data).toContain('FROM ai_insights i');
    expect(data).toContain('FROM payment_records p');
    expect(data).toContain('"sim_audit_log".after->>\'stationUnknown\' IS NULL');
    expect(data).toContain('"payment_terminal_audit_log".after->>\'auditSiteId\'');
    expect(data).toContain('jsonb_array_elements_text');
    expect(data).toContain('"vehicle_departure_audit_log".before->>\'auditSiteId\'');
    expect(data).toContain('case_visible_marker');
    expect(data).toContain('case_session_marker');
    // An unsited type (driver) is left out for a restricted viewer.
    expect(data).not.toContain('"driver_audit_log"');
    // An AI conversation is listed only to its owner, and has no site: left out here.
    expect(data).not.toContain('ai_conversation_audit_log');
  });

  it('shows an AI conversation history only to its owner', async () => {
    const res = await get('/audit?entityType=ai_conversation');
    expect(res.statusCode).toBe(200);
    const q = executed()[0];
    expect(q?.sql).toContain(
      'FROM ai_conversations oc WHERE oc.id = "ai_conversation_audit_log"."ai_conversation_id" AND oc.user_id = $',
    );
    expect(q?.params).toContain(VIEWER);
  });
});

describe('GET /audit/:entityType/:entityId', () => {
  it('owner-scopes an AI conversation and turns stored values into strings', async () => {
    mocks.execute
      .mockResolvedValueOnce([
        {
          id: 3,
          ai_conversation_id: 'aic_1',
          ai_conversation_id_snapshot: 42,
          action: true,
          actor: { kind: 'odd' },
          created_at: '2026-10-10 10:00:00+00',
        },
        {
          id: 2,
          ai_conversation_id: null,
          ai_conversation_id_snapshot: new Date('2026-01-02T03:04:05.000Z'),
          action: null,
          actor: 'system',
          created_at: '2026-10-09 10:00:00+00',
        },
      ])
      .mockResolvedValueOnce([]);
    const res = await get('/audit/ai_conversation/aic_1');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<Record<string, unknown>>; total: number }>();
    // No count row: a total of 0.
    expect(body.total).toBe(0);
    expect(body.data[0]).toMatchObject({
      entityId: 'aic_1',
      entityIdSnapshot: '42',
      action: 'true',
      actor: '{"kind":"odd"}',
    });
    expect(body.data[1]).toMatchObject({
      entityId: null,
      entityIdSnapshot: '2026-01-02T03:04:05.000Z',
      action: '',
    });
    expect(executed()[0]?.sql).toContain('FROM ai_conversations oc');
  });

  it('answers an empty page for an unsited entity of a restricted viewer', async () => {
    mocks.getUserSiteIds.mockResolvedValue(['sit_1']);
    mocks.visibleUserIds.mockResolvedValue(new Set());
    const res = await get('/audit/driver/drv_1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], total: 0 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('lists a session with its payments under the restricted site scope', async () => {
    mocks.getUserSiteIds.mockResolvedValue(['sit_1']);
    mocks.visibleUserIds.mockResolvedValue(new Set());
    const res = await get('/audit/session/ses_1');
    expect(res.statusCode).toBe(200);
    const sqls = executed().map((q) => q.sql);
    expect(sqls).toHaveLength(4);
    expect(
      sqls.some((s) => s.includes('"payment_audit_log"') && s.includes('FROM payment_records p')),
    ).toBe(true);
  });
});
