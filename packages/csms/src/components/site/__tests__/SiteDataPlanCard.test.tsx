// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), patch: vi.fn() },
  perms: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key} ${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: (p: string) => perms.has(p) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { SiteDataPlanCard } from '../SiteDataPlanCard';

function renderCard(dataPlan: 'wifi_or_wired' | 'cellular' | null = null): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SiteDataPlanCard siteId="site_1" dataPlan={dataPlan} />
    </QueryClientProvider>,
  );
}

function saveButton(index: number): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: /common.save/ });
  const button = buttons.at(index);
  if (button == null) throw new Error('no Save button');
  return button;
}

afterEach(() => {
  cleanup();
  perms.clear();
  vi.clearAllMocks();
});

describe('SiteDataPlanCard', () => {
  it('is read-only without sites:write', () => {
    renderCard('cellular');
    expect(screen.queryByLabelText('dataPlan.title')).toBeNull();
    expect(screen.getByText('dataPlan.plans.cellular')).toBeTruthy();
  });

  it('names how many stations change plan, then saves', async () => {
    perms.add('sites:write');
    apiMock.get.mockResolvedValue({ stationsChanging: 3 });
    apiMock.patch.mockResolvedValue({});
    renderCard();
    fireEvent.change(screen.getByLabelText('dataPlan.title'), { target: { value: 'cellular' } });
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(screen.getByText('dataPlan.site.stationsChanging {"count":3}')).toBeTruthy();
    });
    expect(apiMock.get).toHaveBeenCalledWith('/v1/sites/site_1/data-plan-impact?dataPlan=cellular');
    fireEvent.click(saveButton(-1));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/site_1', { dataPlan: 'cellular' });
    });
  });

  it('asks the impact of Not Set without a plan parameter', async () => {
    perms.add('sites:write');
    apiMock.get.mockResolvedValue({ stationsChanging: 0 });
    apiMock.patch.mockResolvedValue({});
    renderCard('wifi_or_wired');
    fireEvent.change(screen.getByLabelText('dataPlan.title'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/sites/site_1/data-plan-impact');
    });
    fireEvent.click(saveButton(-1));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/site_1', { dataPlan: null });
    });
  });
});
