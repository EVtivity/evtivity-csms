// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { apiMock, perms, paymentTab, toastMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
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
vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => perms.has(p),
  useHasCompanyWidePermission: (p: string) => perms.has(p),
}));
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

describe('SessionDetail header', () => {
  it('puts Stop, Prev and Next in their own row, right-aligned from sm', async () => {
    perms.add('stations:write');
    renderPage();
    await screen.findByRole('button', { name: 'sessions.stopSession' });
    const actions = screen.getByTestId('session-header-actions');
    const header = actions.parentElement;
    expect(header?.className).toContain('sm:justify-between');
    expect(header?.className).toContain('sm:flex-row');
    // The title and badges sit in a sibling group, not in the actions row.
    expect(actions.contains(screen.getByText('sessions.title'))).toBe(false);
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

describe('SessionDetail billing recipient', () => {
  const ACCOUNT_SESSION = {
    ...SESSION,
    status: 'completed',
    driverId: 'drv_1',
    driverName: 'Anna Berg',
    paymentRecord: null,
    billingMode: 'account',
    billingFleetName: 'Acme',
    memberBilled: false,
    invoiceId: null,
    invoiceStatus: null,
  };

  beforeEach(() => {
    perms.clear();
    perms.add('payments:write');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('moves an unbilled fleet session to the member invoice after the confirmation', async () => {
    apiMock.patch.mockResolvedValue({ moved: true });
    renderPage(ACCOUNT_SESSION);
    fireEvent.click(await screen.findByRole('button', { name: 'billingRecipient.billToDriver' }));
    expect(screen.getByText('billingRecipient.sessionToDriverDescription')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'billingRecipient.billToDriver' });
    fireEvent.click(buttons.at(-1) as HTMLElement);
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sessions/ses_1/billing-recipient', {
        recipient: 'member',
      });
    });
  });

  it('offers Bill to Fleet for a member-billed session', async () => {
    renderPage({ ...ACCOUNT_SESSION, memberBilled: true });
    expect(
      await screen.findByRole('button', { name: 'billingRecipient.billToFleet' }),
    ).toBeTruthy();
  });

  it('offers no move for an invoiced session or without the permission', async () => {
    renderPage({ ...ACCOUNT_SESSION, invoiceId: 'inv_1', invoiceStatus: 'issued' });
    await screen.findByTestId('session-billing-badge');
    expect(screen.queryByRole('button', { name: 'billingRecipient.billToDriver' })).toBeNull();
    cleanup();
    perms.clear();
    renderPage(ACCOUNT_SESSION);
    await screen.findByTestId('session-billing-badge');
    expect(screen.queryByRole('button', { name: 'billingRecipient.billToDriver' })).toBeNull();
  });
});
