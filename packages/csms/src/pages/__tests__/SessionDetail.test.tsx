// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { apiMock, perms, paymentTab, toastMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn() },
  perms: new Set<string>(),
  paymentTab: vi.fn((props: { canRefund: boolean }) => {
    void props;
    return null;
  }),
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/timezone')>();
  return { ...actual, useUserTimezone: () => 'UTC' };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/hooks/use-feature-flags', () => ({ useFeatureFlags: () => ({ flags: {} }) }));
vi.mock('@/hooks/use-entity-neighbors', () => ({
  useEntityNeighbors: () => ({ prevId: null, nextId: null }),
}));
// The tab contents are covered by their own tests.
vi.mock('@/components/session/SessionDetailsTab', () => ({ SessionDetailsTab: () => null }));
vi.mock('@/components/session/SessionRebillCard', () => ({ SessionRebillCard: () => null }));
vi.mock('@/components/session/SessionPaymentTab', () => ({ SessionPaymentTab: paymentTab }));
vi.mock('@/components/MeterValuesTable', () => ({ MeterValuesTable: () => null }));
vi.mock('@/components/EntityHistoryTab', () => ({ EntityHistoryTab: () => null }));
vi.mock('@/components/ai/insights/RecordInsight', () => ({ RecordInsight: () => null }));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { SessionDetail } from '@/pages/SessionDetail';

const SESSION = {
  id: 'ses_1',
  stationId: 'sta_1',
  stationName: 'CS-1',
  evseId: 2,
  siteName: null,
  driverId: null,
  driverName: null,
  transactionId: 'tx-1',
  status: 'active',
  startedAt: '2026-10-14T10:00:00.000Z',
  endedAt: null,
  idleStartedAt: null,
  energyDeliveredWh: 1000,
  currentCostCents: 100,
  finalCostCents: null,
  currency: 'USD',
  stoppedReason: null,
  reservationId: null,
  freeVend: false,
  rebillable: false,
  rebillBlockedReason: 'status',
  co2AvoidedKg: null,
  paymentRecord: {
    id: 1,
    status: 'captured',
    paymentSource: 'web_portal',
    currency: 'USD',
    preAuthAmountCents: 5000,
    capturedAmountCents: 100,
    refundedAmountCents: 0,
    failureReason: null,
    pendingOperation: null,
    providerRefunds: [],
  },
  guestSession: null,
  token: null,
  vehicle: null,
  metadata: null,
};

function renderPage(session: Record<string, unknown> = SESSION): void {
  apiMock.get.mockImplementation((url: string) =>
    url === '/v1/sessions/ses_1' ? Promise.resolve(session) : Promise.resolve({ data: [] }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/sessions/ses_1?tab=payment']}>
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  perms.clear();
  apiMock.get.mockReset();
  apiMock.post.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SessionDetail refund', () => {
  it('offers no refund without payments:write', async () => {
    renderPage();
    await waitFor(() => {
      expect(paymentTab).toHaveBeenCalled();
    });
    expect(paymentTab.mock.lastCall?.[0].canRefund).toBe(false);
  });

  it('offers a refund of a captured payment with payments:write', async () => {
    perms.add('payments:write');
    renderPage();
    await waitFor(() => {
      expect(paymentTab).toHaveBeenCalled();
    });
    expect(paymentTab.mock.lastCall?.[0].canRefund).toBe(true);
  });
});

describe('SessionDetail stop', () => {
  it('hides Stop without stations:write', async () => {
    renderPage();
    await screen.findByText('sessions.title');
    expect(screen.queryByRole('button', { name: 'sessions.stopSession' })).toBeNull();
  });

  it('hides Stop on an ended session', async () => {
    perms.add('stations:write');
    renderPage({ ...SESSION, status: 'completed', endedAt: '2026-10-14T11:00:00.000Z' });
    await screen.findByText('sessions.title');
    expect(screen.queryByRole('button', { name: 'sessions.stopSession' })).toBeNull();
  });

  it('stops an active session through the EVSE stop route after the confirmation', async () => {
    perms.add('stations:write');
    apiMock.post.mockResolvedValue({ sessionId: 'ses_1', transactionId: 'tx-1' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'sessions.stopSession' }));
    expect(screen.getByText('sessions.stopSessionConfirmTitle')).toBeDefined();
    const confirm = screen
      .getAllByRole('button', { name: 'sessions.stopSession' })
      .find((b) => b.closest('[role="dialog"]') != null);
    if (confirm == null) throw new Error('no confirm button');
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        '/v1/stations/sta_1/evses/2/stop-active-session',
        {},
      );
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'success',
        title: 'stations.stopSessionDispatched',
      });
    });
  });
});

describe('SessionDetail end without the station', () => {
  const OFFLINE = { ...SESSION, stationOnline: false };

  it('shows End Session instead of Stop for an active session of an offline station', async () => {
    perms.add('stations:write');
    perms.add('sessions:write');
    renderPage(OFFLINE);
    expect(await screen.findByRole('button', { name: 'sessions.endSession' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'sessions.stopSession' })).toBeNull();
  });

  it('shows Stop, not End Session, while the station is online', async () => {
    perms.add('stations:write');
    perms.add('sessions:write');
    renderPage({ ...SESSION, stationOnline: true });
    expect(await screen.findByRole('button', { name: 'sessions.stopSession' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'sessions.endSession' })).toBeNull();
  });

  it('hides End Session without sessions:write and on an ended session', async () => {
    perms.add('stations:write');
    renderPage(OFFLINE);
    await screen.findByText('sessions.title');
    expect(screen.queryByRole('button', { name: 'sessions.endSession' })).toBeNull();
    cleanup();
    perms.add('sessions:write');
    renderPage({ ...OFFLINE, status: 'completed', endedAt: '2026-10-14T11:00:00.000Z' });
    await screen.findByText('sessions.title');
    expect(screen.queryByRole('button', { name: 'sessions.endSession' })).toBeNull();
  });

  it('ends the session through the CSMS end route after a confirmation that names the billing', async () => {
    perms.add('sessions:write');
    apiMock.post.mockResolvedValue({ sessionId: 'ses_1', transactionId: 'tx-1' });
    renderPage(OFFLINE);
    fireEvent.click(await screen.findByRole('button', { name: 'sessions.endSession' }));
    expect(screen.getByText('sessions.endSessionConfirmTitle')).toBeDefined();
    // The session has a running cost: the dialog names it with the energy.
    expect(screen.getByText('sessions.endSessionConfirmDescriptionWithCost')).toBeDefined();
    const confirm = screen
      .getAllByRole('button', { name: 'sessions.endSession' })
      .find((b) => b.closest('[role="dialog"]') != null);
    if (confirm == null) throw new Error('no confirm button');
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/sessions/ses_1/end', {});
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'success',
        title: 'sessions.endSessionRequested',
      });
    });
  });

  it('describes the billing without a cost for an unpriced session', async () => {
    perms.add('sessions:write');
    renderPage({ ...OFFLINE, currentCostCents: null });
    fireEvent.click(await screen.findByRole('button', { name: 'sessions.endSession' }));
    expect(screen.getByText('sessions.endSessionConfirmDescription')).toBeDefined();
  });

  // getErrorMessage resolves errors.<code>, then the API text: the key-echo t mock
  // leaves the code untranslated, so the API text shows instead of the generic failure.
  it('shows the API error of a refused end, not the generic failure', async () => {
    perms.add('sessions:write');
    const { ApiError } = await import('@/lib/api');
    apiMock.post.mockRejectedValue(
      new ApiError(409, { error: 'The station is online', code: 'STATION_ONLINE' }),
    );
    renderPage(OFFLINE);
    fireEvent.click(await screen.findByRole('button', { name: 'sessions.endSession' }));
    const confirm = screen
      .getAllByRole('button', { name: 'sessions.endSession' })
      .find((b) => b.closest('[role="dialog"]') != null);
    if (confirm == null) throw new Error('no confirm button');
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({
        variant: 'destructive',
        title: 'The station is online',
      });
    });
  });
});
