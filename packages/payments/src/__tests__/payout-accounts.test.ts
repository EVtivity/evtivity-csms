// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PaymentContext } from '../context.js';
import type { PayoutAccountStatus } from '../types.js';

const m = vi.hoisted(() => ({
  countSitesWithPayoutAccount: vi.fn(),
  ensureSitePaymentConfig: vi.fn(),
  findSitePayoutAccount: vi.fn(),
  payoutAccountIds: vi.fn(),
  setPayoutAccountId: vi.fn(),
  storeCreatedPayoutAccount: vi.fn(),
  writePayoutAccountStatus: vi.fn(),
  clearPaymentSettingsCache: vi.fn(),
  getSitePaymentConfig: vi.fn(),
}));

vi.mock('../payout-account-records.js', () => ({
  countSitesWithPayoutAccount: m.countSitesWithPayoutAccount,
  ensureSitePaymentConfig: m.ensureSitePaymentConfig,
  findSitePayoutAccount: m.findSitePayoutAccount,
  payoutAccountIds: m.payoutAccountIds,
  setPayoutAccountId: m.setPayoutAccountId,
  storeCreatedPayoutAccount: m.storeCreatedPayoutAccount,
  writePayoutAccountStatus: m.writePayoutAccountStatus,
}));
vi.mock('../settings.js', () => ({
  clearPaymentSettingsCache: m.clearPaymentSettingsCache,
  getSitePaymentConfig: m.getSitePaymentConfig,
}));

import {
  createSitePayoutAccount,
  createSitePayoutOnboardingLink,
  refreshAllPayoutAccounts,
  refreshPayoutAccountById,
  refreshSitePayoutAccount,
  setSitePayoutAccountId,
  sitePayoutReadiness,
} from '../payout-accounts.js';
import { PaymentProviderNotConfiguredError } from '../errors.js';

const UPDATED_AT = new Date('2026-10-01T10:00:00.000Z');

function status(state: PayoutAccountStatus['state'], accountId = 'acct_1'): PayoutAccountStatus {
  const capability = state === 'active' ? 'active' : 'inactive';
  return {
    accountId,
    state,
    capabilities: { card_payments: capability, transfers: capability },
    detailsSubmitted: state !== 'onboarding',
    requirementsDue: [],
    disabledReason: null,
  };
}

const provider = {
  id: 'stripe',
  capabilities: { payoutOnboarding: 'hosted_link' },
  createPayoutAccount: vi.fn(),
  createPayoutOnboardingLink: vi.fn(),
  getPayoutAccountStatus: vi.fn(),
};
const getPaymentProvider = vi.fn();
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ctx = { registry: { getPaymentProvider }, logger } as unknown as PaymentContext;

function row(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configId: 7,
    siteId: 'sit_1',
    accountId: null,
    status: null,
    details: null,
    checkedAt: null,
    updatedAt: UPDATED_AT,
    ...fields,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getPaymentProvider.mockResolvedValue(provider);
  provider.capabilities.payoutOnboarding = 'hosted_link';
  m.writePayoutAccountStatus.mockResolvedValue(1);
});

describe('createSitePayoutAccount', () => {
  const input = { displayName: 'Main St', contactEmail: 'host@example.com', country: 'US' };

  it('creates the account with the Stripe provider and stores its id before reading it', async () => {
    m.findSitePayoutAccount.mockResolvedValueOnce(row());
    provider.createPayoutAccount.mockResolvedValueOnce({ accountId: 'acct_new' });
    m.storeCreatedPayoutAccount.mockResolvedValueOnce(true);
    provider.getPayoutAccountStatus.mockResolvedValueOnce(status('onboarding', 'acct_new'));

    const result = await createSitePayoutAccount('sit_1', input, ctx);

    expect(result).toEqual({ outcome: 'created', accountId: 'acct_new' });
    expect(getPaymentProvider).toHaveBeenCalledWith('stripe');
    expect(m.ensureSitePaymentConfig).toHaveBeenCalledWith('sit_1');
    expect(provider.createPayoutAccount).toHaveBeenCalledWith({
      displayName: 'Main St',
      contactEmail: 'host@example.com',
      country: 'US',
      metadata: { evtivity_site_id: 'sit_1' },
      idempotencyKey: `payout_account_sit_1_${String(UPDATED_AT.getTime())}`,
    });
    expect(m.storeCreatedPayoutAccount).toHaveBeenCalledWith('sit_1', 'acct_new');
    expect(m.writePayoutAccountStatus).toHaveBeenCalledWith(
      status('onboarding', 'acct_new'),
      expect.any(Date),
    );
    // Stored (P4) before the status read.
    const storeOrder = m.storeCreatedPayoutAccount.mock.invocationCallOrder[0] ?? 0;
    const readOrder = provider.getPayoutAccountStatus.mock.invocationCallOrder[0] ?? 0;
    expect(storeOrder).toBeLessThan(readOrder);
    expect(m.clearPaymentSettingsCache).toHaveBeenCalled();
  });

  it('returns the existing account without calling the provider', async () => {
    m.findSitePayoutAccount.mockResolvedValueOnce(row({ accountId: 'acct_old' }));
    const result = await createSitePayoutAccount('sit_1', input, ctx);
    expect(result).toEqual({ outcome: 'exists', accountId: 'acct_old' });
    expect(provider.createPayoutAccount).not.toHaveBeenCalled();
  });

  it('keeps the account a concurrent request stored first', async () => {
    m.findSitePayoutAccount
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ accountId: 'acct_first' }));
    provider.createPayoutAccount.mockResolvedValueOnce({ accountId: 'acct_second' });
    m.storeCreatedPayoutAccount.mockResolvedValueOnce(false);

    const result = await createSitePayoutAccount('sit_1', input, ctx);

    expect(result).toEqual({ outcome: 'exists', accountId: 'acct_first' });
    expect(provider.getPayoutAccountStatus).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('still reports the created account when the status read fails', async () => {
    m.findSitePayoutAccount.mockResolvedValueOnce(row());
    provider.createPayoutAccount.mockResolvedValueOnce({ accountId: 'acct_new' });
    m.storeCreatedPayoutAccount.mockResolvedValueOnce(true);
    provider.getPayoutAccountStatus.mockRejectedValueOnce(new Error('Stripe down'));

    const result = await createSitePayoutAccount('sit_1', input, ctx);

    expect(result).toEqual({ outcome: 'created', accountId: 'acct_new' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct_new' }),
      'Payout account status read failed after create',
    );
  });

  it('is not_supported when the payout provider cannot onboard accounts', async () => {
    provider.capabilities.payoutOnboarding = 'none';
    expect(await createSitePayoutAccount('sit_1', input, ctx)).toEqual({
      outcome: 'not_supported',
    });
    expect(m.ensureSitePaymentConfig).not.toHaveBeenCalled();
  });

  it('propagates a provider that is not configured', async () => {
    getPaymentProvider.mockRejectedValueOnce(new PaymentProviderNotConfiguredError('stripe'));
    await expect(createSitePayoutAccount('sit_1', input, ctx)).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredError,
    );
  });
});

describe('setSitePayoutAccountId', () => {
  it('stores a changed id and reads the account', async () => {
    m.setPayoutAccountId.mockResolvedValueOnce(true);
    provider.getPayoutAccountStatus.mockResolvedValueOnce(status('active', 'acct_2'));

    expect(await setSitePayoutAccountId('sit_1', ' acct_2 ', ctx)).toBe(true);

    expect(m.setPayoutAccountId).toHaveBeenCalledWith('sit_1', 'acct_2');
    expect(provider.getPayoutAccountStatus).toHaveBeenCalledWith('acct_2');
    expect(m.writePayoutAccountStatus).toHaveBeenCalledWith(
      status('active', 'acct_2'),
      expect.any(Date),
    );
  });

  it('clears the id with null or an empty string without a provider call', async () => {
    m.setPayoutAccountId.mockResolvedValue(true);
    expect(await setSitePayoutAccountId('sit_1', '', ctx)).toBe(true);
    expect(m.setPayoutAccountId).toHaveBeenCalledWith('sit_1', null);
    expect(provider.getPayoutAccountStatus).not.toHaveBeenCalled();
  });

  it('does nothing more when the id did not change', async () => {
    m.setPayoutAccountId.mockResolvedValueOnce(false);
    expect(await setSitePayoutAccountId('sit_1', 'acct_1', ctx)).toBe(false);
    expect(provider.getPayoutAccountStatus).not.toHaveBeenCalled();
    expect(m.clearPaymentSettingsCache).not.toHaveBeenCalled();
  });

  it('keeps the new id when the read fails (fail open, warn)', async () => {
    m.setPayoutAccountId.mockResolvedValueOnce(true);
    provider.getPayoutAccountStatus.mockRejectedValueOnce(new Error('Stripe down'));
    expect(await setSitePayoutAccountId('sit_1', 'acct_2', ctx)).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('refreshSitePayoutAccount', () => {
  it('reads and stores the status of the site account', async () => {
    m.findSitePayoutAccount.mockResolvedValueOnce(row({ accountId: 'acct_1' }));
    provider.getPayoutAccountStatus.mockResolvedValueOnce(status('pending'));
    expect(await refreshSitePayoutAccount('sit_1', ctx)).toEqual(status('pending'));
    expect(m.writePayoutAccountStatus).toHaveBeenCalledWith(status('pending'), expect.any(Date));
  });

  it('is null without an account', async () => {
    m.findSitePayoutAccount.mockResolvedValueOnce(row());
    expect(await refreshSitePayoutAccount('sit_1', ctx)).toBeNull();
    expect(provider.getPayoutAccountStatus).not.toHaveBeenCalled();
  });

  it('stamps the read with the time before the provider call', async () => {
    m.findSitePayoutAccount.mockResolvedValueOnce(row({ accountId: 'acct_1' }));
    let callTime = 0;
    provider.getPayoutAccountStatus.mockImplementationOnce(() => {
      callTime = Date.now();
      return Promise.resolve(status('active'));
    });
    await refreshSitePayoutAccount('sit_1', ctx);
    const checkedAt = m.writePayoutAccountStatus.mock.calls[0]?.[1] as Date;
    expect(checkedAt.getTime()).toBeLessThanOrEqual(callTime);
  });
});

describe('refreshPayoutAccountById', () => {
  it('skips an account no site uses without a provider call', async () => {
    m.countSitesWithPayoutAccount.mockResolvedValueOnce(0);
    expect(await refreshPayoutAccountById('acct_x', ctx)).toBe(0);
    expect(provider.getPayoutAccountStatus).not.toHaveBeenCalled();
  });

  it('refreshes every site config with the account', async () => {
    m.countSitesWithPayoutAccount.mockResolvedValueOnce(2);
    provider.getPayoutAccountStatus.mockResolvedValueOnce(status('active'));
    m.writePayoutAccountStatus.mockResolvedValueOnce(2);
    expect(await refreshPayoutAccountById('acct_1', ctx)).toBe(2);
  });
});

describe('refreshAllPayoutAccounts', () => {
  it('refreshes each account and continues after a failure', async () => {
    m.payoutAccountIds.mockResolvedValueOnce(['acct_1', 'acct_2', 'acct_3']);
    provider.getPayoutAccountStatus
      .mockResolvedValueOnce(status('active', 'acct_1'))
      .mockRejectedValueOnce(new Error('Stripe down'))
      .mockResolvedValueOnce(status('pending', 'acct_3'));

    expect(await refreshAllPayoutAccounts(ctx)).toEqual({ total: 3, refreshed: 2, failed: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct_2' }),
      'Payout account status sync failed',
    );
  });

  it('does not need the provider without accounts', async () => {
    m.payoutAccountIds.mockResolvedValueOnce([]);
    expect(await refreshAllPayoutAccounts(ctx)).toEqual({ total: 0, refreshed: 0, failed: 0 });
    expect(getPaymentProvider).not.toHaveBeenCalled();
  });
});

describe('sitePayoutReadiness', () => {
  function site(payoutAccountStatus: string | null, payoutAccountId: string | null = 'acct_1') {
    return { configId: 7, payoutAccountId, payoutAccountStatus, preAuthAmountCents: 5000 };
  }

  it('is none without an enabled config or without an account', async () => {
    m.getSitePaymentConfig.mockResolvedValueOnce(null);
    expect(await sitePayoutReadiness('sit_1', ctx)).toBe('none');
    m.getSitePaymentConfig.mockResolvedValueOnce(site(null, null));
    expect(await sitePayoutReadiness('sit_1', ctx)).toBe('none');
  });

  it('is ready for an active account without a provider call', async () => {
    m.getSitePaymentConfig.mockResolvedValueOnce(site('active'));
    expect(await sitePayoutReadiness('sit_1', ctx)).toBe('ready');
    expect(provider.getPayoutAccountStatus).not.toHaveBeenCalled();
  });

  it.each(['onboarding', 'action_required', 'pending', 'disabled'])(
    'is not_ready for a %s account',
    async (state) => {
      m.getSitePaymentConfig.mockResolvedValueOnce(site(state));
      expect(await sitePayoutReadiness('sit_1', ctx)).toBe('not_ready');
      expect(provider.getPayoutAccountStatus).not.toHaveBeenCalled();
    },
  );

  it('reads an account never read once and uses the result', async () => {
    m.getSitePaymentConfig.mockResolvedValueOnce(site(null));
    provider.getPayoutAccountStatus.mockResolvedValueOnce(status('active'));
    expect(await sitePayoutReadiness('sit_1', ctx)).toBe('ready');
    expect(m.writePayoutAccountStatus).toHaveBeenCalled();

    m.getSitePaymentConfig.mockResolvedValueOnce(site(null));
    provider.getPayoutAccountStatus.mockResolvedValueOnce(status('onboarding'));
    expect(await sitePayoutReadiness('sit_1', ctx)).toBe('not_ready');
  });

  it('fails closed when the read fails', async () => {
    m.getSitePaymentConfig.mockResolvedValueOnce(site(null));
    provider.getPayoutAccountStatus.mockRejectedValueOnce(new Error('Stripe down'));
    expect(await sitePayoutReadiness('sit_1', ctx)).toBe('not_ready');
    expect(logger.warn).toHaveBeenCalled();

    m.getSitePaymentConfig.mockResolvedValueOnce(site(null));
    getPaymentProvider.mockRejectedValueOnce(new PaymentProviderNotConfiguredError('stripe'));
    expect(await sitePayoutReadiness('sit_1', ctx)).toBe('not_ready');
  });
});

describe('createSitePayoutOnboardingLink', () => {
  const urls = { refreshUrl: 'https://p/r', returnUrl: 'https://p/x' };

  it('mints a provider link for the site account', async () => {
    m.findSitePayoutAccount.mockResolvedValueOnce(
      row({ accountId: 'acct_1', status: 'onboarding' }),
    );
    const expiresAt = new Date('2026-10-03T12:05:00Z');
    provider.createPayoutOnboardingLink.mockResolvedValueOnce({
      url: 'https://connect/x',
      expiresAt,
    });

    expect(await createSitePayoutOnboardingLink('sit_1', urls, ctx)).toEqual({
      outcome: 'link',
      url: 'https://connect/x',
      expiresAt,
    });
    expect(provider.createPayoutOnboardingLink).toHaveBeenCalledWith({
      accountId: 'acct_1',
      ...urls,
    });
  });

  it('answers active without a provider call for an active account', async () => {
    m.findSitePayoutAccount.mockResolvedValueOnce(row({ accountId: 'acct_1', status: 'active' }));
    expect(await createSitePayoutOnboardingLink('sit_1', urls, ctx)).toEqual({ outcome: 'active' });
    expect(provider.createPayoutOnboardingLink).not.toHaveBeenCalled();
  });

  it('answers no_account without an account', async () => {
    m.findSitePayoutAccount.mockResolvedValueOnce(null);
    expect(await createSitePayoutOnboardingLink('sit_1', urls, ctx)).toEqual({
      outcome: 'no_account',
    });
  });
});
