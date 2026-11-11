// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';

const { apiMock } = vi.hoisted(() => {
  // The theme store reads matchMedia when the app modules load; jsdom has none.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return { apiMock: { get: vi.fn() } };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/timezone')>();
  return { ...actual, useUserTimezone: () => 'UTC' };
});

import { FirmwareCampaigns } from '@/pages/FirmwareCampaigns';

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <FirmwareCampaigns />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('FirmwareCampaigns', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it('labels every column and the missing version through locale keys', async () => {
    apiMock.get.mockResolvedValue({
      data: [
        {
          id: 'fwc_1',
          name: 'Spring rollout',
          firmwareUrl: 'https://example.com/fw.bin',
          version: null,
          status: 'draft',
          createdAt: '2026-11-01T10:00:00.000Z',
        },
      ],
      total: 1,
    });
    renderPage();
    expect(await screen.findByText('Spring rollout')).toBeTruthy();
    expect(screen.getByText('firmwareCampaigns.version')).toBeTruthy();
    expect(screen.getByText('common.na')).toBeTruthy();
    expect(screen.queryByText('Version')).toBeNull();
    expect(screen.queryByText('n/a')).toBeNull();
  });

  it('shows the empty list through a locale key', async () => {
    apiMock.get.mockResolvedValue({ data: [], total: 0 });
    renderPage();
    expect(await screen.findByText('firmwareCampaigns.noCampaigns')).toBeTruthy();
  });
});
