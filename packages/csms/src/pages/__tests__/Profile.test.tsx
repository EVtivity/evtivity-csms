// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, fleetUser } = vi.hoisted(() => ({
  getMock: vi.fn(),
  fleetUser: { value: false },
}));

vi.mock('@/lib/auth', () => ({ useIsFleetUser: () => fleetUser.value }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/components/profile/ProfilePersonalInfo', () => ({ ProfilePersonalInfo: () => null }));
vi.mock('@/components/profile/ProfileAppearance', () => ({ ProfileAppearance: () => null }));
vi.mock('@/components/profile/ProfilePassword', () => ({ ProfilePassword: () => null }));
vi.mock('@/components/profile/ProfileMfa', () => ({ ProfileMfa: () => null }));
vi.mock('@/components/profile/ProfilePasskeys', () => ({ ProfilePasskeys: () => null }));
vi.mock('@/components/profile/ProfileNotifications', () => ({ ProfileNotifications: () => null }));
vi.mock('@/components/profile/ProfileChatbotAi', () => ({ ProfileChatbotAi: () => null }));
vi.mock('@/components/profile/ProfileSupportAi', () => ({ ProfileSupportAi: () => null }));

import { Profile } from '../Profile';

// The tabs measure themselves; jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

const USER = {
  id: 'usr_1',
  email: 'operator@example.com',
  firstName: 'Op',
  lastName: 'Erator',
  phone: null,
  language: 'en',
  timezone: 'UTC',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  role: null,
};

function answer(chatbotAiEnabled: boolean, supportAiEnabled: boolean): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/v1/users/me') return Promise.resolve(USER);
    if (path === '/v1/portal/features') return Promise.resolve({ chatbotAiEnabled });
    if (path === '/v1/security/public') return Promise.resolve({ supportAiEnabled });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fleetUser.value = false;
});

describe('Profile', () => {
  it('shows the AI tabs from the public flags, without reading settings', async () => {
    answer(true, true);
    renderPage();

    expect(await screen.findByText('profile.chatbotAi')).toBeDefined();
    expect(await screen.findByText('profile.supportAi')).toBeDefined();
    const paths = getMock.mock.calls.map((c) => c[0] as string);
    expect(paths.filter((p) => p.startsWith('/v1/settings'))).toEqual([]);
  });

  it('hides the AI tabs while the features are off', async () => {
    answer(false, false);
    renderPage();

    expect(await screen.findByText('profile.personalInfo')).toBeDefined();
    expect(screen.queryByText('profile.chatbotAi')).toBeNull();
    expect(screen.queryByText('profile.supportAi')).toBeNull();
  });

  it('shows a fleet user no AI tabs: it has no assistant or support', async () => {
    fleetUser.value = true;
    answer(true, true);
    renderPage();

    expect(await screen.findByText('profile.personalInfo')).toBeDefined();
    // Both flags answered on: only the fleet user check hides the tabs.
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/portal/features');
      expect(getMock).toHaveBeenCalledWith('/v1/security/public');
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('profile.chatbotAi')).toBeNull();
    expect(screen.queryByText('profile.supportAi')).toBeNull();
  });
});
