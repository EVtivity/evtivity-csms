// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** Dashboard Simulate tab buttons. `suspendEv` and `suspendEvse` both call suspendCharging. */
export const SIMULATE_ACTIONS = [
  'plugIn',
  'unplug',
  'authorize',
  'startCharging',
  'stopCharging',
  'evFull',
  'suspendEv',
  'suspendEvse',
  'resumeCharging',
  'injectFault',
  'clearFault',
  'powerCycle',
  'goOffline',
  'comeOnline',
] as const;

export type SimulateAction = (typeof SIMULATE_ACTIONS)[number];

export type FaultMode = 'end' | 'suspend';

const IDLE_WITH_CABLE: SimulateAction[] = [
  'plugIn',
  'unplug',
  'authorize',
  'startCharging',
  'goOffline',
  'injectFault',
  'powerCycle',
];

const IN_SESSION: SimulateAction[] = [
  'stopCharging',
  'unplug',
  'evFull',
  'suspendEv',
  'suspendEvse',
  'resumeCharging',
  'injectFault',
  'goOffline',
  'powerCycle',
];

/**
 * Buttons that make sense for a connector status (`connectors.status`, lowercase CSMS
 * form). Mirrors the chaos VALID_BY_STATE map. The simulator's own guards are the source
 * of truth (it ignores or refuses an action that does not apply); this is a UX hint only.
 */
export function getValidActions(connectorStatus: string): Set<SimulateAction> {
  switch (connectorStatus) {
    case 'available':
    case 'reserved':
      return new Set(['plugIn', 'authorize', 'goOffline', 'injectFault', 'powerCycle']);
    // OCPP 1.6 Finishing: cable still connected, session ended, ready for the next
    // driver. Real 1.6 stations accept a fresh RemoteStart here without an
    // Unplug/Plug-in cycle, so it matches the 2.1 'occupied' post-stop set.
    case 'preparing':
    case 'ev_connected':
    case 'occupied':
    case 'finishing':
      return new Set(IDLE_WITH_CABLE);
    case 'charging':
    case 'discharging':
    case 'suspended_ev':
    case 'suspended_evse':
    case 'idle':
      return new Set(IN_SESSION);
    case 'faulted':
      // clearFault returns a session the fault kept to Occupied (1.6 SuspendedEVSE)
      return new Set(['clearFault', 'goOffline', 'powerCycle']);
    case 'unavailable':
      return new Set(['comeOnline', 'goOffline']);
    default:
      // Unknown status: don't gate. The simulator will no-op invalid actions.
      return new Set(SIMULATE_ACTIONS);
  }
}

/** The API action and body fields for a Simulate button. */
export function simulateRequest(
  action: SimulateAction,
  faultMode: FaultMode,
): { apiAction: string; params: Record<string, unknown> } {
  switch (action) {
    case 'suspendEv':
      return { apiAction: 'suspendCharging', params: { by: 'EV' } };
    case 'suspendEvse':
      return { apiAction: 'suspendCharging', params: { by: 'EVSE' } };
    case 'injectFault':
      return { apiAction: 'injectFault', params: { errorCode: 'InternalError', mode: faultMode } };
    default:
      return { apiAction: action, params: {} };
  }
}
