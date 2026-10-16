// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock, perms, access } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn() },
  perms: new Set<string>(),
  access: { allSites: true },
}));

// The AI alert banner has its own test (AiAlertsBanner.test.tsx).
vi.mock('@/components/ai/alerts/AiAlertsBanner', () => ({ AiAlertsBanner: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => perms.has(p),
  useHasAllSiteAccess: () => access.allSites,
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/components/ai/usage/AiUsageTab', () => ({
  AiUsageTab: ({ warnPercent }: { warnPercent: number }) => (
    <div data-testid="usage-tab">{warnPercent}</div>
  ),
}));

// The tabs measure themselves; jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { AiInsightsSettings, AiMcpSettings, mcpEndpointUrl } from '../AiOpsSettings';
import type { AiDefaults } from '@/components/ai/use-ai-defaults';
import { ApiError } from '@/lib/api';
import { AiSettings } from '../AiSettings';
import { ProfileNotifications } from '../../profile/ProfileNotifications';

/** The ops tabs (Automatic insights with the background workers, MCP) on one page. */
function AiOpsSettings({
  settings,
  canWrite,
  aiDefaults,
}: {
  settings: Record<string, unknown>;
  canWrite: boolean;
  aiDefaults: AiDefaults | undefined;
}): React.JSX.Element {
  return (
    <>
      <AiInsightsSettings settings={settings} canWrite={canWrite} aiDefaults={aiDefaults} />
      <AiMcpSettings settings={settings} canWrite={canWrite} />
    </>
  );
}

function openAdvanced(container: HTMLElement): void {
  fireEvent.click(within(container).getByRole('button', { name: /settings.aiAdvancedOptions/ }));
}

function wrap(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const SETTINGS = {
  'opsAi.enabled': false,
  'opsAi.provider': 'anthropic',
  'opsAi.model': '',
  'opsAi.effort': 'low',
  'opsAi.systemPrompt': '',
  'aiInsights.debounceSeconds': 120,
  'ai.mcp.allowedOrigins': [],
  'ai.anthropic.apiKeyEnc': 'k',
};

beforeEach(() => {
  perms.clear();
  perms.add('settings.ai:write');
  access.allSites = true;
  apiMock.put.mockResolvedValue({});
  apiMock.get.mockResolvedValue({ chatbot: {}, support: {}, providers: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Settings > AI roadmap panels', () => {
  it('shows the data warning and turns system-initiated AI on', async () => {
    wrap(<AiOpsSettings settings={SETTINGS} canWrite aiDefaults={undefined} />);
    const ops = screen.getByTestId('ai-ops-settings');
    fireEvent.click(within(ops).getByRole('switch'));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/opsAi.enabled', { value: true });
    });
  });

  it('shows defaults for unset keys and saves only the changed insight values', async () => {
    wrap(<AiOpsSettings settings={SETTINGS} canWrite aiDefaults={undefined} />);
    const panel = screen.getByTestId('ai-insights-settings');
    // The reservation switch shows once the features answer says reservations are on.
    await within(panel).findByLabelText('settings.aiInsightsSettings.reservation');
    // D4: per-trigger switches default on (station, session, authorization, reservation).
    expect(
      within(panel)
        .getAllByRole('switch')
        .map((s) => s.getAttribute('aria-checked')),
    ).toEqual(['true', 'true', 'true', 'true']);
    const cooldown = document.getElementById(
      'ai-setting-aiInsights-cooldownMinutes',
    ) as HTMLInputElement;
    expect(cooldown.value).toBe('60');
    fireEvent.change(cooldown, { target: { value: '90' } });
    fireEvent.click(within(panel).getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/aiInsights.cooldownMinutes', {
        value: 90,
      });
    });
    expect(apiMock.put).toHaveBeenCalledTimes(1);
  });

  it('TC-UI-LY-10 the reservation insights switch saves aiInsights.reservation.enabled', async () => {
    wrap(<AiOpsSettings settings={SETTINGS} canWrite aiDefaults={undefined} />);
    const panel = screen.getByTestId('ai-insights-settings');
    const toggle = await within(panel).findByLabelText('settings.aiInsightsSettings.reservation');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    fireEvent.click(within(panel).getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/aiInsights.reservation.enabled', {
        value: false,
      });
    });
    expect(apiMock.put).toHaveBeenCalledTimes(1);
  });

  it('hides the reservation insights switch while reservations are off and links to that setting', async () => {
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(url === '/v1/portal/features' ? { reservationEnabled: false } : {}),
    );
    wrap(<AiOpsSettings settings={SETTINGS} canWrite aiDefaults={undefined} />);
    const panel = screen.getByTestId('ai-insights-settings');
    const off = await within(panel).findByTestId('ai-reservation-insights-off');
    expect(off.textContent).toContain('settings.aiInsightsSettings.reservationOff');
    expect(
      within(off)
        .getByRole('link', { name: 'settings.aiInsightsSettings.reservationOffLink' })
        .getAttribute('href'),
    ).toBe('/settings?tab=integrations&sub=reservation');
    expect(within(panel).queryByLabelText('settings.aiInsightsSettings.reservation')).toBeNull();
    expect(within(panel).getAllByRole('switch')).toHaveLength(3);
    // Saving the card never writes the hidden reservation switch.
    fireEvent.click(within(panel).getAllByRole('switch')[0] as HTMLElement);
    fireEvent.click(within(panel).getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/aiInsights.station.enabled', {
        value: false,
      });
    });
    expect(apiMock.put).toHaveBeenCalledTimes(1);
  });

  it('refuses an out-of-range worker threshold before saving', () => {
    wrap(<AiOpsSettings settings={SETTINGS} canWrite aiDefaults={undefined} />);
    const panel = screen.getByTestId('ai-workers-settings');
    const idle = document.getElementById(
      'ai-setting-aiWorkers-stuckSessions-idleMinutes',
    ) as HTMLInputElement;
    fireEvent.change(idle, { target: { value: '5' } });
    fireEvent.click(within(panel).getByRole('button', { name: /save/i }));
    expect(idle.getAttribute('aria-invalid')).toBe('true');
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('saves MCP origins as a normalized list and refuses an origin with a path', async () => {
    wrap(<AiOpsSettings settings={SETTINGS} canWrite aiDefaults={undefined} />);
    const panel = screen.getByTestId('ai-mcp-settings');
    // TC-UI-LY-10: the origins are an advanced option, closed by default.
    expect(within(panel).queryByLabelText('settings.aiMcp.allowedOrigins')).toBeNull();
    openAdvanced(panel);
    const origins = within(panel).getByLabelText('settings.aiMcp.allowedOrigins');
    fireEvent.change(origins, { target: { value: 'https://app.example.com/path' } });
    fireEvent.click(within(panel).getByRole('button', { name: /save/i }));
    // Under the field, and in the disclosure summary so a closed disclosure still shows it.
    expect(within(panel).getAllByText('settings.aiMcp.allowedOriginsInvalid')).toHaveLength(2);
    expect(apiMock.put).not.toHaveBeenCalled();
    fireEvent.change(origins, {
      target: { value: 'https://app.example.com/\n\nhttp://localhost:3000' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/ai.mcp.allowedOrigins', {
        value: ['https://app.example.com', 'http://localhost:3000'],
      });
    });
  });

  it('shows MCP writes off by default and saves the Allow Writes switch', async () => {
    wrap(<AiOpsSettings settings={SETTINGS} canWrite aiDefaults={undefined} />);
    const panel = screen.getByTestId('ai-mcp-settings');
    expect(within(panel).queryByText('settings.aiMcp.proposalTtlMinutes')).toBeNull();
    expect(within(panel).getByText('settings.aiMcp.allowWritesHint')).toBeTruthy();
    const writes = within(panel).getByRole('switch', { name: 'settings.aiMcp.allowWrites' });
    expect(writes.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(writes);
    fireEvent.click(within(panel).getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/ai.mcp.allowWrites', {
        value: true,
      });
    });
    expect(apiMock.put).toHaveBeenCalledTimes(1);
  });

  it('shows the built-in ops prompt as the default and saves an unchanged copy as empty', async () => {
    const aiDefaults = {
      language: 'en',
      chatbot: { prompt: 'c', fixedRules: 'r' },
      support: { prompt: 's', fixedRules: 'r' },
      ops: { prompt: 'Built-in ops prompt', fixedRules: 'Ops rules' },
      providers: [],
    };
    wrap(<AiOpsSettings settings={SETTINGS} canWrite aiDefaults={aiDefaults} />);
    const ops = screen.getByTestId('ai-ops-settings');
    // TC-UI-LY-10: the prompt override sits behind the disclosure, which says it is the default.
    expect(within(ops).queryByDisplayValue('Built-in ops prompt')).toBeNull();
    expect(within(ops).getByText('settings.aiPromptDefaultSummary')).toBeTruthy();
    openAdvanced(ops);
    expect(within(ops).getByDisplayValue('Built-in ops prompt')).toBeTruthy();
    fireEvent.click(within(ops).getByRole('button', { name: 'common.edit' }));
    // The copied default is not a change: nothing to save.
    expect(within(ops).getByRole<HTMLButtonElement>('button', { name: /save/i }).disabled).toBe(
      true,
    );
    fireEvent.change(within(ops).getByDisplayValue('Built-in ops prompt'), {
      target: { value: 'Custom ops prompt' },
    });
    fireEvent.click(within(ops).getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/opsAi.systemPrompt', {
        value: 'Custom ops prompt',
      });
    });
  });

  it('shows the MCP endpoint and how to connect', () => {
    wrap(<AiOpsSettings settings={SETTINGS} canWrite aiDefaults={undefined} />);
    const info = screen.getByTestId('ai-mcp-info');
    expect(within(info).getByLabelText<HTMLInputElement>('settings.aiMcp.endpoint').value).toMatch(
      /\/v1\/mcp$/,
    );
    expect(within(info).getByText('settings.aiMcp.writeScopeHint')).toBeTruthy();
    expect(mcpEndpointUrl('https://api.example.com', 'https://csms.example.com')).toBe(
      'https://api.example.com/v1/mcp',
    );
    expect(mcpEndpointUrl('', 'https://csms.example.com')).toBe('https://csms.example.com/v1/mcp');
  });

  it('keeps edits in one card when another card saves and the settings reload', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (settings: Record<string, unknown>) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AiOpsSettings settings={settings} canWrite aiDefaults={undefined} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(view(SETTINGS));
    const cooldown = document.getElementById(
      'ai-setting-aiInsights-cooldownMinutes',
    ) as HTMLInputElement;
    fireEvent.change(cooldown, { target: { value: '90' } });
    // The ops toggle saved, so the settings come back as a new object.
    rerender(view({ ...SETTINGS, 'opsAi.enabled': true }));
    await waitFor(() => {
      expect(
        within(screen.getByTestId('ai-ops-settings'))
          .getByRole('switch')
          .getAttribute('aria-checked'),
      ).toBe('true');
    });
    expect(cooldown.value).toBe('90');
    // A clean card takes the reloaded values.
    rerender(view({ ...SETTINGS, 'opsAi.enabled': true, 'aiWorkers.proposalTtlHours': 12 }));
    await waitFor(() => {
      expect(
        (document.getElementById('ai-setting-aiWorkers-proposalTtlHours') as HTMLInputElement)
          .value,
      ).toBe('12');
    });
  });

  it('puts the system AI switch back when the write fails', async () => {
    apiMock.put.mockRejectedValue(new ApiError(400, { error: 'x', code: 'VALIDATION_ERROR' }));
    wrap(<AiOpsSettings settings={SETTINGS} canWrite aiDefaults={undefined} />);
    const toggle = within(screen.getByTestId('ai-ops-settings')).getByRole('switch');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/opsAi.enabled', { value: true });
  });

  it('is read-only without settings.ai:write', () => {
    wrap(<AiOpsSettings settings={SETTINGS} canWrite={false} aiDefaults={undefined} />);
    expect(screen.queryAllByRole('button', { name: /save/i })).toHaveLength(0);
    for (const s of screen.getAllByRole('switch')) {
      expect((s as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('TC-AI-US-11 TC-UI-LY-09: the usage dashboard shows for all-site users with aiUsage:read only', () => {
    perms.add('aiUsage:read');
    wrap(<AiSettings settings={{ ...SETTINGS, 'ai.budget.warnPercent': 75 }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'settings.aiTabs.usage' }));
    expect(screen.getByTestId('usage-tab').textContent).toBe('75');
    expect(screen.getByText('settings.aiLimitsTitle')).toBeTruthy();
    cleanup();
    // Without access to every site: the Limits card only.
    access.allSites = false;
    wrap(<AiSettings settings={SETTINGS} />);
    fireEvent.click(screen.getByRole('tab', { name: 'settings.aiTabs.usage' }));
    expect(screen.getByText('settings.aiLimitsTitle')).toBeTruthy();
    expect(screen.queryByTestId('usage-tab')).toBeNull();
    cleanup();
    // Without aiUsage:read: the Limits card only.
    access.allSites = true;
    perms.delete('aiUsage:read');
    wrap(<AiSettings settings={SETTINGS} />);
    fireEvent.click(screen.getByRole('tab', { name: 'settings.aiTabs.usage' }));
    expect(screen.getByText('settings.aiLimitsTitle')).toBeTruthy();
    expect(screen.queryByTestId('usage-tab')).toBeNull();
  });
});

describe('Profile AI digest toggle (ai-workers.md, "Digest")', () => {
  it('shows for users who decide proposals and sends only the changed preference', async () => {
    perms.add('aiInsights:write');
    apiMock.get.mockResolvedValue({ smsEnabled: false, aiDigestEmail: false });
    wrap(<ProfileNotifications />);
    const toggle = await screen.findByLabelText('profile.aiDigestEmail');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/users/me/notification-preferences', {
        aiDigestEmail: true,
      });
    });
  });

  it('puts the switch back and shows an inline error when the save fails', async () => {
    perms.add('aiInsights:write');
    apiMock.get.mockResolvedValue({ smsEnabled: true, aiDigestEmail: false });
    apiMock.put.mockRejectedValue(new ApiError(500, null));
    wrap(<ProfileNotifications />);
    const toggle = await screen.findByLabelText('profile.aiDigestEmail');
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('profile.notificationsSaveFailed')).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('stays hidden without aiInsights:write', async () => {
    apiMock.get.mockResolvedValue({ smsEnabled: true, aiDigestEmail: true });
    wrap(<ProfileNotifications />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/v1/users/me/notification-preferences');
    });
    expect(screen.queryByLabelText('profile.aiDigestEmail')).toBeNull();
  });
});
