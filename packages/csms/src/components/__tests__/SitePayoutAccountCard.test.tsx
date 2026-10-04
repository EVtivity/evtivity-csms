// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, toastMock, permission, writeTextMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  toastMock: vi.fn(),
  permission: { canWrite: true },
  writeTextMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count != null ? `${key}:${String(options.count)}` : key,
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
    api: { get: getMock, post: postMock },
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
  formatDateTime: (value: string) => `date:${value}`,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { ApiError } from '@/lib/api';
import { SitePayoutAccountCard, type SitePayoutAccount } from '../settings/SitePayoutAccountCard';

function asInput(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error('not an input');
  return element;
}

const NONE: SitePayoutAccount = {
  accountId: null,
  status: null,
  details: null,
  checkedAt: null,
  invite: null,
};

const ONBOARDING: SitePayoutAccount = {
  accountId: 'acct_1',
  status: 'action_required',
  details: {
    capabilities: { card_payments: 'inactive', transfers: 'pending' },
    detailsSubmitted: true,
    requirementsDue: ['business_profile.mcc', 'external_account'],
    disabledReason: null,
  },
  checkedAt: '2026-10-03T10:00:00.000Z',
  invite: { expiresAt: '2026-10-10T10:00:00.000Z', sentTo: 'host@example.com', lastUsedAt: null },
};

const ACTIVE: SitePayoutAccount = {
  ...ONBOARDING,
  status: 'active',
  details: {
    capabilities: { card_payments: 'active', transfers: 'active' },
    detailsSubmitted: true,
    requirementsDue: [],
    disabledReason: null,
  },
  invite: null,
};

function mockGets(account: SitePayoutAccount, contactEmail: string | null = 'host@example.com') {
  getMock.mockImplementation((url: string) => {
    if (url === '/v1/sites/sit_1/payout-account') return Promise.resolve(account);
    if (url === '/v1/sites/sit_1') return Promise.resolve({ id: 'sit_1', contactEmail });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderCard(paymentsEnabled = false): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SitePayoutAccountCard siteId="sit_1" paymentsEnabled={paymentsEnabled} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock },
  });
  writeTextMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
  toastMock.mockReset();
  writeTextMock.mockReset();
  permission.canWrite = true;
});

describe('SitePayoutAccountCard', () => {
  it('creates the Stripe account with the contact email prefilled from the site', async () => {
    mockGets(NONE);
    postMock.mockResolvedValue({ ...ONBOARDING, status: 'onboarding', invite: null });
    renderCard();

    expect(await screen.findByText('payments.payoutAccountNone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /payments\.payoutAccountCreate/ }));
    const email = asInput(screen.getByLabelText('payments.payoutAccountContactEmail'));
    await waitFor(() => {
      expect(email.value).toBe('host@example.com');
    });
    fireEvent.change(email, { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('payments.payoutAccountCountry'), {
      target: { value: 'de' },
    });
    const confirm = screen.getAllByRole('button', { name: /payments\.payoutAccountCreate/ }).at(-1);
    if (confirm == null) throw new Error('confirm button not found');
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/sites/sit_1/payout-account', {
        contactEmail: 'owner@example.com',
        country: 'DE',
      });
    });
    expect(await screen.findByText('acct_1')).toBeTruthy();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'payments.payoutAccountCreated' }),
    );
  });

  it('requires a contact email before calling the API', async () => {
    mockGets(NONE, null);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /payments\.payoutAccountCreate/ }));
    const confirm = screen.getAllByRole('button', { name: /payments\.payoutAccountCreate/ }).at(-1);
    if (confirm == null) throw new Error('confirm button not found');
    fireEvent.click(confirm);
    expect(await screen.findByText('validation.required')).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('shows the 409 PAYOUT_ACCOUNT_EXISTS error and reloads the account', async () => {
    mockGets(NONE);
    postMock.mockRejectedValue(
      new ApiError(409, { code: 'PAYOUT_ACCOUNT_EXISTS', error: 'exists', accountId: 'acct_x' }),
    );
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /payments\.payoutAccountCreate/ }));
    await waitFor(() => {
      expect(asInput(screen.getByLabelText('payments.payoutAccountContactEmail')).value).toBe(
        'host@example.com',
      );
    });
    const confirm = screen.getAllByRole('button', { name: /payments\.payoutAccountCreate/ }).at(-1);
    if (confirm == null) throw new Error('confirm button not found');
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'payments.payoutAccountCreateFailed',
          variant: 'destructive',
        }),
      );
    });
    expect(
      getMock.mock.calls.filter((c) => c[0] === '/v1/sites/sit_1/payout-account'),
    ).toHaveLength(2);
  });

  it('shows the status, requirements count, capabilities and the open link', async () => {
    mockGets(ONBOARDING);
    renderCard();
    expect(await screen.findByText('payments.payoutAccountStatus.action_required')).toBeTruthy();
    expect(screen.getByText('payments.payoutAccountRequirementsDue:2')).toBeTruthy();
    expect(screen.getByText('business_profile.mcc')).toBeTruthy();
    expect(screen.getByText('card_payments')).toBeTruthy();
    expect(screen.getByText('payments.payoutCapability.pending')).toBeTruthy();
    expect(screen.getByText('payments.payoutAccountLastChecked')).toBeTruthy();
    expect(screen.getByText('payments.payoutAccountInviteOpen')).toBeTruthy();
  });

  it('warns when payments are enabled and the account is not active', async () => {
    mockGets(ONBOARDING);
    renderCard(true);
    expect(await screen.findByText('payments.payoutAccountNotActiveWarning')).toBeTruthy();
  });

  it('does not warn for an active account and hides the onboarding link actions', async () => {
    mockGets(ACTIVE);
    renderCard(true);
    expect(await screen.findByText('payments.payoutAccountStatus.active')).toBeTruthy();
    expect(screen.queryByText('payments.payoutAccountNotActiveWarning')).toBeNull();
    expect(screen.queryByRole('button', { name: /payments\.payoutAccountCopyLink/ })).toBeNull();
    expect(screen.getByRole('button', { name: /payments\.payoutAccountRefresh/ })).toBeTruthy();
  });

  it('copies a new onboarding link', async () => {
    mockGets(ONBOARDING);
    postMock.mockResolvedValue({
      url: 'https://portal.test/payout-onboarding?token=t1',
      expiresAt: '2026-10-10T10:00:00.000Z',
      sentTo: null,
    });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /payments\.payoutAccountCopyLink/ }));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('https://portal.test/payout-onboarding?token=t1');
    });
    expect(postMock).toHaveBeenCalledWith('/v1/sites/sit_1/payout-account/invite', {
      send: 'none',
    });
  });

  it('shows the link to copy by hand when the clipboard refuses the write', async () => {
    mockGets(ONBOARDING);
    writeTextMock.mockRejectedValue(new Error('NotAllowedError'));
    postMock.mockResolvedValue({
      url: 'https://portal.test/payout-onboarding?token=t2',
      expiresAt: '2026-10-10T10:00:00.000Z',
      sentTo: null,
    });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /payments\.payoutAccountCopyLink/ }));
    const input = asInput(await screen.findByLabelText('payments.payoutAccountManualCopy'));
    expect(input.value).toBe('https://portal.test/payout-onboarding?token=t2');
  });

  it('emails the link to the site contact after confirmation', async () => {
    mockGets(ONBOARDING);
    postMock.mockResolvedValue({
      url: 'https://portal.test/payout-onboarding?token=t3',
      expiresAt: '2026-10-10T10:00:00.000Z',
      sentTo: 'host@example.com',
    });
    renderCard();
    const emailButton = await screen.findByRole('button', {
      name: /payments\.payoutAccountEmailContact/,
    });
    await waitFor(() => {
      expect((emailButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(emailButton);
    fireEvent.click(screen.getByRole('button', { name: /payments\.payoutAccountEmailSend/ }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/sites/sit_1/payout-account/invite', {
        send: 'email',
      });
    });
  });

  it('disables Email site contact when the site has no contact email', async () => {
    mockGets(ONBOARDING, null);
    renderCard();
    const emailButton = await screen.findByRole('button', {
      name: /payments\.payoutAccountEmailContact/,
    });
    expect((emailButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('refreshes the status from Stripe', async () => {
    mockGets(ONBOARDING);
    postMock.mockResolvedValue(ACTIVE);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /payments\.payoutAccountRefresh/ }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/sites/sit_1/payout-account/refresh', {});
    });
    expect(await screen.findByText('payments.payoutAccountStatus.active')).toBeTruthy();
  });

  it('hides every write control without payments:write', async () => {
    permission.canWrite = false;
    mockGets(ONBOARDING);
    renderCard();
    expect(await screen.findByText('payments.payoutAccountStatus.action_required')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('hides the create button without payments:write', async () => {
    permission.canWrite = false;
    mockGets(NONE);
    renderCard();
    expect(await screen.findByText('payments.payoutAccountNone')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
