// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'source' in opts ? `${key}:${String(opts['source'])}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => false }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { StationLayoutPopup } from '../StationLayoutPopup';
import type { LayoutStation } from '../StationCard';

function station(overrides: Partial<LayoutStation> = {}): LayoutStation {
  return {
    id: 'sta_1',
    stationId: 'CS-1',
    model: null,
    status: 'available',
    isOnline: true,
    securityProfile: 1,
    positionX: 20,
    positionY: 20,
    placed: true,
    chargingKind: 'ac',
    cellular: false,
    inMaintenance: false,
    displayMessage: null,
    evses: [],
    ...overrides,
  };
}

function renderPopup(s: LayoutStation) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <StationLayoutPopup station={s} onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('layout popup charger screen', () => {
  it('shows what the screen shows and where it comes from', () => {
    renderPopup(
      station({
        screenMessage: {
          text: 'Acme\nCS-1\nPlug in to start',
          source: 'station_message_template',
        },
      }),
    );
    const block = screen.getByTestId('layout-screen-message');
    expect(block.getAttribute('aria-label')).toBe('sites.layoutView.screenShows');
    within(block).getByText('sites.layoutView.screenShows');
    expect(block.querySelector('.whitespace-pre-line')?.textContent).toBe(
      'Acme\nCS-1\nPlug in to start',
    );
    within(block).getByText(
      'sites.layoutView.screenSourceLabel:sites.layoutView.screenSource.station_message_template',
    );
  });

  it('keeps the display message row next to the screen text', () => {
    renderPopup(
      station({
        displayMessage: 'Free charging today',
        screenMessage: { text: 'Free charging today', source: 'display_message' },
      }),
    );
    expect(screen.getByLabelText('sites.layoutView.displayMessage').textContent).toBe(
      'Free charging today',
    );
    screen.getByText(
      'sites.layoutView.screenSourceLabel:sites.layoutView.screenSource.display_message',
    );
  });

  it('shows no screen block without a screen message (older replies, the day replay)', () => {
    renderPopup(station());
    expect(screen.queryByTestId('layout-screen-message')).toBeNull();
  });
});
