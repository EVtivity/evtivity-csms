// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({ api: { put: vi.fn() } }));

import { SecurityRecaptchaSettings } from '../SecurityRecaptchaSettings';

afterEach(() => {
  cleanup();
});

function renderWith(settings: Record<string, unknown> | undefined): void {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <SecurityRecaptchaSettings settings={settings} />
    </QueryClientProvider>,
  );
}

describe('SecurityRecaptchaSettings', () => {
  it('warns that sign-up relies on IP rate limits while reCAPTCHA is off', () => {
    renderWith({ 'security.recaptcha.enabled': false });
    expect(screen.getByText('settings.recaptchaOffWarning')).toBeTruthy();
  });

  it('shows no warning while reCAPTCHA is on', () => {
    renderWith({ 'security.recaptcha.enabled': true });
    expect(screen.queryByText('settings.recaptchaOffWarning')).toBeNull();
  });

  it('shows no warning before the settings load', () => {
    renderWith(undefined);
    expect(screen.queryByText('settings.recaptchaOffWarning')).toBeNull();
  });

  it('shows a stored secret from the configured flag when the secret itself is withheld', () => {
    renderWith({
      'security.recaptcha.secretKeyEnc': null,
      'security.recaptcha.secretKeyConfigured': true,
    });
    const input = document.getElementById('recaptcha-secret-key') as HTMLInputElement;
    expect(input.placeholder).toBe('••••••••');
    expect(input.value).toBe('');
  });

  it('shows no stored secret placeholder when none is configured', () => {
    renderWith({ 'security.recaptcha.secretKeyConfigured': false });
    const input = document.getElementById('recaptcha-secret-key') as HTMLInputElement;
    expect(input.placeholder).toBe('');
  });
});
