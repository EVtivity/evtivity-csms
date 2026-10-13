// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/lib/version', () => ({ APP_VERSION: 'test' }));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/lib/auth', () => ({
  useAuth: (pick: (s: { retryConnection: () => void; isHydrating: boolean }) => unknown) =>
    pick({ retryConnection: vi.fn(), isHydrating: false }),
}));

import { useAuthBranding } from '../AuthBranding';
import { ServerDown } from '../ServerDown';

function BrandingProbe(): React.JSX.Element {
  const { companyLogo } = useAuthBranding();
  return <span data-testid="logo">{companyLogo ?? ''}</span>;
}

describe('ServerDown', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    getMock.mockReset();
  });

  // The app shows it before the query provider exists, so it renders without one.
  it('shows the last company logo without a query provider', () => {
    localStorage.setItem(
      'csms_branding',
      JSON.stringify({ name: 'Acme Charging', logo: 'data:image/png;base64,AAA' }),
    );
    render(<ServerDown />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(img.getAttribute('alt')).toBe('Acme Charging');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('falls back to the EVtivity logo when no branding was ever loaded', () => {
    render(<ServerDown />);
    expect(screen.getByRole('img').getAttribute('src')).toBe('/evtivity-logo.svg');
  });

  it('branding remembers the company logo once it loads', async () => {
    getMock.mockResolvedValue({ name: 'Acme Charging', logo: 'data:image/png;base64,BBB' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BrandingProbe />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(localStorage.getItem('csms_branding')).toContain('BBB');
    });
    expect(screen.getByTestId('logo').textContent).toBe('data:image/png;base64,BBB');
  });
});
