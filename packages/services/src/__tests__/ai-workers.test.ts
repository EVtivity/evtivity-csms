// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileTemplate } from '@evtivity/lib';
import {
  STALE_CLEANUP_MARGIN_MINUTES,
  SIGNAL_GRACE_MINUTES,
  effectiveIdleMinutes,
} from '../ai-workers/stuck-sessions.js';
import { softResetProposal, stopSessionProposal, workerAction } from '../ai-workers/proposals.js';
import { dayPeriod, quarterHourPeriod } from '../ai-workers/runs.js';

describe('stuck-session idle time (TC-AI-WK-04)', () => {
  it('TC-AI-WK-04 keeps the idle time below the stale-session timeout', () => {
    expect(effectiveIdleMinutes(90, 24)).toBe(90);
    expect(effectiveIdleMinutes(1440, 24)).toBe(24 * 60 - STALE_CLEANUP_MARGIN_MINUTES);
    expect(effectiveIdleMinutes(1440, 2)).toBe(60);
    expect(effectiveIdleMinutes(5, 24)).toBe(SIGNAL_GRACE_MINUTES);
    expect(effectiveIdleMinutes(90, 1)).toBe(SIGNAL_GRACE_MINUTES);
    // A timeout of 0 turns the stale cleanup off: the setting is used as is.
    expect(effectiveIdleMinutes(1440, 0)).toBe(1440);
  });
});

describe('worker suggestions', () => {
  const session = {
    sessionId: 'ses_000000000001',
    stationId: 'sta_000000000001',
    ocppStationId: 'CS-1',
    ocppProtocol: 'ocpp1.6',
    transactionId: '42',
    siteId: 'sit_000000000001',
    reason: 'station_offline' as const,
    startedAt: new Date(Date.now() - 3 * 3_600_000),
    lastActivityAt: new Date(Date.now() - 2 * 3_600_000),
  };
  const opts = {
    idleMinutes: 90,
    expiresAt: new Date(Date.now() + 3_600_000),
    workerRunId: 7,
    period: '2026-10-10T10:15',
    now: new Date(),
  };

  it('TC-AI-WK-04 stops a 1.6 session with an integer transaction id, as a stuck session insight', () => {
    const suggestion = stopSessionProposal(session, opts);
    expect(suggestion?.action).toMatchObject({
      job: 'stuck_sessions',
      operationId: 'ocppv16_RemoteStopTransaction',
      args: { stationId: 'CS-1', transactionId: 42 },
      dedupKey: 'stuck_sessions:ses_000000000001',
      summary: { action: 'stop_transaction', rationale: { code: 'stuckSessionOffline' } },
    });
    expect(suggestion?.insight).toEqual({
      kind: 'stuck_session',
      siteId: 'sit_000000000001',
      stationId: 'sta_000000000001',
      sessionId: 'ses_000000000001',
      triggerKey: 'stuck_sessions:ses_000000000001:2026-10-10T10:15',
      narrative: null,
      rootCause: { category: 'connectivity', confidence: 'high' },
    });
  });

  it('gives a stuck session the root cause of its reason', () => {
    const rootCause = (reason: 'no_activity' | 'station_offline' | 'connector_available') =>
      stopSessionProposal({ ...session, reason }, opts)?.insight.rootCause;
    expect(rootCause('station_offline')).toEqual({ category: 'connectivity', confidence: 'high' });
    expect(rootCause('connector_available')).toEqual({
      category: 'connectivity',
      confidence: 'medium',
    });
    expect(rootCause('no_activity')).toEqual({ category: 'unknown', confidence: 'low' });
  });

  it('suggests a soft reset of a long faulted station as a station insight, one per day', () => {
    const suggestion = softResetProposal(
      {
        stationId: 'sta_000000000001',
        ocppStationId: 'CS-1',
        ocppProtocol: 'ocpp2.1',
        siteId: 'sit_000000000001',
        faultedSince: new Date('2026-10-10T01:00:00Z'),
      },
      { expiresAt: new Date(Date.now() + 3_600_000), workerRunId: 7, period: '2026-10-10' },
    );
    expect(suggestion.insight).toMatchObject({
      kind: 'station_long_faulted',
      stationId: 'sta_000000000001',
      sessionId: null,
      triggerKey: 'network_summary:soft_reset:sta_000000000001:2026-10-10',
    });
    expect(suggestion.action).toMatchObject({
      job: 'network_summary',
      operationId: 'ocppv21_Reset',
      args: { stationId: 'CS-1', type: 'OnIdle' },
      precondition: { kind: 'station_faulted', params: { stationId: 'sta_000000000001' } },
    });
  });

  it('skips a 1.6 session whose transaction id is not an integer', () => {
    expect(stopSessionProposal({ ...session, transactionId: 'abc' }, opts)).toBeNull();
  });

  it('uses the 2.1 action for a station that never connected', () => {
    expect(workerAction('soft_reset', null)).toMatchObject({
      operationId: 'ocppv21_Reset',
      fixedArgs: { type: 'OnIdle' },
    });
  });

  it('names the run periods in UTC', () => {
    const at = new Date('2026-10-10T10:22:31Z');
    expect(dayPeriod(at)).toBe('2026-10-10');
    expect(quarterHourPeriod(at)).toBe('2026-10-10T10:15');
  });
});

describe('AI insight action digest templates (TC-AI-WK-14)', () => {
  const variables = {
    firstName: 'Ada',
    lastName: 'Lovelace',
    digestDate: '2026-10-10',
    pendingCount: 3,
    stuckSessionsCount: 2,
    networkSummaryCount: 1,
    siteCount: 2,
    siteNames: 'Site A, Site B',
    insightsUrl: 'https://csms.example.com/ai/insights?status=pending',
    companyName: 'EVtivity',
  };

  for (const language of ['en', 'de', 'es', 'ko', 'zh', 'zh-TW']) {
    it(`TC-AI-WK-14 renders the digest in ${language} with structured content only`, () => {
      const dir = resolve(
        import.meta.dirname,
        '../../../api/src/templates',
        language,
        'ai/ProposalDigest',
      );
      const email = compileTemplate(readFileSync(`${dir}/email.hbs`, 'utf8'), variables);
      const subject = compileTemplate(readFileSync(`${dir}/subject.hbs`, 'utf8'), variables);
      expect(email).toContain('https://csms.example.com/ai/insights?status');
      expect(email).toContain('Site A, Site B');
      expect(email).toContain('3');
      expect(subject).toContain('EVtivity');
      expect(subject).toContain('3');
      expect(email).not.toContain('{{');
    });
  }
});
