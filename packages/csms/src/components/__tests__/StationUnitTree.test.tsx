// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { putMock, patchMock, deleteMock, canWrite } = vi.hoisted(() => ({
  putMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
  canWrite: { value: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
  }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: patchMock, put: putMock, delete: deleteMock },
  ApiError: class extends Error {},
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => canWrite.value }));
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

// EVSEs numbered `looseFrom` and up have no unit.
function evses(withUnits: boolean, looseFrom = 17) {
  return Array.from({ length: 16 }, (_, i) => ({
    evseId: i + 1,
    status: 'available',
    unitId: withUnits && i + 1 < looseFrom ? `unt_box${String(Math.floor(i / 2) + 1)}` : null,
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

function renderTab(props: {
  withUnits: boolean;
  isOnline?: boolean;
  units?: StationUnit[];
  looseFrom?: number;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectorStatus
        data={evses(props.withUnits, props.looseFrom) as never}
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
  vi.clearAllMocks();
  canWrite.value = true;
});

describe('Connectors tab with station units', () => {
  it('renders a station without units exactly as before (one grid, no unit cards)', () => {
    const without = renderTab({ withUnits: false });
    const html = without.container.innerHTML;
    expect(screen.queryByTestId('station-unit-tree')).toBeNull();
    cleanup();
    // Passing no units at all renders the same markup.
    const plain = renderTab({ withUnits: false, units: [] });
    expect(plain.container.innerHTML).toBe(html);
  });

  it('shows one card per box with its EVSEs and status', () => {
    renderTab({ withUnits: true, units: UNITS });
    const tree = screen.getByTestId('station-unit-tree');
    const box2 = within(tree).getByTestId('station-unit-unt_box2');
    expect(within(box2).getByRole('heading', { name: 'Box 2' })).toBeDefined();
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

  it('renders no unit picker on a station without units', () => {
    renderTab({ withUnits: false });
    expect(screen.queryByLabelText(/stationUnits\.unitOfEvse/)).toBeNull();
  });

  it('gives each EVSE card a Unit picker that moves the EVSE', async () => {
    putMock.mockResolvedValue({ changed: true });
    renderTab({ withUnits: true, units: UNITS });
    const box2 = screen.getByTestId('station-unit-unt_box2');
    const picker = within(box2).getByLabelText(
      'stationUnits.unitOfEvse:{"evse":"charts.evse:{\\"id\\":3}"}',
    );
    expect((picker as HTMLSelectElement).value).toBe('unt_box2');
    fireEvent.change(picker, { target: { value: 'unt_box5' } });
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/stations/sta_1/evses/3/unit', {
        unitId: 'unt_box5',
      });
    });
    fireEvent.change(picker, { target: { value: '' } });
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/stations/sta_1/evses/3/unit', { unitId: null });
    });
  });

  it('renames and deletes a unit from its card, the delete after the confirmation', async () => {
    patchMock.mockResolvedValue({});
    deleteMock.mockResolvedValue({ success: true });
    renderTab({ withUnits: true, units: UNITS });
    const box1 = screen.getByTestId('station-unit-unt_box1');
    fireEvent.click(within(box1).getByRole('button', { name: 'stationUnits.renameUnit' }));
    fireEvent.change(screen.getByLabelText('stationUnits.unitName'), {
      target: { value: 'Master' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common\.save|save/i }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/stations/sta_1/units/unt_box1', {
        name: 'Master',
      });
    });
    fireEvent.click(within(box1).getByRole('button', { name: 'stationUnits.deleteUnit' }));
    const confirm = await screen.findByRole('dialog');
    expect(deleteMock).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'stationUnits.deleteUnit' }));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/stations/sta_1/units/unt_box1');
    });
  });

  it('assigns an EVSE to a unit, listing the EVSEs without a unit first', async () => {
    putMock.mockResolvedValue({ changed: true });
    renderTab({ withUnits: true, units: UNITS, looseFrom: 15 });
    const box1 = screen.getByTestId('station-unit-unt_box1');
    fireEvent.click(within(box1).getByRole('button', { name: 'stationUnits.assignEvse' }));
    const select = await screen.findByLabelText<HTMLSelectElement>('stationUnits.evse');
    const options = Array.from(select.options).filter((o) => o.value !== '');
    const values = options.map((o) => o.value);
    // EVSEs 15 and 16 have no unit; then the EVSEs of Box 2 to Box 7; none of Box 1.
    expect(values.slice(0, 3)).toEqual(['15', '16', '3']);
    expect(values).not.toContain('1');
    expect(values).not.toContain('2');
    expect(values).toHaveLength(14);
    expect(options[0]?.textContent).toContain('stationUnits.noUnit');
    expect(options[2]?.textContent).toContain('Box 2');
    fireEvent.change(select, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /common\.save|save/i }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/stations/sta_1/evses/3/unit', {
        unitId: 'unt_box1',
      });
    });
  });

  it('disables Assign EVSE while every EVSE is in the unit', () => {
    const all: StationUnit = { ...UNITS[0], id: 'unt_all', name: 'All' } as StationUnit;
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorStatus
          data={evses(false).map((e) => ({ ...e, unitId: 'unt_all', unitName: 'All' })) as never}
          stationId="sta_1"
          stationOcppId="EM4-MASTER"
          ocppProtocol="ocpp1.6"
          isOnline
          isSimulator={false}
          units={[all]}
          stationStatus="charging"
          statusReason={null}
        />
      </QueryClientProvider>,
    );
    const card = screen.getByTestId('station-unit-unt_all');
    const button = within(card).getByRole('button', { name: 'stationUnits.assignEvse' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // Box 1 of the other test still offers EVSEs.
    cleanup();
    renderTab({ withUnits: true, units: UNITS });
    const box1 = screen.getByTestId('station-unit-unt_box1');
    const open = within(box1).getByRole('button', { name: 'stationUnits.assignEvse' });
    expect((open as HTMLButtonElement).disabled).toBe(false);
  });

  it('hides the unit actions and shows the unit as text without stations:write', () => {
    canWrite.value = false;
    renderTab({ withUnits: true, units: UNITS });
    const box1 = screen.getByTestId('station-unit-unt_box1');
    expect(within(box1).queryByRole('button', { name: 'stationUnits.assignEvse' })).toBeNull();
    expect(within(box1).queryByRole('button', { name: 'stationUnits.renameUnit' })).toBeNull();
    expect(within(box1).queryByRole('button', { name: 'stationUnits.deleteUnit' })).toBeNull();
    expect(within(box1).queryByRole('combobox')).toBeNull();
    // The heading and each EVSE card's unit text.
    expect(within(box1).getAllByText('Box 1')).toHaveLength(3);
  });
});
