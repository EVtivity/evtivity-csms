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
import {
  softResetProposal,
  stationOfflineMinutes,
  stuckSessionCase,
  stuckSessionProposal,
  workerAction,
} from '../ai-workers/proposals.js';
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
  const offlineSince = new Date(Date.now() - 30 * 3_600_000);
  const session = {
    sessionId: 'ses_000000000001',
    stationId: 'sta_000000000001',
    ocppStationId: 'CS-1',
    ocppProtocol: 'ocpp1.6',
    ocppEvseId: 2,
    transactionId: '42',
    siteId: 'sit_000000000001',
    reason: 'station_offline' as const,
    stationOfflineSince: offlineSince as Date | null,
    energyWh: 14_800,
    currentCostCents: 518 as number | null,
    currency: 'EUR',
    startedAt: new Date(Date.now() - 3 * 3_600_000),
    lastActivityAt: new Date(Date.now() - 2 * 3_600_000),
  };
  const online = (reason: 'no_activity' | 'connector_available') => ({
    ...session,
    reason,
    stationOfflineSince: null,
  });
  const opts = {
    idleMinutes: 90,
    offlineEndAfterHours: 24,
    expiresAt: new Date(Date.now() + 3_600_000),
    workerRunId: 7,
    period: '2026-10-10T10:15',
    now: new Date(),
  };
  const offlineInsight = {
    kind: 'stuck_session',
    siteId: 'sit_000000000001',
    stationId: 'sta_000000000001',
    sessionId: 'ses_000000000001',
    narrative: null,
    rootCause: { category: 'connectivity', confidence: 'high' },
    fixes: ['check_power_supply', 'check_network_connection', 'contact_site'],
    scope: { stationOffline: { since: offlineSince.toISOString() } },
  };

  it('TC-AI-WK-04 ends the session of a station offline past the setting in the CSMS', () => {
    const suggestion = stuckSessionProposal(session, opts);
    expect(suggestion?.action).toEqual({
      job: 'stuck_sessions',
      workerRunId: 7,
      siteId: 'sit_000000000001',
      stationId: 'sta_000000000001',
      sessionId: 'ses_000000000001',
      operationId: 'endSession',
      method: 'POST',
      path: '/v1/sessions/{id}/end',
      args: { id: 'ses_000000000001' },
      summary: {
        action: 'end_session',
        stationId: 'CS-1',
        transactionId: '42',
        reason: 'station_offline',
        rationale: { code: 'stuckSessionOffline', params: { minutes: 120 } },
        lastActivityAt: session.lastActivityAt.toISOString(),
        transactionOngoing: null,
        billing: {
          code: 'stuckSessionEnd',
          params: { energyWh: 14_800, costCents: 518, currency: 'EUR' },
        },
      },
      precondition: {
        kind: 'session_active',
        params: { sessionId: 'ses_000000000001', transactionId: '42', stationOnline: false },
      },
      dedupKey: 'stuck_sessions:ses_000000000001',
      expiresAt: opts.expiresAt,
      actor: { actor: 'system', actorLabel: 'ai-stuck_sessions' },
    });
    // The end insight still leads with getting the station back online.
    expect(suggestion?.insight).toEqual({
      ...offlineInsight,
      triggerKey: 'stuck_sessions:ses_000000000001:2026-10-10T10:15',
    });
  });

  it('TC-AI-WK-04 advises restoring an offline station before the setting, with no action', () => {
    const recent = { ...session, stationOfflineSince: new Date(Date.now() - 2 * 3_600_000) };
    const suggestion = stuckSessionProposal(recent, opts);
    expect(suggestion?.action).toBeNull();
    // One advice insight per session, whatever the run period.
    expect(suggestion?.insight).toEqual({
      ...offlineInsight,
      scope: { stationOffline: { since: recent.stationOfflineSince.toISOString() } },
      triggerKey: 'stuck_sessions:ses_000000000001:offline',
    });
    expect(stuckSessionCase(recent, opts)).toBe('offline_advice');
    expect(stuckSessionCase(recent, { ...opts, offlineEndAfterHours: 1 })).toBe('offline_end');
    expect(stuckSessionCase(session, opts)).toBe('offline_end');
    expect(stuckSessionCase(online('no_activity'), opts)).toBe('stop');
  });

  it('measures how long the station is offline', () => {
    expect(stationOfflineMinutes(session, opts.now)).toBe(30 * 60);
    expect(stationOfflineMinutes(online('no_activity'), opts.now)).toBeNull();
  });

  it.each(['no_activity', 'connector_available'] as const)(
    'TC-AI-WK-04 stops the session at its online station through the EVSE stop (%s)',
    (reason) => {
      const suggestion = stuckSessionProposal(online(reason), opts);
      expect(suggestion?.action).toMatchObject({
        operationId: 'stopActiveEvseSession',
        method: 'POST',
        path: '/v1/stations/{id}/evses/{evseId}/stop-active-session',
        // The internal station id and the session's OCPP EVSE number, for 1.6 and 2.1 alike.
        args: { id: 'sta_000000000001', evseId: 2 },
        summary: {
          action: 'stop_transaction',
          stationId: 'CS-1',
          transactionId: '42',
          billing: {
            code: 'stuckSessionStop',
            params: { energyWh: 14_800, costCents: 518, currency: 'EUR' },
          },
        },
        precondition: {
          kind: 'session_active',
          params: { sessionId: 'ses_000000000001', transactionId: '42', stationOnline: true },
        },
      });
      // No offline advice on an online station.
      expect(suggestion?.insight).not.toHaveProperty('fixes');
      expect(suggestion?.insight).not.toHaveProperty('scope');
    },
  );

  it('skips the stop of an online station when the session has no known EVSE', () => {
    expect(stuckSessionProposal({ ...online('no_activity'), ocppEvseId: null }, opts)).toBeNull();
    // The CSMS end needs no EVSE.
    expect(stuckSessionProposal({ ...session, ocppEvseId: null }, opts)?.action?.operationId).toBe(
      'endSession',
    );
  });

  it('gives the billing params of an unpriced session a null cost', () => {
    const suggestion = stuckSessionProposal(
      { ...session, currentCostCents: null, energyWh: 0 },
      opts,
    );
    expect(suggestion?.action?.summary).toMatchObject({
      billing: { code: 'stuckSessionEnd', params: { energyWh: 0, costCents: null } },
    });
  });

  it('gives a stuck session the root cause of its reason', () => {
    expect(stuckSessionProposal(session, opts)?.insight.rootCause).toEqual({
      category: 'connectivity',
      confidence: 'high',
    });
    expect(stuckSessionProposal(online('connector_available'), opts)?.insight.rootCause).toEqual({
      category: 'connectivity',
      confidence: 'medium',
    });
    expect(stuckSessionProposal(online('no_activity'), opts)?.insight.rootCause).toEqual({
      category: 'unknown',
      confidence: 'low',
    });
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

  it('keeps a 1.6 transaction id that is not an integer: the session routes take any id', () => {
    expect(
      stuckSessionProposal({ ...session, transactionId: 'abc' }, opts)?.action?.summary,
    ).toMatchObject({ transactionId: 'abc' });
  });

  it('uses the 2.1 action for a station that never connected', () => {
    expect(workerAction('soft_reset', null)).toMatchObject({
      operationId: 'ocppv21_Reset',
      fixedArgs: { type: 'OnIdle' },
    });
  });

  it('uses the same session actions for OCPP 1.6 and 2.1', () => {
    for (const protocol of ['ocpp1.6', 'ocpp2.1', null]) {
      expect(workerAction('stop_transaction', protocol).operationId).toBe('stopActiveEvseSession');
      expect(workerAction('end_session', protocol).operationId).toBe('endSession');
    }
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
