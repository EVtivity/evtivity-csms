// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: { get: vi.fn(), put: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) =>
      opts?.name != null ? `${key}(${opts.name})` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { AiInsightsScopeCard } from '../AiInsightsScopeCard';

const SCOPE = {
  mode: 'all',
  stationsWithoutSite: 0,
  sites: [
    { id: 'sit_a', name: 'Alpha', selected: true, stationCount: 2, stationsTurnedOff: 0 },
    { id: 'sit_b', name: 'Beta', selected: true, stationCount: 1, stationsTurnedOff: 0 },
  ],
};
const STATIONS = [
  { id: 'sta_1', stationId: 'CS-1', enabled: true },
  { id: 'sta_2', stationId: 'CS-2', enabled: true },
];

function wrap(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  apiMock.get.mockImplementation((url: string) =>
    Promise.resolve(url.endsWith('/stations') ? STATIONS : SCOPE),
  );
  apiMock.put.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AI Insights Scope card', () => {
  it('starts on All Sites with no site list', async () => {
    wrap(<AiInsightsScopeCard canWrite opsOff={false} />);
    const all = await screen.findByRole('radio', { name: /settings.aiInsightsScope.mode.all/ });
    expect((all as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('ai-insights-scope-sites')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /save/i }).disabled).toBe(true);
  });

  it('selects sites, turns a station off and saves only what changed', async () => {
    wrap(<AiInsightsScopeCard canWrite opsOff={false} />);
    fireEvent.click(
      await screen.findByRole('radio', { name: /settings.aiInsightsScope.mode.selected/ }),
    );
    expect(screen.getByText('settings.unsavedChanges')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('switch', { name: 'settings.aiInsightsScope.siteToggle(Beta)' }),
    );
    // Open Alpha and turn one station off.
    fireEvent.click(within(screen.getByTestId('ai-scope-site-sit_a')).getByRole('button'));
    const stations = await screen.findByTestId('ai-scope-stations-sit_a');
    expect(apiMock.get).toHaveBeenCalledWith('/v1/settings/ai/insights-scope/sites/sit_a/stations');
    fireEvent.click(within(stations).getByRole('switch', { name: 'CS-2' }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/ai/insights-scope', {
        mode: 'selected',
        sites: [{ siteId: 'sit_b', selected: false }],
        stations: [{ stationId: 'sta_2', enabled: false }],
      });
    });
  });

  it('keeps the site list in a fixed height box that scrolls, with expanded stations inside it', async () => {
    wrap(<AiInsightsScopeCard canWrite opsOff={false} />);
    fireEvent.click(
      await screen.findByRole('radio', { name: /settings.aiInsightsScope.mode.selected/ }),
    );
    const box = screen.getByTestId('ai-insights-scope-sites-scroll');
    expect(box.className).toContain('h-96');
    expect(box.className).toContain('overflow-y-auto');
    expect(box.getAttribute('role')).toBe('region');
    expect(box.getAttribute('aria-label')).toBe('settings.aiInsightsScope.siteListLabel');
    expect(box.getAttribute('tabindex')).toBe('0');
    fireEvent.click(within(screen.getByTestId('ai-scope-site-sit_a')).getByRole('button'));
    const stations = await screen.findByTestId('ai-scope-stations-sit_a');
    expect(box.contains(stations)).toBe(true);
  });

  it('disables a station switch while its site is not selected', async () => {
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/stations')
          ? STATIONS
          : {
              ...SCOPE,
              mode: 'selected',
              sites: [{ ...SCOPE.sites[0], selected: false }],
            },
      ),
    );
    wrap(<AiInsightsScopeCard canWrite opsOff={false} />);
    fireEvent.click(within(await screen.findByTestId('ai-scope-site-sit_a')).getByRole('button'));
    const stations = await screen.findByTestId('ai-scope-stations-sit_a');
    const toggle = within(stations).getByRole<HTMLButtonElement>('switch', { name: 'CS-1' });
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('filters the sites by name', async () => {
    apiMock.get.mockResolvedValue({ ...SCOPE, mode: 'selected' });
    wrap(<AiInsightsScopeCard canWrite opsOff={false} />);
    const search = await screen.findByLabelText('settings.aiInsightsScope.search');
    fireEvent.change(search, { target: { value: 'bet' } });
    expect(screen.queryByTestId('ai-scope-site-sit_a')).toBeNull();
    expect(screen.getByTestId('ai-scope-site-sit_b')).toBeTruthy();
  });

  it('is disabled with a note while system-initiated AI is off, and enabled once it is on', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <AiInsightsScopeCard canWrite opsOff />
      </QueryClientProvider>,
    );
    const selected = await screen.findByRole<HTMLInputElement>('radio', {
      name: /settings.aiInsightsScope.mode.selected/,
    });
    // Disabled through the fieldset, so the property stays false: match :disabled.
    expect(selected.matches(':disabled')).toBe(true);
    expect(screen.getByTestId('ai-insights-scope-ops-off').textContent).toBe(
      'settings.aiSurface.ops.offNote',
    );
    rerender(
      <QueryClientProvider client={client}>
        <AiInsightsScopeCard canWrite opsOff={false} />
      </QueryClientProvider>,
    );
    expect(selected.matches(':disabled')).toBe(false);
    expect(screen.queryByTestId('ai-insights-scope-ops-off')).toBeNull();
  });

  it('is read-only without write access', async () => {
    wrap(<AiInsightsScopeCard canWrite={false} opsOff={false} />);
    const all = await screen.findByRole<HTMLInputElement>('radio', {
      name: /settings.aiInsightsScope.mode.all/,
    });
    expect(all.matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });
});
