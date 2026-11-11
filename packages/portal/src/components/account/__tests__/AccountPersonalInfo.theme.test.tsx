// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { state, patchMock, getMock } = vi.hoisted(() => ({
  patchMock: vi.fn(() => Promise.resolve({})),
  getMock: vi.fn(() => Promise.resolve({ enabled: false, method: null, methods: [] })),
  state: {
    driver: {
      id: 'drv_1',
      firstName: 'Ada',
      lastName: 'Driver',
      email: 'ada@example.com',
      phone: null,
      language: 'en',
      timezone: 'UTC',
      themePreference: 'light',
      uiTheme: 'default',
      distanceUnit: 'miles',
      priceDisplay: null,
      isActive: true,
      emailVerified: true,
    },
    theme: 'light',
    uiTheme: 'default',
    hydrate: vi.fn(),
    applyLanguageLocal: vi.fn(() => Promise.resolve()),
    applyTimezoneLocal: vi.fn(),
    applyThemeLocal: vi.fn(),
    applyUiThemeLocal: vi.fn(),
    applyDistanceUnitLocal: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: typeof state) => unknown) => selector(state),
}));
vi.mock('@/lib/api', () => ({ api: { patch: patchMock, get: getMock } }));
vi.mock('@/lib/avatar', () => ({ useDriverAvatar: () => ({ data: null }) }));
vi.mock('../AvatarEditor', () => ({ AvatarField: () => null }));
vi.mock('@/hooks/use-price-display', () => ({ useCompanyPriceDisplay: () => 'gross' }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { AccountPersonalInfo } from '../AccountPersonalInfo';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccountPersonalInfo />
    </QueryClientProvider>,
  );
}

describe('AccountPersonalInfo theme and mode', () => {
  it('shows Theme with its description and Mode with Light and Dark', () => {
    mount();
    const theme = screen.getByLabelText<HTMLSelectElement>('profile.uiTheme');
    expect([...theme.options].map((o) => o.value)).toEqual(['default', 'soft', 'high-contrast']);
    expect(screen.getByText('profile.uiThemeDefaultDescription')).toBeTruthy();
    const mode = screen.getByLabelText<HTMLSelectElement>('profile.theme');
    expect([...mode.options].map((o) => o.value)).toEqual(['light', 'dark']);
    fireEvent.change(theme, { target: { value: 'soft' } });
    expect(screen.getByText('profile.uiThemeSoftDescription')).toBeTruthy();
  });

  it('saves the theme with the profile and applies it after the save', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('profile.uiTheme'), {
      target: { value: 'high-contrast' },
    });
    fireEvent.submit(screen.getByLabelText('profile.uiTheme').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(state.applyUiThemeLocal).toHaveBeenCalledWith('high-contrast');
    });
    expect(patchMock).toHaveBeenCalledWith(
      '/v1/portal/driver/profile',
      expect.objectContaining({ uiTheme: 'high-contrast', themePreference: 'light' }),
    );
  });
});
