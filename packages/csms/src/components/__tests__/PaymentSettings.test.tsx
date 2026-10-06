// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, postMock, putMock, toastMock, permission } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  toastMock: vi.fn(),
  permission: { canWrite: true },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
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
vi.mock('@/hooks/use-company-currency', () => ({
  useCompanyCurrency: () => ({ currency: 'USD', isError: false, refetch: vi.fn() }),
}));
vi.mock('../settings/AdyenSettings', () => ({ AdyenSettings: () => <div>adyen-tab</div> }));
vi.mock('../settings/PaymentProviderSettings', () => ({
  PaymentProviderSettings: () => <div>general-tab</div>,
}));
vi.mock('../settings/SitePayoutAccountCard', () => ({
  SitePayoutAccountCard: ({ siteId }: { siteId: string }) => <div>payout-card:{siteId}</div>,
}));

import { ApiError } from '@/lib/api';
import { PaymentSettings } from '../settings/PaymentSettings';

function asInput(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error('not an input');
  return element;
}

// The tabs measure themselves; jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

const STRIPE_URL = 'https://api.example.com/v1/webhooks/payments/stripe';

const ENDPOINTS = [
  {
    id: 'we_1',
    url: STRIPE_URL,
    scope: 'platform',
    enabledEvents: ['charge.refunded'],
    apiVersion: '2026-09-30.endive',
    active: true,
  },
  {
    id: 'we_2',
    url: STRIPE_URL,
    scope: 'connect',
    enabledEvents: ['account.updated'],
    apiVersion: '2026-09-30.endive',
    active: true,
  },
];

const WEBHOOK_GET_PREFIX = '/v1/settings/stripe/webhook?url=';

/** GET /v1/settings/stripe for a user with settings.system:read (secrets returned). */
const STRIPE_SETTINGS_WITH_SECRETS = {
  publishableKey: 'pk_test_1',
  secretKey: 'sk_test_stored',
  secretKeyConfigured: true,
  webhookSecret: 'whsec_stored',
  webhookSecretConfigured: true,
  connectWebhookSecret: null,
  connectWebhookSecretConfigured: false,
};

/** The same settings for a user without settings.system:read (secrets withheld). */
const STRIPE_SETTINGS_HIDDEN = {
  ...STRIPE_SETTINGS_WITH_SECRETS,
  secretKey: null,
  webhookSecret: null,
};

let stripeSettings: Record<string, unknown> = STRIPE_SETTINGS_WITH_SECRETS;

function mockGets(
  webhook: (url: string) => Promise<unknown> = () => Promise.resolve(webhookSetup()),
): void {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/settings/stripe') return Promise.resolve(stripeSettings);
    if (url.startsWith(WEBHOOK_GET_PREFIX)) {
      return webhook(decodeURIComponent(url.slice(WEBHOOK_GET_PREFIX.length)));
    }
    if (url.startsWith('/v1/sites?')) {
      return Promise.resolve({ data: [{ id: 'sit_1', name: 'Main Street' }], total: 1 });
    }
    if (url === '/v1/sites/payment-configs') return Promise.resolve([]);
    if (url === '/v1/sites/sit_1/payment-config') {
      return Promise.resolve({
        id: 1,
        siteId: 'sit_1',
        payoutAccountId: 'acct_site_1',
        preAuthAmountCents: 5000,
        platformFeePercent: null,
        isEnabled: true,
      });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function webhookSetup(endpoints = ENDPOINTS): Record<string, unknown> {
  return {
    endpoints,
    platformSecretConfigured: true,
    connectSecretConfigured: false,
    events: {
      platform: ['payment_intent.payment_failed', 'charge.refunded', 'charge.dispute.created'],
      connect: ['account.updated'],
    },
    apiVersion: '2026-09-30.endive',
  };
}

function renderSettings(path = '/settings?sub=stripe'): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <PaymentSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function stripeForm(): Promise<HTMLFormElement> {
  const input = await screen.findByLabelText('settings.stripePublishableKey');
  const form = input.closest('form');
  if (form == null) throw new Error('form not found');
  return form;
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
  putMock.mockReset();
  toastMock.mockReset();
  permission.canWrite = true;
  stripeSettings = STRIPE_SETTINGS_WITH_SECRETS;
});

describe('PaymentSettings sub-tabs', () => {
  it('opens the General tab by default', async () => {
    mockGets();
    renderSettings('/settings');
    expect(await screen.findByText('general-tab')).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual([
      'paymentProviders.general.tab',
      'settings.paymentSubTabStripe',
      'settings.paymentSubTabAdyen',
      'settings.paymentSubTabSiteConfigs',
    ]);
  });

  it('has no pre-auth amount or platform fee on the Stripe tab', async () => {
    mockGets();
    putMock.mockResolvedValue({ success: true });
    renderSettings();
    const publishable = asInput(await screen.findByLabelText('settings.stripePublishableKey'));
    await waitFor(() => {
      expect(publishable.value).toBe('pk_test_1');
    });
    fireEvent.change(publishable, { target: { value: 'pk_test_2' } });
    expect(screen.queryByLabelText(/preAuth/i)).toBeNull();
    expect(screen.queryByLabelText(/platformFee/i)).toBeNull();
    fireEvent.submit(await stripeForm());

    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith('/v1/settings/stripe', { publishableKey: 'pk_test_2' });
    });
  });
});

describe('PaymentSettings Stripe tab', () => {
  it('prefills the webhook URL with the new path and lists the endpoints', async () => {
    mockGets();
    renderSettings();
    const url = asInput(await screen.findByLabelText('settings.stripeWebhookUrl'));
    expect(url.value).toBe(STRIPE_URL);
    expect(await screen.findByText('settings.webhookScopes.connect')).toBeTruthy();
    expect(screen.getByText('account.updated')).toBeTruthy();
    expect(screen.queryByTestId('other-webhook-endpoints')).toBeNull();
  });

  it('does not query the webhook setup before the Stripe secret key is configured', async () => {
    // A fresh install: the API would answer 400 PAYMENT_PROVIDER_NOT_CONFIGURED.
    stripeSettings = {
      ...STRIPE_SETTINGS_WITH_SECRETS,
      secretKey: null,
      secretKeyConfigured: false,
    };
    mockGets();
    renderSettings();
    expect(await screen.findByText('settings.stripeWebhookNotConfigured')).toBeTruthy();
    expect(getMock.mock.calls.some(([url]) => String(url).startsWith(WEBHOOK_GET_PREFIX))).toBe(
      false,
    );
  });

  it("lists other EVtivity deployments' endpoints apart", async () => {
    const otherUrl = 'https://dev.example.com/v1/webhooks/payments/stripe';
    mockGets(() =>
      Promise.resolve({
        ...webhookSetup([]),
        otherEndpoints: [{ ...ENDPOINTS[0], id: 'we_other', url: otherUrl }],
      }),
    );
    renderSettings();
    const other = await screen.findByTestId('other-webhook-endpoints');
    expect(other.textContent).toContain('settings.webhookOtherEndpoints');
    expect(other.textContent).toContain('settings.webhookOtherEndpointsHint');
    expect(other.textContent).toContain(otherUrl);
    expect(screen.getByText('settings.stripeWebhookNoEndpoints')).toBeTruthy();
  });

  it('opens the replace dialog on 409 and retries with replace: true', async () => {
    mockGets();
    postMock
      .mockRejectedValueOnce(
        new ApiError(409, { code: 'PAYMENT_WEBHOOK_EXISTS', endpoints: ENDPOINTS }),
      )
      .mockResolvedValueOnce({ endpoints: ENDPOINTS });
    renderSettings();
    await screen.findByLabelText('settings.stripeWebhookUrl');

    fireEvent.click(screen.getByRole('button', { name: /settings\.stripeWebhookCreate/ }));
    expect(await screen.findByText('settings.stripeWebhookReplaceBody')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /settings\.webhookReplaceConfirm/ }));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(2);
    });
    expect(postMock).toHaveBeenNthCalledWith(1, '/v1/settings/stripe/webhook', {
      url: STRIPE_URL,
      replace: false,
    });
    expect(postMock).toHaveBeenNthCalledWith(2, '/v1/settings/stripe/webhook', {
      url: STRIPE_URL,
      replace: true,
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'settings.stripeWebhookCreated' }),
      );
    });
  });

  it('sends the edited tunnel URL', async () => {
    mockGets();
    postMock.mockResolvedValue({ endpoints: ENDPOINTS });
    renderSettings();
    const url = await screen.findByLabelText('settings.stripeWebhookUrl');
    fireEvent.change(url, {
      target: { value: 'https://tunnel.trycloudflare.com/v1/webhooks/payments/stripe' },
    });
    fireEvent.click(screen.getByRole('button', { name: /settings\.stripeWebhookCreate/ }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/settings/stripe/webhook', {
        url: 'https://tunnel.trycloudflare.com/v1/webhooks/payments/stripe',
        replace: false,
      });
    });
  });

  describe('split by the URL in the field', () => {
    const TUNNEL_URL = 'https://tunnel.trycloudflare.com/v1/webhooks/payments/stripe';
    const TUNNEL_ENDPOINTS = ENDPOINTS.map((endpoint) => ({
      ...endpoint,
      id: `${endpoint.id}_tunnel`,
      url: TUNNEL_URL,
    }));

    function mockSplit(): void {
      mockGets((url) =>
        Promise.resolve(
          url === TUNNEL_URL
            ? { ...webhookSetup(TUNNEL_ENDPOINTS), otherEndpoints: ENDPOINTS }
            : { ...webhookSetup(ENDPOINTS), otherEndpoints: TUNNEL_ENDPOINTS },
        ),
      );
    }

    function webhookGets(url: string): number {
      const path = `${WEBHOOK_GET_PREFIX}${encodeURIComponent(url)}`;
      return getMock.mock.calls.filter(([called]) => called === path).length;
    }

    it('lists the webhooks at the edited URL as this deployment, after the typing pauses', async () => {
      mockSplit();
      renderSettings();
      const url = await screen.findByLabelText('settings.stripeWebhookUrl');
      const other = await screen.findByTestId('other-webhook-endpoints');
      expect(other.textContent).toContain(TUNNEL_URL);

      fireEvent.change(url, { target: { value: 'https://tunnel.trycloudflare.com' } });
      fireEvent.change(url, { target: { value: TUNNEL_URL } });
      // The last result stays on screen while the field changes.
      expect(webhookGets(TUNNEL_URL)).toBe(0);
      expect(screen.getByTestId('other-webhook-endpoints').textContent).toContain(TUNNEL_URL);

      await waitFor(
        () => {
          expect(screen.getByTestId('other-webhook-endpoints').textContent).toContain(STRIPE_URL);
        },
        { timeout: 2000 },
      );
      expect(screen.getByTestId('other-webhook-endpoints').textContent).not.toContain(TUNNEL_URL);
      expect(webhookGets(TUNNEL_URL)).toBe(1);
      // The partial value was never queried.
      expect(
        getMock.mock.calls.filter(([called]) =>
          String(called).endsWith(encodeURIComponent('https://tunnel.trycloudflare.com')),
        ),
      ).toHaveLength(0);
    });

    it('does not query an invalid URL and keeps the last list', async () => {
      mockSplit();
      renderSettings();
      const url = await screen.findByLabelText('settings.stripeWebhookUrl');
      await screen.findByTestId('other-webhook-endpoints');
      const callsBefore = getMock.mock.calls.length;
      for (const value of [
        `${TUNNEL_URL}?x=1`,
        'https://tunnel.trycloudflare.com/v1/webhooks/payments/adyen',
        'https://user:pass@tunnel.trycloudflare.com/v1/webhooks/payments/stripe',
        'ftp://tunnel.trycloudflare.com/v1/webhooks/payments/stripe',
      ]) {
        fireEvent.change(url, { target: { value } });
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(getMock.mock.calls.length).toBe(callsBefore);
      expect(screen.getByTestId('other-webhook-endpoints').textContent).toContain(TUNNEL_URL);
    });

    it('queries an http URL, which the lookup accepts, but Create still refuses it', async () => {
      const httpUrl = 'http://localhost:7102/v1/webhooks/payments/stripe';
      mockSplit();
      renderSettings();
      const url = await screen.findByLabelText('settings.stripeWebhookUrl');
      await screen.findByTestId('other-webhook-endpoints');
      fireEvent.change(url, { target: { value: httpUrl } });
      await waitFor(
        () => {
          expect(webhookGets(httpUrl)).toBe(1);
        },
        { timeout: 2000 },
      );
      fireEvent.click(screen.getByRole('button', { name: /settings\.stripeWebhookCreate/ }));
      expect(await screen.findByText('settings.webhookUrlInvalid')).toBeTruthy();
      expect(postMock).not.toHaveBeenCalled();
    });

    it('Create moves the list to the field URL at once, matching the replace dialog', async () => {
      mockSplit();
      postMock.mockRejectedValueOnce(
        new ApiError(409, {
          code: 'PAYMENT_WEBHOOK_EXISTS',
          endpoints: TUNNEL_ENDPOINTS,
          otherEndpoints: ENDPOINTS,
        }),
      );
      renderSettings();
      const url = await screen.findByLabelText('settings.stripeWebhookUrl');
      await screen.findByTestId('other-webhook-endpoints');
      fireEvent.change(url, { target: { value: TUNNEL_URL } });
      fireEvent.click(screen.getByRole('button', { name: /settings\.stripeWebhookCreate/ }));

      // No wait for the typing pause: the list follows the submitted URL now.
      await waitFor(
        () => {
          expect(webhookGets(TUNNEL_URL)).toBe(1);
        },
        { timeout: 300 },
      );
      expect(await screen.findByText('settings.stripeWebhookReplaceBody')).toBeTruthy();
      expect(postMock).toHaveBeenCalledWith('/v1/settings/stripe/webhook', {
        url: TUNNEL_URL,
        replace: false,
      });
      await waitFor(() => {
        expect(screen.getByTestId('other-webhook-endpoints').textContent).toContain(STRIPE_URL);
      });
    });
  });

  it('shows the provider message when Stripe refuses the registration', async () => {
    mockGets();
    postMock.mockRejectedValue(
      new ApiError(400, {
        code: 'PAYMENT_PROVIDER_PERMISSION_MISSING',
        permission: 'Webhook Endpoints: write',
      }),
    );
    renderSettings();
    await screen.findByLabelText('settings.stripeWebhookUrl');
    fireEvent.click(screen.getByRole('button', { name: /settings\.stripeWebhookCreate/ }));
    expect(await screen.findByText(/Webhook Endpoints: write/)).toBeTruthy();
  });

  it('asks for the secret key when Stripe is not configured', async () => {
    mockGets(() => Promise.reject(new ApiError(400, { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' })));
    renderSettings();
    expect(await screen.findByText('settings.stripeWebhookNotConfigured')).toBeTruthy();
  });

  it('shows the manual setup with the events, API version and stripe listen command', async () => {
    mockGets();
    renderSettings();
    await screen.findByText('settings.webhookScopes.connect');
    fireEvent.click(screen.getByRole('button', { name: 'settings.stripeWebhookManual' }));
    const manual = await screen.findByTestId('stripe-webhook-manual');
    expect(manual.textContent).toContain(
      `stripe listen --forward-to ${STRIPE_URL} --forward-connect-to ${STRIPE_URL}`,
    );
  });

  it('shows the stored secrets behind the eye toggle', async () => {
    mockGets();
    renderSettings();
    const secretKey = await screen.findByLabelText('settings.stripeSecretKey');
    if (!(secretKey instanceof HTMLInputElement)) throw new Error('not an input');
    await waitFor(() => {
      expect(secretKey.value).toBe('sk_test_stored');
    });
    expect(secretKey.type).toBe('password');
  });

  it('saves a changed Connect secret, clears an emptied secret, and omits unchanged ones', async () => {
    mockGets();
    putMock.mockResolvedValue({ success: true });
    renderSettings();
    const webhookSecret = await screen.findByLabelText('settings.stripeWebhookSecret');
    await waitFor(() => {
      expect((webhookSecret as HTMLInputElement).value).toBe('whsec_stored');
    });
    fireEvent.change(screen.getByLabelText('settings.stripeConnectWebhookSecret'), {
      target: { value: 'whsec_connect' },
    });
    fireEvent.change(webhookSecret, { target: { value: '' } });
    fireEvent.submit(await stripeForm());

    await waitFor(() => {
      expect(putMock).toHaveBeenCalledTimes(1);
    });
    const body = putMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).toMatchObject({ connectWebhookSecret: 'whsec_connect', webhookSecret: '' });
    expect(body).not.toHaveProperty('secretKey');
  });

  describe('without settings.system:read (secrets withheld by the API)', () => {
    async function hiddenSecretKey(): Promise<HTMLInputElement> {
      const input = asInput(await screen.findByLabelText('settings.stripeSecretKey'));
      await waitFor(() => {
        expect(input.placeholder).toBe('settings.secretStoredPlaceholder');
      });
      return input;
    }

    it('shows the stored state with an empty field', async () => {
      stripeSettings = STRIPE_SETTINGS_HIDDEN;
      mockGets();
      renderSettings();
      const secretKey = await hiddenSecretKey();
      expect(secretKey.value).toBe('');
      expect(asInput(screen.getByLabelText('settings.stripeWebhookSecret')).value).toBe('');
      // Two stored secrets are hidden; the unset Connect secret keeps its hint.
      expect(screen.getAllByText('settings.secretStoredHint')).toHaveLength(2);
      expect(screen.getByText('settings.stripeConnectWebhookSecretHint')).toBeTruthy();
      expect(screen.queryByText('settings.stripeSecretKeyHint')).toBeNull();
    });

    it('keeps a hidden secret when its field is left empty', async () => {
      stripeSettings = STRIPE_SETTINGS_HIDDEN;
      mockGets();
      putMock.mockResolvedValue({ success: true });
      renderSettings();
      await hiddenSecretKey();
      fireEvent.change(screen.getByLabelText('settings.stripePublishableKey'), {
        target: { value: 'pk_test_2' },
      });
      fireEvent.submit(await stripeForm());

      await waitFor(() => {
        expect(putMock).toHaveBeenCalledWith('/v1/settings/stripe', {
          publishableKey: 'pk_test_2',
        });
      });
    });

    it('replaces a hidden secret with a typed value', async () => {
      stripeSettings = STRIPE_SETTINGS_HIDDEN;
      mockGets();
      putMock.mockResolvedValue({ success: true });
      renderSettings();
      const secretKey = await hiddenSecretKey();
      fireEvent.change(secretKey, { target: { value: ' sk_test_new ' } });
      fireEvent.submit(await stripeForm());

      await waitFor(() => {
        expect(putMock).toHaveBeenCalledTimes(1);
      });
      const body = putMock.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(body).toMatchObject({ secretKey: 'sk_test_new' });
      expect(body).not.toHaveProperty('webhookSecret');
      expect(body).not.toHaveProperty('connectWebhookSecret');
    });

    it('clears a hidden secret only through Remove, and Keep it undoes the remove', async () => {
      stripeSettings = STRIPE_SETTINGS_HIDDEN;
      mockGets();
      putMock.mockResolvedValue({ success: true });
      renderSettings();
      const secretKey = await hiddenSecretKey();
      const [removeSecretKey, removeWebhookSecret] = screen.getAllByRole('button', {
        name: 'settings.secretRemove',
      });
      if (removeSecretKey == null || removeWebhookSecret == null) throw new Error('no remove');
      fireEvent.click(removeSecretKey);
      expect(secretKey.disabled).toBe(true);
      expect(screen.getByText('settings.secretRemovePending')).toBeTruthy();
      fireEvent.click(removeWebhookSecret);
      const undoWebhookSecret = screen.getAllByRole('button', {
        name: 'settings.secretRemoveUndo',
      })[1];
      if (undoWebhookSecret == null) throw new Error('no undo');
      fireEvent.click(undoWebhookSecret);
      fireEvent.submit(await stripeForm());

      await waitFor(() => {
        expect(putMock).toHaveBeenCalledTimes(1);
      });
      const body = putMock.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(body).toMatchObject({ secretKey: '' });
      expect(body).not.toHaveProperty('webhookSecret');
    });

    it('has no Remove without payments:write', async () => {
      stripeSettings = STRIPE_SETTINGS_HIDDEN;
      permission.canWrite = false;
      mockGets();
      renderSettings();
      await hiddenSecretKey();
      expect(screen.queryByRole('button', { name: 'settings.secretRemove' })).toBeNull();
    });
  });

  it('hides the write controls without payments:write', async () => {
    permission.canWrite = false;
    mockGets();
    renderSettings();
    await stripeForm();
    expect(screen.queryByRole('button', { name: /settings\.stripeWebhookCreate/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.stripeTestConnection' })).toBeNull();
    expect(screen.queryByRole('button', { name: /common\.save/ })).toBeNull();
  });

  it('has an Adyen tab', async () => {
    mockGets();
    renderSettings('/settings?sub=adyen');
    expect(await screen.findByText('adyen-tab')).toBeTruthy();
  });

  it('shows the payout account card for the selected site', async () => {
    mockGets();
    renderSettings('/settings?sub=siteConfigs');
    fireEvent.click(await screen.findByText('Main Street'));
    expect(await screen.findByText('payout-card:sit_1')).toBeTruthy();
  });

  it('reads and sends the site connected account as payoutAccountId', async () => {
    mockGets();
    putMock.mockResolvedValue({});
    renderSettings('/settings?sub=siteConfigs');
    fireEvent.click(await screen.findByText('Main Street'));
    const input = asInput(await screen.findByLabelText('payments.connectedAccountId'));
    await waitFor(() => {
      expect(input.value).toBe('acct_site_1');
    });

    fireEvent.change(input, { target: { value: 'acct_site_2' } });
    const form = input.closest('form');
    if (form == null) throw new Error('form not found');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith(
        '/v1/sites/sit_1/payment-config',
        expect.objectContaining({ payoutAccountId: 'acct_site_2' }),
      );
    });
    const body = putMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('stripeConnectedAccountId');
  });
});
