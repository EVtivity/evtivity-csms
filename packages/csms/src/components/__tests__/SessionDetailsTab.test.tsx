// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      typeof opts?.['pcid'] === 'string' ? `${key}:${opts['pcid']}` : key,
  }),
}));
vi.mock('@/lib/timezone', () => ({ formatDateTime: (value: string) => value }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => false }));
const paginatedQuery = vi.hoisted(() =>
  vi.fn(() => ({
    data: [],
    isLoading: false,
    page: 1,
    totalPages: 1,
    setPage: () => undefined,
    total: 0,
  })),
);
vi.mock('@/hooks/use-paginated-query', () => ({ usePaginatedQuery: paginatedQuery }));

import { SessionDetailsTab, type SessionDetailsTabProps } from '../session/SessionDetailsTab';

const session: SessionDetailsTabProps['session'] = {
  stationId: 'sta_1',
  stationName: 'CS-1',
  siteName: null,
  driverId: 'drv_1',
  driverName: 'Ada Driver',
  startedAt: '2026-10-14T10:00:00.000Z',
  endedAt: null,
  idleStartedAt: null,
  energyDeliveredWh: 1000,
  currentCostCents: 100,
  finalCostCents: null,
  status: 'active',
  stoppedReason: null,
  reservationId: null,
  freeVend: false,
  co2AvoidedKg: null,
  transactionId: 'tx-1',
  token: { id: 'dtk_1', idToken: 'USEVTC12345678', tokenType: 'eMAID', pncContract: null },
  vehicle: null,
  metadata: null,
};

function renderTab(token: SessionDetailsTabProps['session']['token']): void {
  render(
    <MemoryRouter>
      <SessionDetailsTab
        session={{ ...session, token }}
        sessionId="ses_1"
        currency="USD"
        timezone="UTC"
        formatCents={(cents) => String(cents)}
        formatDuration={() => '1m'}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('SessionDetailsTab Plug and Charge contract', () => {
  it('shows the contract of a session the eMAID of a contract authorized', () => {
    renderTab({
      id: 'dtk_1',
      idToken: 'USEVTC12345678',
      tokenType: 'eMAID',
      pncContract: { id: 3, pcid: 'EVSIMABC', status: 'revoked' },
    });
    expect(screen.getByText('sessions.pncContract')).toBeDefined();
    expect(screen.getByTestId('session-pnc-contract').textContent).toBe(
      'sessions.pncContractPcid:EVSIMABC',
    );
    expect(screen.getByText('drivers.pncContractStatus.revoked')).toBeDefined();
  });

  it('shows no contract row for a token without a contract', () => {
    renderTab({ id: 'dtk_2', idToken: 'RFID-1', tokenType: 'ISO14443', pncContract: null });
    expect(screen.queryByText('sessions.pncContract')).toBeNull();
    expect(screen.getByText('RFID-1')).toBeDefined();
  });
});

describe('SessionDetailsTab cost and events', () => {
  function renderSession(overrides: Partial<SessionDetailsTabProps['session']>): void {
    render(
      <MemoryRouter>
        <SessionDetailsTab
          session={{ ...session, ...overrides }}
          sessionId="ses_1"
          currency="USD"
          timezone="UTC"
          formatCents={(cents) => `cost:${String(cents)}`}
          formatDuration={() => '1m'}
        />
      </MemoryRouter>,
    );
  }

  it('shows a faulted session without a stored final cost at 0, not its running cost', () => {
    renderSession({ status: 'faulted', currentCostCents: 300, finalCostCents: null });
    expect(screen.getByText('cost:0')).toBeDefined();
    expect(screen.queryByText('cost:300')).toBeNull();
  });

  it('shows a completed session at its final cost', () => {
    renderSession({ status: 'completed', currentCostCents: 300, finalCostCents: 450 });
    expect(screen.getByText('cost:450')).toBeDefined();
  });

  it('keys the transaction events under the session, so another session never shares them', () => {
    renderSession({});
    expect(paginatedQuery).toHaveBeenCalledWith(
      ['sessions', 'ses_1', 'transaction-events'],
      '/v1/sessions/ses_1/transaction-events',
    );
  });
});
