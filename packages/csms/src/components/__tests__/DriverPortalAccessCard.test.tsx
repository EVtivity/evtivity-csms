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

vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.canWrite }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { ApiError } from '@/lib/api';
import { DriverPortalAccessCard, type PortalAccess } from '../driver/DriverPortalAccessCard';

const NONE: PortalAccess = { status: 'none', inviteExpiresAt: null };

function renderCard(
  overrides: Partial<{
    email: string | null;
    isActive: boolean;
    portalAccess: PortalAccess;
  }> = {},
): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DriverPortalAccessCard
        driver={{
          id: 'drv_1',
          email: 'jane@example.com',
          isActive: true,
          portalAccess: NONE,
          ...overrides,
        }}
        timezone="UTC"
      />
    </QueryClientProvider>,
  );
}

const inviteButton = (): HTMLElement =>
  screen.getByRole('button', { name: /drivers\.invitePortal/ });

afterEach(() => {
  cleanup();
  permission.canWrite = true;
});

describe('DriverPortalAccessCard', () => {
  it('shows Not invited and an enabled invite button for an eligible driver', () => {
    renderCard();
    expect(screen.getByText('drivers.portalStatus.none')).toBeTruthy();
    expect((inviteButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the invite after confirmation and shows a success toast', async () => {
    postMock.mockResolvedValueOnce({ expiresAt: '2026-10-08T00:00:00.000Z' });
    renderCard();

    fireEvent.click(inviteButton());
    fireEvent.click(screen.getByRole('button', { name: 'drivers.sendInvite' }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/drivers/drv_1/portal-invite', {});
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'drivers.portalInviteSent', variant: 'success' }),
      );
    });
  });

  it('shows the translated API error when the invite fails', async () => {
    postMock.mockRejectedValueOnce(
      new ApiError(409, { error: 'Driver is inactive', code: 'DRIVER_INACTIVE' }),
    );
    renderCard();

    fireEvent.click(inviteButton());
    fireEvent.click(screen.getByRole('button', { name: 'drivers.sendInvite' }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'drivers.portalInviteFailed',
          description: 'translated:errors.DRIVER_INACTIVE',
          variant: 'destructive',
        }),
      );
    });
  });

  it('offers Resend and shows the expiry for an invited driver', () => {
    renderCard({
      portalAccess: { status: 'invited', inviteExpiresAt: '2026-10-08T12:00:00.000Z' },
    });
    expect(screen.getByText('drivers.portalStatus.invited')).toBeTruthy();
    expect(screen.getByText('drivers.portalInviteExpires')).toBeTruthy();
    expect(screen.getByRole('button', { name: /drivers\.resendInvite/ })).toBeTruthy();
  });

  it('hides the invite button once the driver has portal access', () => {
    renderCard({ portalAccess: { status: 'active', inviteExpiresAt: null } });
    expect(screen.getByText('drivers.portalStatus.active')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /drivers\.invitePortal/ })).toBeNull();
  });

  it.each([
    [{ isActive: false }, 'drivers.portalInviteInactive'],
    [{ email: null }, 'drivers.portalInviteNoEmail'],
  ])('disables the invite button and explains why for %o', (overrides, reason) => {
    renderCard(overrides);
    expect((inviteButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.mouseEnter(inviteButton().parentElement as HTMLElement);
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
  });

  it('hides the invite button without drivers:write', () => {
    permission.canWrite = false;
    renderCard();
    expect(screen.queryByRole('button', { name: /drivers\.invitePortal/ })).toBeNull();
  });
});
