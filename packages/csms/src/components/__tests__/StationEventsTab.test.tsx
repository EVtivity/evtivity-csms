// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock } = vi.hoisted(() => {
  // The auth store reads the color scheme when it loads.
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return { getMock: vi.fn() };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({ api: { get: getMock } }));

import { StationEventsTab } from '../StationEventsTab';

const EVENT_DATA = {
  eventId: 7,
  trigger: 'Delta',
  component: { name: 'EVSE' },
  variable: { name: 'Power' },
};

function renderTab(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StationEventsTab stationId="sta_1" timezone="UTC" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationEventsTab', () => {
  it('lists the notify events without a security sub-tab', async () => {
    getMock.mockResolvedValue({
      data: [
        { id: 1, generatedAt: '2026-10-15T10:00:00Z', seqNo: 3, tbc: false, eventData: EVENT_DATA },
      ],
      total: 1,
    });
    renderTab();

    expect(await screen.findByTestId('notify-event-row-1')).not.toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('stations.securityEvents')).toBeNull();
    expect(screen.getByText('stations.notifyEvents')).not.toBeNull();
    expect(screen.getByText('stations.seqNo')).not.toBeNull();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith('/v1/stations/sta_1/events?page=1&limit=25');
  });

  it('expands a row to formatted JSON with a copy button and collapses it again', async () => {
    getMock.mockResolvedValue({
      data: [
        { id: 1, generatedAt: '2026-10-15T10:00:00Z', seqNo: 3, tbc: false, eventData: EVENT_DATA },
      ],
      total: 1,
    });
    renderTab();

    const toggle = await screen.findByRole('button', { name: JSON.stringify(EVENT_DATA) });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('json-detail')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const detail = screen.getByTestId('json-detail');
    expect(toggle.getAttribute('aria-controls')).toBe(detail.id);
    expect(detail.querySelector('code')?.textContent).toBe(JSON.stringify(EVENT_DATA, null, 2));
    expect(within(detail).getByTestId('copy-button')).not.toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('json-detail')).toBeNull();

    // A click anywhere on the row toggles it too.
    fireEvent.click(screen.getByText('3'));
    expect(screen.getByTestId('json-detail')).not.toBeNull();
  });
});
