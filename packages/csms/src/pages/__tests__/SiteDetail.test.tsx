// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

// The theme store reads the color scheme on import; jsdom has no matchMedia.
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const SITE = {
  id: 's1',
  name: 'Depot',
  address: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
  latitude: null,
  longitude: null,
  timezone: 'UTC',
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  contactIsPublic: false,
  hoursOfOperation: null,
  reservationsEnabled: false,
  freeVendEnabled: false,
  freeVendTemplateId21: null,
  freeVendTemplateId16: null,
  carbonRegionCode: null,
  stationMessageLanguage: null,
  aiInsightsEnabled: true,
  aiMonthlyTokenBudget: null,
  stationCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// The site itself answers; every other query stays pending.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: (path: string) =>
        path === '/v1/sites/s1' ? Promise.resolve(SITE) : new Promise(() => {}),
    },
  };
});
vi.mock('@/components/ai/usage/SiteAiCard', () => ({
  SiteAiCard: () => <div data-testid="site-ai-card" />,
}));
// The Details tab form is covered elsewhere; its source is checked below.
vi.mock('@/components/site/SiteDetailsTab', async () => {
  const { TabsContent } = await import('@/components/ui/tabs');
  return {
    SiteDetailsTab: () => (
      <TabsContent value="details">
        <div data-testid="site-details" />
      </TabsContent>
    ),
  };
});

// The tabs measure themselves; jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { SiteDetail } from '../SiteDetail';
import { useAuth } from '@/lib/auth';
import detailsTabSource from '@/components/site/SiteDetailsTab?raw';

function renderSite(permissions: string[], hasAllSiteAccess: boolean, search = ''): void {
  useAuth.setState({ role: 'operator', permissions, hasAllSiteAccess });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/sites/s1${search}`]}>
        <Routes>
          <Route path="/sites/:id" element={<SiteDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('Site detail AI tab (plan v0.1.45, section 6)', () => {
  it('TC-UI-LY-03 shows the AI tab with aiUsage:read, and ?tab=ai opens the card', async () => {
    renderSite(['sites:read', 'aiUsage:read'], false, '?tab=ai');
    const tab = await screen.findByRole('tab', { name: 'sites.tabs.ai' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('site-ai-card')).toBeTruthy();
  });

  it('TC-UI-LY-03 shows the AI tab to an all-site user with sites:write', async () => {
    renderSite(['sites:read', 'sites:write'], true);
    const tab = await screen.findByRole('tab', { name: 'sites.tabs.ai' });
    expect(screen.queryByTestId('site-ai-card')).toBeNull();
    fireEvent.click(tab);
    expect(screen.getByTestId('site-ai-card')).toBeTruthy();
  });

  it('TC-UI-LY-03 hides the AI tab otherwise, and ?tab=ai then shows nothing', async () => {
    for (const [perms, allSites] of [
      [['sites:read', 'sites:write'], false],
      [['sites:read'], true],
    ] as const) {
      renderSite([...perms], allSites, '?tab=ai');
      await screen.findByRole('tab', { name: 'common.details' });
      expect(screen.queryByRole('tab', { name: 'sites.tabs.ai' })).toBeNull();
      expect(screen.queryByTestId('site-ai-card')).toBeNull();
      // The link falls back to Details instead of an empty page.
      expect(
        screen.getByRole('tab', { name: 'common.details' }).getAttribute('aria-selected'),
      ).toBe('true');
      expect(screen.getByTestId('site-details')).toBeTruthy();
      cleanup();
    }
  });

  it('TC-UI-LY-04 the Details tab no longer renders the AI card', async () => {
    renderSite(['sites:read', 'aiUsage:read'], true);
    await screen.findByTestId('site-details');
    expect(screen.queryByTestId('site-ai-card')).toBeNull();
    expect(detailsTabSource).toContain('export function SiteDetailsTab');
    expect(detailsTabSource).not.toContain('SiteAiCard');
  });
});
