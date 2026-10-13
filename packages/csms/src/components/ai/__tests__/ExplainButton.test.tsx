// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { apiMock, perms, data } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn() },
  perms: new Set<string>(),
  data: {
    reservation: {},
    fees: [] as { id: number; status: string; chargeType: string }[],
    insights: [] as Record<string, unknown>[],
    reservationEnabled: true,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (v: string) => v,
  formatRelativeTime: (v: string) => v,
  useUserTimezone: () => 'UTC',
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('../use-ai-status', () => ({
  useAiStatus: () => ({ chatbot: true, support: false, isLoading: false }),
}));
// The tabs are covered by their own tests.
vi.mock('@/components/reservation/ReservationDetailsTab', () => ({
  ReservationDetailsTab: () => null,
}));
vi.mock('@/components/reservation/ReservationSessionTab', () => ({
  ReservationSessionTab: () => null,
}));
vi.mock('@/components/reservation/ReservationCommandsTab', () => ({
  ReservationCommandsTab: () => null,
}));
vi.mock('@/components/EntityHistoryTab', () => ({ EntityHistoryTab: () => null }));
vi.mock('@/components/entity-nav-buttons', () => ({ EntityNavButtons: () => null }));

// The tabs measure themselves; jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { ReservationDetail } from '@/pages/ReservationDetail';
import { reservationExplainable } from '@/components/reservation/reservation-explain';

function reservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'res1',
    reservationId: 7,
    stationId: 'st1',
    stationOcppId: 'CS-1',
    siteId: 'site1',
    siteName: 'Depot',
    status: 'active',
    cancelReason: null,
    expiresAt: '2026-10-11T12:00:00Z',
    createdAt: '2026-10-11T11:00:00Z',
    updatedAt: '2026-10-11T11:00:00Z',
    cancellationFeeCents: 0,
    cancellationFee: null,
    sessionId: null,
    ...overrides,
  };
}

function serve(): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/v1/reservations/res1') return Promise.resolve(data.reservation);
    if (url === '/v1/reservations/res1/fee-payments') return Promise.resolve(data.fees);
    if (url === '/v1/portal/features') {
      return Promise.resolve({
        reservationEnabled: data.reservationEnabled,
        aiInsightsEnabled: true,
      });
    }
    if (url.startsWith('/v1/ai/insights')) {
      return Promise.resolve({ data: data.insights, total: data.insights.length });
    }
    return Promise.resolve({ data: [], total: 0 });
  });
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/reservations/res1']}>
        <Routes>
          <Route path="/reservations/:id" element={<ReservationDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  perms.clear();
  perms.add('aiAssistant:write');
  perms.add('aiInsights:read');
  perms.add('payments:read');
  data.reservation = reservation();
  data.fees = [];
  data.insights = [];
  data.reservationEnabled = true;
  serve();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Explain on the reservation page (TC-AI-RI-UI-02)', () => {
  it.each([
    ['a station-reason cancel', { status: 'cancelled', cancelReason: 'station_rejected_other' }],
    [
      'a hold the station dropped',
      { status: 'cancelled', cancelReason: 'station_unavailable_during_hold' },
    ],
    ['an expiry', { status: 'expired' }],
  ])('TC-AI-RI-UI-02 shows for %s', async (_label, overrides) => {
    data.reservation = reservation(overrides);
    renderPage();
    expect(await screen.findByTestId('ai-explain')).toBeTruthy();
  });

  it('TC-AI-RI-UI-02 shows for a failed fee', async () => {
    data.reservation = reservation({ status: 'cancelled', cancelReason: 'driver_initiated' });
    data.fees = [{ id: 1, status: 'failed', chargeType: 'reservation_cancellation' }];
    renderPage();
    expect(await screen.findByTestId('ai-explain')).toBeTruthy();
  });

  it('TC-AI-RI-UI-02 is hidden for a driver cancel, an active or a used reservation', async () => {
    for (const overrides of [
      { status: 'cancelled', cancelReason: 'driver_initiated' },
      { status: 'active' },
      { status: 'used' },
    ]) {
      data.reservation = reservation(overrides);
      renderPage();
      await screen.findByText('reservations.detail #7', { exact: false });
      await waitFor(() => {
        expect(apiMock.get).toHaveBeenCalledWith(
          '/v1/ai/insights?reservationId=res1&limit=10&language=en',
        );
      });
      expect(screen.queryByTestId('ai-explain')).toBeNull();
      cleanup();
    }
  });

  it('TC-AI-RI-UI-02 is hidden without the right to write to the assistant', async () => {
    perms.delete('aiAssistant:write');
    data.reservation = reservation({ status: 'expired' });
    renderPage();
    await screen.findByText('reservations.detail #7', { exact: false });
    expect(screen.queryByTestId('ai-explain')).toBeNull();
  });

  it('hides Explain and the insight card while reservations are off (owner rule v0.1.45)', async () => {
    data.reservationEnabled = false;
    data.reservation = reservation({ status: 'expired' });
    data.insights = [{ id: 'ins1', kind: 'reservation_no_show', status: 'open' }];
    renderPage();
    await screen.findByText('reservations.detail #7', { exact: false });
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/portal/features');
    });
    expect(screen.queryByTestId('ai-explain')).toBeNull();
    expect(screen.queryByTestId('ai-insight-card')).toBeNull();
    expect(apiMock.get.mock.calls.some(([url]) => String(url).startsWith('/v1/ai/insights'))).toBe(
      false,
    );
  });

  it('TC-AI-RI-UI-01 shows the insight card below the header when the reservation has one', async () => {
    data.reservation = reservation({ status: 'expired' });
    data.insights = [
      {
        id: 'ins1',
        kind: 'reservation_no_show',
        status: 'open',
        skipReason: null,
        siteId: 'site1',
        stationId: 'st1',
        sessionId: null,
        authorizeAttemptId: null,
        reservationId: 'res1',
        parentInsightId: null,
        category: 'configuration',
        confidence: 'high',
        fixes: [{ code: 'reservation_review_holding_settings' }],
        scope: {},
        generatedBy: 'rule',
        language: 'en',
        summary: null,
        textStatus: 'unavailable',
        stale: false,
        basisAt: null,
        createdAt: '2026-10-11T12:00:00Z',
        resolvedAt: null,
        dismissedAt: null,
      },
    ];
    renderPage();
    // The floating icon opens the AI Insights tab with the reservation's insight.
    fireEvent.click(await screen.findByTestId('record-insight-trigger'));
    expect(await screen.findByTestId('record-insight-row-ins1')).toBeTruthy();
  });
});

describe('reservationExplainable', () => {
  it('needs a station reason, an expiry or a failed fee', () => {
    const fee = [{ status: 'failed' }];
    expect(reservationExplainable({ status: 'expired', cancelReason: null }, [], [])).toBe(true);
    expect(
      reservationExplainable(
        { status: 'cancelled', cancelReason: 'evse_in_use_at_activation' },
        [],
        [],
      ),
    ).toBe(true);
    expect(
      reservationExplainable({ status: 'cancelled', cancelReason: 'operator_manual' }, [], []),
    ).toBe(false);
    expect(reservationExplainable({ status: 'used', cancelReason: null }, fee, [])).toBe(true);
    expect(
      reservationExplainable(
        { status: 'used', cancelReason: null },
        [],
        [{ kind: 'reservation_fee_failed' }],
      ),
    ).toBe(true);
    expect(
      reservationExplainable({ status: 'used', cancelReason: null }, [{ status: 'captured' }], []),
    ).toBe(false);
  });
});
