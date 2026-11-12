// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
  }),
}));

import { StationsTable } from '../StationsTable';

const BASE = {
  id: 'sta_000000000001',
  stationId: 'EM4-MASTER',
  model: 'eM4 Twin',
  status: 'available',
  connectorCount: 16,
  connectorTypes: ['Type2'],
  isOnline: true,
  lastHeartbeat: null,
  createdAt: null,
};

function renderTable(station: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <StationsTable stations={[{ ...BASE, ...station }]} timezone="UTC" />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('Stations list with station units', () => {
  it('shows a station without units as before: no unit groups and no unit count', () => {
    renderTable({ unitCount: 0, units: null, unassignedConnectorTypes: null });
    expect(screen.queryByTestId('unit-connector-groups')).toBeNull();
    expect(screen.queryByTestId('station-unit-count')).toBeNull();
  });

  it('groups the connector icons by box and names the boxes', () => {
    const units = Array.from({ length: 8 }, (_, i) => ({
      id: `unt_box${String(i + 1)}`,
      name: `Box ${String(i + 1)}`,
      connectorTypes: ['Type2'],
    }));
    renderTable({ unitCount: 8, units, unassignedConnectorTypes: ['CCS2'] });
    const groups = within(screen.getByTestId('unit-connector-groups')).getAllByTestId(
      'unit-connector-group',
    );
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      ...units.map((u) => u.name),
      'stationUnits.evsesWithoutUnit',
    ]);
    expect(screen.getByTestId('station-unit-count').textContent).toBe(
      'stationUnits.unitCount:{"count":8}',
    );
  });
});
