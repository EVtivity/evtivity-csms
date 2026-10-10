// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { putMock, getMock, permissions } = vi.hoisted(() => ({
  putMock: vi.fn(),
  getMock: vi.fn(),
  permissions: { write: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'de' } }),
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => permissions.write }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { put: putMock, get: getMock } };
});

import { AiSettings } from '../AiSettings';

const DEFAULTS = {
  language: 'de',
  chatbot: { prompt: 'Du bist der EVtivity-Assistent.', fixedRules: 'Security rules: chatbot' },
  support: { prompt: 'Du entwirfst Antworten.', fixedRules: 'Security rules: support' },
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

function renderSettings(overrides: Record<string, unknown> = {}): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AiSettings settings={{ ...SETTINGS, ...overrides }} />
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

const chatbotPrompt = (): HTMLTextAreaElement =>
  document.getElementById('chatbotAi-system-prompt') as HTMLTextAreaElement;
const chatbotSave = (): HTMLElement =>
  screen.getAllByRole('button', { name: /common.save|save/i })[1] as HTMLElement;

describe('AiSettings system prompt', () => {
  it('shows the built-in prompt of the UI language, read-only and marked Default', async () => {
    renderSettings();
    await waitFor(() => {
      expect(chatbotPrompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    expect(getMock).toHaveBeenCalledWith('/v1/settings/ai/defaults?language=de');
    expect(chatbotPrompt().readOnly).toBe(true);
    expect(screen.getAllByText('settings.aiPromptDefaultBadge').length).toBe(2);
    expect(screen.getByText('Security rules: chatbot')).toBeTruthy();
    expect(screen.getAllByText('settings.aiFixedRulesNote').length).toBe(2);
  });

  it('Edit copies the default, and saving it unchanged stores nothing', async () => {
    putMock.mockResolvedValue({});
    renderSettings();
    await waitFor(() => {
      expect(chatbotPrompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'common.edit' })[0] as HTMLElement);
    expect(chatbotPrompt().readOnly).toBe(false);
    expect(chatbotPrompt().value).toBe(DEFAULTS.chatbot.prompt);
    fireEvent.change(document.getElementById('chatbotAi-effort') as HTMLElement, {
      target: { value: 'high' },
    });
    fireEvent.click(chatbotSave());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.effort', { value: 'high' });
    });
    expect(putMock).toHaveBeenCalledTimes(1);
  });

  it('saves an edited prompt', async () => {
    putMock.mockResolvedValue({});
    renderSettings();
    await waitFor(() => {
      expect(chatbotPrompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'common.edit' })[0] as HTMLElement);
    fireEvent.change(chatbotPrompt(), { target: { value: 'Custom instructions' } });
    fireEvent.click(chatbotSave());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.systemPrompt', {
        value: 'Custom instructions',
      });
    });
  });

  it('Reset to default saves an empty prompt', async () => {
    putMock.mockResolvedValue({});
    renderSettings({ 'chatbotAi.systemPrompt': 'Saved custom prompt' });
    expect(chatbotPrompt().value).toBe('Saved custom prompt');
    expect(chatbotPrompt().readOnly).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'settings.aiPromptReset' }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.systemPrompt', { value: '' });
    });
  });

  it('shows the default read-only without Edit for a reader', async () => {
    permissions.write = false;
    renderSettings();
    await waitFor(() => {
      expect(chatbotPrompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    expect(screen.queryByRole('button', { name: 'common.edit' })).toBeNull();
  });
});

describe('AiSettings model', () => {
  const chatbotModel = (): HTMLSelectElement =>
    document.getElementById('chatbotAi-model') as HTMLSelectElement;

  it('lists the provider models with the default marked and a docs link', async () => {
    renderSettings();
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
    renderSettings();
    await waitFor(() => {
      expect(chatbotModel().tagName).toBe('SELECT');
    });
    fireEvent.change(chatbotModel(), { target: { value: '__custom__' } });
    const custom = document.getElementById('chatbotAi-model-custom') as HTMLInputElement;
    fireEvent.change(custom, { target: { value: 'deepseek-v5-preview' } });
    fireEvent.click(chatbotSave());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.model', {
        value: 'deepseek-v5-preview',
      });
    });
  });

  it('a provider switch resets a listed model to the default', async () => {
    putMock.mockResolvedValue({});
    renderSettings({ 'chatbotAi.model': 'deepseek-v4-pro' });
    await waitFor(() => {
      expect(chatbotModel().tagName).toBe('SELECT');
      expect(chatbotModel().value).toBe('deepseek-v4-pro');
    });
    fireEvent.change(document.getElementById('chatbotAi-provider') as HTMLElement, {
      target: { value: 'openai' },
    });
    expect(chatbotModel().value).toBe('');
    fireEvent.click(chatbotSave());
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.model', { value: '' });
    });
    expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.provider', { value: 'openai' });
  });

  it('a provider switch keeps a custom model id', async () => {
    renderSettings({ 'chatbotAi.model': 'deepseek-v5-preview' });
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
});

describe('AiSettings', () => {
  it('has no sampling fields and one key per provider', () => {
    renderSettings();
    expect(screen.queryByText(/temperature|topP|topK/i)).toBeNull();
    for (const p of ['anthropic', 'openai', 'gemini', 'deepseek']) {
      expect(document.getElementById(`ai-${p}-key`)).toBeTruthy();
      expect(document.getElementById(`ai-${p}-base-url`)).toBeTruthy();
    }
    expect((document.getElementById('ai-deepseek-key') as HTMLInputElement).value).toBe('sk-test');
  });

  it('writes only the changed provider keys', async () => {
    putMock.mockResolvedValue({});
    renderSettings();
    fireEvent.change(document.getElementById('ai-openai-key') as HTMLElement, {
      target: { value: 'sk-openai' },
    });
    fireEvent.change(document.getElementById('ai-openai-base-url') as HTMLElement, {
      target: { value: ' https://proxy.example.com/v1 ' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /common.save|save/i })[0] as HTMLElement);
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
    const client = renderSettings();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.change(document.getElementById('chatbotAi-effort') as HTMLElement, {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /common.save|save/i })[1] as HTMLElement);
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/chatbotAi.effort', { value: 'high' });
    });
    expect(putMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ai-status'] });
    });
  });

  it('toggling the assistant writes chatbotAi.enabled and invalidates the status', async () => {
    putMock.mockResolvedValue({});
    const client = renderSettings();
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
    renderSettings();
    const input = document.getElementById('ai-limit-ai-maxToolCallsPerTurn') as HTMLInputElement;
    expect(input.value).toBe('20');
    fireEvent.change(input, { target: { value: '500' } });
    const saves = screen.getAllByRole('button', { name: /common.save|save/i });
    const limitSave = saves[saves.length - 1] as HTMLButtonElement;
    expect(limitSave.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '30' } });
    expect(limitSave.disabled).toBe(false);
    fireEvent.click(limitSave);
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
});
