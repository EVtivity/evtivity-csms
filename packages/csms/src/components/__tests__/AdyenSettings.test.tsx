// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, putMock, toastMock, permission } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  toastMock: vi.fn(),
  permission: { canWrite: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { roles?: string; code?: string }) =>
      options?.roles != null
        ? `${key}:${options.roles}`
        : options?.code != null
          ? `${key}:${options.code}`
          : key,
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
    api: { get: getMock, post: postMock, put: putMock },
    ApiError,
    getApiErrorCode: (err: unknown) => {
      const code = field(err, 'code');
      return typeof code === 'string' ? code : null;
    },
    getApiErrorFieldDetails: (err: unknown) =>
      (field(err, 'details') as Record<string, string> | undefined) ?? {},
  };
});

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => permission.canWrite }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { ApiError } from '@/lib/api';
import { AdyenSettings, type AdyenSettingsResponse } from '../settings/AdyenSettings';

function asInput(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error('not an input');
  return element;
}

const SETTINGS: AdyenSettingsResponse = {
  merchantAccount: 'EVtivityECOM',
  environment: 'test',
  liveUrlPrefix: null,
  liveRegion: 'eu',
  clientKey: 'test_CLIENT',
  webhookUsername: 'evtivity-abc',
  authorisationAdjustment: false,
  apiKey: 'AQE_stored_key',
  hmacKey: 'ABCDEF0123',
  hmacKeyPreviousConfigured: false,
  webhookPassword: null,
  webhookUrlPath: '/v1/webhooks/payments/adyen',
};

const ENDPOINT = {
  id: 'WBHK1',
  url: 'https://api.example.com/v1/webhooks/payments/adyen',
  scope: 'standard',
  enabledEvents: ['AUTHORISATION'],
  apiVersion: null,
  active: true,
};

function mockGets(
  options: {
    providers?: unknown[];
    webhook?: () => Promise<unknown>;
  } = {},
): void {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/settings/adyen') return Promise.resolve(SETTINGS);
    if (url === `/v1/settings/adyen/webhook?url=${encodeURIComponent(ENDPOINT.url)}`) {
      return (
        options.webhook?.() ??
        Promise.resolve({
          endpoints: [],
          hmacKeyConfigured: true,
          webhookPasswordConfigured: false,
          events: ['AUTHORISATION'],
        })
      );
    }
    if (url === '/v1/settings/payments') {
      return Promise.resolve({
        providers: options.providers ?? [
          { id: 'adyen', configured: true, selectable: false, reason: 'requires_upgrade' },
        ],
      });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderSettings(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AdyenSettings />
    </QueryClientProvider>,
  );
}

async function form(): Promise<HTMLFormElement> {
  const input = await screen.findByLabelText('settings.adyenMerchantAccount');
  const element = input.closest('form');
  if (element == null) throw new Error('form not found');
  return element;
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
  putMock.mockReset();
  toastMock.mockReset();
  permission.canWrite = true;
});

describe('AdyenSettings', () => {
  it('shows the stored values with the secrets hidden behind the eye toggle', async () => {
    mockGets();
    renderSettings();
    expect(asInput(await screen.findByLabelText('settings.adyenMerchantAccount')).value).toBe(
      'EVtivityECOM',
    );
    const apiKey = asInput(screen.getByLabelText('settings.adyenApiKey'));
    expect(apiKey.value).toBe('AQE_stored_key');
    expect(apiKey.type).toBe('password');
    expect(asInput(screen.getByLabelText('settings.adyenHmacKey')).value).toBe('ABCDEF0123');
    expect(asInput(screen.getByLabelText('settings.adyenWebhookPassword')).value).toBe('');
  });

  it('says Adyen cannot be selected when the API reports requires_upgrade', async () => {
    mockGets();
    renderSettings();
    expect(await screen.findByText('settings.adyenNotSelectable')).toBeTruthy();
  });

  it('shows no availability line when the API lists Adyen as selectable', async () => {
    mockGets({
      providers: [{ id: 'adyen', configured: true, selectable: true, reason: null }],
    });
    renderSettings();
    await form();
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/v1/settings/payments');
    });
    expect(screen.queryByText('settings.adyenNotSelectable')).toBeNull();
    expect(screen.queryByText('settings.adyenNotConfiguredForPayments')).toBeNull();
  });

  it('sends a changed secret, an empty string for an emptied one, and omits unchanged ones', async () => {
    mockGets();
    putMock.mockResolvedValue({ success: true });
    renderSettings();
    await form();
    fireEvent.change(screen.getByLabelText('settings.adyenWebhookPassword'), {
      target: { value: 'new-password' },
    });
    fireEvent.change(screen.getByLabelText('settings.adyenHmacKey'), { target: { value: '' } });
    fireEvent.submit(await form());

    await waitFor(() => {
      expect(putMock).toHaveBeenCalledTimes(1);
    });
    const body = putMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).toMatchObject({
      merchantAccount: 'EVtivityECOM',
      environment: 'test',
      webhookPassword: 'new-password',
      hmacKey: '',
    });
    expect(body).not.toHaveProperty('apiKey');
  });

  it('requires the live URL prefix in live mode', async () => {
    mockGets();
    renderSettings();
    fireEvent.change(await screen.findByLabelText('settings.adyenEnvironment'), {
      target: { value: 'live' },
    });
    fireEvent.submit(await form());
    expect(await screen.findByText('validation.required')).toBeTruthy();
    expect(putMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('settings.adyenLiveRegion')).toBeTruthy();
  });

  it('shows the credential roles and warns when the webhook role is missing', async () => {
    mockGets();
    postMock.mockResolvedValue({
      success: true,
      roles: ['Checkout webservice role'],
      webhookRoleGranted: false,
    });
    renderSettings();
    await form();
    fireEvent.click(screen.getByRole('button', { name: 'settings.adyenTestConnection' }));
    expect(await screen.findByText('settings.adyenRoles:Checkout webservice role')).toBeTruthy();
    expect(screen.getByText('settings.adyenWebhookRoleMissing')).toBeTruthy();
    expect(postMock).toHaveBeenCalledWith('/v1/settings/adyen/test', {});
  });

  it('creates the webhook, confirms the replacement on 409 and shows the test result', async () => {
    mockGets();
    postMock
      .mockRejectedValueOnce(
        new ApiError(409, { code: 'PAYMENT_WEBHOOK_EXISTS', endpoints: [ENDPOINT] }),
      )
      .mockResolvedValueOnce({
        endpoints: [ENDPOINT],
        test: { status: 'success', responseCode: '200' },
      });
    renderSettings();
    await form();
    const url = asInput(screen.getByLabelText('settings.adyenWebhookUrl'));
    expect(url.value).toBe('https://api.example.com/v1/webhooks/payments/adyen');

    fireEvent.click(screen.getByRole('button', { name: /settings\.stripeWebhookCreate/ }));
    expect(await screen.findByText('settings.adyenWebhookReplaceBody')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /settings\.adyenWebhookUpdate/ }));

    expect(await screen.findByText('settings.adyenWebhookTestSuccess:200')).toBeTruthy();
    expect(postMock).toHaveBeenNthCalledWith(1, '/v1/settings/adyen/webhook', {
      url: 'https://api.example.com/v1/webhooks/payments/adyen',
      replace: false,
    });
    expect(postMock).toHaveBeenNthCalledWith(2, '/v1/settings/adyen/webhook', {
      url: 'https://api.example.com/v1/webhooks/payments/adyen',
      replace: true,
    });
  });

  it("lists other EVtivity deployments' webhooks apart", async () => {
    const otherUrl = 'https://dev.example.com/v1/webhooks/payments/adyen';
    mockGets({
      webhook: () =>
        Promise.resolve({
          endpoints: [ENDPOINT],
          otherEndpoints: [{ ...ENDPOINT, id: 'WBHK_OTHER', url: otherUrl }],
          hmacKeyConfigured: true,
          webhookPasswordConfigured: true,
          events: ['AUTHORISATION'],
        }),
    });
    renderSettings();
    const other = await screen.findByTestId('other-webhook-endpoints');
    expect(other.textContent).toContain('settings.webhookOtherEndpoints');
    expect(other.textContent).toContain(otherUrl);
  });

  it('refuses a webhook URL that is not https before calling the API', async () => {
    mockGets();
    renderSettings();
    await form();
    fireEvent.change(screen.getByLabelText('settings.adyenWebhookUrl'), {
      target: { value: 'http://localhost:7102/v1/webhooks/payments/adyen' },
    });
    fireEvent.click(screen.getByRole('button', { name: /settings\.stripeWebhookCreate/ }));
    expect(await screen.findByText('settings.webhookUrlInvalid')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('says to save the credentials when the webhook list answers not configured', async () => {
    mockGets({
      webhook: () => Promise.reject(new ApiError(400, { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' })),
    });
    renderSettings();
    expect(await screen.findByText('settings.adyenWebhookNotConfigured')).toBeTruthy();
  });

  it('hides the write controls without payments:write', async () => {
    permission.canWrite = false;
    mockGets();
    renderSettings();
    await form();
    expect(screen.queryByRole('button', { name: 'settings.adyenTestConnection' })).toBeNull();
    expect(screen.queryByRole('button', { name: /settings\.stripeWebhookCreate/ })).toBeNull();
    expect(asInput(screen.getByLabelText('settings.adyenMerchantAccount')).disabled).toBe(true);
    expect(asInput(screen.getByLabelText('settings.adyenApiKey')).disabled).toBe(true);
  });
});
