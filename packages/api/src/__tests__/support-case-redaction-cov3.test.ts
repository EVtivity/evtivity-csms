// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({ results: [] as unknown[][], index: 0, selects: 0 }));

vi.mock('@evtivity/database', async () => {
  const { pgTable, text, jsonb } = await import('drizzle-orm/pg-core');
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from']) c[m] = () => c;
    c['where'] = () => {
      const r = h.results[h.index] ?? [];
      h.index++;
      return Promise.resolve(r);
    };
    return c;
  };
  return {
    db: {
      select: () => {
        h.selects++;
        return chain();
      },
    },
    chargingSessions: pgTable('charging_sessions', {
      id: text('id'),
      siteId: text('site_id'),
      transactionId: text('transaction_id'),
    }),
    supportCaseSessions: pgTable('support_case_sessions', {
      caseId: text('case_id'),
      sessionId: text('session_id'),
    }),
    supportCaseAuditLog: pgTable('support_case_audit_log', {
      supportCaseId: text('support_case_id'),
      action: text('action'),
      before: jsonb('before'),
      after: jsonb('after'),
    }),
  };
});

import {
  foreignCaseSessionRefs,
  redactSupportCaseAuditRows,
  sessionIdsInSites,
  supportCaseAuditSessionCondition,
} from '../lib/support-case-redaction.js';

const dialect = new PgDialect();

beforeEach(() => {
  h.results = [];
  h.index = 0;
  h.selects = 0;
});

describe('supportCaseAuditSessionCondition', () => {
  it('is false for a user without sites', () => {
    expect(dialect.sqlToQuery(supportCaseAuditSessionCondition([])).sql).toBe('false');
  });

  it('keeps rows of other actions and session rows naming a session of the user sites', () => {
    const q = dialect.sqlToQuery(supportCaseAuditSessionCondition(['sit_1', 'sit_2']));
    expect(q.sql).toContain('"support_case_audit_log".action::text NOT IN ($1, $2, $3)');
    expect(q.sql).toContain('jsonb_array_elements_text');
    expect(q.sql).toContain('"charging_sessions"."site_id" IN ($4, $5)');
    expect(q.params).toEqual([
      'sessions_linked',
      'sessions_unlinked',
      'refund_issued',
      'sit_1',
      'sit_2',
    ]);
  });
});

describe('sessionIdsInSites', () => {
  it('reads nothing for no ids or no sites', async () => {
    expect(await sessionIdsInSites([], ['sit_1'])).toEqual(new Set());
    expect(await sessionIdsInSites(['ses_a'], [])).toEqual(new Set());
    expect(h.selects).toBe(0);
  });
});

describe('redactSupportCaseAuditRows', () => {
  it('returns the rows unchanged when none is a support case row', async () => {
    const rows = [{ entityType: 'station', before: { sessionIds: ['ses_b'] }, after: null }];
    expect(await redactSupportCaseAuditRows(rows, ['sit_1'])).toBe(rows);
    expect(h.selects).toBe(0);
  });

  it('keeps an array or scalar snapshot as it is', async () => {
    h.results = [[{ id: 'ses_a' }]];
    const rows = [
      { entityType: 'support_case', before: ['ses_b'], after: 'text' },
      { entityType: 'support_case', before: null, after: { sessionIds: ['ses_a', 'ses_b', 3] } },
    ];
    const out = await redactSupportCaseAuditRows(rows, ['sit_1']);
    expect(out[0]).toEqual(rows[0]);
    expect(out[1]?.after).toEqual({ sessionIds: ['ses_a'] });
  });
});

describe('foreignCaseSessionRefs', () => {
  it('is empty for an all-site user without reading', async () => {
    const refs = await foreignCaseSessionRefs('cas_1', null);
    expect(refs.sessionIds.size).toBe(0);
    expect(refs.transactionIds.size).toBe(0);
    expect(h.selects).toBe(0);
  });

  it('is empty when the case references no session', async () => {
    h.results = [[], [{ before: null, after: { note: 'x' } }]];
    const refs = await foreignCaseSessionRefs('cas_1', ['sit_1']);
    expect(refs.sessionIds.size).toBe(0);
    expect(h.selects).toBe(2);
  });

  it('is empty when every referenced session ran at the user sites', async () => {
    h.results = [
      [{ sessionId: 'ses_a' }],
      [{ before: null, after: { sessionId: 'ses_a' } }],
      [{ id: 'ses_a' }],
    ];
    const refs = await foreignCaseSessionRefs('cas_1', ['sit_1']);
    expect(refs.sessionIds.size).toBe(0);
    expect(h.selects).toBe(3);
  });

  it('returns the foreign sessions of the links and audit rows with their transaction ids', async () => {
    h.results = [
      [{ sessionId: 'ses_a' }, { sessionId: 'ses_b' }],
      [
        { before: { sessionIds: ['ses_c'] }, after: null },
        { before: null, after: { sessionId: 'ses_a' } },
      ],
      [{ id: 'ses_a' }],
      [{ transactionId: 'tx-9' }, { transactionId: '' }],
    ];
    const refs = await foreignCaseSessionRefs('cas_1', ['sit_1']);
    expect([...refs.sessionIds].sort()).toEqual(['ses_b', 'ses_c']);
    expect([...refs.transactionIds]).toEqual(['tx-9']);
  });
});
