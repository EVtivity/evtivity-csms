// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const { putMock, getMock } = vi.hoisted(() => ({ putMock: vi.fn(), getMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: {
    get: getMock,
    put: putMock,
  },
}));

import { SecurityMfaSettings, type SecuritySettingsResponse } from '../SecurityMfaSettings';

afterEach(() => {
  cleanup();
  putMock.mockReset();
});

getMock.mockImplementation(() =>
  Promise.resolve({ 'smtp.host': 'smtp.test', 'twilio.accountSid': 'AC1' }),
);

const ROLE_NAMES = ['admin', 'operator'];

function renderWith(
  settings: SecuritySettingsResponse | undefined,
  props: { canWrite?: boolean; loadFailed?: boolean; onRetry?: () => void } = {},
): void {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <SecurityMfaSettings settings={settings} {...props} />
    </QueryClientProvider>,
  );
}

function switchState(label: string): string | null {
  return screen.getByRole('switch', { name: label }).getAttribute('aria-checked');
}

describe('SecurityMfaSettings', () => {
  it('shows the switches the server applies when no key is stored', () => {
    renderWith({ mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false } });
    expect(switchState('settings.mfaEmail')).toBe('true');
    expect(switchState('settings.mfaTotp')).toBe('true');
    expect(switchState('settings.mfaSms')).toBe('false');
  });

  it('shows every switch off while the reply has no effective values', () => {
    renderWith({ 'security.mfa.emailEnabled': true });
    expect(switchState('settings.mfaEmail')).toBe('false');
    expect(switchState('settings.mfaTotp')).toBe('false');
    expect(switchState('settings.mfaSms')).toBe('false');
  });

  it('follows the effective values, not the stored keys', () => {
    renderWith({
      'security.mfa.smsEnabled': true,
      mfa: { emailEnabled: false, totpEnabled: false, smsEnabled: true },
    });
    expect(switchState('settings.mfaEmail')).toBe('false');
    expect(switchState('settings.mfaTotp')).toBe('false');
    expect(switchState('settings.mfaSms')).toBe('true');
  });

  it('saves required MFA for the chosen roles', async () => {
    putMock.mockResolvedValue({ success: true });
    renderWith({
      mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false },
      roleNames: ROLE_NAMES,
    });
    const select = screen.getByLabelText('settings.mfaRequired');
    expect((select as HTMLSelectElement).value).toBe('off');
    fireEvent.change(select, { target: { value: 'roles' } });
    const admin = await screen.findByRole('checkbox', { name: 'admin' });
    fireEvent.click(admin);
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/security/mfa', {
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: false,
        required: 'roles',
        requiredRoles: ['admin'],
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        requireDrivers: false,
      });
    });
  });

  it('lists the roles from the security settings, without the roles endpoint', async () => {
    renderWith({
      mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false, required: 'roles' },
      roleNames: ROLE_NAMES,
    });
    expect(await screen.findByRole('checkbox', { name: 'admin' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'operator' })).toBeTruthy();
    expect(getMock).not.toHaveBeenCalledWith('/v1/roles');
  });

  it('keeps the stored roles when another mode is saved', async () => {
    putMock.mockResolvedValue({ success: true });
    renderWith({
      mfa: {
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: false,
        required: 'roles',
        requiredRoles: ['operator'],
      },
      roleNames: ROLE_NAMES,
    });
    fireEvent.change(screen.getByLabelText('settings.mfaRequired'), {
      target: { value: 'all' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/security/mfa', {
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: false,
        required: 'all',
        webauthnEnabled: true,
        passkeyLoginEnabled: false,
        requireDrivers: false,
      });
    });
  });

  it('asks for a role before it saves selected roles', () => {
    renderWith({ mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false } });
    fireEvent.change(screen.getByLabelText('settings.mfaRequired'), {
      target: { value: 'roles' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    expect(screen.getByText('settings.mfaRequiredRolesEmpty')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('refuses required MFA without email or authenticator app codes', () => {
    renderWith({
      mfa: { emailEnabled: false, totpEnabled: false, smsEnabled: true },
    });
    fireEvent.change(screen.getByLabelText('settings.mfaRequired'), {
      target: { value: 'all' },
    });
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    expect(screen.getByText('settings.mfaRequiredNoMethod')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('shows passkeys on and passkey sign-in off when neither key is stored', () => {
    renderWith({ mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false } });
    expect(switchState('settings.mfaWebauthn')).toBe('true');
    expect(switchState('settings.mfaPasskeyLogin')).toBe('false');
    expect(screen.getByText('settings.mfaPasskeyLoginDescription')).toBeTruthy();
  });

  it('saves passkey sign-in with passkeys on', async () => {
    putMock.mockResolvedValue({ success: true });
    renderWith({ mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false } });
    fireEvent.click(screen.getByRole('switch', { name: 'settings.mfaPasskeyLogin' }));
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/security/mfa', {
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: false,
        required: 'off',
        webauthnEnabled: true,
        passkeyLoginEnabled: true,
        requireDrivers: false,
      });
    });
  });

  it('turns passkey sign-in off and locks it while passkeys are off', async () => {
    putMock.mockResolvedValue({ success: true });
    renderWith({
      mfa: {
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: false,
        webauthnEnabled: true,
        passkeyLoginEnabled: true,
      },
    });
    expect(switchState('settings.mfaPasskeyLogin')).toBe('true');
    fireEvent.click(screen.getByRole('switch', { name: 'settings.mfaWebauthn' }));
    const login = screen.getByRole('switch', { name: 'settings.mfaPasskeyLogin' });
    expect(login.getAttribute('aria-checked')).toBe('false');
    expect(login.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('settings.mfaPasskeyLoginDisabledHint')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith(
        '/v1/security/mfa',
        expect.objectContaining({ webauthnEnabled: false, passkeyLoginEnabled: false }),
      );
    });
  });

  it('shows required MFA for drivers off by default and saves it on', async () => {
    putMock.mockResolvedValue({ success: true });
    renderWith({ mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false } });
    expect(switchState('settings.mfaRequireDrivers')).toBe('false');
    expect(screen.getByText('settings.mfaRequireDriversDescription')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'settings.mfaRequireDrivers' }));
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith(
        '/v1/security/mfa',
        expect.objectContaining({ requireDrivers: true }),
      );
    });
  });

  it('shows the stored driver rule', () => {
    renderWith({
      mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false, requireDrivers: true },
    });
    expect(switchState('settings.mfaRequireDrivers')).toBe('true');
  });

  it('refuses required MFA for drivers without email or authenticator app codes', () => {
    renderWith({
      mfa: { emailEnabled: false, totpEnabled: false, smsEnabled: true },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'settings.mfaRequireDrivers' }));
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    expect(screen.getByText('settings.mfaRequiredNoMethod')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('shows the stored required roles', async () => {
    renderWith({
      mfa: {
        emailEnabled: true,
        totpEnabled: true,
        smsEnabled: false,
        required: 'roles',
        requiredRoles: ['operator'],
      },
      roleNames: ROLE_NAMES,
    });
    const operator = await screen.findByRole<HTMLInputElement>('checkbox', { name: 'operator' });
    expect(operator.checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'admin' }).checked).toBe(false);
  });
  it('shows Unsaved changes after an edit, keeps Save off without one and shows Saved after a save', async () => {
    putMock.mockResolvedValue({ success: true });
    renderWith({ mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false } });
    const save = screen.getByRole('button', { name: /common.save/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('settings.unsavedChanges')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'settings.mfaTotp' }));
    expect(screen.getByText('settings.unsavedChanges')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /common.save/ }));
    await waitFor(() => {
      expect(screen.getByText('common.saved')).toBeTruthy();
    });
    expect(screen.queryByText('settings.unsavedChanges')).toBeNull();
  });

  it('labels every switch for its row', () => {
    renderWith({ mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false } });
    expect(screen.getByLabelText('settings.mfaTotp').getAttribute('role')).toBe('switch');
  });

  it('is read-only without the write permission', () => {
    renderWith(
      { mfa: { emailEnabled: true, totpEnabled: true, smsEnabled: false } },
      { canWrite: false },
    );
    expect(screen.queryByRole('button', { name: /common.save/ })).toBeNull();
    expect(screen.getByRole('switch', { name: 'settings.mfaTotp' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('shows the load error with Retry', () => {
    const onRetry = vi.fn();
    renderWith(undefined, { loadFailed: true, onRetry });
    expect(screen.getByText('common.loadError')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(onRetry).toHaveBeenCalled();
  });
});
