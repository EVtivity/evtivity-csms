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

/** GET /v1/settings/adyen for a user with settings.system:read (secrets returned). */
const SETTINGS_WITH_SECRETS: AdyenSettingsResponse = {
  merchantAccount: 'EVtivityECOM',
  environment: 'test',
  liveUrlPrefix: null,
  liveRegion: 'eu',
  clientKey: 'test_CLIENT',
  webhookUsername: 'evtivity-abc',
  authorisationAdjustment: false,
  apiKey: 'AQE_stored_key',
  apiKeyConfigured: true,
  hmacKey: 'ABCDEF0123',
  hmacKeyConfigured: true,
  hmacKeyPreviousConfigured: false,
  webhookPassword: null,
  webhookPasswordConfigured: false,
  webhookUrlPath: '/v1/webhooks/payments/adyen',
};

/** The same settings for a user without settings.system:read (secrets withheld). */
const SETTINGS_HIDDEN: AdyenSettingsResponse = {
  ...SETTINGS_WITH_SECRETS,
  apiKey: null,
  hmacKey: null,
};

let SETTINGS: AdyenSettingsResponse = SETTINGS_WITH_SECRETS;

const ENDPOINT = {
  id: 'WBHK1',
  url: 'https://api.example.com/v1/webhooks/payments/adyen',
  scope: 'standard',
  enabledEvents: ['AUTHORISATION'],
  apiVersion: null,
  active: true,
};

const WEBHOOK_GET_PREFIX = '/v1/settings/adyen/webhook?url=';

function mockGets(
  options: {
    providers?: unknown[];
    webhook?: (url: string) => Promise<unknown>;
  } = {},
): void {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/settings/adyen') return Promise.resolve(SETTINGS);
    if (url.startsWith(WEBHOOK_GET_PREFIX)) {
      return (
        options.webhook?.(decodeURIComponent(url.slice(WEBHOOK_GET_PREFIX.length))) ??
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
  SETTINGS = SETTINGS_WITH_SECRETS;
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

  it('does not query the webhook setup before the Adyen API key is configured', async () => {
    // A fresh install: the API would answer 400 PAYMENT_PROVIDER_NOT_CONFIGURED.
    SETTINGS = { ...SETTINGS_WITH_SECRETS, apiKey: null, apiKeyConfigured: false };
    mockGets();
    renderSettings();
    expect(await screen.findByText('settings.adyenWebhookNotConfigured')).toBeTruthy();
    expect(getMock.mock.calls.some(([url]) => String(url).startsWith(WEBHOOK_GET_PREFIX))).toBe(
      false,
    );
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

  describe('split by the URL in the field', () => {
    const TUNNEL_URL = 'https://tunnel.trycloudflare.com/v1/webhooks/payments/adyen';
    const TUNNEL_ENDPOINT = { ...ENDPOINT, id: 'WBHK_TUNNEL', url: TUNNEL_URL };

    function mockSplit(): void {
      mockGets({
        webhook: (url) =>
          Promise.resolve({
            endpoints: [url === TUNNEL_URL ? TUNNEL_ENDPOINT : ENDPOINT],
            otherEndpoints: [url === TUNNEL_URL ? ENDPOINT : TUNNEL_ENDPOINT],
            hmacKeyConfigured: true,
            webhookPasswordConfigured: true,
            events: ['AUTHORISATION'],
          }),
      });
    }

    function webhookGets(url: string): number {
      const path = `${WEBHOOK_GET_PREFIX}${encodeURIComponent(url)}`;
      return getMock.mock.calls.filter(([called]) => called === path).length;
    }

    it('lists the webhook at the edited URL as this deployment, after the typing pauses', async () => {
      mockSplit();
      renderSettings();
      await form();
      const other = await screen.findByTestId('other-webhook-endpoints');
      expect(other.textContent).toContain(TUNNEL_URL);

      fireEvent.change(screen.getByLabelText('settings.adyenWebhookUrl'), {
        target: { value: TUNNEL_URL },
      });
      expect(webhookGets(TUNNEL_URL)).toBe(0);
      expect(screen.getByTestId('other-webhook-endpoints').textContent).toContain(TUNNEL_URL);

      await waitFor(
        () => {
          expect(screen.getByTestId('other-webhook-endpoints').textContent).toContain(ENDPOINT.url);
        },
        { timeout: 2000 },
      );
      expect(screen.getByTestId('other-webhook-endpoints').textContent).not.toContain(TUNNEL_URL);
      expect(webhookGets(TUNNEL_URL)).toBe(1);
    });

    it('Create moves the list to the field URL at once, matching the update dialog', async () => {
      mockSplit();
      postMock.mockRejectedValueOnce(
        new ApiError(409, {
          code: 'PAYMENT_WEBHOOK_EXISTS',
          endpoints: [TUNNEL_ENDPOINT],
          otherEndpoints: [ENDPOINT],
        }),
      );
      renderSettings();
      await form();
      await screen.findByTestId('other-webhook-endpoints');
      fireEvent.change(screen.getByLabelText('settings.adyenWebhookUrl'), {
        target: { value: TUNNEL_URL },
      });
      fireEvent.click(screen.getByRole('button', { name: /settings\.stripeWebhookCreate/ }));

      await waitFor(
        () => {
          expect(webhookGets(TUNNEL_URL)).toBe(1);
        },
        { timeout: 300 },
      );
      expect(await screen.findByText('settings.adyenWebhookReplaceBody')).toBeTruthy();
      expect(postMock).toHaveBeenCalledWith('/v1/settings/adyen/webhook', {
        url: TUNNEL_URL,
        replace: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('other-webhook-endpoints').textContent).toContain(ENDPOINT.url);
      });
    });
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

  describe('without settings.system:read (secrets withheld by the API)', () => {
    async function hiddenApiKey(): Promise<HTMLInputElement> {
      const input = asInput(await screen.findByLabelText('settings.adyenApiKey'));
      expect(input.placeholder).toBe('settings.secretStoredPlaceholder');
      return input;
    }

    it('shows the stored state with empty fields', async () => {
      SETTINGS = SETTINGS_HIDDEN;
      mockGets();
      renderSettings();
      expect((await hiddenApiKey()).value).toBe('');
      expect(asInput(screen.getByLabelText('settings.adyenHmacKey')).value).toBe('');
      expect(screen.getAllByText('settings.secretStoredHint')).toHaveLength(2);
      expect(screen.queryByText('settings.adyenApiKeyHint')).toBeNull();
      // The unset webhook password keeps its normal hint and no placeholder.
      expect(asInput(screen.getByLabelText('settings.adyenWebhookPassword')).placeholder).toBe('');
    });

    it('keeps hidden secrets left empty, sends a typed one, and clears one through Remove', async () => {
      SETTINGS = SETTINGS_HIDDEN;
      mockGets();
      putMock.mockResolvedValue({ success: true });
      renderSettings();
      await hiddenApiKey();
      fireEvent.change(screen.getByLabelText('settings.adyenHmacKey'), {
        target: { value: '0123ABCD' },
      });
      const removeButtons = screen.getAllByRole('button', { name: 'settings.secretRemove' });
      expect(removeButtons).toHaveLength(2);
      const [removeApiKey] = removeButtons;
      if (removeApiKey == null) throw new Error('no remove');
      fireEvent.click(removeApiKey);
      fireEvent.submit(await form());

      await waitFor(() => {
        expect(putMock).toHaveBeenCalledTimes(1);
      });
      const body = putMock.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(body).toMatchObject({ hmacKey: '0123ABCD', apiKey: '' });
      expect(body).not.toHaveProperty('webhookPassword');
    });

    it('sends no secret when only plain fields change', async () => {
      SETTINGS = SETTINGS_HIDDEN;
      mockGets();
      putMock.mockResolvedValue({ success: true });
      renderSettings();
      await hiddenApiKey();
      fireEvent.change(screen.getByLabelText('settings.adyenMerchantAccount'), {
        target: { value: 'OtherECOM' },
      });
      fireEvent.submit(await form());

      await waitFor(() => {
        expect(putMock).toHaveBeenCalledTimes(1);
      });
      const body = putMock.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(body).toMatchObject({ merchantAccount: 'OtherECOM' });
      expect(body).not.toHaveProperty('apiKey');
      expect(body).not.toHaveProperty('hmacKey');
      expect(body).not.toHaveProperty('webhookPassword');
    });
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
