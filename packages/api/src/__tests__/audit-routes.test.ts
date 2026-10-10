// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getUserSiteIds: vi.fn(),
  redactRows: vi.fn(async (rows: unknown[]) => rows),
}));

vi.mock('@evtivity/database', async () => {
  const rawTimestamp = await import('@evtivity/database/src/lib/raw-timestamp.js');
  const keys = [
    'site',
    'station',
    'driver',
    'fleet',
    'user',
    'vehicle',
    'support_case',
    'ocpi_partner',
    'certificate',
    'role',
    'api_key',
    'setting',
    'smart_charging_template',
    'config_template',
    'firmware_campaign',
    'station_image',
    'local_auth_list',
    'token',
    'reservation',
    'pricing_group',
    'tariff',
    'holiday',
    'pricing_assignment',
    'maintenance_event',
    'session',
    'invoice',
  ];
  return {
    ...rawTimestamp,
    db: { execute: mocks.execute, select: vi.fn() },
    AUDIT_TABLES: Object.fromEntries(keys.map((k) => [k, {}])),
    users: {},
    drivers: {},
    refreshTokens: {},
    supportCases: {},
  };
});

vi.mock('../middleware/rbac.js', () => ({
  authorize: () => async (request: { jwtVerify: () => Promise<void> }) => {
    await request.jwtVerify();
  },
}));

vi.mock('../lib/site-access.js', () => ({ getUserSiteIds: mocks.getUserSiteIds }));
vi.mock('../lib/support-case-scope.js', async () => {
  const { sql } = await import('drizzle-orm');
  return { supportCaseSiteCondition: vi.fn(() => sql`case_visible_marker`) };
});
vi.mock('../lib/support-case-redaction.js', async () => {
  const { sql } = await import('drizzle-orm');
  return {
    supportCaseAuditSessionCondition: vi.fn(() => sql`case_session_marker`),
    redactSupportCaseAuditRows: mocks.redactRows,
  };
});

import { registerAuth } from '../plugins/auth.js';
import { auditRoutes } from '../routes/audit.js';

const dialect = new PgDialect();
function executedSql(): string[] {
  return mocks.execute.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL).sql);
}

describe('audit routes site scope', () => {
  let app: FastifyInstance;
  let auth: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    app.register(async (instance) => {
      auditRoutes(instance);
    });
    await app.ready();
    auth = `Bearer ${app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_1' })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mocks.execute.mockReset().mockResolvedValue([]);
    mocks.getUserSiteIds.mockReset().mockResolvedValue(null);
  });

  function get(url: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: auth } });
  }

  describe('GET /audit/:entityType/:entityId', () => {
    it('returns createdAt as ISO 8601 from a postgres text created_at', async () => {
      // The shared client returns raw timestamps as postgres text.
      mocks.execute
        .mockResolvedValueOnce([
          {
            id: 1,
            action: 'updated',
            actor: 'system',
            created_at: '2026-10-10 10:49:38.215861+00',
          },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);
      const res = await get('/audit/setting/company.name');
      expect(res.statusCode).toBe(200);
      expect(res.json().data[0].createdAt).toBe('2026-10-10T10:49:38.215Z');
    });

    it('does not filter by site for an all-site user', async () => {
      const res = await get('/audit/setting/company.name');
      expect(res.statusCode).toBe(200);
      expect(executedSql()[0]).not.toContain('site_id');
    });

    it('returns an empty page for a company-wide entity to a restricted user', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      const res = await get('/audit/setting/company.name');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(mocks.execute).not.toHaveBeenCalled();
    });

    it("filters a station's history by the station site for a restricted user", async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
      const res = await get('/audit/station/sta_000000000001');
      expect(res.statusCode).toBe(200);
      const [rowsSql, countSql] = executedSql();
      expect(rowsSql).toContain('SELECT cs.site_id FROM charging_stations cs');
      expect(countSql).toContain('SELECT cs.site_id FROM charging_stations cs');
      const params = dialect.sqlToQuery(mocks.execute.mock.calls[0]?.[0] as SQL).params;
      expect(params).toContain('sit_a');
    });

    it("scopes a support case's history by the case's own visibility", async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);
      const res = await get('/audit/support_case/cas_000000000001');
      expect(res.statusCode).toBe(200);
      const [rowsSql, countSql] = executedSql();
      expect(rowsSql).toContain('case_visible_marker');
      expect(countSql).toContain('case_visible_marker');
      // Rows about sessions of other sites are excluded, the rest trimmed.
      expect(rowsSql).toContain('case_session_marker');
      expect(countSql).toContain('case_session_marker');
      expect(mocks.redactRows).toHaveBeenCalledWith([], ['sit_a']);
    });

    it('returns an empty page to a user without sites', async () => {
      mocks.getUserSiteIds.mockResolvedValue([]);
      const res = await get('/audit/site/sit_a');
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(mocks.execute).not.toHaveBeenCalled();
    });
  });

  describe('GET /audit', () => {
    it('returns createdAt as ISO 8601 from a postgres text created_at', async () => {
      mocks.execute
        .mockResolvedValueOnce([
          {
            id: 1,
            entity_type: 'setting',
            entity_id: 'company.name',
            action: 'updated',
            actor: 'system',
            created_at: '2026-10-10 10:49:38.215861+00',
          },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);
      const res = await get('/audit');
      expect(res.statusCode).toBe(200);
      expect(res.json().data[0].createdAt).toBe('2026-10-10T10:49:38.215Z');
    });

    it('queries every audit table for an all-site user', async () => {
      const res = await get('/audit');
      expect(res.statusCode).toBe(200);
      expect(executedSql()[0]).toContain('"setting_audit_log"');
    });

    it('queries only site-scoped tables, filtered, for a restricted user', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      const res = await get('/audit');
      expect(res.statusCode).toBe(200);
      const [dataSql] = executedSql();
      expect(dataSql).not.toContain('"setting_audit_log"');
      expect(dataSql).not.toContain('"driver_audit_log"');
      expect(dataSql).toContain('"station_audit_log"');
      expect(dataSql).toContain('"session_audit_log"');
      expect(dataSql).toContain('SELECT m.site_id FROM maintenance_events m');
    });

    it('returns an empty page for a company-wide entity type filter', async () => {
      mocks.getUserSiteIds.mockResolvedValue(['sit_a']);
      const res = await get('/audit?entityType=tariff');
      expect(res.json()).toEqual({ data: [], total: 0 });
      expect(mocks.execute).not.toHaveBeenCalled();
    });
  });
});
