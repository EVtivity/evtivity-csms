// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: Record<string, unknown>) => unknown) =>
    select({
      logout: vi.fn(),
      setLanguage: vi.fn(),
      setTheme: vi.fn(),
      theme: 'light',
      user: { id: 'usr_me', email: 'me@example.com', firstName: 'Me', lastName: 'Self' },
    }),
}));
// Renders only the trigger of the menu.
vi.mock('@/components/SpeedDial', () => ({
  SpeedDial: ({ trigger }: { trigger: React.ReactNode }) => <div>{trigger}</div>,
}));

import { UserDropdown } from '../UserDropdown';

function renderMenu(collapsed = false): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UserDropdown collapsed={collapsed} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('Sidebar user menu avatar (expanded, collapsed and the mobile drawer)', () => {
  it('shows the own avatar from /v1/users/me in the header menu', async () => {
    getMock.mockResolvedValue({
      id: 'usr_me',
      avatar: { kind: 'generated', style: 'avataaars', seed: 'abc', options: {} },
    });
    renderMenu();
    const img = await screen.findByAltText('avatar.alt');
    expect(img.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
    expect(getMock).toHaveBeenCalledWith('/v1/users/me');
  });

  it('shows the avatar in the collapsed sidebar too', async () => {
    getMock.mockResolvedValue({
      id: 'usr_me',
      avatar: { kind: 'image', url: 'https://s3.example/me.jpg' },
    });
    renderMenu(true);
    const img = await screen.findByAltText('avatar.alt');
    expect(img.getAttribute('src')).toBe('https://s3.example/me.jpg');
  });

  it('shows initials without an avatar', async () => {
    getMock.mockResolvedValue({ id: 'usr_me', avatar: null });
    renderMenu();
    expect(await screen.findByText('MS')).toBeTruthy();
    expect(screen.queryByAltText('avatar.alt')).toBeNull();
    cleanup();
    renderMenu(true);
    expect(await screen.findByText('MS')).toBeTruthy();
  });
});
