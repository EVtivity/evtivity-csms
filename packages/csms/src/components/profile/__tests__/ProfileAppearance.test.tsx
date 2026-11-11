// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const { state } = vi.hoisted(() => ({
  state: {
    theme: 'light',
    uiTheme: 'default',
    setTheme: vi.fn(() => Promise.resolve()),
    setUiTheme: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: typeof state) => unknown) => selector(state),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { ProfileAppearance } from '../ProfileAppearance';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.uiTheme = 'default';
});

describe('ProfileAppearance', () => {
  it('lists the three themes and describes the selected one', () => {
    state.uiTheme = 'soft';
    render(<ProfileAppearance />);
    const theme = screen.getByLabelText<HTMLSelectElement>('profile.uiTheme');
    expect([...theme.options].map((o) => o.value)).toEqual(['default', 'soft', 'high-contrast']);
    expect(theme.value).toBe('soft');
    expect(screen.getByText('profile.uiThemeSoftDescription')).toBeTruthy();
  });

  it('saves a theme and a mode on the account', () => {
    render(<ProfileAppearance />);
    fireEvent.change(screen.getByLabelText('profile.uiTheme'), {
      target: { value: 'high-contrast' },
    });
    expect(state.setUiTheme).toHaveBeenCalledWith('high-contrast');
    fireEvent.change(screen.getByLabelText('profile.theme'), { target: { value: 'dark' } });
    expect(state.setTheme).toHaveBeenCalledWith('dark');
  });

  it('offers Light and Dark as the only modes', () => {
    render(<ProfileAppearance />);
    const mode = screen.getByLabelText<HTMLSelectElement>('profile.theme');
    expect([...mode.options].map((o) => o.value)).toEqual(['light', 'dark']);
  });
});
