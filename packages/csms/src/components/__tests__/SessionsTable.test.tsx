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
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import {
  ALL_SESSIONS_SORT_KEYS,
  FLEET_SESSION_SORT_KEYS,
  SESSION_SORT_KEYS,
  SESSIONS_COLUMNS,
  SessionsTable,
  type Session,
} from '@/components/SessionsTable';
import { buildDefaultVisibility } from '@/lib/column-visibility';

const SESSION: Session = {
  id: 'ses_abc123',
  stationId: 'sta_1',
  stationName: 'CP-001',
  siteName: 'Depot',
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

afterEach(() => {
  cleanup();
});

describe('SessionsTable', () => {
  it('lists the session ID first, always visible on desktop and phones', () => {
    const first = SESSIONS_COLUMNS[0];
    expect(first?.key).toBe('sessionId');
    expect(first?.label).toBe('sessions.sessionId');
    expect(first?.alwaysVisible).toBe(true);
    expect(buildDefaultVisibility(SESSIONS_COLUMNS, false)['sessionId']).toBe(true);
    expect(buildDefaultVisibility(SESSIONS_COLUMNS, true)['sessionId']).toBe(true);
  });

  it('sorts by the session ID in every session list', () => {
    expect(SESSION_SORT_KEYS).toContain('sessionId');
    expect(ALL_SESSIONS_SORT_KEYS).toContain('sessionId');
    expect(FLEET_SESSION_SORT_KEYS).toContain('sessionId');
  });

  it('shows the session ID in the first cell as the row identifier', () => {
    render(
      <MemoryRouter>
        <SessionsTable
          sessions={[SESSION]}
          page={1}
          totalPages={1}
          onPageChange={() => undefined}
          timezone="UTC"
          visibility={buildDefaultVisibility(SESSIONS_COLUMNS, true)}
        />
      </MemoryRouter>,
    );
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers[0]?.startsWith('sessions.sessionId')).toBe(true);
    const row = screen.getByTestId('session-row-ses_abc123');
    const firstCell = within(row).getAllByRole('cell')[0];
    expect(firstCell?.textContent).toBe('ses_abc123');
    expect(firstCell?.className).toContain('text-link');
    expect(firstCell?.className).not.toContain('font-mono');
  });
});
