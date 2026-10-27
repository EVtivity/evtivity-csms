// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Operators edit avatars inside the driver and user edit forms: drivers:write
// for a driver, users:write for another user, always for the own account.

const { getMock, patchMock, putMock, deleteMock, toastMock, auth } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
  putMock: vi.fn(),
  deleteMock: vi.fn(),
  toastMock: vi.fn(),
  auth: { permissions: [] as string[], userId: 'usr_me' },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: getMock, patch: patchMock, put: putMock, delete: deleteMock, post: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (perm: string) => auth.permissions.includes(perm),
  useHasAllSiteAccess: () => true,
  useAuth: (select: (s: Record<string, unknown>) => unknown) =>
    select({ user: { id: auth.userId } }),
}));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/components/ui/tabs', () => ({
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../driver/DriverPortalAccessCard', () => ({ DriverPortalAccessCard: () => null }));
vi.mock('@/components/avatar/AvatarField', () => ({
  AvatarField: ({ onSave }: { onSave?: (c: unknown) => Promise<void> }) =>
    onSave == null ? (
      <span>avatar-read-only</span>
    ) : (
      <>
        <button
          type="button"
          onClick={() => {
            void onSave({
              kind: 'generated',
              avatar: { style: 'avataaars', seed: 'Op1', options: {} },
            });
          }}
        >
          set-avatar
        </button>
        <button
          type="button"
          onClick={() => {
            void onSave({ kind: 'remove' });
          }}
        >
          remove-avatar
        </button>
      </>
    ),
}));

import { DriverDetailsTab } from '../driver/DriverDetailsTab';
import { UserDetailsTab } from '../user/UserDetailsTab';

const DRIVER = {
  id: 'drv_1',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  phone: null,
  language: 'en',
  isActive: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  avatar: null,
};

function user(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    firstName: 'Op',
    lastName: 'Erator',
    phone: null,
    roleId: 'rol_operator',
    isActive: true,
    hasAllSiteAccess: true,
    siteIds: [],
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    avatar: null,
  };
}

function wrap(children: React.ReactNode): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
}

function renderUser(id: string): void {
  getMock.mockResolvedValue({ data: [], factorProofKinds: [] });
  wrap(
    <UserDetailsTab
      user={user(id)}
      userId={id}
      roles={[{ id: 'rol_operator', name: 'operator' }]}
      canAdminister
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('driver avatar in the Details edit form', () => {
  it('sets and removes the avatar through /v1/drivers/:id/avatar with drivers:write', async () => {
    auth.permissions = ['drivers:write'];
    putMock.mockResolvedValue({ avatar: null });
    deleteMock.mockResolvedValue({ avatar: null });
    wrap(<DriverDetailsTab driver={DRIVER} timezone="UTC" />);
    expect(screen.queryByText('set-avatar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /common\.edit/ }));
    fireEvent.click(screen.getByText('set-avatar'));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/drivers/drv_1/avatar', {
        style: 'avataaars',
        seed: 'Op1',
        options: {},
      });
    });
    fireEvent.click(screen.getByText('remove-avatar'));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/drivers/drv_1/avatar');
    });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'avatar.removed' }));
  });

  it('keeps the avatar read-only without drivers:write', () => {
    auth.permissions = [];
    wrap(<DriverDetailsTab driver={DRIVER} timezone="UTC" />);
    fireEvent.click(screen.getByRole('button', { name: /common\.edit/ }));
    expect(screen.getByText('avatar-read-only')).toBeTruthy();
  });
});

describe('user avatar in the Details edit form', () => {
  it("edits another user's avatar through /v1/users/:id/avatar with users:write", async () => {
    auth.permissions = ['users:write'];
    deleteMock.mockResolvedValue({ avatar: null });
    renderUser('usr_other');
    fireEvent.click(screen.getByText('remove-avatar'));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/users/usr_other/avatar');
    });
  });

  it('edits the own avatar through /v1/users/me/avatar, users:write or not', async () => {
    auth.permissions = [];
    deleteMock.mockResolvedValue({ avatar: null });
    renderUser('usr_me');
    fireEvent.click(screen.getByText('remove-avatar'));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/users/me/avatar');
    });
  });

  it("keeps another user's avatar read-only without users:write", () => {
    auth.permissions = [];
    renderUser('usr_other');
    expect(screen.getByText('avatar-read-only')).toBeTruthy();
  });
});
