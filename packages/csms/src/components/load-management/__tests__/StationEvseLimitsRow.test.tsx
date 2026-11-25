// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));

import { CircuitStationTable, type CircuitStationStatus } from '../CircuitStationTable';

const STATION: CircuitStationStatus = {
  id: 'sta_phase',
  stationId: 'CS-PHASE',
  currentDrawKw: 0,
  allocatedLimitKw: 22,
  maxPowerKw: 44,
  loadPriority: 5,
  isOnline: true,
  hasActiveSession: true,
  balancingMode: 'evse',
  evseLimitsRefusedAt: null,
  usesUnits: false,
  evseLimits: [
    {
      evseNumber: 1,
      unitId: null,
      kind: 'ac',
      limitA: 16,
      limitKw: 3.68,
      paused: false,
      phaseSwitchingSupported: true,
      phaseToUse: 2,
    },
    {
      evseNumber: 2,
      unitId: null,
      kind: 'ac',
      limitA: 16,
      limitKw: 11.04,
      paused: false,
      phaseSwitchingSupported: true,
      phaseToUse: null,
    },
    { evseNumber: 3, unitId: null, kind: 'dc', limitA: null, limitKw: 50, paused: false },
  ],
};

function renderTable(station: CircuitStationStatus): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CircuitStationTable
        siteId="sit_phase"
        stations={[station]}
        strategy="equal_share"
        canWrite={false}
        onRemove={() => undefined}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('EVSE limits of a station without units', () => {
  it('shows the phase each single-phase car is sent to and which EVSEs switch phases', () => {
    renderTable(STATION);
    const text = screen.getByTestId('evse-limits-row-sta_phase').textContent;
    expect(text).toContain('loadManagement.evseLimitPhaseToUse');
    expect(text).toContain('"phase":2');
    expect(text).toContain('loadManagement.evseLimitPhaseSwitching');
    expect(text).toContain('"evse":3,"limit":"50 kW"');
    expect(text.match(/evseLimitPhase/g)).toHaveLength(2);
  });

  it('shows no row without EVSE limits', () => {
    renderTable({ ...STATION, evseLimits: [] });
    expect(screen.queryByTestId('evse-limits-row-sta_phase')).toBeNull();
  });
});
