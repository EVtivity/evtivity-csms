// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ client: vi.fn() }));

import { sessionProfileCapFrom } from '../session-profile-cap.js';

import type { SessionProfileCapInput } from '../session-profile-cap.js';

const threePhase = { voltageV: null, phaseConnections: null, panelVoltageV: 230, panelPhases: 3 };

function input(overrides: Partial<SessionProfileCapInput> = {}): SessionProfileCapInput {
  return {
    transactionId: 'tx-1',
    stationDbId: 'sta_1',
    kind: 'ac',
    evPhases: null,
    tariffMaxCurrentA: null,
    circuit: threePhase,
    loadManagementEnabled: true,
    appliedAllocations: null,
    ...overrides,
  };
}

const applied = (limitKw: number, transactionId = 'tx-1'): unknown => [
  {
    stationId: 'CS-1',
    stationDbId: 'sta_1',
    allocatedKw: 22,
    evses: [
      {
        sessionId: 'ses_1',
        transactionId,
        evseNumber: 1,
        kind: 'ac',
        limitKw,
        limitA: 10,
        phases: 3,
        rateUnit: 'A',
      },
    ],
  },
];

describe('sessionProfileCapFrom', () => {
  it('caps an AC session at its tariff limit on its circuit and phases', () => {
    expect(sessionProfileCapFrom(input({ tariffMaxCurrentA: 6 })).capKw).toBeCloseTo(4.14, 9);
    expect(
      sessionProfileCapFrom(input({ tariffMaxCurrentA: 16, evPhases: 'L1' })).capKw,
    ).toBeCloseTo(3.68, 9);
  });

  it('caps at the EVSE limit load management holds for the transaction', () => {
    expect(sessionProfileCapFrom(input({ appliedAllocations: applied(6.9) })).capKw).toBe(6.9);
    expect(
      sessionProfileCapFrom(input({ tariffMaxCurrentA: 6, appliedAllocations: applied(6.9) }))
        .capKw,
    ).toBeCloseTo(4.14, 9);
    expect(sessionProfileCapFrom(input({ appliedAllocations: applied(0) })).capKw).toBe(0);
  });

  it('ignores another transaction, a site with load management off and a DC tariff limit', () => {
    expect(
      sessionProfileCapFrom(input({ appliedAllocations: applied(6.9, 'tx-2') })).capKw,
    ).toBeNull();
    expect(
      sessionProfileCapFrom(
        input({ loadManagementEnabled: false, appliedAllocations: applied(6.9) }),
      ).capKw,
    ).toBeNull();
    expect(sessionProfileCapFrom(input({ kind: 'dc', tariffMaxCurrentA: 16 })).capKw).toBeNull();
  });

  it('cannot convert a tariff limit without a circuit', () => {
    expect(sessionProfileCapFrom(input({ circuit: null, tariffMaxCurrentA: 16 })).capKw).toBeNull();
  });
});
