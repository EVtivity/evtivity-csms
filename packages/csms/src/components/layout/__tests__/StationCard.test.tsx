// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'n' in opts ? `${key}:${String(opts['n'])}:${String(opts['state'])}` : key,
    i18n: { language: 'en' },
  }),
}));

import { StationCardContent, type LayoutStation } from '../StationCard';

function station(overrides: Partial<LayoutStation> = {}): LayoutStation {
  return {
    id: 'sta_1',
    stationId: 'CS-1',
    model: null,
    status: 'charging',
    statusReason: null,
    isOnline: true,
    securityProfile: 2,
    positionX: 20,
    positionY: 20,
    placed: true,
    chargingKind: 'dc',
    cellular: false,
    inMaintenance: false,
    displayMessage: null,
    evses: [
      {
        evseId: 1,
        status: 'charging',
        connectors: [
          {
            connectorId: 1,
            connectorType: 'CCS1',
            maxPowerKw: 150,
            status: 'charging',
            isPluggedIn: true,
            energyDeliveredWh: 1000,
          },
        ],
      },
      {
        evseId: 2,
        status: 'faulted',
        connectors: [
          {
            connectorId: 1,
            connectorType: 'CHAdeMO',
            maxPowerKw: 50,
            status: 'faulted',
            isPluggedIn: false,
            energyDeliveredWh: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('standard 2D charger card', () => {
  it('shows the shared status marker for the station and each EVSE, and no status dot', () => {
    const { container } = render(<StationCardContent station={station()} />);
    const badges = screen.getAllByTestId('state-badge');
    // The station (faulted: an EVSE is faulted) and its two EVSEs.
    expect(badges.map((b) => b.getAttribute('data-state'))).toEqual([
      'faulted',
      'charging',
      'faulted',
    ]);
    // The 3D badge look: a solid white round background, no border.
    for (const badge of badges) {
      expect(badge.className).toContain('bg-white');
      expect(badge.className).toContain('rounded-full');
      expect(badge.className).not.toMatch(/\bborder\b/);
    }
    const evses = screen.getByTestId('station-card-evses');
    expect(within(evses).getAllByTestId('state-badge')[0]?.getAttribute('aria-label')).toBe(
      'sites.layoutView.evseState:1:sites.layoutState.charging',
    );
    // No old pulsing dot, colored dot or status LED.
    expect(container.querySelector('.animate-ping')).toBeNull();
    expect(
      container.querySelector('.rounded-full.bg-success, .rounded-full.bg-destructive'),
    ).toBeNull();
    expect(container.querySelector('svg[width="52"] circle')).toBeNull();
  });

  it('shows no security profile (it stays on the station page)', () => {
    render(<StationCardContent station={station()} />);
    expect(screen.queryByText(/Security Profile/)).toBeNull();
    expect(screen.queryByText('2')).toBeNull();
  });
});
