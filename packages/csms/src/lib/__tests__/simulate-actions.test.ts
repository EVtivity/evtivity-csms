// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  SIMULATE_ACTIONS,
  getValidActions,
  securityEventGroups,
  simulateRequest,
} from '../simulate-actions';

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

describe('High Temperature fault', () => {
  it('sends the chosen fault code with injectFault', () => {
    expect(simulateRequest('injectFault', 'end', 'HighTemperature')).toEqual({
      apiAction: 'injectFault',
      params: { errorCode: 'HighTemperature', mode: 'end' },
    });
  });
});

describe('securityEventGroups', () => {
  it('groups the 2.x events by severity, worst first, with the vendor tamper types critical', () => {
    const groups = securityEventGroups('ocpp2.1');
    expect(groups.map((g) => g.severity)).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(groups[0]?.types).toEqual(
      expect.arrayContaining(['TamperDetectionActivated', 'TiltDetected', 'CableCutDetected']),
    );
    expect(groups.flatMap((g) => g.types)).toHaveLength(23);
    expect(groups.flatMap((g) => g.types)).toContain('InvalidCsmsCertificate');
  });

  it('lists the 1.6 whitepaper names for a 1.6 station', () => {
    const types = securityEventGroups('ocpp1.6').flatMap((g) => g.types);
    expect(types).toContain('InvalidCentralSystemCertificate');
    expect(types).not.toContain('InvalidCsmsCertificate');
    expect(types).toContain('MaintenanceLoginFailed');
    expect(types).toHaveLength(23);
  });
});
