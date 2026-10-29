// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Settings > Payment > Payment Terminals: the simulated status line, the ID
// TECH card (unverified notice, webhook URL, hidden secrets), the fresh proof
// for an account change, and Test Connection.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock, authState } = vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  return {
    apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
    authState: { permissions: [] as string[] },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && Object.keys(opts).length > 0 ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    useHasPermission: (perm: string) => authState.permissions.includes(perm),
  };
});
// The proof field has its own tests: here it hands back a password proof.
vi.mock('@/components/FactorProofField', () => ({
  FactorProofField: ({
    onChange,
    showMissing,
  }: {
    onChange: (proof: { kind: string; password: string }) => void;
    showMissing: boolean;
  }) => (
    <button
      type="button"
      data-testid="idtech-proof"
      data-missing={String(showMissing)}
      onClick={() => {
        onChange({ kind: 'password', password: 'pw' });
      }}
    >
      proof
    </button>
  ),
  proofRejection: () => ({ code: null }),
}));

import { PaymentTerminalSettings } from '../PaymentTerminalSettings';

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    simulatedAvailable: true,
    webhookPath: '/v1/webhooks/payment-terminals/idtech',
    idtech: {
      enabled: false,
      verified: false,
      environment: 'sandbox',
      merchantId: '',
      apiKey: null,
      apiKeyConfigured: false,
      apiSecret: null,
      apiSecretConfigured: false,
      webhookSecret: null,
      webhookSecretConfigured: false,
      ...overrides,
    },
  };
}

let data = settings();

function renderTab(): void {
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/v1/settings/payment-terminals') return Promise.resolve(data);
    if (url === '/v1/users/me/mfa') {
      return Promise.resolve({ factorProofKinds: ['password'], mfaMethod: null });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PaymentTerminalSettings />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  data = settings();
  authState.permissions = ['settings.payment:read', 'settings.payment:write'];
  apiMock.put.mockResolvedValue({ success: true });
  apiMock.post.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PaymentTerminalSettings', () => {
  it('shows the simulated status, the unverified notice and the webhook URL', async () => {
    renderTab();
    expect(await screen.findByTestId('terminal-simulated-status')).toBeDefined();
    expect(screen.getByText('paymentTerminals.settings.simulatedOn')).toBeDefined();
    expect(screen.getByTestId('idtech-unverified')).toBeDefined();
    expect(
      screen.getByText('https://api.example.com/v1/webhooks/payment-terminals/idtech'),
    ).toBeDefined();
  });

  it('shows no unverified notice once the contract is verified', async () => {
    data = settings({ verified: true });
    renderTab();
    await screen.findByTestId('terminal-simulated-status');
    expect(screen.queryByTestId('idtech-unverified')).toBeNull();
  });

  it('asks for the fresh proof when the merchant changes and sends it', async () => {
    renderTab();
    fireEvent.change(await screen.findByLabelText('paymentTerminals.settings.merchantId'), {
      target: { value: 'merchant_1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    const proof = await screen.findByTestId('idtech-proof');
    expect(proof.getAttribute('data-missing')).toBe('true');
    expect(apiMock.put).not.toHaveBeenCalled();
    fireEvent.click(proof);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/payment-terminals', {
        idtech: { merchantId: 'merchant_1' },
        proof: { kind: 'password', password: 'pw' },
      });
    });
  });

  it('refuses a merchant ID with other characters', async () => {
    renderTab();
    fireEvent.change(await screen.findByLabelText('paymentTerminals.settings.merchantId'), {
      target: { value: 'bad id!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText('paymentTerminals.settings.merchantIdInvalid')).toBeDefined();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('keeps a hidden stored secret when its field stays empty', async () => {
    data = settings({ merchantId: 'merchant_1', apiKeyConfigured: true });
    renderTab();
    fireEvent.change(await screen.findByLabelText('paymentTerminals.settings.apiSecret'), {
      target: { value: 'new-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    fireEvent.click(await screen.findByTestId('idtech-proof'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/payment-terminals', {
        idtech: { apiSecret: 'new-secret' },
        proof: { kind: 'password', password: 'pw' },
      });
    });
  });

  it('tests the stored connection of an enabled account', async () => {
    data = settings({ enabled: true, verified: true, merchantId: 'merchant_1' });
    apiMock.post.mockResolvedValue({ ok: false, reason: 'auth' });
    renderTab();
    fireEvent.click(
      await screen.findByRole('button', { name: 'paymentTerminals.settings.testConnection' }),
    );
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/v1/settings/payment-terminals/idtech/test', {});
    });
    expect(await screen.findByText(/paymentTerminals\.settings\.testRefused/)).toBeDefined();
  });

  it('is read-only without settings.payment:write', async () => {
    authState.permissions = ['settings.payment:read'];
    renderTab();
    const merchant = await screen.findByLabelText('paymentTerminals.settings.merchantId');
    expect((merchant as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });
});
