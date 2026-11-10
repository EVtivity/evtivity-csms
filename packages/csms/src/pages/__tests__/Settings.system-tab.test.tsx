// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { perms } = vi.hoisted(() => {
  // jsdom has no matchMedia; the theme store reads it on import.
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
  return { perms: { list: ['settings.system:read', 'settings.system:write'] as string[] } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: vi.fn().mockResolvedValue({}) } };
});

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    useAuth: (select: (s: { permissions: string[] }) => unknown) =>
      select({ permissions: perms.list }),
    useHasAllSiteAccess: () => true,
  };
});

vi.mock('@/hooks/use-qr-icon', () => ({ useQrIcon: () => ({ svgDataUri: undefined }) }));
vi.mock('@/components/SystemInfoDialog', () => ({ SystemInfoDialog: () => null }));
vi.mock('@/components/settings/CompanySettings', () => ({
  CompanySettings: () => <div data-testid="company-panel" />,
}));
vi.mock('@/components/settings/UpdateCheckSettings', () => ({
  UpdateCheckSettings: ({ canWrite }: { canWrite: boolean }) => (
    <div data-testid="update-check-panel" data-can-write={String(canWrite)} />
  ),
}));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { Settings } from '../Settings';

afterEach(() => {
  cleanup();
  perms.list = ['settings.system:read', 'settings.system:write'];
});

function renderAt(url: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Settings System tab', () => {
  it('shows the Update Check card on the System tab', () => {
    renderAt('/settings?tab=system');
    expect(screen.getByRole('tab', { name: 'settings.systemTab' })).toBeTruthy();
    expect(screen.getByTestId('update-check-panel').getAttribute('data-can-write')).toBe('true');
  });

  it('no longer shows the Update Check card on Company Info', () => {
    renderAt('/settings?tab=company');
    expect(screen.getByTestId('company-panel')).toBeTruthy();
    expect(screen.queryByTestId('update-check-panel')).toBeNull();
  });

  it('opens it read-only without settings.system:write', () => {
    perms.list = ['settings.system:read'];
    renderAt('/settings?tab=system');
    expect(screen.getByTestId('update-check-panel').getAttribute('data-can-write')).toBe('false');
  });

  it('hides the System tab without settings.system:read', () => {
    perms.list = ['settings.security:read'];
    renderAt('/settings?tab=system');
    expect(screen.queryByRole('tab', { name: 'settings.systemTab' })).toBeNull();
    expect(screen.queryByTestId('update-check-panel')).toBeNull();
  });
});
