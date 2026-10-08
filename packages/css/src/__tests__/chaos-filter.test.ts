// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { filterChaosActions } from '../chaos-orchestrator.js';

const STATE_MUTATING_ACTIONS = [
  { name: 'plugIn' },
  { name: 'unplug' },
  { name: 'authorize' },
  { name: 'startCharging' },
  { name: 'stopCharging' },
  { name: 'injectFault' },
  { name: 'clearFault' },
  { name: 'suspendCharging' },
  { name: 'resumeCharging' },
  { name: 'comeOnline' },
  { name: 'goOffline' },
  { name: 'sendStatusNotification' },
  { name: 'sendBootNotification' },
];

const NOTIFICATION_ACTIONS = [
  { name: 'sendHeartbeat' },
  { name: 'sendMeterValues' },
  { name: 'sendNotifyEvent' },
  { name: 'sendDataTransfer' },
];

const ALL_ACTIONS = [...STATE_MUTATING_ACTIONS, ...NOTIFICATION_ACTIONS];

function names(actions: Array<{ name: string }>): string[] {
  return actions.map((a) => a.name);
}

describe('filterChaosActions', () => {
  it('lets all notifications through when station is available', () => {
    const result = names(filterChaosActions(ALL_ACTIONS, 'available', 'Available'));
    for (const n of names(NOTIFICATION_ACTIONS)) {
      expect(result).toContain(n);
    }
  });

  it('available state: allows plugIn, authorize, goOffline, injectFault, sendStatusNotification', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'available', 'Available'));
    expect(result.sort()).toEqual(
      ['plugIn', 'authorize', 'goOffline', 'injectFault', 'sendStatusNotification'].sort(),
    );
  });

  it('available + plugged connector: also allows startCharging and unplug', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'available', 'Preparing'));
    expect(result).toContain('startCharging');
    expect(result).toContain('unplug');
  });

  it('available + Occupied connector also allows startCharging and unplug', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'available', 'Occupied'));
    expect(result).toContain('startCharging');
    expect(result).toContain('unplug');
  });

  it('charging state: stop, unplug, fault, offline, suspend and resume', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'charging', 'Charging'));
    expect(result.sort()).toEqual(
      [
        'stopCharging',
        'unplug',
        'injectFault',
        'goOffline',
        'suspendCharging',
        'resumeCharging',
      ].sort(),
    );
  });

  it('a session kept through a fault (Faulted connector) can only clear it or go offline', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'charging', 'Faulted'));
    expect(result.sort()).toEqual(['clearFault', 'goOffline'].sort());
  });

  it('charging state never returns startCharging', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'charging', 'Charging'));
    expect(result).not.toContain('startCharging');
    expect(result).not.toContain('plugIn');
    expect(result).not.toContain('authorize');
    expect(result).not.toContain('sendStatusNotification');
  });

  it('faulted state: only clearFault and goOffline', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'faulted', 'Faulted'));
    expect(result.sort()).toEqual(['clearFault', 'goOffline'].sort());
  });

  it('disconnected state: only comeOnline among state-mutating', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'disconnected', 'Available'));
    expect(result).toEqual(['comeOnline']);
  });

  it('disconnected state still passes notifications through', () => {
    // Notifications are not state-mutating, so they pass even when disconnected.
    // SimulatorManager will drop them on a closed socket; that's acceptable.
    const result = names(filterChaosActions(NOTIFICATION_ACTIONS, 'disconnected', 'Available'));
    expect(result.sort()).toEqual(names(NOTIFICATION_ACTIONS).sort());
  });

  it('booting state: no state-mutating actions valid', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'booting', 'Available'));
    expect(result).toEqual([]);
  });

  it('unavailable state: only comeOnline and sendStatusNotification', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'unavailable', 'Unavailable'));
    expect(result.sort()).toEqual(['comeOnline', 'sendStatusNotification'].sort());
  });

  it('does not allow startCharging in available state when connector is Available (no cable)', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'available', 'Available'));
    expect(result).not.toContain('startCharging');
  });

  it('Finishing connector: only unplug, goOffline, injectFault allowed', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'available', 'Finishing'));
    expect(result.sort()).toEqual(['unplug', 'goOffline', 'injectFault'].sort());
  });

  it('Finishing connector: excludes authorize and plugIn (avoids charging->preparing->finishing race)', () => {
    const result = names(filterChaosActions(STATE_MUTATING_ACTIONS, 'available', 'Finishing'));
    expect(result).not.toContain('authorize');
    expect(result).not.toContain('plugIn');
    expect(result).not.toContain('startCharging');
    expect(result).not.toContain('sendStatusNotification');
  });

  it('Finishing connector: notifications still pass through', () => {
    const result = names(filterChaosActions(NOTIFICATION_ACTIONS, 'available', 'Finishing'));
    expect(result.sort()).toEqual(names(NOTIFICATION_ACTIONS).sort());
  });
});
