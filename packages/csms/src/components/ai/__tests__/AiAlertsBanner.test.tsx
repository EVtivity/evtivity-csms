// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { AiAlertsDto } from '@evtivity/lib/ai-usage';

const { apiMock, perms, access } = vi.hoisted(() => ({
  apiMock: { get: vi.fn() },
  perms: new Set<string>(),
  access: { allSites: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) =>
      o == null ? key : `${key}(${Object.values(o).map(String).join(',')})`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => perms.has(p),
  useHasAllSiteAccess: () => access.allSites,
}));
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (v: string) => v,
  useUserTimezone: () => 'UTC',
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { AiAlertsBanner } from '../alerts/AiAlertsBanner';

const NONE: AiAlertsDto = { providers: [], companyBudget: null };
const PAUSED: AiAlertsDto = {
  providers: [
    { provider: 'deepseek', since: '2026-10-15T08:00:00Z', lastSeenAt: '2026-10-15T09:00:00Z' },
  ],
  companyBudget: {
    period: '2026-10',
    level: 'warn',
    percent: 85,
    usedTokens: 850,
    limitTokens: 1000,
  },
};

function wrap(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  perms.clear();
  access.allSites = true;
  apiMock.get.mockReset();
});
afterEach(() => {
  cleanup();
});

describe('AiAlertsBanner', () => {
  it('shows a paused provider (error tone, name, since, link) and the budget warning to AI administrators', async () => {
    perms.add('settings.ai:read');
    perms.add('settings.ai:write');
    apiMock.get.mockResolvedValue(PAUSED);
    wrap(<AiAlertsBanner />);
    expect(await screen.findByText('aiAlerts.providerTitle(DeepSeek)')).toBeTruthy();
    expect(
      screen.getByText(/aiAlerts\.providerBody\(DeepSeek,2026-10-15T08:00:00Z\)/),
    ).toBeTruthy();
    const alerts = screen.getAllByRole('alert');
    expect(alerts[0]?.className).toContain('destructive');
    expect(alerts[1]?.className).toContain('warning');
    expect(screen.getByText('aiUsage.thresholdWarningCompany(85)')).toBeTruthy();
    const link = screen.getByText('aiAlerts.openSettings');
    expect(link.getAttribute('href')).toBe('/settings?tab=ai&sub=providers');
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/alerts');
  });

  it('shows a used up company budget in the error tone', async () => {
    perms.add('settings.ai:write');
    apiMock.get.mockResolvedValue({
      providers: [],
      companyBudget: { ...PAUSED.companyBudget, level: 'exceeded', percent: 100 },
    });
    wrap(<AiAlertsBanner />);
    expect(await screen.findByText('aiAlerts.budgetExhaustedTitle')).toBeTruthy();
    expect(screen.getByRole('alert').className).toContain('destructive');
  });

  it('renders nothing when no alert is active', async () => {
    perms.add('settings.ai:write');
    apiMock.get.mockResolvedValue(NONE);
    wrap(<AiAlertsBanner />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('ai-alerts-banner')).toBeNull();
  });

  it('asks nothing for users without settings.ai:write or without access to every site', () => {
    perms.add('settings.ai:read');
    wrap(<AiAlertsBanner />);
    perms.add('settings.ai:write');
    access.allSites = false;
    wrap(<AiAlertsBanner />);
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('in Settings > AI shows the state to readers, without links', async () => {
    perms.add('settings.ai:read');
    apiMock.get.mockResolvedValue(PAUSED);
    wrap(<AiAlertsBanner placement="settings" />);
    expect(await screen.findByText('aiAlerts.providerTitle(DeepSeek)')).toBeTruthy();
    expect(screen.queryByText('aiAlerts.openSettings')).toBeNull();
  });
});
