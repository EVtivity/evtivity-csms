// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, putMock, deleteMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  deleteMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: getMock, put: putMock, delete: deleteMock, patch: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: Record<string, unknown>) => unknown) =>
    select({ hydrate: vi.fn(), applyLanguageLocal: vi.fn(), applyTimezoneLocal: vi.fn() }),
}));
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (value: string) => value,
  TIMEZONE_OPTIONS: [{ value: 'UTC', label: 'UTC' }],
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/components/avatar/AvatarField', () => ({
  AvatarField: ({ onSave }: { onSave?: (c: unknown) => Promise<void> }) =>
    onSave == null ? (
      <span>avatar-read-only</span>
    ) : (
      <button
        type="button"
        onClick={() => {
          void onSave({ kind: 'remove' });
        }}
      >
        remove-avatar
      </button>
    ),
}));

import { ProfilePersonalInfo } from '../ProfilePersonalInfo';

const USER = {
  id: 'usr_me',
  email: 'me@example.com',
  firstName: 'Me',
  lastName: 'Self',
  phone: null,
  roleId: 'rol_operator',
  isActive: true,
  language: 'en',
  timezone: 'UTC',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  role: null,
  avatar: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProfilePersonalInfo avatar', () => {
  it('edits the own avatar in the profile edit form through /v1/users/me/avatar', async () => {
    getMock.mockResolvedValue({ factorProofKinds: [] });
    deleteMock.mockResolvedValue({ avatar: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ProfilePersonalInfo user={USER} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('avatar-read-only')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    fireEvent.click(screen.getByText('remove-avatar'));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/v1/users/me/avatar');
    });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'avatar.removed' }));
  });
});
