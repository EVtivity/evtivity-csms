// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, putMock, permission } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  permission: { canWrite: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null || Object.keys(opts).length === 0 ? key : `${key} ${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  const field = (err: unknown, key: string): unknown =>
    err instanceof ApiError && err.body != null
      ? (err.body as Record<string, unknown>)[key]
      : undefined;
  return {
    api: { get: getMock, put: putMock },
    ApiError,
    getApiErrorCode: (err: unknown) => {
      const code = field(err, 'code');
      return typeof code === 'string' ? code : null;
    },
    getApiErrorFieldDetails: (err: unknown) =>
      (field(err, 'details') as Record<string, string> | undefined) ?? {},
  };
});

vi.mock('@/lib/auth', () => ({
  useHasPermission: () => permission.canWrite,
  useAuth: () => null,
}));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => `at ${value}`,
}));
vi.mock('@/hooks/use-company-currency', () => ({
  useCompanyCurrency: () => ({ currency: 'EUR', isError: false, refetch: vi.fn() }),
}));

import { ApiError } from '@/lib/api';
import {
  PaymentProviderSettings,
  type PaymentProviderEntry,
  type PaymentSettingsResponse,
} from '../settings/PaymentProviderSettings';

const CAPS = {
  savedMethods: true,
  clientActions: true,
  nativeMobileSheet: false,
  marketplaceSplit: 'none',
};

const PENDING = {
  legacyConnections: 2,
  hosts: ['10.0.0.7'],
  lastLegacySeenAt: '2026-10-03T10:00:00.000Z',
  watchCheckedAt: '2026-10-03T10:01:00.000Z',
};

function entry(id: string, patch: Partial<PaymentProviderEntry> = {}): PaymentProviderEntry {
  return {
    id,
    configured: true,
    selectable: true,
    reason: null,
    upgradePending: null,
    capabilities: CAPS,
    ...patch,
  };
}

function settings(patch: Partial<PaymentSettingsResponse> = {}): PaymentSettingsResponse {
  return {
    provider: 'stripe',
    preAuthAmountCents: 5000,
    platformFeePercent: 2.5,
    simulated: { resultMode: 'sync', asyncDelaySeconds: 3, randomFailureRate: 0.2 },
    providers: [
      entry('stripe'),
      entry('adyen', { configured: false, selectable: false, reason: 'not_configured' }),
      entry('simulated'),
    ],
    ...patch,
  };
}

function renderSettings(data: PaymentSettingsResponse | Error = settings()): void {
  getMock.mockImplementation((url: string) => {
    if (url !== '/v1/settings/payments') return Promise.reject(new Error(`unexpected ${url}`));
    return data instanceof Error ? Promise.reject(data) : Promise.resolve(data);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PaymentProviderSettings />
    </QueryClientProvider>,
  );
}

async function providerSelect(): Promise<HTMLSelectElement> {
  const select = await screen.findByLabelText('paymentProviders.select.label');
  if (!(select instanceof HTMLSelectElement)) throw new Error('not a select');
  return select;
}

function inputValue(label: RegExp | string): string {
  const input = screen.getByLabelText(label);
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input');
  return input.value;
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  putMock.mockReset();
  permission.canWrite = true;
});

describe('PaymentProviderSettings', () => {
  it('lists none and the providers from the API, disabling unselectable ones with the reason', async () => {
    renderSettings();
    const select = await providerSelect();
    expect(select.value).toBe('stripe');
    const options = within(select).getAllByRole<HTMLOptionElement>('option');
    expect(options.map((o) => o.value)).toEqual(['none', 'stripe', 'adyen', 'simulated']);
    const adyen = options.find((o) => o.value === 'adyen');
    expect(adyen?.disabled).toBe(true);
    expect(adyen?.textContent).toContain('paymentProviders.reason.not_configured');
    expect(options.find((o) => o.value === 'simulated')?.disabled).toBe(false);
    expect(
      within(screen.getByTestId('provider-status-adyen')).getByText(
        'paymentProviders.status.not_configured',
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('provider-status-stripe')).getByText(
        'paymentProviders.status.selected',
      ),
    ).toBeTruthy();
  });

  it('prefills the amounts and the test provider settings', async () => {
    renderSettings();
    await providerSelect();
    expect(inputValue(/paymentProviders\.general\.preAuthAmount/)).toBe('50.00');
    expect(inputValue('paymentProviders.general.platformFee')).toBe('2.5');
    expect(inputValue('paymentProviders.simulated.asyncDelay')).toBe('3');
    expect(inputValue('paymentProviders.simulated.failureRate')).toBe('0.2');
    expect(screen.getByText('paymentProviders.simulated.testMode')).toBeTruthy();
    const async = screen.getByRole('option', {
      name: 'paymentProviders.simulated.resultModeAsync',
    });
    expect((async as HTMLOptionElement).disabled).toBe(false);
    expect(screen.getByText('paymentProviders.simulated.resultModeHint')).toBeTruthy();
  });

  it('selects the async result mode, explains it and sends it', async () => {
    putMock.mockResolvedValue({ success: true });
    renderSettings();
    await providerSelect();
    fireEvent.change(screen.getByLabelText('paymentProviders.simulated.resultMode'), {
      target: { value: 'async' },
    });
    expect(screen.getByText('paymentProviders.simulated.resultModeAsyncHint')).toBeTruthy();
    expect(screen.queryByText('paymentProviders.simulated.resultModeHint')).toBeNull();
    save();
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/payments', {
        simulated: { resultMode: 'async' },
      });
    });
  });

  it('prefills a stored async result mode with its hint', async () => {
    renderSettings(
      settings({
        simulated: { resultMode: 'async', asyncDelaySeconds: 3, randomFailureRate: 0.2 },
      }),
    );
    await providerSelect();
    const select = screen.getByLabelText('paymentProviders.simulated.resultMode');
    expect((select as HTMLSelectElement).value).toBe('async');
    expect(screen.getByText('paymentProviders.simulated.resultModeAsyncHint')).toBeTruthy();
  });

  it('hides the test provider card when the API does not list it', async () => {
    renderSettings(settings({ providers: [entry('stripe')] }));
    await providerSelect();
    expect(screen.queryByText('paymentProviders.simulated.title')).toBeNull();
  });

  it('warns when payments are off', async () => {
    renderSettings(settings({ provider: 'none' }));
    expect(await screen.findByText('paymentProviders.general.noneWarning')).toBeTruthy();
  });

  it('shows a stored provider this process does not list as unavailable', async () => {
    renderSettings(settings({ provider: 'simulated', providers: [entry('stripe')] }));
    const select = await providerSelect();
    expect(select.value).toBe('simulated');
    const option = within(select).getByRole('option', {
      name: /paymentProviders\.select\.unavailable/,
    });
    expect((option as HTMLOptionElement).disabled).toBe(true);
  });

  it('sends only the changed fields', async () => {
    putMock.mockResolvedValue({ success: true });
    renderSettings();
    fireEvent.change(await providerSelect(), { target: { value: 'simulated' } });
    fireEvent.change(screen.getByLabelText(/paymentProviders\.general\.preAuthAmount/), {
      target: { value: '75' },
    });
    fireEvent.change(screen.getByLabelText('paymentProviders.simulated.failureRate'), {
      target: { value: '0.5' },
    });
    save();
    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/payments', {
        provider: 'simulated',
        preAuthAmountCents: 7500,
        simulated: { randomFailureRate: 0.5 },
      });
    });
    expect(await screen.findByText('paymentProviders.general.saved')).toBeTruthy();
  });

  it('validates the amounts and the test provider settings before saving', async () => {
    renderSettings();
    await providerSelect();
    fireEvent.change(screen.getByLabelText(/paymentProviders\.general\.preAuthAmount/), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByLabelText('paymentProviders.general.platformFee'), {
      target: { value: '101' },
    });
    fireEvent.change(screen.getByLabelText('paymentProviders.simulated.asyncDelay'), {
      target: { value: '1.5' },
    });
    fireEvent.change(screen.getByLabelText('paymentProviders.simulated.failureRate'), {
      target: { value: '2' },
    });
    save();
    expect(await screen.findByText('validation.min {"min":"0.01"}')).toBeTruthy();
    expect(screen.getByText('validation.max {"max":100}')).toBeTruthy();
    expect(screen.getByText('validation.invalidNumber')).toBeTruthy();
    expect(screen.getByText('validation.max {"max":1}')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('shows the upgrade guard details of a provider the catalog refuses', async () => {
    renderSettings(
      settings({
        providers: [
          entry('stripe'),
          entry('adyen', {
            selectable: false,
            reason: 'requires_upgrade',
            upgradePending: PENDING,
          }),
        ],
      }),
    );
    const panel = await screen.findByTestId('upgrade-pending-adyen');
    expect(panel.textContent).toContain('paymentProviders.upgradePending.connections {"count":2}');
    expect(panel.textContent).toContain('10.0.0.7');
    expect(panel.textContent).toContain('at 2026-10-03T10:00:00.000Z');
    expect(panel.textContent).toContain('at 2026-10-03T10:01:00.000Z');
    const option = within(await providerSelect()).getByRole('option', {
      name: /paymentProviders\.reason\.requires_upgrade/,
    });
    expect((option as HTMLOptionElement).disabled).toBe(true);
  });

  it('says when the worker has not checked yet', async () => {
    renderSettings(
      settings({
        providers: [
          entry('adyen', {
            selectable: false,
            reason: 'requires_upgrade',
            upgradePending: { ...PENDING, legacyConnections: 0, hosts: [], watchCheckedAt: null },
          }),
        ],
      }),
    );
    const panel = await screen.findByTestId('upgrade-pending-adyen');
    expect(panel.textContent).toContain('paymentProviders.upgradePending.notChecked');
    expect(panel.textContent).not.toContain('paymentProviders.upgradePending.hosts');
  });

  it('shows the 409 upgrade-pending details when the save is refused', async () => {
    putMock.mockRejectedValue(
      new ApiError(409, {
        error: 'A process older than v0.1.38 is still connected.',
        code: 'PAYMENT_PROVIDER_UPGRADE_PENDING',
        details: PENDING,
      }),
    );
    renderSettings(settings({ providers: [entry('stripe'), entry('adyen')] }));
    fireEvent.change(await providerSelect(), { target: { value: 'adyen' } });
    save();
    const panel = await screen.findByTestId('upgrade-pending-adyen');
    expect(panel.textContent).toContain('paymentProviders.upgradePending.title');
    expect(panel.textContent).toContain('10.0.0.7');
    // The i18n mock has no translation, so the API message is shown.
    expect(screen.getByText('A process older than v0.1.38 is still connected.')).toBeTruthy();
  });

  it('marks the provider field when the API refuses the provider', async () => {
    putMock.mockRejectedValue(
      new ApiError(400, {
        error: 'Payment provider simulated is not available',
        code: 'VALIDATION_ERROR',
        details: { provider: 'Payment provider simulated is not available' },
      }),
    );
    renderSettings();
    fireEvent.change(await providerSelect(), { target: { value: 'simulated' } });
    save();
    expect(await screen.findByText('paymentProviders.select.refused')).toBeTruthy();
  });

  it('has no write controls without payments:write', async () => {
    permission.canWrite = false;
    renderSettings();
    expect((await providerSelect()).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /common\.save/ })).toBeNull();
    const fee = screen.getByLabelText('paymentProviders.general.platformFee');
    expect((fee as HTMLInputElement).disabled).toBe(true);
  });

  it('offers a retry when the settings cannot be loaded', async () => {
    renderSettings(new Error('down'));
    expect(await screen.findByText('paymentProviders.general.loadFailed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledTimes(2);
    });
  });
});
