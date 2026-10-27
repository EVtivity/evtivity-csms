// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

// The New Driver and New User pages keep the avatar choice and store it right
// after the account exists; a failed avatar keeps the account.

const { getMock, postMock, putMock, toastMock, navigateMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  toastMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigateMock,
}));
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, put: putMock, delete: vi.fn() },
  getApiErrorFieldDetails: () => ({}),
  ApiError: class ApiError extends Error {},
}));
vi.mock('@/lib/auth', () => ({ useHasAllSiteAccess: () => true }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/components/PermissionEditor', () => ({ PermissionEditor: () => null }));
vi.mock('@/components/avatar/AvatarField', () => ({
  AvatarField: ({
    avatar,
    onSave,
    hint,
  }: {
    avatar: { kind: string; seed?: string } | null;
    onSave?: (c: unknown) => Promise<void>;
    hint?: string;
  }) => (
    <div>
      <span>{avatar == null ? 'preview-none' : `preview-${avatar.kind}-${avatar.seed ?? ''}`}</span>
      <span>{hint}</span>
      <button
        type="button"
        onClick={() => {
          void onSave?.({
            kind: 'generated',
            avatar: { style: 'avataaars', seed: 'New1', options: {} },
          });
        }}
      >
        choose-avatar
      </button>
    </div>
  ),
}));

import { DriverCreate } from '../DriverCreate';
import { UserCreate } from '../UserCreate';

function wrap(children: React.ReactNode): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillDriver(): void {
  fireEvent.change(screen.getByLabelText('drivers.firstName'), { target: { value: 'Ana' } });
  fireEvent.change(screen.getByLabelText('drivers.lastName'), { target: { value: 'Lee' } });
  fireEvent.change(screen.getByLabelText('common.email'), { target: { value: 'ana@b.example' } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('New Driver avatar', () => {
  it('previews the choice, stores nothing before the driver exists, then sets it', async () => {
    postMock.mockResolvedValue({ id: 'drv_new' });
    putMock.mockResolvedValue({ avatar: null });
    wrap(<DriverCreate />);
    expect(screen.getByText('avatar.savedWithNewAccount')).toBeTruthy();
    expect(screen.getByText('preview-none')).toBeTruthy();
    fireEvent.click(screen.getByText('choose-avatar'));
    expect(await screen.findByText('preview-generated-New1')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
    fillDriver();
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/drivers/drv_new');
    });
    expect(postMock).toHaveBeenCalledWith('/v1/drivers', expect.any(Object));
    expect(putMock).toHaveBeenCalledWith('/v1/drivers/drv_new/avatar', {
      style: 'avataaars',
      seed: 'New1',
      options: {},
    });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('keeps the new driver and says so when the avatar fails', async () => {
    postMock.mockResolvedValue({ id: 'drv_new' });
    putMock.mockRejectedValue(new Error('boom'));
    wrap(<DriverCreate />);
    fireEvent.click(screen.getByText('choose-avatar'));
    fillDriver();
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/drivers/drv_new');
    });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'avatar.applyFailed', variant: 'destructive' }),
    );
  });

  it('sends no avatar request without a choice', async () => {
    postMock.mockResolvedValue({ id: 'drv_new' });
    wrap(<DriverCreate />);
    fillDriver();
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/drivers/drv_new');
    });
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe('New User avatar', () => {
  it("sets the chosen avatar on the new user's /v1/users/:id/avatar after the create", async () => {
    getMock.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/v1/roles'
          ? [{ id: 'rol_viewer', name: 'viewer' }]
          : path === '/v1/users/me/mfa'
            ? { factorProofKinds: [], mfaMethod: null }
            : { data: [] },
      ),
    );
    postMock.mockResolvedValue({ id: 'usr_new' });
    putMock.mockResolvedValue({ avatar: null });
    wrap(<UserCreate />);
    fireEvent.click(screen.getByText('choose-avatar'));
    await screen.findByRole('option', { name: 'viewer' });
    fireEvent.change(screen.getByLabelText('users.role'), { target: { value: 'rol_viewer' } });
    fireEvent.change(screen.getByLabelText('common.email'), { target: { value: 'u@b.example' } });
    fireEvent.change(screen.getByLabelText('users.firstName'), { target: { value: 'U' } });
    fireEvent.change(screen.getByLabelText('users.lastName'), { target: { value: 'V' } });
    fireEvent.click(screen.getByLabelText('users.allSites'));
    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/users/usr_new');
    });
    expect(putMock).toHaveBeenCalledWith('/v1/users/usr_new/avatar', {
      style: 'avataaars',
      seed: 'New1',
      options: {},
    });
  });
});
