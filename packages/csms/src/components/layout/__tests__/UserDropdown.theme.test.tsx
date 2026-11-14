// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, patchMock, postMock, toastMock } = vi.hoisted(() => {
  // The auth store reads the system mode when it loads; jsdom has no matchMedia.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  return { getMock: vi.fn(), patchMock: vi.fn(), postMock: vi.fn(), toastMock: vi.fn() };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: getMock, patch: patchMock, post: postMock },
}));
vi.mock('@/i18n', () => ({ loadLanguage: vi.fn(() => Promise.resolve()) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { useAuth } from '@/lib/auth';
import { UserDropdown } from '../UserDropdown';
import { ProfileAppearance } from '@/components/profile/ProfileAppearance';

const user = {
  id: 'usr_me',
  email: 'me@example.com',
  firstName: 'Me',
  lastName: 'Self',
  themePreference: 'light' as const,
  uiTheme: 'default' as const,
};

function renderMenu(collapsed = false): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UserDropdown collapsed={collapsed} />
        <ProfileAppearance />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { expanded: false }));
}

beforeEach(() => {
  getMock.mockResolvedValue({ id: 'usr_me', avatar: null });
  patchMock.mockResolvedValue({});
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('data-theme');
  act(() => {
    useAuth.setState({
      user: user as unknown as NonNullable<ReturnType<typeof useAuth.getState>['user']>,
      theme: 'light',
      uiTheme: 'default',
    });
  });
});

afterEach(() => {
  cleanup();
  getMock.mockReset();
  patchMock.mockReset();
  localStorage.clear();
});

describe('Sidebar user menu theme and mode', () => {
  it.each([
    ['expanded and the mobile drawer', false],
    ['collapsed', true],
  ])('picks a theme in the %s form, saves it and applies it at once', async (_form, collapsed) => {
    renderMenu(collapsed);
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'profile.uiTheme' }));
    const soft = screen.getByRole('button', { name: 'profile.uiThemeSoft' });
    expect(screen.getByRole('button', { name: 'profile.uiThemeDefault' }).ariaPressed).toBe('true');
    expect(soft.ariaPressed).toBe('false');
    expect(screen.getByRole('button', { name: 'profile.uiThemeHighContrast' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(soft);
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith('/v1/users/me', { uiTheme: 'soft' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('soft');
    expect(localStorage.getItem('ui_theme')).toBe('soft');
    // Profile > Appearance reads the same store, so it shows the new theme.
    expect(screen.getByLabelText<HTMLSelectElement>('profile.uiTheme').value).toBe('soft');
    // The menu closed; reopening it shows the new choice.
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'profile.uiTheme' }));
    expect(screen.getByRole('button', { name: 'profile.uiThemeSoft' }).ariaPressed).toBe('true');
  });

  it('switches back to Default by removing data-theme', async () => {
    act(() => {
      useAuth.setState({ uiTheme: 'high-contrast' });
    });
    document.documentElement.setAttribute('data-theme', 'high-contrast');
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'profile.uiTheme' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'profile.uiThemeDefault' }));
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith('/v1/users/me', { uiTheme: 'default' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('switches the mode next to the theme and keeps the theme', async () => {
    act(() => {
      useAuth.setState({ uiTheme: 'soft' });
    });
    document.documentElement.setAttribute('data-theme', 'soft');
    renderMenu();
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'nav.theme' }));
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith('/v1/users/me', { themePreference: 'dark' });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('soft');
    expect(screen.getByLabelText<HTMLSelectElement>('profile.theme').value).toBe('dark');
  });

  it('puts the theme back and says so when the save fails', async () => {
    patchMock.mockRejectedValue(new Error('offline'));
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'profile.uiTheme' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'profile.uiThemeSoft' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(patchMock).toHaveBeenCalledWith('/v1/users/me', { uiTheme: 'soft' });
    expect(useAuth.getState().uiTheme).toBe('default');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('puts the mode back and says so when the save fails', async () => {
    patchMock.mockRejectedValue(new Error('offline'));
    renderMenu();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('profile.theme'), { target: { value: 'dark' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useAuth.getState().theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });

  it('goes back from the theme list to the menu', () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'profile.uiTheme' }));
    fireEvent.click(screen.getByRole('button', { name: 'nav.back' }));
    expect(screen.getByRole('button', { name: 'nav.language' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'profile.uiThemeSoft' })).toBeNull();
  });
});
