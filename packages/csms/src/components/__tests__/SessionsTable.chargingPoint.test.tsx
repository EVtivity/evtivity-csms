// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

const LABELS: Record<string, string> = {
  'sessions.evseNumber': 'EVSE {{id}}',
  'sessions.connectorNumber': 'Connector {{id}}',
  'sessions.chargingPoint': 'Charging Point',
  'sessions.stationName': 'Station',
};

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      (LABELS[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(values?.[name] ?? ''),
      ),
    i18n: { language: 'en' },
  }),
}));

import { SessionsTable, type Session } from '@/components/SessionsTable';

const SESSION: Session = {
  id: 'ses_abc123',
  stationId: 'sta_1',
  stationName: 'EM4-MASTER-01',
  siteName: 'Parkhaus Lindenhof',
  unitName: 'Box 3',
  evseId: 5,
  connectorId: 1,
  connectorType: 'CCS2',
  driverId: null,
  driverName: null,
  transactionId: 'tx-1',
  status: 'completed',
  startedAt: '2026-11-01T10:00:00.000Z',
  endedAt: '2026-11-01T11:00:00.000Z',
  idleStartedAt: null,
  energyDeliveredWh: 1000,
  currentCostCents: null,
  finalCostCents: 500,
  currency: 'USD',
  freeVend: false,
  co2AvoidedKg: null,
};

function renderTable(
  session: Session,
  props: { hideStationName?: boolean; hideSiteName?: boolean } = {},
): void {
  render(
    <MemoryRouter>
      <SessionsTable
        sessions={[session]}
        page={1}
        totalPages={1}
        onPageChange={() => undefined}
        timezone="UTC"
        {...props}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('SessionsTable charging point', () => {
  it('shows site, station, unit, EVSE and connector type on one line, linked to the station', () => {
    renderTable(SESSION);
    const cell = screen.getByTestId('session-charging-point');
    const path = 'Parkhaus Lindenhof / EM4-MASTER-01 / Box 3 / EVSE 5 / CCS2';
    expect(cell.textContent).toBe(path);
    expect(cell.getAttribute('href')).toBe('/stations/sta_1');
    expect(cell.getAttribute('title')).toBe(path);
    expect(screen.getByRole('link', { name: path })).toBe(cell);
    // One line, cut with an ellipsis when the cell is narrow.
    expect(cell.classList.contains('truncate')).toBe(true);
    expect(cell.classList.contains('block')).toBe(true);
  });

  it('leaves out the unit and the site when the session has none', () => {
    renderTable({ ...SESSION, unitName: null, evseId: 2, connectorType: 'Type2' });
    expect(screen.getByTestId('session-charging-point').textContent).toBe(
      'Parkhaus Lindenhof / EM4-MASTER-01 / EVSE 2 / Type 2',
    );
    cleanup();
    renderTable({ ...SESSION, siteName: null, unitName: null, evseId: 1 });
    expect(screen.getByTestId('session-charging-point').textContent).toBe(
      'EM4-MASTER-01 / EVSE 1 / CCS2',
    );
  });

  it('names the connector by its number when its type is unknown', () => {
    renderTable({ ...SESSION, connectorType: null, connectorId: 2 });
    expect(screen.getByTestId('session-charging-point').textContent).toBe(
      'Parkhaus Lindenhof / EM4-MASTER-01 / Box 3 / EVSE 5 / Connector 2',
    );
  });

  it('starts at the station on a site page', () => {
    renderTable(SESSION, { hideSiteName: true });
    expect(screen.getByTestId('session-charging-point').textContent).toBe(
      'EM4-MASTER-01 / Box 3 / EVSE 5 / CCS2',
    );
  });

  it('shows the unit, EVSE and connector under Charging Point on a station page', () => {
    renderTable(SESSION, { hideStationName: true });
    expect(screen.getByRole('columnheader', { name: 'Charging Point' })).toBeDefined();
    const cell = screen.getByTestId('session-charging-point');
    expect(cell.textContent).toBe('Box 3 / EVSE 5 / CCS2');
    expect(cell.getAttribute('title')).toBe('Box 3 / EVSE 5 / CCS2');
    expect(cell.tagName).toBe('SPAN');
  });
});
