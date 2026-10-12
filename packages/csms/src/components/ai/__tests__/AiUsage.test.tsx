// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { AiUsageDto } from '@evtivity/lib/ai-usage';

const { apiMock, perms, access, currency } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), patch: vi.fn(), put: vi.fn() },
  perms: new Set<string>(),
  access: { allSites: true },
  currency: { value: 'USD' },
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
vi.mock('@/hooks/use-company-currency', () => ({
  useCompanyCurrency: () => ({ currency: currency.value, isError: false, refetch: () => {} }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { AiUsageTab } from '../usage/AiUsageTab';
import { AiUsageFooter } from '../usage/AiUsageFooter';
import { AiUsageNotices } from '../usage/AiUsageNotices';
import { SiteAiCard, parseSiteBudget } from '../usage/SiteAiCard';
import { parseAiUsageThreshold, useAiUsageNotices } from '../usage/usage-notices';

const totals = (n: number, micros = 1_234_567) => ({
  tokens: { input: n, cachedRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
  totalTokens: n,
  costMicros: micros,
});

const USAGE: AiUsageDto = {
  month: '2026-10',
  period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
  company: {
    totals: totals(900),
    budget: { limitTokens: 1000, usedTokens: 900, percent: 90 },
  },
  unattributed: totals(100),
  sites: [
    {
      siteId: 's1',
      siteName: 'Harbor Garage',
      totals: totals(800),
      budget: { limitTokens: 500, usedTokens: 800, percent: 160 },
    },
  ],
  surfaces: [
    { surface: 'chatbot', totals: totals(100) },
    { surface: 'insight', totals: totals(800) },
  ],
  topUsers: [{ userId: 'u1', totals: totals(100) }],
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
  currency.value = 'USD';
  useAiUsageNotices.setState({ notices: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Settings > AI > Usage (TC-AI-US-11)', () => {
  beforeEach(() => {
    perms.add('aiUsage:read');
    perms.add('users:read');
    apiMock.get.mockImplementation((path: string) =>
      path.startsWith('/v1/users/')
        ? Promise.resolve({ firstName: 'Ada', lastName: 'Ops', email: 'ada@example.com' })
        : Promise.resolve(USAGE),
    );
  });

  it('shows the company budget, sites, the assistant row, surfaces and named top users', async () => {
    wrap(<AiUsageTab warnPercent={80} />);
    expect((await screen.findByTestId('ai-usage-company-used')).textContent).toBe('900');
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/usage');
    expect(screen.getByText('Harbor Garage')).toBeTruthy();
    expect(screen.getByText('aiUsage.unattributed')).toBeTruthy();
    expect(screen.getByText('aiUsage.surface.insight')).toBeTruthy();
    expect((await screen.findByTestId('ai-usage-top-user')).textContent).toBe('Ada Ops');
    // Company at 90% of 80% warns; the site is over budget.
    const warnings = screen.getByTestId('ai-usage-warnings').textContent;
    expect(warnings).toContain('aiUsage.thresholdWarningCompany(80)');
    expect(warnings).toContain('aiUsage.thresholdExceededSite(Harbor Garage)');
  });

  it('asks for the picked month', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
    try {
      wrap(<AiUsageTab warnPercent={80} />);
      await screen.findByTestId('ai-usage-company-used');
      fireEvent.change(screen.getByLabelText('aiUsage.month'), { target: { value: '2026-09' } });
      await waitFor(() => {
        expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/usage?month=2026-09');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('picks the month with the shared month picker, newest first (ISSUES item 9)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
    try {
      wrap(<AiUsageTab warnPercent={80} />);
      await screen.findByTestId('ai-usage-company-used');
      const picker = screen.getByLabelText('aiUsage.month');
      expect(picker.tagName).toBe('SELECT');
      expect((picker as HTMLSelectElement).value).toBe('2026-10');
      const options = Array.from((picker as HTMLSelectElement).options);
      expect(options).toHaveLength(24);
      expect(options[0]?.value).toBe('2026-10');
      expect(options[0]?.textContent).toBe('October 2026');
      expect(options.at(-1)?.value).toBe('2024-11');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pages the sites with the shared pagination, the unattributed row on the last page (ISSUES item 9)', async () => {
    const sites = Array.from({ length: 12 }, (_, i) => ({
      siteId: `s${String(i + 1)}`,
      siteName: `Site ${String(i + 1)}`,
      totals: totals(10),
      budget: { limitTokens: null, usedTokens: 10, percent: null },
    }));
    apiMock.get.mockImplementation((path: string) =>
      path.startsWith('/v1/users/')
        ? Promise.resolve({ firstName: 'Ada', lastName: 'Ops', email: 'ada@example.com' })
        : Promise.resolve({ ...USAGE, sites }),
    );
    wrap(<AiUsageTab warnPercent={80} />);
    expect(await screen.findByText('Site 1')).toBeTruthy();
    expect(screen.getByText('Site 10')).toBeTruthy();
    expect(screen.queryByText('Site 11')).toBeNull();
    expect(screen.queryByText('aiUsage.unattributed')).toBeNull();
    expect(screen.getByText('common.pageOf(1,2)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.next' }));
    expect(screen.getByText('Site 11')).toBeTruthy();
    expect(screen.getByText('Site 12')).toBeTruthy();
    expect(screen.queryByText('Site 1')).toBeNull();
    expect(screen.getByText('aiUsage.unattributed')).toBeTruthy();
  });

  it('shows user ids when names cannot be read', async () => {
    perms.delete('users:read');
    wrap(<AiUsageTab warnPercent={80} />);
    expect((await screen.findByTestId('ai-usage-top-user')).textContent).toBe('u1');
  });

  it('TC-AI-US-08: shows cost for a USD company only', async () => {
    wrap(<AiUsageTab warnPercent={80} />);
    expect((await screen.findByTestId('ai-usage-cost')).textContent).toMatch(/\$1\.23/);
    cleanup();
    currency.value = 'EUR';
    wrap(<AiUsageTab warnPercent={80} />);
    await screen.findByTestId('ai-usage-company-used');
    expect(screen.queryByTestId('ai-usage-cost')).toBeNull();
    expect(screen.queryByText('aiUsage.cost')).toBeNull();
  });
});

describe('Site AI card (TC-AI-US-11, decision D17)', () => {
  const siteUsage = {
    month: '2026-10',
    period: USAGE.period,
    site: USAGE.sites[0],
    surfaces: [],
  };

  it('lets an all-site user with sites:write change the budget and the insights switch', async () => {
    perms.add('aiUsage:read');
    perms.add('sites:write');
    apiMock.get.mockResolvedValue(siteUsage);
    apiMock.patch.mockResolvedValue({});
    wrap(<SiteAiCard siteId="s1" site={{ aiInsightsEnabled: true, aiMonthlyTokenBudget: null }} />);
    expect(await screen.findByText('aiUsage.percentUsed(160)')).toBeTruthy();
    expect(apiMock.get).toHaveBeenCalledWith('/v1/ai/usage/sites/s1');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/s1', { aiInsightsEnabled: false });
    });
    fireEvent.change(screen.getByLabelText('aiUsage.siteBudget'), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith('/v1/sites/s1', { aiMonthlyTokenBudget: 5000 });
    });
  });

  it('is read-only for a site-restricted user, who still sees the usage', async () => {
    perms.add('aiUsage:read');
    perms.add('sites:write');
    access.allSites = false;
    apiMock.get.mockResolvedValue(siteUsage);
    wrap(<SiteAiCard siteId="s1" site={{ aiInsightsEnabled: true, aiMonthlyTokenBudget: 10 }} />);
    expect(await screen.findByText('aiUsage.allSitesOnly')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('switch').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('aiUsage.siteBudget').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('renders nothing for a user who can neither read usage nor edit', () => {
    access.allSites = false;
    wrap(<SiteAiCard siteId="s1" site={{}} />);
    expect(screen.queryByTestId('ai-site-card')).toBeNull();
  });

  it('parses the budget: empty follows the setting, whole numbers only', () => {
    expect(parseSiteBudget('')).toBeNull();
    expect(parseSiteBudget('0')).toBe(0);
    expect(parseSiteBudget('1500')).toBe(1500);
    expect(parseSiteBudget('1.5')).toBeUndefined();
    expect(parseSiteBudget('-1')).toBeUndefined();
    expect(parseSiteBudget('1000000000001')).toBeUndefined();
  });
});

describe('panel footer and threshold notices (TC-AI-US-11)', () => {
  it("shows today's own tokens against the daily budget", async () => {
    perms.add('aiAssistant:read');
    apiMock.get.mockResolvedValue({
      today: { limitTokens: 2000, usedTokens: 500, percent: 25 },
      month: totals(500),
    });
    wrap(<AiUsageFooter />);
    expect((await screen.findByTestId('ai-usage-footer')).textContent).toContain(
      'aiUsage.todayFooter(500,2,000)',
    );
    expect(apiMock.get).toHaveBeenCalledWith('/v1/users/me/ai-usage');
  });

  it('reads threshold events and keeps the newest per scope', () => {
    expect(parseAiUsageThreshold({ eventType: 'other' })).toBeNull();
    expect(
      parseAiUsageThreshold({
        eventType: 'ai.usage.threshold',
        scope: 'site',
        level: 'warn',
        percent: 80,
      }),
    ).toBeNull();
    const record = useAiUsageNotices.getState().record;
    record({
      eventType: 'ai.usage.threshold',
      scope: 'company',
      level: 'warn',
      percent: 81,
      period: '2026-10',
    });
    record({
      eventType: 'ai.usage.threshold',
      scope: 'company',
      level: 'exceeded',
      percent: 100,
      period: '2026-10',
    });
    expect(useAiUsageNotices.getState().notices).toEqual([
      { scope: 'company', siteId: null, level: 'exceeded', percent: 100, period: '2026-10' },
    ]);
  });

  it('shows a dismissible banner, never a toast', () => {
    useAiUsageNotices.getState().record({
      eventType: 'ai.usage.threshold',
      scope: 'company',
      level: 'warn',
      percent: 85,
      period: '2026-10',
    });
    wrap(<AiUsageNotices />);
    expect(screen.getByText('aiUsage.thresholdWarningCompany(85)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    expect(screen.queryByTestId('ai-usage-notices')).toBeNull();
  });
});
