// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ client: vi.fn() }));

import { sessionProfileCapKwFrom } from '../session-profile-cap.js';
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

describe('sessionProfileCapKwFrom', () => {
  it('caps an AC session at its tariff limit on its circuit and phases', () => {
    expect(sessionProfileCapKwFrom(input({ tariffMaxCurrentA: 6 }))).toBeCloseTo(4.14, 9);
    expect(sessionProfileCapKwFrom(input({ tariffMaxCurrentA: 16, evPhases: 'L1' }))).toBeCloseTo(
      3.68,
      9,
    );
  });

  it('caps at the EVSE limit load management holds for the transaction', () => {
    expect(sessionProfileCapKwFrom(input({ appliedAllocations: applied(6.9) }))).toBe(6.9);
    expect(
      sessionProfileCapKwFrom(input({ tariffMaxCurrentA: 6, appliedAllocations: applied(6.9) })),
    ).toBeCloseTo(4.14, 9);
    expect(sessionProfileCapKwFrom(input({ appliedAllocations: applied(0) }))).toBe(0);
  });

  it('ignores another transaction, a site with load management off and a DC tariff limit', () => {
    expect(sessionProfileCapKwFrom(input({ appliedAllocations: applied(6.9, 'tx-2') }))).toBeNull();
    expect(
      sessionProfileCapKwFrom(
        input({ loadManagementEnabled: false, appliedAllocations: applied(6.9) }),
      ),
    ).toBeNull();
    expect(sessionProfileCapKwFrom(input({ kind: 'dc', tariffMaxCurrentA: 16 }))).toBeNull();
  });

  it('cannot convert a tariff limit without a circuit', () => {
    expect(sessionProfileCapKwFrom(input({ circuit: null, tariffMaxCurrentA: 16 }))).toBeNull();
  });
});
