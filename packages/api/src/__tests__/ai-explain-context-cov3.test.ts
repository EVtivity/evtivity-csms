// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[][],
  reservationEnabled: true,
  insightVisible: true,
  siteIds: null as string[] | null,
  selects: 0,
}));

vi.mock('@evtivity/database', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where']) c[m] = vi.fn(() => c);
  c['limit'] = vi.fn(async () => h.rows.shift() ?? []);
  return {
    db: {
      select: vi.fn(() => {
        h.selects++;
        return c;
      }),
    },
    aiInsights: {},
    chargingStations: {},
    chargingSessions: {},
    authorizeAttempts: {},
    reservations: {},
    isReservationEnabled: vi.fn(async () => h.reservationEnabled),
  };
});
vi.mock('../lib/ai-insight-scope.js', () => ({
  insightRowVisible: vi.fn(async () => h.insightVisible),
}));
vi.mock('../lib/site-access.js', () => ({ getUserSiteIds: vi.fn(async () => h.siteIds) }));

import {
  EXPLAIN_READ_PERMISSION,
  explainContextForTurn,
  explainPromptBlock,
  resolveExplainSubject,
} from '../services/ai/engine/explain-context.js';
import type { ExplainAccess } from '../services/ai/engine/explain-context.js';
import type { AiContextKind } from '@evtivity/lib/ai-insights';

const hasPermission = vi.fn(async (_p: string) => true);
const ACCESS: ExplainAccess = { userId: 'usr_1', hasPermission };

beforeEach(() => {
  h.rows = [];
  h.reservationEnabled = true;
  h.insightVisible = true;
  h.siteIds = null;
  h.selects = 0;
  hasPermission.mockImplementation(async () => true);
});

describe('resolveExplainSubject', () => {
  it('refuses an unknown kind without reading anything', async () => {
    const res = await resolveExplainSubject('toString' as AiContextKind, 'x', ACCESS);
    expect(res).toEqual({ status: 'forbidden' });
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it('checks the read permission of the kind before reading the record', async () => {
    hasPermission.mockImplementation(async () => false);
    expect(await resolveExplainSubject('session', 's1', ACCESS)).toEqual({ status: 'forbidden' });
    expect(hasPermission).toHaveBeenCalledWith(EXPLAIN_READ_PERMISSION.session);
    expect(h.selects).toBe(0);
  });

  it('loads a station', async () => {
    h.rows = [[{ id: 'sta_1', ocppStationId: 'CS-1', siteId: 'site_1' }]];
    expect(await resolveExplainSubject('station', 'sta_1', ACCESS)).toEqual({
      status: 'ok',
      subject: {
        kind: 'station',
        id: 'sta_1',
        siteId: 'site_1',
        label: 'CS-1',
        stationId: 'sta_1',
        ocppStationId: 'CS-1',
        sessionId: null,
        authorizeAttemptId: null,
        reservationId: null,
        insightId: null,
      },
    });
  });

  it('answers missing for a record that does not exist', async () => {
    for (const kind of ['station', 'session', 'reservation', 'insight'] as const) {
      expect(await resolveExplainSubject(kind, 'x', ACCESS)).toEqual({ status: 'missing' });
    }
    expect(await resolveExplainSubject('authorization', '5', ACCESS)).toEqual({
      status: 'missing',
    });
  });

  it('loads a session by its own site', async () => {
    h.rows = [[{ id: 'ses_1', stationDbId: 'sta_1', ocppStationId: 'CS-1', siteId: 'site_2' }]];
    h.siteIds = ['site_2'];
    const res = await resolveExplainSubject('session', 'ses_1', ACCESS);
    expect(res).toMatchObject({
      status: 'ok',
      subject: { kind: 'session', siteId: 'site_2', sessionId: 'ses_1', stationId: 'sta_1' },
    });
  });

  it('refuses a record outside the caller sites and an unsited one for a site user', async () => {
    h.siteIds = ['site_1'];
    h.rows = [[{ id: 'sta_1', ocppStationId: 'CS-1', siteId: 'site_9' }]];
    expect(await resolveExplainSubject('station', 'sta_1', ACCESS)).toEqual({
      status: 'forbidden',
    });
    h.rows = [[{ id: 'sta_1', ocppStationId: 'CS-1', siteId: null }]];
    expect(await resolveExplainSubject('station', 'sta_1', ACCESS)).toEqual({
      status: 'forbidden',
    });
  });

  it('treats a non-serial authorization id as missing without a query', async () => {
    for (const id of ['abc', '0', '01', '-1', '2147483648', '12345678901']) {
      expect(await resolveExplainSubject('authorization', id, ACCESS)).toEqual({
        status: 'missing',
      });
    }
    expect(h.selects).toBe(0);
  });

  it('loads an authorization attempt by its serial id', async () => {
    h.rows = [[{ id: 42, ocppStationId: 'CS-9', stationDbId: null, siteId: null }]];
    const res = await resolveExplainSubject('authorization', '42', ACCESS);
    expect(res).toMatchObject({
      status: 'ok',
      subject: { kind: 'authorization', authorizeAttemptId: 42, label: 'CS-9', stationId: null },
    });
  });

  it('loads a reservation, and none while reservations are off', async () => {
    h.rows = [
      [
        {
          id: 'rsv_1',
          ocppReservationId: 7,
          stationDbId: 'sta_1',
          ocppStationId: 'CS-1',
          siteId: 'site_1',
        },
      ],
    ];
    expect(await resolveExplainSubject('reservation', 'rsv_1', ACCESS)).toMatchObject({
      status: 'ok',
      subject: { label: '#7', reservationId: 'rsv_1' },
    });
    h.reservationEnabled = false;
    expect(await resolveExplainSubject('reservation', 'rsv_1', ACCESS)).toEqual({
      status: 'missing',
    });
  });

  it('loads a visible insight and hides one the insight gate refuses', async () => {
    const insight = {
      id: 'ins_1',
      kind: 'station_offline',
      siteId: 'site_1',
      stationDbId: 'sta_1',
      ocppStationId: 'CS-1',
      sessionId: 'ses_1',
      reservationId: null,
    };
    h.rows = [[insight]];
    expect(await resolveExplainSubject('insight', 'ins_1', ACCESS)).toMatchObject({
      status: 'ok',
      subject: { kind: 'insight', label: 'ins_1', insightId: 'ins_1', sessionId: 'ses_1' },
    });
    h.insightVisible = false;
    h.rows = [[insight]];
    expect(await resolveExplainSubject('insight', 'ins_1', ACCESS)).toEqual({
      status: 'missing',
    });
  });
});

describe('explainContextForTurn', () => {
  it('is null for an ordinary conversation', async () => {
    expect(await explainContextForTurn({ contextKind: null, contextId: 'x' }, ACCESS)).toBeNull();
    expect(
      await explainContextForTurn({ contextKind: 'station', contextId: null }, ACCESS),
    ).toBeNull();
  });

  it("is 'forbidden' when the caller lost access", async () => {
    hasPermission.mockImplementation(async () => false);
    expect(
      await explainContextForTurn({ contextKind: 'station', contextId: 'sta_1' }, ACCESS),
    ).toBe('forbidden');
  });

  it('carries a deleted record as missing', async () => {
    expect(
      await explainContextForTurn({ contextKind: 'station', contextId: 'sta_1' }, ACCESS),
    ).toEqual({ kind: 'station', id: 'sta_1', resolution: { status: 'missing' } });
  });
});

describe('explainPromptBlock', () => {
  it('says a missing record is no longer available', () => {
    const text = explainPromptBlock({
      kind: 'session',
      id: 's',
      resolution: { status: 'missing' },
    });
    expect(text).toContain('the session record this conversation was opened from');
  });

  it('lists every id the subject holds, the authorization attempt included', () => {
    const text = explainPromptBlock({
      kind: 'insight',
      id: 'ins_1',
      resolution: {
        status: 'ok',
        subject: {
          kind: 'insight',
          id: 'ins_1',
          siteId: null,
          label: null,
          stationId: null,
          ocppStationId: null,
          sessionId: 'ses_1',
          authorizeAttemptId: 9,
          reservationId: 'rsv_1',
          insightId: 'ins_1',
        },
      },
    });
    const json = /<untrusted[^>]*>\n?([\s\S]*?)\n?<\/untrusted>/.exec(text)?.[1] ?? '';
    expect(JSON.parse(json)).toEqual({
      kind: 'insight',
      id: 'ins_1',
      sessionId: 'ses_1',
      reservationId: 'rsv_1',
      insightId: 'ins_1',
      authorizeAttemptId: 9,
    });
  });
});
