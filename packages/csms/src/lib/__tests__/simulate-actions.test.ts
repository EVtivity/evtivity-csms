// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { SIMULATE_ACTIONS, getValidActions, simulateRequest } from '../simulate-actions';

describe('getValidActions', () => {
  it('offers suspend, resume and EV full during a session', () => {
    for (const status of ['charging', 'suspended_ev', 'suspended_evse']) {
      const valid = getValidActions(status);
      expect(valid.has('suspendEv')).toBe(true);
      expect(valid.has('suspendEvse')).toBe(true);
      expect(valid.has('resumeCharging')).toBe(true);
      expect(valid.has('evFull')).toBe(true);
      expect(valid.has('startCharging')).toBe(false);
    }
  });

  it('offers no session actions without a session', () => {
    const valid = getValidActions('available');
    expect(valid.has('suspendEv')).toBe(false);
    expect(valid.has('resumeCharging')).toBe(false);
    expect(valid.has('powerCycle')).toBe(true);
  });

  it('allows only clearFault, goOffline and powerCycle while faulted', () => {
    expect([...getValidActions('faulted')].sort()).toEqual(
      ['clearFault', 'goOffline', 'powerCycle'].sort(),
    );
  });

  it('does not gate an unknown status', () => {
    expect(getValidActions('something').size).toBe(SIMULATE_ACTIONS.length);
  });
});

describe('simulateRequest', () => {
  it('maps the suspend buttons to suspendCharging with the party', () => {
    expect(simulateRequest('suspendEv', 'end')).toEqual({
      apiAction: 'suspendCharging',
      params: { by: 'EV' },
    });
    expect(simulateRequest('suspendEvse', 'end').params).toEqual({ by: 'EVSE' });
  });

  it('sends the fault mode with injectFault', () => {
    expect(simulateRequest('injectFault', 'suspend')).toEqual({
      apiAction: 'injectFault',
      params: { errorCode: 'InternalError', mode: 'suspend' },
    });
    expect(simulateRequest('powerCycle', 'end')).toEqual({ apiAction: 'powerCycle', params: {} });
  });
});
