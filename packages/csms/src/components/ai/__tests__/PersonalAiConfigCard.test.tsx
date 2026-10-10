// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { putMock, getMock } = vi.hoisted(() => ({ putMock: vi.fn(), getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ko' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { put: putMock, get: getMock, delete: vi.fn() } };
});

import { PersonalAiConfigCard } from '../AiConfigFields';

const DEFAULTS = {
  language: 'ko',
  chatbot: { prompt: '당신은 EVtivity 어시스턴트입니다.', fixedRules: 'Security rules: chatbot' },
  support: { prompt: '답변 초안을 작성합니다.', fixedRules: 'Security rules: support' },
  providers: [
    {
      id: 'anthropic',
      defaultModel: 'claude-sonnet-5-5',
      modelsDocsUrl: 'https://platform.claude.com/docs/en/models/overview',
      models: [
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', vision: true, pdf: true },
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', vision: true, pdf: true },
      ],
    },
    {
      id: 'gemini',
      defaultModel: 'gemini-3.8-flash',
      modelsDocsUrl: 'https://ai.google.dev/gemini-api/docs/models',
      models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', vision: true, pdf: true }],
    },
  ],
};

interface Config {
  configured: boolean;
  provider: string | null;
  apiKey: string | null;
  model: string | null;
  effort: string | null;
  systemPrompt: string | null;
}

const CONFIGURED: Config = {
  configured: true,
  provider: 'anthropic',
  apiKey: 'sk-ant',
  model: 'claude-opus-5-5',
  effort: 'medium',
  systemPrompt: null,
};

function mockGets(config: Config): void {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith('/v1/users/me/ai-defaults') ? DEFAULTS : config),
  );
}

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PersonalAiConfigCard surface="chatbot" />
    </QueryClientProvider>,
  );
}

const prompt = (): HTMLTextAreaElement =>
  document.getElementById('ai-profile-system-prompt') as HTMLTextAreaElement;
const model = (): HTMLSelectElement =>
  document.getElementById('ai-profile-model') as HTMLSelectElement;

beforeEach(() => {
  putMock.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PersonalAiConfigCard', () => {
  it('shows the built-in prompt of the UI language, marked Default, and the fixed rules', async () => {
    mockGets(CONFIGURED);
    renderCard();
    await waitFor(() => {
      expect(prompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    expect(getMock).toHaveBeenCalledWith('/v1/users/me/ai-defaults?language=ko');
    expect(prompt().readOnly).toBe(true);
    expect(screen.getByText('settings.aiPromptDefaultBadge')).toBeTruthy();
    expect(screen.getByText('Security rules: chatbot')).toBeTruthy();
  });

  it('saving after Edit without changes stores no prompt', async () => {
    mockGets(CONFIGURED);
    renderCard();
    await waitFor(() => {
      expect(prompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    expect(prompt().readOnly).toBe(false);
    expect(prompt().value).toBe(DEFAULTS.chatbot.prompt);
    fireEvent.click(screen.getByRole('button', { name: /common.save|save/i }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledTimes(1);
    });
    expect(putMock.mock.calls[0]?.[1]).not.toHaveProperty('systemPrompt');
  });

  it('saves an edited prompt', async () => {
    mockGets(CONFIGURED);
    renderCard();
    await waitFor(() => {
      expect(prompt().value).toBe(DEFAULTS.chatbot.prompt);
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    fireEvent.change(prompt(), { target: { value: 'My own instructions' } });
    fireEvent.click(screen.getByRole('button', { name: /common.save|save/i }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith(
        '/v1/users/me/chatbot-ai-config',
        expect.objectContaining({ systemPrompt: 'My own instructions' }),
      );
    });
  });

  it('Reset to default saves the configuration without a prompt', async () => {
    mockGets({ ...CONFIGURED, systemPrompt: 'Saved prompt' });
    renderCard();
    await waitFor(() => {
      expect(prompt().value).toBe('Saved prompt');
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.aiPromptReset' }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledTimes(1);
    });
    expect(putMock.mock.calls[0]?.[0]).toBe('/v1/users/me/chatbot-ai-config');
    expect(putMock.mock.calls[0]?.[1]).not.toHaveProperty('systemPrompt');
    expect(prompt().readOnly).toBe(true);
  });

  it('lists the provider models, links the docs and resets a listed model on a provider switch', async () => {
    mockGets(CONFIGURED);
    renderCard();
    await waitFor(() => {
      expect(model().value).toBe('claude-opus-5-5');
    });
    expect(Array.from(model().options).map((o) => o.value)).toEqual([
      'claude-opus-5-5',
      '',
      '__custom__',
    ]);
    expect(
      screen.getByRole('link', { name: /settings.aiModelDocsLink/ }).getAttribute('href'),
    ).toBe('https://platform.claude.com/docs/en/models/overview');
    fireEvent.change(document.getElementById('ai-profile-provider') as HTMLElement, {
      target: { value: 'gemini' },
    });
    expect(model().value).toBe('');
    expect(
      screen.getByRole('link', { name: /settings.aiModelDocsLink/ }).getAttribute('href'),
    ).toBe('https://ai.google.dev/gemini-api/docs/models');
    fireEvent.click(screen.getByRole('button', { name: /common.save|save/i }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledTimes(1);
    });
    expect(putMock.mock.calls[0]?.[1]).toMatchObject({ provider: 'gemini' });
    expect(putMock.mock.calls[0]?.[1]).not.toHaveProperty('model');
  });

  it('keeps a custom model id on a provider switch', async () => {
    mockGets({ ...CONFIGURED, model: 'claude-next-preview' });
    renderCard();
    await waitFor(() => {
      expect(model().value).toBe('__custom__');
    });
    fireEvent.change(document.getElementById('ai-profile-provider') as HTMLElement, {
      target: { value: 'gemini' },
    });
    expect((document.getElementById('ai-profile-model-custom') as HTMLInputElement).value).toBe(
      'claude-next-preview',
    );
  });
});
