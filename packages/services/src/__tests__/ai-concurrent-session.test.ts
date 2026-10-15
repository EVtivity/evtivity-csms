// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  CONCURRENT_SESSION_FIXES,
  concurrentSessionIdOf,
  concurrentSessionStep,
} from '../ai-evidence/concurrent-session.js';
import { buildAuthorizationEvidence } from '../ai-evidence/authorization.js';

const now = new Date('2026-10-15T13:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const limits = { idleMinutes: 90, offlineEndAfterHours: 24, now };
const live = {
  active: true,
  stationOnline: true,
  lastActivityAt: minutesAgo(1),
  connectorStatus: 'charging',
  stationOfflineSince: null,
};

describe('concurrent session of a refused token', () => {
  it('reads the session id from the refusal reason', () => {
    expect(concurrentSessionIdOf('concurrent_session ses_zbgp346aze2k')).toBe('ses_zbgp346aze2k');
    expect(concurrentSessionIdOf('blocked')).toBeNull();
    expect(concurrentSessionIdOf(null)).toBeNull();
  });

  it('waits for a live session: online station, recent activity, connector in use', () => {
    expect(concurrentSessionStep(live, limits)).toBe('wait');
    expect(CONCURRENT_SESSION_FIXES.wait).toEqual([
      'wait_for_concurrent_session',
      'check_shared_token',
    ]);
    expect(CONCURRENT_SESSION_FIXES.wait).not.toContain('end_concurrent_session');
  });

  it('stops a stuck session at an online station: silent past the idle time or connector available', () => {
    expect(concurrentSessionStep({ ...live, lastActivityAt: minutesAgo(91) }, limits)).toBe('stop');
    expect(concurrentSessionStep({ ...live, connectorStatus: 'available' }, limits)).toBe('stop');
    expect(CONCURRENT_SESSION_FIXES.stop).toEqual(['end_concurrent_session']);
  });

  it('restores an offline station first, ends in the CSMS past the offline setting', () => {
    const offline = { ...live, stationOnline: false, stationOfflineSince: minutesAgo(120) };
    expect(concurrentSessionStep(offline, limits)).toBe('restore');
    expect(
      concurrentSessionStep({ ...offline, stationOfflineSince: minutesAgo(25 * 60) }, limits),
    ).toBe('end');
    expect(concurrentSessionStep(offline, { ...limits, offlineEndAfterHours: 1 })).toBe('end');
    expect(CONCURRENT_SESSION_FIXES.end).toEqual(['end_concurrent_session']);
  });

  it('has no step for a session that ended', () => {
    expect(concurrentSessionStep({ ...live, active: false }, limits)).toBeNull();
  });

  it('gives the model the concurrent session state as facts', () => {
    const pack = buildAuthorizationEvidence(
      {
        stationDbId: 'sta_1',
        siteId: null,
        idToken: 'RFID-000123',
        attempts: [],
        token: null,
        localList: null,
        concurrentSession: {
          ...live,
          sessionId: 'ses_1',
          stationId: 'sta_2',
          stationOcppId: 'CS-1853',
          startedAt: minutesAgo(60),
          step: 'wait',
        },
      },
      'auth_subject',
    );
    expect(pack.facts['concurrentSession']).toMatchObject({
      active: true,
      live: true,
      stationOnline: true,
      suggestedStep: 'wait',
      connectorStatus: 'charging',
    });
  });
});
