// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock, putMock, patchMock, deleteMock, canWrite, toastMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  postMock: vi.fn(),
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
  api: { get: vi.fn(), post: postMock, patch: patchMock, put: putMock, delete: deleteMock },
  ApiError: class extends Error {},
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
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
function evses(withUnits: boolean, looseFrom = 17, retired: readonly number[] = []) {
  return Array.from({ length: 16 }, (_, i) => ({
    evseId: i + 1,
    status: 'available',
    retiredAt: retired.includes(i + 1) ? '2026-11-01T00:00:00Z' : null,
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
  retired?: number[];
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectorStatus
        data={evses(props.withUnits, props.looseFrom, props.retired) as never}
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

describe('EVSE & Connectors tab with station units', () => {
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

  it('counts only the EVSEs in service and names the retired ones apart', () => {
    renderTab({ withUnits: true, units: UNITS, retired: [2, 16], looseFrom: 16 });
    const box1 = screen.getByTestId('station-unit-unt_box1');
    expect(box1.textContent).toContain('stationUnits.evseCount:{"count":1}');
    expect(box1.textContent).toContain('stationUnits.retiredCount:{"count":1}');
    // The retired loose EVSE 16 still shows, to restore it, and counts no EVSE in service.
    const loose = screen.getByTestId('station-unit-unassigned');
    expect(loose.textContent).toContain('stationUnits.evseCount:{"count":0}');
    expect(loose.textContent).toContain('stationUnits.retiredCount:{"count":1}');
  });

  it('lists the EVSEs without a unit last', () => {
    renderTab({ withUnits: true, units: UNITS.slice(0, 7) });
    const loose = screen.getByTestId('station-unit-unassigned');
    expect(within(loose).getByText('stationUnits.evsesWithoutUnit')).toBeDefined();
    expect(within(loose).getByText('charts.evse:{"id":15}')).toBeDefined();
  });

  it('puts Create Unit before Create EVSE, no units text in the header, and no Unit picker on the EVSE cards', () => {
    renderTab({ withUnits: false });
    const buttons = screen
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((label) => label === 'stationUnits.createUnit' || label === 'stations.addEvse');
    expect(buttons).toEqual(['stationUnits.createUnit', 'stations.addEvse']);
    expect(screen.queryByText('stationUnits.description')).toBeNull();
    expect(screen.getByText('stations.evseConnectorsTab')).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
    cleanup();
    renderTab({ withUnits: true, units: UNITS });
    expect(screen.queryByText('stationUnits.description')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('adds a unit from the tab header', async () => {
    postMock.mockResolvedValue({ id: 'unt_new' });
    renderTab({ withUnits: false });
    fireEvent.click(screen.getByRole('button', { name: 'stationUnits.createUnit' }));
    expect(screen.getByText('stationUnits.createUnitDescription')).toBeDefined();
    fireEvent.change(screen.getByLabelText('stationUnits.unitName'), {
      target: { value: 'Box 1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common\.save|save/i }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/stations/sta_1/units', { name: 'Box 1' });
    });
  });

  it('sends the optional serial number and IP address with a new unit', async () => {
    postMock.mockResolvedValue({ id: 'unt_new' });
    renderTab({ withUnits: false });
    fireEvent.click(screen.getByRole('button', { name: 'stationUnits.createUnit' }));
    fireEvent.change(screen.getByLabelText('stationUnits.unitName'), {
      target: { value: 'Box 1' },
    });
    fireEvent.change(screen.getByLabelText('stationUnits.serialNumber'), {
      target: { value: ' EM4-0001 ' },
    });
    fireEvent.change(screen.getByLabelText('stationUnits.ipAddress'), {
      target: { value: '192.168.1.21' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common\.save|save/i }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/stations/sta_1/units', {
        name: 'Box 1',
        serialNumber: 'EM4-0001',
        ipAddress: '192.168.1.21',
      });
    });
  });

  it('removes an EVSE from a unit with Remove EVSE, listing only the unit EVSEs', async () => {
    putMock.mockResolvedValue({ changed: true });
    renderTab({ withUnits: true, units: UNITS });
    const box2 = screen.getByTestId('station-unit-unt_box2');
    fireEvent.click(within(box2).getByRole('button', { name: 'stationUnits.removeEvse' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('stationUnits.removeEvse')).toBeDefined();
    const select = within(dialog).getByLabelText<HTMLSelectElement>('stationUnits.evse');
    const values = Array.from(select.options)
      .map((o) => o.value)
      .filter((v) => v !== '');
    expect(values).toEqual(['3', '4']);
    fireEvent.change(select, { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /common\.save|save/i }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/stations/sta_1/evses/4/unit', { unitId: null });
    });
  });

  it('disables Remove EVSE while the unit has no EVSEs', () => {
    const empty: StationUnit = { ...UNITS[0], id: 'unt_empty', name: 'Empty' } as StationUnit;
    renderTab({ withUnits: true, units: [...UNITS, empty] });
    const card = screen.getByTestId('station-unit-unt_empty');
    const button = within(card).getByRole('button', { name: 'stationUnits.removeEvse' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const box1 = screen.getByTestId('station-unit-unt_box1');
    const enabled = within(box1).getByRole('button', { name: 'stationUnits.removeEvse' });
    expect((enabled as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the serial number and IP address in the unit header when set', () => {
    const units = UNITS.map((u, i) =>
      i === 0 ? { ...u, serialNumber: 'EM4-0001', ipAddress: '192.168.1.21' } : u,
    );
    renderTab({ withUnits: true, units });
    const box1 = screen.getByTestId('station-unit-unt_box1');
    expect(within(box1).getByText(/stationUnits\.serialNumberValue.*EM4-0001/)).toBeTruthy();
    expect(within(box1).getByText(/stationUnits\.ipAddressValue.*192\.168\.1\.21/)).toBeTruthy();
    const box2 = screen.getByTestId('station-unit-unt_box2');
    expect(within(box2).queryByText(/stationUnits\.serialNumberValue/)).toBeNull();
    expect(within(box2).queryByText(/stationUnits\.ipAddressValue/)).toBeNull();
  });

  it('clears the serial number and IP address with empty fields on an edit', async () => {
    patchMock.mockResolvedValue({});
    const units = UNITS.map((u, i) =>
      i === 0 ? { ...u, serialNumber: 'EM4-0001', ipAddress: '192.168.1.21' } : u,
    );
    renderTab({ withUnits: true, units });
    const box1 = screen.getByTestId('station-unit-unt_box1');
    fireEvent.click(within(box1).getByRole('button', { name: 'stationUnits.editUnit' }));
    expect(screen.getByLabelText<HTMLInputElement>('stationUnits.serialNumber').value).toBe(
      'EM4-0001',
    );
    fireEvent.change(screen.getByLabelText('stationUnits.serialNumber'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('stationUnits.ipAddress'), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: /common\.save|save/i }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/stations/sta_1/units/unt_box1', {
        name: 'Box 1',
        serialNumber: '',
        ipAddress: '',
      });
    });
  });

  it('edits and deletes a unit from its card, the delete after the confirmation', async () => {
    patchMock.mockResolvedValue({});
    deleteMock.mockResolvedValue({ success: true });
    renderTab({ withUnits: true, units: UNITS });
    const box1 = screen.getByTestId('station-unit-unt_box1');
    fireEvent.click(within(box1).getByRole('button', { name: 'stationUnits.editUnit' }));
    fireEvent.change(screen.getByLabelText('stationUnits.unitName'), {
      target: { value: 'Master' },
    });
    fireEvent.change(screen.getByLabelText('stationUnits.serialNumber'), {
      target: { value: 'EM4-0001' },
    });
    fireEvent.change(screen.getByLabelText('stationUnits.ipAddress'), {
      target: { value: '192.168.1.21' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common\.save|save/i }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/stations/sta_1/units/unt_box1', {
        name: 'Master',
        serialNumber: 'EM4-0001',
        ipAddress: '192.168.1.21',
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
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({ variant: 'success', title: 'common.saved' });
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

  it('hides the unit actions and Create Unit without stations:write', () => {
    canWrite.value = false;
    renderTab({ withUnits: true, units: UNITS });
    const box1 = screen.getByTestId('station-unit-unt_box1');
    expect(within(box1).queryByRole('button', { name: 'stationUnits.assignEvse' })).toBeNull();
    expect(within(box1).queryByRole('button', { name: 'stationUnits.editUnit' })).toBeNull();
    expect(within(box1).queryByRole('button', { name: 'stationUnits.deleteUnit' })).toBeNull();
    expect(within(box1).queryByRole('button', { name: 'stationUnits.removeEvse' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'stationUnits.createUnit' })).toBeNull();
    expect(within(box1).queryByRole('combobox')).toBeNull();
    // The heading only: the EVSE cards name no unit.
    expect(within(box1).getAllByText('Box 1')).toHaveLength(1);
  });
});
