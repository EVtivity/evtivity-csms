// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn() },
  perms: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => perms.has(p),
  useHasAllSiteAccess: () => true,
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { DriverAiSettings, loadDriverAiValues } from '../DriverAiSettings';

const DEFAULT_PROMPT = 'You are the automatic support assistant.';

const SETTINGS = {
  'driverAi.enabled': false,
  'driverAi.provider': 'anthropic',
  'driverAi.model': '',
  'driverAi.effort': 'low',
  'driverAi.systemPrompt': '',
  'driverAi.maxCasesPerDriverPerDay': 3,
  'driverAi.feedbackTimeoutHours': 24,
  'ai.budget.driverDailyTokens': 40000,
  'ai.rateLimit.driverPerMinute': 2,
  'ai.anthropic.apiKeyEnc': 'k',
};

function wrap(settings: Record<string, unknown> = SETTINGS): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DriverAiSettings settings={settings} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function change(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  perms.clear();
  perms.add('settings.ai:write');
  apiMock.put.mockResolvedValue({});
  apiMock.get.mockResolvedValue({
    chatbot: { prompt: '', fixedRules: '' },
    support: { prompt: '', fixedRules: '' },
    driver: { prompt: DEFAULT_PROMPT, fixedRules: 'Rules' },
    providers: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Settings > AI > Driver support (TC-AI-DR-UI-08)', () => {
  it('TC-AI-DR-UI-08: shows the data residency warning and turns driver AI on', async () => {
    wrap();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/driverAi.enabled', { value: true });
    });
  });

  it('TC-AI-DR-UI-08: saves provider, model, effort and the prompt override', async () => {
    wrap();
    change('settings.aiProvider', 'openai');
    change('settings.aiModel', 'gpt-custom');
    change('settings.aiEffort', 'medium');
    // The prompt override sits behind the advanced options (frontend/ui.md).
    fireEvent.click(screen.getByRole('button', { name: /settings.aiAdvancedOptions/ }));
    // The built-in prompt is loaded: Edit copies it into the field.
    await screen.findByText('settings.aiFixedRulesShow');
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    change('settings.aiSystemPrompt', 'Be brief and kind.');
    fireEvent.click(screen.getAllByRole('button', { name: 'common.save' })[0] as HTMLElement);
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/driverAi.systemPrompt', {
        value: 'Be brief and kind.',
      });
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/driverAi.provider', {
      value: 'openai',
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/driverAi.model', {
      value: 'gpt-custom',
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/driverAi.effort', { value: 'medium' });
  });

  it('TC-AI-DR-UI-08: an unchanged built-in prompt is saved empty', async () => {
    wrap({ ...SETTINGS, 'driverAi.systemPrompt': 'Old custom prompt' });
    fireEvent.click(screen.getByRole('button', { name: /settings.aiAdvancedOptions/ }));
    await screen.findByText('settings.aiFixedRulesShow');
    change('settings.aiSystemPrompt', `${DEFAULT_PROMPT}\n`);
    fireEvent.click(screen.getAllByRole('button', { name: 'common.save' })[0] as HTMLElement);
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/driverAi.systemPrompt', {
        value: '',
      });
    });
  });

  it('TC-AI-DR-UI-08: saves every driver limit as a number', async () => {
    wrap();
    change('settings.aiDriverSettings.maxCasesPerDriverPerDay', '5');
    change('settings.aiDriverSettings.feedbackTimeoutHours', '48');
    change('settings.aiDriverSettings.driverDailyTokens', '0');
    change('settings.aiDriverSettings.driverPerMinute', '4');
    fireEvent.click(screen.getAllByRole('button', { name: 'common.save' })[1] as HTMLElement);
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/ai.rateLimit.driverPerMinute', {
        value: 4,
      });
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/driverAi.maxCasesPerDriverPerDay', {
      value: 5,
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/driverAi.feedbackTimeoutHours', {
      value: 48,
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/ai.budget.driverDailyTokens', {
      value: 0,
    });
  });

  it('refuses a limit outside its range', () => {
    wrap();
    change('settings.aiDriverSettings.feedbackTimeoutHours', '0');
    const saves = screen.getAllByRole('button', { name: 'common.save' });
    expect((saves[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns when the chosen provider has no key', () => {
    wrap({ ...SETTINGS, 'ai.anthropic.apiKeyEnc': '' });
    expect(screen.getByText('settings.aiProviderNoKey')).toBeTruthy();
  });

  it('is read-only without settings.ai:write', () => {
    perms.clear();
    wrap();
    expect(screen.queryByRole('button', { name: 'common.save' })).toBeNull();
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true);
  });

  it('loads the defaults when nothing is stored', () => {
    const values = loadDriverAiValues({});
    expect(values['driverAi.effort']).toBe('low');
    expect(values['driverAi.maxCasesPerDriverPerDay']).toBe('3');
    expect(values['driverAi.feedbackTimeoutHours']).toBe('24');
    expect(values['ai.budget.driverDailyTokens']).toBe('40000');
    expect(values['ai.rateLimit.driverPerMinute']).toBe('2');
  });
});
