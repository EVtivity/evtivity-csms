// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock } = vi.hoisted(() => ({ apiMock: { put: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: apiMock, ApiError };
});

import { ApiError } from '@/lib/api';
import { SecurityPasswordSessionSettings } from '../SecurityPasswordSessionSettings';

const SETTINGS = {
  passwordPolicy: {
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSymbol: false,
  },
  sessionLifetimes: {
    operatorAccessMinutes: 60,
    operatorRefreshDays: 30,
    driverAccessMinutes: 60,
    driverRefreshDays: 30,
  },
};

let client: QueryClient;

function renderWith(
  settings: Record<string, unknown> | undefined = SETTINGS,
  canWrite = true,
): ReturnType<typeof render> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SecurityPasswordSessionSettings settings={settings} canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

function inputValue(label: string): string {
  return screen.getByLabelText<HTMLInputElement>(label).value;
}

function isDisabled(label: string): boolean {
  return screen.getByLabelText<HTMLInputElement | HTMLButtonElement>(label).disabled;
}

function passwordsCard(): HTMLElement {
  return screen.getByTestId('password-policy-card');
}

function sessionsCard(): HTMLElement {
  return screen.getByTestId('session-lifetimes-card');
}

beforeEach(() => {
  apiMock.put.mockReset();
  apiMock.put.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
});

describe('SecurityPasswordSessionSettings', () => {
  it('loads the values from the security settings', () => {
    renderWith();
    expect(inputValue('settings.passwordSessions.minLength')).toBe('12');
    expect(
      screen
        .getByLabelText('settings.passwordSessions.requireUppercase')
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByLabelText('settings.passwordSessions.requireSymbol').getAttribute('aria-checked'),
    ).toBe('false');
    expect(inputValue('settings.passwordSessions.operatorAccessMinutes')).toBe('60');
    expect(inputValue('settings.passwordSessions.driverRefreshDays')).toBe('30');
  });

  it('shows when each change applies', () => {
    renderWith();
    expect(
      within(passwordsCard()).getByText('settings.passwordSessions.passwordsNote'),
    ).toBeTruthy();
    expect(within(sessionsCard()).getByText('settings.passwordSessions.sessionsNote')).toBeTruthy();
  });

  it('saves the password policy and refreshes the public policy', async () => {
    renderWith();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.minLength'), {
      target: { value: '14' },
    });
    fireEvent.click(screen.getByLabelText('settings.passwordSessions.requireSymbol'));
    expect(within(passwordsCard()).getByText('settings.unsavedChanges')).toBeTruthy();
    fireEvent.click(within(passwordsCard()).getByRole('button', { name: /common.save/ }));

    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/security/password-policy', {
        minLength: 14,
        requireUppercase: true,
        requireLowercase: true,
        requireNumber: true,
        requireSymbol: true,
      });
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['security-settings'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['security-public'] });
    });
    expect(apiMock.put).toHaveBeenCalledTimes(1);
  });

  it('saves the session lifetimes and refreshes both queries', async () => {
    renderWith();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.operatorAccessMinutes'), {
      target: { value: '15' },
    });
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.driverRefreshDays'), {
      target: { value: '90' },
    });
    fireEvent.click(within(sessionsCard()).getByRole('button', { name: /common.save/ }));

    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/security/sessions', {
        operatorAccessMinutes: 15,
        operatorRefreshDays: 30,
        driverAccessMinutes: 60,
        driverRefreshDays: 90,
      });
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['security-settings'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['security-public'] });
    });
    expect(await within(sessionsCard()).findByText('common.saved')).toBeTruthy();
  });

  it('shows a minimum length below the floor only after Save, and sends nothing', () => {
    renderWith();
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.minLength'), {
      target: { value: '7' },
    });
    expect(within(passwordsCard()).queryByText('validation.min')).toBeNull();
    fireEvent.click(within(passwordsCard()).getByRole('button', { name: /common.save/ }));
    expect(within(passwordsCard()).getByText('validation.min')).toBeTruthy();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('refuses an empty minimum length as required', () => {
    renderWith();
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.minLength'), {
      target: { value: '' },
    });
    fireEvent.click(within(passwordsCard()).getByRole('button', { name: /common.save/ }));
    expect(within(passwordsCard()).getByText('validation.required')).toBeTruthy();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('refuses a session lifetime above its range', () => {
    renderWith();
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.operatorRefreshDays'), {
      target: { value: '91' },
    });
    fireEvent.click(within(sessionsCard()).getByRole('button', { name: /common.save/ }));
    expect(within(sessionsCard()).getByText('validation.max')).toBeTruthy();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('refuses a fractional session lifetime', () => {
    renderWith();
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.driverAccessMinutes'), {
      target: { value: '10.5' },
    });
    fireEvent.click(within(sessionsCard()).getByRole('button', { name: /common.save/ }));
    expect(within(sessionsCard()).getByText('validation.invalidNumber')).toBeTruthy();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('shows the save error from the API', async () => {
    apiMock.put.mockRejectedValueOnce(new ApiError(500, {}));
    renderWith();
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.minLength'), {
      target: { value: '16' },
    });
    fireEvent.click(within(passwordsCard()).getByRole('button', { name: /common.save/ }));
    expect(
      await within(passwordsCard()).findByText('settings.passwordSessions.saveFailed'),
    ).toBeTruthy();
  });

  it('reloads the values while the form is clean', () => {
    const view = renderWith();
    view.rerender(
      <QueryClientProvider client={client}>
        <SecurityPasswordSessionSettings
          settings={{ ...SETTINGS, passwordPolicy: { ...SETTINGS.passwordPolicy, minLength: 20 } }}
          canWrite
        />
      </QueryClientProvider>,
    );
    expect(inputValue('settings.passwordSessions.minLength')).toBe('20');
  });

  it('keeps a dirty edit when the settings rerender', () => {
    const view = renderWith();
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.minLength'), {
      target: { value: '16' },
    });
    view.rerender(
      <QueryClientProvider client={client}>
        <SecurityPasswordSessionSettings
          settings={{ ...SETTINGS, passwordPolicy: { ...SETTINGS.passwordPolicy, minLength: 20 } }}
          canWrite
        />
      </QueryClientProvider>,
    );
    expect(inputValue('settings.passwordSessions.minLength')).toBe('16');
    expect(within(passwordsCard()).getByText('settings.unsavedChanges')).toBeTruthy();
  });

  it('hides earlier validation errors after a reload replaces a clean form', () => {
    const view = renderWith();
    const minLength = (): HTMLElement =>
      screen.getByLabelText('settings.passwordSessions.minLength');
    fireEvent.change(minLength(), { target: { value: '7' } });
    fireEvent.click(within(passwordsCard()).getByRole('button', { name: /common.save/ }));
    expect(within(passwordsCard()).getByText('validation.min')).toBeTruthy();
    fireEvent.change(minLength(), { target: { value: '12' } });
    view.rerender(
      <QueryClientProvider client={client}>
        <SecurityPasswordSessionSettings
          settings={{ ...SETTINGS, passwordPolicy: { ...SETTINGS.passwordPolicy, minLength: 20 } }}
          canWrite
        />
      </QueryClientProvider>,
    );
    expect(inputValue('settings.passwordSessions.minLength')).toBe('20');
    fireEvent.change(minLength(), { target: { value: '7' } });
    expect(within(passwordsCard()).queryByText('validation.min')).toBeNull();
  });

  it('clears the save error when the user edits again', async () => {
    apiMock.put.mockRejectedValueOnce(new ApiError(500, {}));
    renderWith();
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.operatorAccessMinutes'), {
      target: { value: '30' },
    });
    fireEvent.click(within(sessionsCard()).getByRole('button', { name: /common.save/ }));
    expect(
      await within(sessionsCard()).findByText('settings.passwordSessions.saveFailed'),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.operatorAccessMinutes'), {
      target: { value: '45' },
    });
    expect(within(sessionsCard()).queryByText('settings.passwordSessions.saveFailed')).toBeNull();
  });

  it('saves the sessions card without calling the password policy route', async () => {
    renderWith();
    fireEvent.change(screen.getByLabelText('settings.passwordSessions.driverAccessMinutes'), {
      target: { value: '20' },
    });
    fireEvent.click(within(sessionsCard()).getByRole('button', { name: /common.save/ }));
    expect(await within(sessionsCard()).findByText('common.saved')).toBeTruthy();
    expect(apiMock.put).toHaveBeenCalledTimes(1);
    expect(apiMock.put).toHaveBeenCalledWith('/v1/security/sessions', expect.any(Object));
    expect(apiMock.put).not.toHaveBeenCalledWith('/v1/security/password-policy', expect.anything());
  });

  it('shows a load error with Retry instead of default values', () => {
    const onRetry = vi.fn();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SecurityPasswordSessionSettings
          settings={undefined}
          canWrite
          loadFailed
          onRetry={onRetry}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText('common.loadError')).toBeTruthy();
    expect(screen.queryByTestId('password-policy-card')).toBeNull();
    expect(screen.queryByTestId('session-lifetimes-card')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('is read-only without the write permission', () => {
    renderWith(SETTINGS, false);
    expect(isDisabled('settings.passwordSessions.minLength')).toBe(true);
    expect(isDisabled('settings.passwordSessions.requireNumber')).toBe(true);
    expect(screen.queryByRole('button', { name: /common.save/ })).toBeNull();
  });
});
