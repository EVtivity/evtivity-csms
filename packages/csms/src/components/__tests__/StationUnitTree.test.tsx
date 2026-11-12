// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
  }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  ApiError: class extends Error {},
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/lib/ocpp-command-access', () => ({ useCanSendOcppCommand: () => () => true }));

import { ConnectorStatus } from '../charts/ConnectorStatus';
import type { StationUnit } from '@/lib/station-units';

// GitHub discussion 59: one OCPP 1.6 station, 8 boxes of 2 AC EVSEs.
const UNITS: StationUnit[] = Array.from({ length: 8 }, (_, i) => ({
  id: `unt_box${String(i + 1)}`,
  stationId: 'sta_1',
  name: `Box ${String(i + 1)}`,
  sortOrder: i,
  evseIds: [],
  evseNumbers: [i * 2 + 1, i * 2 + 2],
}));

function evses(withUnits: boolean) {
  return Array.from({ length: 16 }, (_, i) => ({
    evseId: i + 1,
    status: 'available',
    unitId: withUnits ? `unt_box${String(Math.floor(i / 2) + 1)}` : null,
    unitName: withUnits ? `Box ${String(Math.floor(i / 2) + 1)}` : null,
    connectors: [
      {
        connectorId: 1,
        connectorType: 'Type2',
        maxPowerKw: 11,
        maxCurrentAmps: 16,
        status: i === 2 ? 'charging' : 'available',
      },
    ],
  }));
}

function renderTab(props: { withUnits: boolean; isOnline?: boolean; units?: StationUnit[] }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectorStatus
        data={evses(props.withUnits) as never}
        stationId="sta_1"
        stationOcppId="EM4-MASTER"
        ocppProtocol="ocpp1.6"
        isOnline={props.isOnline ?? true}
        isSimulator={false}
        {...(props.units != null ? { units: props.units } : {})}
        stationStatus="charging"
        statusReason={null}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('Connectors tab with station units', () => {
  it('renders a station without units exactly as before (one grid, no unit sections)', () => {
    const without = renderTab({ withUnits: false });
    const html = without.container.innerHTML;
    expect(screen.queryByTestId('station-unit-tree')).toBeNull();
    cleanup();
    // Passing no units at all renders the same markup.
    const plain = renderTab({ withUnits: false, units: [] });
    expect(plain.container.innerHTML).toBe(html);
  });

  it('shows one section per box with its EVSEs and status', () => {
    renderTab({ withUnits: true, units: UNITS });
    const tree = screen.getByTestId('station-unit-tree');
    const box2 = within(tree).getByTestId('station-unit-unt_box2');
    expect(within(box2).getByText('Box 2')).toBeDefined();
    expect(within(box2).getByText('charts.evse:{"id":3}')).toBeDefined();
    expect(within(box2).getByText('charts.evse:{"id":4}')).toBeDefined();
    expect(within(box2).queryByText('charts.evse:{"id":5}')).toBeNull();
    // Box 2 holds the charging EVSE 3.
    expect(within(box2).getAllByText(/^status\.charging/).length).toBeGreaterThan(0);
    expect(within(tree).getByTestId('station-unit-unt_box1').textContent).toContain(
      'status.available',
    );
    expect(screen.queryByTestId('station-unit-unassigned')).toBeNull();
  });

  it('shows every unit offline while the station is offline', () => {
    renderTab({ withUnits: true, units: UNITS, isOnline: false });
    expect(screen.getAllByTestId('station-online-badge')).toHaveLength(8);
  });

  it('lists the EVSEs without a unit last', () => {
    renderTab({ withUnits: true, units: UNITS.slice(0, 7) });
    const loose = screen.getByTestId('station-unit-unassigned');
    expect(within(loose).getByText('stationUnits.evsesWithoutUnit')).toBeDefined();
    expect(within(loose).getByText('charts.evse:{"id":15}')).toBeDefined();
  });
});
