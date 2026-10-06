// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock, toastMock, permission } = vi.hoisted(() => ({
  postMock: vi.fn(),
  toastMock: vi.fn(),
  permission: { canWrite: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null
        ? key
        : `${key}:${Object.entries(opts)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(',')}`,
  }),
}));

vi.mock('@/lib/api', () => ({ api: { post: postMock } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.canWrite }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { StationSimulatorConflict } from '../station/StationSimulatorConflict';

function renderBanner(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StationSimulatorConflict
        stationDbId="sta_1"
        stationId="CS-1"
        conflictAt="2026-10-04T10:00:00.000Z"
        timezone="UTC"
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  permission.canWrite = true;
});

describe('StationSimulatorConflict', () => {
  it('shows when the conflicting connection arrived', () => {
    renderBanner();
    expect(screen.getByText(/stations\.simulatorConflict:time=Oct 4, 2026/)).toBeTruthy();
  });

  it('confirms a real station after the dialog and shows a success toast', async () => {
    postMock.mockResolvedValueOnce({ changed: true });
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: 'stations.confirmRealStation' }));
    expect(screen.getByText('stations.confirmRealStationDescription:stationId=CS-1')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'stations.confirmRealStation' });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/stations/sta_1/confirm-real-station', {});
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'stations.confirmRealStationSuccess',
          variant: 'success',
        }),
      );
    });
  });

  it('hides the confirm button without stations:write', () => {
    permission.canWrite = false;
    renderBanner();
    expect(screen.queryByRole('button', { name: 'stations.confirmRealStation' })).toBeNull();
  });
});
