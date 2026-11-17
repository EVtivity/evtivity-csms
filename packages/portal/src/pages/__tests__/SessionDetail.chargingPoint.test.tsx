// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: vi.fn(), patch: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { id?: number }) =>
      key === 'sessions.evseNumber'
        ? `EVSE ${String(options?.id)}`
        : key === 'sessions.connectorNumber'
          ? `Connector ${String(options?.id)}`
          : key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: { driver: null }) => unknown) => selector({ driver: null }),
}));
vi.mock('@/lib/timezone', () => ({ useDriverTimezone: () => 'UTC' }));
vi.mock('@/hooks/use-price-display', () => ({ usePriceDisplay: () => 'gross' }));
vi.mock('@/hooks/use-portal-features', () => ({ usePortalFeatures: () => ({ data: {} }) }));
// Charts, the vehicle card and Report Issue are not under test here.
vi.mock('@/components/SessionCharts', () => ({ SessionCharts: () => null }));
vi.mock('@/components/SessionVehicleCard', () => ({ SessionVehicleCard: () => null }));
vi.mock('@/components/ReportIssue', () => ({ ReportIssue: () => null }));

import { SessionDetail } from '../SessionDetail';

const SESSION = {
  id: 'ses_1',
  transactionId: 'tx-1',
  status: 'completed',
  startedAt: '2026-11-01T10:00:00Z',
  endedAt: '2026-11-01T11:00:00Z',
  energyDeliveredWh: '10000',
  currentCostCents: null,
  finalCostCents: 500,
  netCents: null,
  taxCents: null,
  taxRate: null,
  currency: 'EUR',
  stationName: 'EM4-MASTER-01',
  siteName: 'Parkhaus Lindenhof',
  unitName: 'Box 3',
  evseId: 5,
  connectorId: 1,
  connectorType: 'CCS2',
  siteAddress: 'Lindenhofstraße 12',
  siteCity: 'Freiburg im Breisgau',
  siteState: null,
  reservationId: null,
  stoppedReason: null,
  idleStartedAt: null,
  updatedAt: null,
  currentPowerW: null,
  payment: null,
  accountBilling: null,
  vehicle: null,
};

function renderPage(session: Record<string, unknown>): void {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(url === '/v1/portal/sessions/ses_1' ? session : { data: [] }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/sessions/ses_1']}>
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('SessionDetail charging point', () => {
  it('shows site, station, unit, EVSE and connector type on one line', async () => {
    renderPage(SESSION);
    const path = 'Parkhaus Lindenhof / EM4-MASTER-01 / Box 3 / EVSE 5 / CCS2';
    const line = await screen.findByTestId('session-charging-point');
    // The whole path is the text screen readers read and the title; CSS cuts the view.
    expect(line.textContent).toBe(path);
    expect(line.getAttribute('title')).toBe(path);
    expect(line.className).toContain('truncate');
    expect(screen.getByText(path)).toBe(line);
    // No second line repeats the site; the address stays.
    expect(screen.queryByText('Parkhaus Lindenhof')).toBeNull();
    expect(screen.getByText('Lindenhofstraße 12, Freiburg im Breisgau')).toBeDefined();
  });

  it('leaves out the parts the session does not have', async () => {
    renderPage({ ...SESSION, siteName: null, unitName: null, evseId: 2, connectorType: null });
    const line = await screen.findByTestId('session-charging-point');
    expect(line.textContent).toBe('EM4-MASTER-01 / EVSE 2 / Connector 1');
    expect(line.getAttribute('title')).toBe('EM4-MASTER-01 / EVSE 2 / Connector 1');
  });

  it('names an unknown station when the session has no charging point', async () => {
    renderPage({
      ...SESSION,
      siteName: null,
      stationName: null,
      unitName: null,
      evseId: null,
      connectorId: null,
      connectorType: null,
    });
    const line = await screen.findByTestId('session-charging-point');
    expect(line.textContent).toBe('sessionDetail.unknownStation');
  });
});
