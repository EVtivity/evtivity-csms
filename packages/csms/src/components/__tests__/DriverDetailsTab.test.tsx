// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { patchMock } = vi.hoisted(() => ({ patchMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({ api: { patch: patchMock } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => null, useHasPermission: () => true }));
vi.mock('@/components/ui/tabs', () => ({
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../driver/DriverPortalAccessCard', () => ({ DriverPortalAccessCard: () => null }));

import { DriverDetailsTab } from '../driver/DriverDetailsTab';

function renderTab(language = 'de'): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DriverDetailsTab
        driver={{
          id: 'drv_1',
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'jane@example.com',
          phone: null,
          language,
          isActive: true,
          createdAt: '2026-10-01T00:00:00Z',
          updatedAt: '2026-10-01T00:00:00Z',
        }}
        timezone="UTC"
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  patchMock.mockReset();
});

describe('DriverDetailsTab', () => {
  it('shows the driver language by its name', () => {
    renderTab('zh-TW');
    expect(screen.getByText('drivers.language')).toBeTruthy();
    expect(screen.getByText('繁體中文')).toBeTruthy();
  });

  it('edits the language and sends it with the update', async () => {
    patchMock.mockResolvedValue({});
    renderTab('de');

    fireEvent.click(screen.getByRole('button', { name: /common\.edit/ }));
    const select = screen.getByLabelText<HTMLSelectElement>('drivers.language');
    expect(select.value).toBe('de');
    fireEvent.change(select, { target: { value: 'ko' } });
    fireEvent.submit(select.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith(
        '/v1/drivers/drv_1',
        expect.objectContaining({ language: 'ko' }),
      );
    });
  });
});
