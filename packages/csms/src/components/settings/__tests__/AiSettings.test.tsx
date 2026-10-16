// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';

const { putMock, getMock, permissions } = vi.hoisted(() => ({
  putMock: vi.fn(),
  getMock: vi.fn(),
  permissions: { write: true },
}));

// The AI alert banner has its own test (AiAlertsBanner.test.tsx).
vi.mock('@/components/ai/alerts/AiAlertsBanner', () => ({ AiAlertsBanner: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'de' } }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: () => permissions.write,
  // The usage dashboard (all-site users only) has its own test (AiOpsSettings.test.tsx).
  useHasAllSiteAccess: () => false,
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { put: putMock, get: getMock } };
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

import { AiSettings } from '../AiSettings';
import { AI_SETTINGS_TABS } from '../ai-settings-tabs';
import type { AiSettingsTab } from '../ai-settings-tabs';

const DEFAULTS = {
  language: 'de',
  chatbot: { prompt: 'Du bist der EVtivity-Assistent.', fixedRules: 'Security rules: chatbot' },
  support: { prompt: 'Du entwirfst Antworten.', fixedRules: 'Security rules: support' },
  ops: { prompt: 'Du analysierst Störungen.', fixedRules: 'Security rules: ops' },
  driver: { prompt: 'Du hilfst Fahrern.', fixedRules: 'Security rules: driver' },
  providers: [
    {
      id: 'deepseek',
      defaultModel: 'deepseek-flash',
      modelsDocsUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek Flash', vision: true, pdf: false },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', vision: false, pdf: false },
      ],
    },
    {
      id: 'openai',
      defaultModel: 'gpt-6.1-sol',
      modelsDocsUrl: 'https://developers.openai.com/api/docs/models',
      models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', vision: true, pdf: true }],
    },
  ],
};

const SETTINGS: Record<string, unknown> = {
  'chatbotAi.enabled': true,
  'chatbotAi.provider': 'deepseek',
  'chatbotAi.model': '',
  'chatbotAi.effort': 'medium',
  'chatbotAi.systemPrompt': '',
  'supportAi.enabled': false,
  'supportAi.provider': '',
  'supportAi.effort': 'low',
  'supportAi.tone': 'friendly',
  'ai.deepseek.apiKeyEnc': 'sk-test',
  'ai.deepseek.baseUrl': '',
  'ai.rateLimit.userPerMinute': 10,
};

let currentSearch = '';
function LocationProbe(): null {
  currentSearch = useLocation().search;
  return null;
}

function renderSettings(
  overrides: Record<string, unknown> = {},
  sub: string | null = 'providers',
): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const search = sub == null ? '?tab=ai' : `?tab=ai&sub=${sub}`;
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/settings${search}`]}>
        <AiSettings settings={{ ...SETTINGS, ...overrides }} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  getMock.mockResolvedValue(DEFAULTS);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  permissions.write = true;
});

/** One element that only the given tab renders. */
const TAB_MARKERS: Record<AiSettingsTab, () => HTMLElement | null> = {
  providers: () => document.getElementById('ai-deepseek-key'),
  assistant: () => document.getElementById('chatbotAi-enabled'),
  support: () => document.getElementById('supportAi-enabled'),
  driver: () => document.getElementById('driverAi-enabled'),
  insights: () => screen.queryByTestId('ai-insights-settings'),
  mcp: () => screen.queryByTestId('ai-mcp-settings'),
  usage: () => document.getElementById('ai-limit-ai-maxToolCallsPerTurn'),
};

function openAdvanced(container: HTMLElement = document.body): void {
  fireEvent.click(within(container).getByRole('button', { name: /settings.aiAdvancedOptions/ }));
}

const chatbotPrompt = (): HTMLTextAreaElement =>
  document.getElementById('chatbotAi-system-prompt') as HTMLTextAreaElement;
const saveButton = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: /common.save|save/i });

describe('Settings > AI tabs (plan v0.1.45, section 6)', () => {
  it('TC-UI-LY-07 shows the seven tabs in order, each with its description, each card in its tab only', () => {
    renderSettings();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'settings.aiTabs.providers',
      'settings.aiTabs.assistant',
      'settings.aiTabs.support',
      'settings.aiTabs.driver',
      'settings.aiTabs.insights',
      'settings.aiTabs.mcp',
      'settings.aiTabs.usage',
    ]);
    cleanup();
    for (const tab of AI_SETTINGS_TABS) {
      renderSettings({}, tab);
      expect(screen.getByText(`settings.aiTabs.${tab}Description`), tab).toBeTruthy();
      for (const other of AI_SETTINGS_TABS) {
        expect(TAB_MARKERS[other]() != null, `${tab} shows ${other}`).toBe(other === tab);
      }
      cleanup();
    }
  });

  it('TC-UI-LY-08 opens each tab from ?tab=ai&sub=<id> and writes the tab into sub', () => {
    for (const tab of AI_SETTINGS_TABS) {
      renderSettings({}, tab);
      expect(
        screen.getByRole('tab', { name: `settings.aiTabs.${tab}` }).getAttribute('aria-selected'),
        tab,
      ).toBe('true');
      cleanup();
    }
    renderSettings({}, null);
    fireEvent.click(screen.getByRole('tab', { name: 'settings.aiTabs.mcp' }));
    expect(new URLSearchParams(currentSearch).get('sub')).toBe('mcp');
    expect(TAB_MARKERS.mcp()).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'settings.aiTabs.providers' }));
    // The default tab needs no sub.
    expect(new URLSearchParams(currentSearch).get('sub')).toBeNull();
    expect(new URLSearchParams(currentSearch).get('tab')).toBe('ai');
  });

  it('TC-UI-LY-08 an old sub=usage link opens usage, an unknown sub (config) opens Providers and keys', () => {
    renderSettings({}, 'usage');
    expect(TAB_MARKERS.usage()).toBeTruthy();
    cleanup();
    renderSettings({}, 'config');
    expect(
      screen.getByRole('tab', { name: 'settings.aiTabs.providers' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(TAB_MARKERS.providers()).toBeTruthy();
  });

  it('TC-UI-LY-09 a user without settings write sees every tab read-only', () => {
    permissions.write = false;
    for (const tab of AI_SETTINGS_TABS) {
      renderSettings({}, tab);
      expect(screen.queryAllByRole('button', { name: /common.save|save/i }), tab).toHaveLength(0);
      for (const s of screen.queryAllByRole('switch')) {
        expect((s as HTMLButtonElement).disabled, tab).toBe(true);
      }
      cleanup();
    }
  });

  it('TC-AI-AD-12 shows the AI data note on Providers and keys and every surface tab', () => {
    for (const tab of AI_SETTINGS_TABS) {
      renderSettings({}, tab);
      const notice = screen.queryByTestId('ai-data-notice');
      if (tab === 'usage') {
        expect(notice, tab).toBeNull();
      } else {
        expect(notice, tab).toBeTruthy();
        expect(within(notice as HTMLElement).getByText('ai.dataNotice.title')).toBeTruthy();
        expect(within(notice as HTMLElement).getByText('ai.dataNotice.body')).toBeTruthy();
      }
      cleanup();
    }
  });

  it('keeps unsaved edits across a tab switch and a settings reload', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (settings: Record<string, unknown>) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/settings?tab=ai&sub=assistant']}>
          <AiSettings settings={settings} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(view(SETTINGS));
    const effort = (): HTMLSelectElement =>
      document.getElementById('chatbotAi-effort') as HTMLSelectElement;
    fireEvent.change(effort(), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('tab', { name: 'settings.aiTabs.mcp' }));
    fireEvent.click(screen.getByRole('tab', { name: 'settings.aiTabs.assistant' }));
    expect(effort().value).toBe('high');
    // The toggle saved, so the settings come back as a new object.
    rerender(view({ ...SETTINGS, 'chatbotAi.enabled': false }));
    expect(effort().value).toBe('high');
    // An unopened tab is not mounted.
    expect(document.getElementById('supportAi-tone')).toBeNull();
  });

  it('shows the background workers in the Automatic insights tab, also from an old workers link', () => {
    renderSettings({}, 'insights');
    expect(screen.getByTestId('ai-workers-settings')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'settings.aiTabs.workers' })).toBeNull();
    cleanup();
    renderSettings({}, 'workers');
    expect(TAB_MARKERS.insights()).toBeTruthy();
    expect(screen.getByTestId('ai-workers-settings')).toBeTruthy();
  });
});

describe('AiSettings system prompt (TC-UI-LY-10)', () => {
  it('sits behind the advanced options, closed by default and marked built-in', async () => {
    renderSettings({}, 'assistant');
    expect(chatbotPrompt()).toBeNull();
    expect(screen.getByText('settings.aiPromptDefaultSummary')).toBeTruthy();
    openAdvanced();
    await waitFor(() => {
      expect(chatbotPrompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    expect(getMock).toHaveBeenCalledWith('/v1/settings/ai/defaults?language=de');
    expect(chatbotPrompt().readOnly).toBe(true);
    expect(screen.getByText('settings.aiPromptDefaultBadge')).toBeTruthy();
    expect(screen.getByText('Security rules: chatbot')).toBeTruthy();
  });

  it('says a custom prompt is set while closed', () => {
    renderSettings({ 'chatbotAi.systemPrompt': 'Saved custom prompt' }, 'assistant');
    expect(screen.getByText('settings.aiPromptCustomSummary')).toBeTruthy();
  });

  it('Edit copies the default, and saving it unchanged stores nothing', async () => {
    putMock.mockResolvedValue({});
    renderSettings({}, 'assistant');
    openAdvanced();
    await waitFor(() => {
      expect(chatbotPrompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    expect(chatbotPrompt().readOnly).toBe(false);
    expect(chatbotPrompt().value).toBe(DEFAULTS.chatbot.prompt);
    fireEvent.change(document.getElementById('chatbotAi-effort') as HTMLElement, {
      target: { value: 'high' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.effort', { value: 'high' });
    });
    expect(putMock).toHaveBeenCalledTimes(1);
  });

  it('saves an edited prompt', async () => {
    putMock.mockResolvedValue({});
    renderSettings({}, 'assistant');
    openAdvanced();
    await waitFor(() => {
      expect(chatbotPrompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    fireEvent.change(chatbotPrompt(), { target: { value: 'Custom instructions' } });
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.systemPrompt', {
        value: 'Custom instructions',
      });
    });
  });

  it('Reset to default saves an empty prompt', async () => {
    putMock.mockResolvedValue({});
    renderSettings({ 'chatbotAi.systemPrompt': 'Saved custom prompt' }, 'assistant');
    openAdvanced();
    expect(chatbotPrompt().value).toBe('Saved custom prompt');
    expect(chatbotPrompt().readOnly).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'settings.aiPromptReset' }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.systemPrompt', { value: '' });
    });
  });

  it('shows the default read-only without Edit for a reader', async () => {
    permissions.write = false;
    renderSettings({}, 'assistant');
    openAdvanced();
    await waitFor(() => {
      expect(chatbotPrompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    expect(screen.queryByRole('button', { name: 'common.edit' })).toBeNull();
  });

  it('every surface tab keeps its prompt behind the disclosure', () => {
    for (const [tab, id] of [
      ['support', 'supportAi-system-prompt'],
      ['driver', 'driverAi-system-prompt'],
      ['insights', 'opsAi-system-prompt'],
    ] as const) {
      renderSettings({}, tab);
      expect(document.getElementById(id), tab).toBeNull();
      openAdvanced(screen.getByTestId(`ai-tab-${tab}`));
      expect(document.getElementById(id), tab).toBeTruthy();
      cleanup();
    }
  });
});

describe('AiSettings model', () => {
  const chatbotModel = (): HTMLSelectElement =>
    document.getElementById('chatbotAi-model') as HTMLSelectElement;

  it('lists the provider models with the default marked and a docs link', async () => {
    renderSettings({}, 'assistant');
    await waitFor(() => {
      expect(chatbotModel().tagName).toBe('SELECT');
    });
    const options = Array.from(chatbotModel().options).map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ['', 'settings.aiModelDefaultOption'],
      ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
      ['__custom__', 'settings.aiModelCustomOption'],
    ]);
    expect(chatbotModel().value).toBe('');
    const link = screen.getAllByRole('link', { name: /settings.aiModelDocsLink/ })[0];
    expect(link?.getAttribute('href')).toBe('https://api-docs.deepseek.com/quick_start/pricing');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('saves a listed model and accepts a custom id', async () => {
    putMock.mockResolvedValue({});
    renderSettings({}, 'assistant');
    await waitFor(() => {
      expect(chatbotModel().tagName).toBe('SELECT');
    });
    fireEvent.change(chatbotModel(), { target: { value: '__custom__' } });
    const custom = document.getElementById('chatbotAi-model-custom') as HTMLInputElement;
    fireEvent.change(custom, { target: { value: 'deepseek-v5-preview' } });
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.model', {
        value: 'deepseek-v5-preview',
      });
    });
  });

  it('a provider switch resets a listed model to the default', async () => {
    putMock.mockResolvedValue({});
    renderSettings({ 'chatbotAi.model': 'deepseek-v4-pro' }, 'assistant');
    await waitFor(() => {
      expect(chatbotModel().tagName).toBe('SELECT');
      expect(chatbotModel().value).toBe('deepseek-v4-pro');
    });
    fireEvent.change(document.getElementById('chatbotAi-provider') as HTMLElement, {
      target: { value: 'openai' },
    });
    expect(chatbotModel().value).toBe('');
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.model', { value: '' });
    });
    expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.provider', { value: 'openai' });
  });

  it('a provider switch keeps a custom model id', async () => {
    renderSettings({ 'chatbotAi.model': 'deepseek-v5-preview' }, 'assistant');
    await waitFor(() => {
      expect(chatbotModel().value).toBe('__custom__');
    });
    fireEvent.change(document.getElementById('chatbotAi-provider') as HTMLElement, {
      target: { value: 'openai' },
    });
    expect(chatbotModel().value).toBe('__custom__');
    expect((document.getElementById('chatbotAi-model-custom') as HTMLInputElement).value).toBe(
      'deepseek-v5-preview',
    );
  });

  it('warns when the chosen provider has no stored key', () => {
    renderSettings({}, 'support');
    expect(screen.queryByText('settings.aiProviderNoKey')).toBeNull();
    fireEvent.change(document.getElementById('supportAi-provider') as HTMLElement, {
      target: { value: 'openai' },
    });
    expect(screen.getByText('settings.aiProviderNoKey')).toBeTruthy();
  });
});

describe('AiSettings cards save from their tab (TC-UI-LY-10)', () => {
  it('has no sampling fields and one key per provider, base URLs behind the disclosure', () => {
    renderSettings();
    expect(screen.queryByText(/temperature|topP|topK/i)).toBeNull();
    for (const p of ['anthropic', 'openai', 'gemini', 'deepseek']) {
      expect(document.getElementById(`ai-${p}-key`)).toBeTruthy();
      expect(document.getElementById(`ai-${p}-base-url`)).toBeNull();
      openAdvanced(screen.getByTestId(`ai-${p}-advanced`));
      expect(document.getElementById(`ai-${p}-base-url`)).toBeTruthy();
    }
    expect((document.getElementById('ai-deepseek-key') as HTMLInputElement).value).toBe('sk-test');
  });

  it('shows a stored base URL in the closed disclosure', () => {
    renderSettings({ 'ai.openai.baseUrl': 'https://proxy.example.com/v1' });
    expect(
      within(screen.getByTestId('ai-openai-advanced')).getByText('https://proxy.example.com/v1'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('ai-deepseek-advanced')).getByText(
        'settings.aiBaseUrlDefaultSummary',
      ),
    ).toBeTruthy();
  });

  it('writes only the changed provider keys', async () => {
    putMock.mockResolvedValue({});
    renderSettings();
    fireEvent.change(document.getElementById('ai-openai-key') as HTMLElement, {
      target: { value: 'sk-openai' },
    });
    openAdvanced(screen.getByTestId('ai-openai-advanced'));
    fireEvent.change(document.getElementById('ai-openai-base-url') as HTMLElement, {
      target: { value: ' https://proxy.example.com/v1 ' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledTimes(2);
    });
    expect(putMock).toHaveBeenCalledWith('/v1/settings/ai.openai.apiKeyEnc', {
      value: 'sk-openai',
    });
    expect(putMock).toHaveBeenCalledWith('/v1/settings/ai.openai.baseUrl', {
      value: 'https://proxy.example.com/v1',
    });
  });

  it('saves the surface effort and invalidates the assistant status', async () => {
    putMock.mockResolvedValue({});
    const client = renderSettings({}, 'assistant');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.change(document.getElementById('chatbotAi-effort') as HTMLElement, {
      target: { value: 'high' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.effort', { value: 'high' });
    });
    expect(putMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ai-status'] });
    });
  });

  it('saves the support draft tone from its tab', async () => {
    putMock.mockResolvedValue({});
    renderSettings({}, 'support');
    fireEvent.change(document.getElementById('supportAi-tone') as HTMLElement, {
      target: { value: 'professional' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/supportAi.tone', {
        value: 'professional',
      });
    });
    expect(putMock).toHaveBeenCalledTimes(1);
  });

  it('toggling the assistant writes chatbotAi.enabled and invalidates the status', async () => {
    putMock.mockResolvedValue({});
    const client = renderSettings({}, 'assistant');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(document.getElementById('chatbotAi-enabled') as HTMLElement);
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.enabled', { value: false });
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ai-status'] });
    });
  });

  it('writes limits as numbers and blocks out-of-range values', async () => {
    putMock.mockResolvedValue({});
    renderSettings({}, 'usage');
    const input = document.getElementById('ai-limit-ai-maxToolCallsPerTurn') as HTMLInputElement;
    expect(input.value).toBe('20');
    fireEvent.change(input, { target: { value: '500' } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: '30' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/ai.maxToolCallsPerTurn', { value: 30 });
    });
  });

  it('is read-only without settings.ai:write', () => {
    permissions.write = false;
    renderSettings();
    expect((document.getElementById('ai-deepseek-key') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryAllByRole('button', { name: /common.save|save/i })).toHaveLength(0);
  });

  it('the driver support tab holds the driver AI settings', () => {
    renderSettings({}, 'driver');
    expect(screen.getByText('settings.aiSurface.driver.title')).toBeTruthy();
    expect(screen.getByText('settings.aiDriverSettings.title')).toBeTruthy();
  });
});
