// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { postMock, getMock, permissions, toastMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  getMock: vi.fn(),
  permissions: new Set<string>(),
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'id' in opts ? `${key}:${String(opts['id'])}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock },
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) => permissions.has(permission),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { StationLayoutPopup } from '../StationLayoutPopup';
import { layoutSimulateActions } from '../LayoutSimulatePanel';
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
    isSimulator: true,
    displayMessage: null,
    evses: [
      {
        evseId: 1,
        status: 'available',
        connectors: [
          {
            connectorId: 1,
            connectorType: 'Type1',
            maxPowerKw: 6.66,
            status: 'available',
            isPluggedIn: false,
            energyDeliveredWh: null,
          },
        ],
      },
      {
        evseId: 2,
        status: 'charging',
        connectors: [
          {
            connectorId: 1,
            connectorType: 'Type1',
            maxPowerKw: 6.66,
            status: 'charging',
            isPluggedIn: true,
            energyDeliveredWh: 1200,
          },
        ],
      },
    ],
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

beforeEach(() => {
  permissions.clear();
  postMock.mockReset().mockResolvedValue({ commandId: 'cmd-1' });
  getMock.mockReset();
  toastMock.mockReset();
});
afterEach(() => {
  cleanup();
});

describe('layout popup simulator screen', () => {
  it('offers Simulate next to Open Station only for a simulator station and stations:write', () => {
    renderPopup(station());
    expect(screen.queryByTestId('layout-simulate-open')).toBeNull();
    cleanup();
    permissions.add('stations:write');
    renderPopup(station({ isSimulator: false }));
    expect(screen.queryByTestId('layout-simulate-open')).toBeNull();
    cleanup();
    renderPopup(station());
    expect(screen.getByTestId('layout-simulate-open').textContent).toContain(
      'sites.layoutView.simulate',
    );
    expect(screen.getByText('sites.layoutView.openStation')).toBeDefined();
  });

  it('slides to the simulator actions of the selected EVSE and back', () => {
    permissions.add('stations:write');
    renderPopup(station());
    fireEvent.click(screen.getByTestId('layout-simulate-open'));
    expect(screen.getByTestId('layout-simulate-panel').className).toContain(
      'animate-slide-in-from-right',
    );
    expect(screen.queryByText('sites.layoutView.openStation')).toBeNull();
    // EVSE 1 is available: plug in, not stop charging.
    expect(screen.getByTestId('layout-simulate-plugIn')).toBeDefined();
    expect(screen.queryByTestId('layout-simulate-stopCharging')).toBeNull();
    fireEvent.change(screen.getByLabelText('simulate.evseId'), { target: { value: '2' } });
    expect(screen.getByTestId('layout-simulate-stopCharging')).toBeDefined();
    expect(screen.queryByTestId('layout-simulate-plugIn')).toBeNull();
    fireEvent.click(screen.getByLabelText('sites.layoutView.simulateBack'));
    expect(screen.queryByTestId('layout-simulate-panel')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('layout-simulate-open'));
  });

  it('sends the action through the simulator API with the OCPP station ID and the EVSE', async () => {
    permissions.add('stations:write');
    renderPopup(station());
    fireEvent.click(screen.getByTestId('layout-simulate-open'));
    fireEvent.click(screen.getByTestId('layout-simulate-plugIn'));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/css/actions/plugIn', {
        stationId: 'CS-1',
        evseId: 1,
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
    });
  });

  it('asks for a known ID token before Start Charging', async () => {
    permissions.add('stations:write');
    getMock.mockResolvedValue({ data: [], total: 0 });
    renderPopup(
      station({
        evses: [
          {
            evseId: 1,
            status: 'occupied',
            connectors: [
              {
                connectorId: 1,
                connectorType: 'Type1',
                maxPowerKw: 6.66,
                status: 'occupied',
                isPluggedIn: true,
                energyDeliveredWh: null,
              },
            ],
          },
        ],
      }),
    );
    fireEvent.click(screen.getByTestId('layout-simulate-open'));
    fireEvent.click(screen.getByTestId('layout-simulate-startCharging'));
    expect(await screen.findByText('simulate.tokenRequired')).toBeDefined();
    fireEvent.change(screen.getByLabelText('simulate.idToken'), { target: { value: 'RFID-9' } });
    fireEvent.click(screen.getByTestId('layout-simulate-startCharging'));
    expect(await screen.findByText('simulate.tokenNotFound')).toBeDefined();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('offers only Come Online for an offline station', () => {
    expect(layoutSimulateActions({ isOnline: false }, 'available')).toEqual(['comeOnline']);
    expect(layoutSimulateActions({ isOnline: true }, 'faulted')).toEqual([
      'clearFault',
      'goOffline',
    ]);
    expect(layoutSimulateActions({ isOnline: true }, 'available')).not.toContain('comeOnline');
  });
});
