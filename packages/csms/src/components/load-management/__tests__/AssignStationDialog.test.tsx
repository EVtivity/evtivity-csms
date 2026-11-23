// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const TRANSLATED: Record<string, string> = {
  'errors.OVERSUBSCRIPTION_EXCEEDED':
    'Total connected capacity ({{connectedKw}} kW) exceeds panel effective capacity ({{allowedKw}} kW)',
};

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { replace?: Record<string, string | number> }) =>
      (TRANSLATED[key] ?? key).replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
        String(options?.replace?.[name] ?? match),
      ),
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { ApiError } from '@/lib/api';
import { AssignStationDialog } from '../AssignStationDialog';

const STATION = {
  id: 'sta_1',
  stationId: 'EM4-MASTER-01',
  currentDrawKw: 0,
  allocatedLimitKw: null,
  maxPowerKw: 352,
  loadPriority: 5,
  isOnline: true,
  hasActiveSession: false,
};

function renderDialog(): {
  onClose: ReturnType<typeof vi.fn>;
  onAssigned: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onAssigned = vi.fn();
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AssignStationDialog
        siteId="sit_1"
        circuitId="cir_1"
        stations={[STATION]}
        assignedStationIds={[]}
        open
        onClose={onClose}
        onAssigned={onAssigned}
      />
    </QueryClientProvider>,
  );
  return { onClose, onAssigned };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AssignStationDialog', () => {
  it('shows the refusal when the panel cannot take the station and stays open', async () => {
    apiMock.patch.mockRejectedValue(
      new ApiError(400, {
        error: 'Total connected capacity (352.0 kW) exceeds panel effective capacity (220.8 kW)',
        code: 'OVERSUBSCRIPTION_EXCEEDED',
        details: { connectedKw: 352, allowedKw: 220.8 },
      }),
    );
    const { onClose, onAssigned } = renderDialog();
    fireEvent.click(screen.getByText('EM4-MASTER-01'));
    fireEvent.click(screen.getAllByText('loadManagement.addStation').at(-1) as HTMLElement);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(
        'Total connected capacity (352 kW) exceeds panel effective capacity (220.8 kW)',
      );
    });
    expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/sit_1/stations/sta_1/circuit', {
      circuitId: 'cir_1',
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onAssigned).not.toHaveBeenCalled();
  });

  it('closes after a successful assignment without an error', async () => {
    apiMock.patch.mockResolvedValue({
      id: 'sta_1',
      stationId: 'EM4-MASTER-01',
      circuitId: 'cir_1',
    });
    const { onClose, onAssigned } = renderDialog();
    fireEvent.click(screen.getByText('EM4-MASTER-01'));
    fireEvent.click(screen.getAllByText('loadManagement.addStation').at(-1) as HTMLElement);
    await waitFor(() => {
      expect(onAssigned).toHaveBeenCalled();
    });
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
