// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { classifyDisconnect, type OfflineCauseContext } from '../sim-offline-cause.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const H = 3_600_000;
const t = (hoursBeforeNow: number): Date => new Date(NOW.getTime() - hoursBeforeNow * H);

function ctx(overrides: Partial<OfflineCauseContext> = {}): OfflineCauseContext {
  return {
    sessions: [],
    alerts: [],
    openSessionBeganAt: null,
    lastFetchedAt: null,
    reportingDelayHours: 6,
    now: NOW,
    coverage: [{ from: t(100), to: NOW }],
    ...overrides,
  };
}

const at = t(48);

describe('classifyDisconnect', () => {
  it('is server for a CSMS restart and for the offline sweep', () => {
    expect(classifyDisconnect({ at, reason: 'server_shutdown' }, ctx())).toBe('server');
    expect(classifyDisconnect({ at, reason: 'offline_sweep' }, ctx())).toBe('server');
  });

  it('puts server before every SIM label', () => {
    const sessions = [{ startedAt: t(50), endedAt: t(46) }];
    expect(classifyDisconnect({ at, reason: 'server_shutdown' }, ctx({ sessions }))).toBe('server');
  });

  it('is sim_account for a data limit alert in the day before', () => {
    const alerts = [{ kind: 'data_limit', receivedAt: t(60) }];
    expect(classifyDisconnect({ at, reason: null }, ctx({ alerts }))).toBe('sim_account');
  });

  it('is sim_account for a data limit alert up to an hour after', () => {
    const alerts = [{ kind: 'data_limit', receivedAt: t(47.5) }];
    expect(classifyDisconnect({ at, reason: null }, ctx({ alerts }))).toBe('sim_account');
  });

  it('ignores a data limit alert outside the window', () => {
    const before = [{ kind: 'data_limit', receivedAt: t(73) }];
    const after = [{ kind: 'data_limit', receivedAt: t(46.5) }];
    expect(classifyDisconnect({ at, reason: null }, ctx({ alerts: before }))).toBe('unknown');
    expect(classifyDisconnect({ at, reason: null }, ctx({ alerts: after }))).toBe('unknown');
  });

  it('ignores a data limit alert when a later session shows the SIM active again', () => {
    const alerts = [{ kind: 'data_limit', receivedAt: t(60) }];
    const sessions = [{ startedAt: t(55), endedAt: t(54) }];
    expect(classifyDisconnect({ at, reason: null }, ctx({ alerts, sessions }))).toBe('unknown');
  });

  it('ignores a data limit alert when a later attach alert shows the SIM active again', () => {
    const alerts = [
      { kind: 'data_limit', receivedAt: t(60) },
      { kind: 'device_changed', receivedAt: t(55) },
    ];
    expect(classifyDisconnect({ at, reason: null }, ctx({ alerts }))).toBe('unknown');
  });

  it('does not take a data warning for a pause', () => {
    const alerts = [{ kind: 'data_warning', receivedAt: t(49) }];
    expect(classifyDisconnect({ at, reason: null }, ctx({ alerts }))).toBe('unknown');
  });

  it('is station when a stored session spans the disconnect', () => {
    const sessions = [{ startedAt: t(50), endedAt: t(46) }];
    expect(classifyDisconnect({ at, reason: null }, ctx({ sessions }))).toBe('station');
  });

  it('is station when the open session of the last Refresh began before it', () => {
    expect(
      classifyDisconnect(
        { at, reason: null },
        ctx({ openSessionBeganAt: t(50), lastFetchedAt: t(1) }),
      ),
    ).toBe('station');
  });

  it('does not trust an open session seen before the disconnect', () => {
    expect(
      classifyDisconnect(
        { at, reason: null },
        ctx({ openSessionBeganAt: t(50), lastFetchedAt: t(49) }),
      ),
    ).toBe('unknown');
  });

  it('is network when stored sessions bracket the disconnect', () => {
    const sessions = [
      { startedAt: t(52), endedAt: t(49) },
      { startedAt: t(47), endedAt: t(45) },
    ];
    expect(classifyDisconnect({ at, reason: null }, ctx({ sessions }))).toBe('network');
  });

  it('is network when the open session began after the disconnect', () => {
    const sessions = [{ startedAt: t(52), endedAt: t(49) }];
    expect(
      classifyDisconnect(
        { at, reason: null },
        ctx({ sessions, openSessionBeganAt: t(40), lastFetchedAt: t(1) }),
      ),
    ).toBe('network');
  });

  it('is not network when the disconnect falls in a period never fetched', () => {
    const sessions = [
      { startedAt: t(52), endedAt: t(49) },
      { startedAt: t(47), endedAt: t(45) },
    ];
    // Fetched before and after the disconnect, not around it: a session may be missing there.
    const coverage = [
      { from: t(100), to: t(49) },
      { from: t(47), to: NOW },
    ];
    expect(classifyDisconnect({ at, reason: null }, ctx({ sessions, coverage }))).toBe('unknown');
    expect(classifyDisconnect({ at, reason: null }, ctx({ sessions, coverage: [] }))).toBe(
      'unknown',
    );
    const recent = [
      { startedAt: t(9), endedAt: t(5) },
      { startedAt: t(3), endedAt: t(2.5) },
    ];
    expect(
      classifyDisconnect(
        { at: t(4), reason: null },
        ctx({ sessions: recent, coverage: [{ from: t(100), to: t(4.5) }] }),
      ),
    ).toBe('pending');
  });

  it('is pending inside the reporting delay without a covering session', () => {
    expect(classifyDisconnect({ at: t(2), reason: null }, ctx())).toBe('pending');
    const sessions = [{ startedAt: t(9), endedAt: t(8) }];
    expect(classifyDisconnect({ at: t(5), reason: null }, ctx({ sessions }))).toBe('pending');
  });

  it('is unknown without stored data for that time', () => {
    expect(classifyDisconnect({ at, reason: null }, ctx())).toBe('unknown');
    expect(classifyDisconnect({ at, reason: 'ping_timeout' }, ctx())).toBe('unknown');
  });

  it('is unknown with a session only before it', () => {
    const sessions = [{ startedAt: t(60), endedAt: t(55) }];
    expect(classifyDisconnect({ at, reason: null }, ctx({ sessions }))).toBe('unknown');
  });
});
