// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Rows the session site lookup returns (the sessions in the user's sites).
const lookup = vi.hoisted(() => ({ rows: [] as Array<{ id: string }>, calls: 0 }));

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin']) chain[m] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => {
    lookup.calls++;
    return Promise.resolve(lookup.rows);
  });
  const t = (name: string) =>
    new Proxy<Record<string, unknown>>({}, { get: (_t, prop: string) => `${name}.${prop}` });
  return {
    db: chain,
    chargingSessions: t('charging_sessions'),
    chargingStations: t('charging_stations'),
    supportCaseAuditLog: t('support_case_audit_log'),
    supportCaseSessions: t('support_case_sessions'),
  };
});

import {
  auditRowSessionRefs,
  messageReferencesForeignSession,
  redactSupportCaseAuditRows,
} from '../lib/support-case-redaction.js';

beforeEach(() => {
  lookup.rows = [];
  lookup.calls = 0;
});

describe('messageReferencesForeignSession', () => {
  const foreign = { sessionIds: new Set(['ses_b']), transactionIds: new Set(['7']) };

  it('matches any message naming a foreign session id', () => {
    expect(
      messageReferencesForeignSession({ senderType: 'operator', body: 'see ses_b' }, foreign),
    ).toBe(true);
    expect(messageReferencesForeignSession({ senderType: 'driver', body: 'ses_a' }, foreign)).toBe(
      false,
    );
  });

  it('matches a system message naming a foreign transaction id as a whole word', () => {
    const sys = (body: string) => ({ senderType: 'system', body });
    expect(
      messageReferencesForeignSession(sys('Refund of $1.00 issued for session 7'), foreign),
    ).toBe(true);
    expect(
      messageReferencesForeignSession(
        sys(
          "Refund of $1.00 requested for session 7; awaiting the payment provider's confirmation",
        ),
        foreign,
      ),
    ).toBe(true);
    expect(messageReferencesForeignSession(sys('Refund issued for session 77'), foreign)).toBe(
      false,
    );
    expect(messageReferencesForeignSession(sys('Status changed from 7 to 8'), foreign)).toBe(false);
    // A driver or operator message is matched by session id only.
    expect(
      messageReferencesForeignSession({ senderType: 'driver', body: 'my session 7' }, foreign),
    ).toBe(false);
  });

  it('escapes regular expression characters in transaction ids', () => {
    const refs = { sessionIds: new Set<string>(), transactionIds: new Set(['a.b']) };
    expect(
      messageReferencesForeignSession({ senderType: 'system', body: 'for session axb' }, refs),
    ).toBe(false);
    expect(
      messageReferencesForeignSession({ senderType: 'system', body: 'for session a.b' }, refs),
    ).toBe(true);
  });
});

describe('auditRowSessionRefs', () => {
  it('reads sessionIds lists and a single sessionId from before and after', () => {
    expect(
      auditRowSessionRefs({ before: { sessionIds: ['s1', 2] }, after: { sessionId: 's2' } }),
    ).toEqual(['s1', 's2']);
    expect(auditRowSessionRefs({ before: null, after: { status: 'open' } })).toEqual([]);
  });
});

describe('redactSupportCaseAuditRows', () => {
  const rows = [
    { entityType: 'support_case', before: null, after: { sessionIds: ['ses_a', 'ses_b'] } },
    { entityType: 'station', before: null, after: { sessionIds: ['ses_b'] } },
  ];

  it('passes every row unchanged for an all-site user, without a lookup', async () => {
    expect(await redactSupportCaseAuditRows(rows, null)).toBe(rows);
    expect(lookup.calls).toBe(0);
  });

  it("keeps only the user's sessions in support case rows", async () => {
    lookup.rows = [{ id: 'ses_a' }];
    const out = await redactSupportCaseAuditRows(rows, ['sit_a']);
    expect(out[0]?.after).toEqual({ sessionIds: ['ses_a'] });
    expect(out[1]).toBe(rows[1]);
  });
});
