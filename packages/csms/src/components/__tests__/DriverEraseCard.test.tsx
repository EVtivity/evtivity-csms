// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock, toastMock, access } = vi.hoisted(() => ({
  postMock: vi.fn(),
  toastMock: vi.fn(),
  access: { canWrite: true, allSites: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
  }),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { post: postMock }, ApiError };
});

vi.mock('@/lib/auth', () => ({
  useHasPermission: () => access.canWrite,
  useHasAllSiteAccess: () => access.allSites,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { ApiError } from '@/lib/api';
import { DriverEraseCard } from '../driver/DriverEraseCard';

function renderCard(erasedAt: string | null = null): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DriverEraseCard driver={{ id: 'drv_1', erasedAt }} timezone="UTC" />
    </QueryClientProvider>,
  );
}

function openDialog(): void {
  fireEvent.click(screen.getByRole('button', { name: 'drivers.erase' }));
}

function confirmButton(): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: 'drivers.erase' });
  return buttons[buttons.length - 1] as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  access.canWrite = true;
  access.allSites = true;
});

describe('DriverEraseCard', () => {
  it('refuses a confirmation that is not the driver id and sends nothing', () => {
    renderCard();
    openDialog();
    fireEvent.change(screen.getByLabelText('drivers.eraseConfirmLabel'), {
      target: { value: 'erase' },
    });
    fireEvent.click(confirmButton());
    expect(screen.getByText('drivers.eraseConfirmMismatch')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('erases with the typed driver id and shows a success toast', async () => {
    postMock.mockResolvedValue({});
    renderCard();
    openDialog();
    fireEvent.change(screen.getByLabelText('drivers.eraseConfirmLabel'), {
      target: { value: 'drv_1' },
    });
    fireEvent.click(confirmButton());
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv_1/erase', { confirm: 'drv_1' });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({ title: 'drivers.eraseSuccess', variant: 'success' });
    });
  });

  it('shows the translated API error in the dialog', async () => {
    postMock.mockRejectedValue(new ApiError(409, { code: 'DRIVER_HAS_ACTIVE_SESSION' }));
    renderCard();
    openDialog();
    fireEvent.change(screen.getByLabelText('drivers.eraseConfirmLabel'), {
      target: { value: 'drv_1' },
    });
    fireEvent.click(confirmButton());
    expect(await screen.findByText('translated:errors.DRIVER_HAS_ACTIVE_SESSION')).toBeTruthy();
  });

  it('is hidden without drivers:write or without access to every site', () => {
    access.allSites = false;
    renderCard();
    expect(screen.queryByRole('button', { name: 'drivers.erase' })).toBeNull();
    cleanup();
    access.allSites = true;
    access.canWrite = false;
    renderCard();
    expect(screen.queryByRole('button', { name: 'drivers.erase' })).toBeNull();
  });

  it('shows when an erased driver was erased, with no action', () => {
    renderCard('2026-10-01T10:00:00Z');
    expect(screen.getByText('drivers.erasedOn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'drivers.erase' })).toBeNull();
  });
});
