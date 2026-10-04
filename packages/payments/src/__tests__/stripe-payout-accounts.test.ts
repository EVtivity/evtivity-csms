// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import { StripePaymentProvider } from '../providers/stripe/index.js';
import { payoutStatusFromAccount } from '../providers/stripe/payout-accounts.js';
import { PaymentProviderPermissionError, PaymentValidationError } from '../errors.js';
import {
  FAKE_LINK_EXPIRES_AT,
  FakeStripeError,
  fakeStripeModule,
  stripeRecorder,
} from '../testing/index.js';

function provider(): StripePaymentProvider {
  const FakeStripe = fakeStripeModule().default;
  return new StripePaymentProvider({
    client: new FakeStripe() as unknown as Stripe,
    publishableKey: 'pk_test_1',
    webhookSecret: null,
    connectWebhookSecret: null,
  });
}

type AccountFields = Partial<Omit<Stripe.Account, 'requirements'>> & {
  requirements?: Partial<Stripe.Account.Requirements>;
};

function account(fields: AccountFields = {}): Stripe.Account {
  const { requirements, ...rest } = fields;
  return {
    id: 'acct_1',
    object: 'account',
    capabilities: { card_payments: 'active', transfers: 'active' },
    details_submitted: true,
    ...rest,
    requirements: {
      currently_due: [],
      past_due: [],
      pending_verification: [],
      disabled_reason: null,
      ...requirements,
    },
  } as unknown as Stripe.Account;
}

beforeEach(() => {
  stripeRecorder.reset();
});

describe('Stripe payout accounts: createPayoutAccount', () => {
  it('creates an Accounts v2 account for destination charges with the idempotency key', async () => {
    const result = await provider().createPayoutAccount({
      displayName: 'Main Street Garage',
      contactEmail: 'host@example.com',
      country: 'US',
      metadata: { siteId: 'sit_1' },
      idempotencyKey: 'payout_account_sit_1_none',
    });

    expect(result).toEqual({ accountId: 'acct_payout_account_sit_1_none' });
    expect(stripeRecorder.calls).toEqual([
      {
        call: 'v2.core.accounts.create',
        args: [
          {
            display_name: 'Main Street Garage',
            contact_email: 'host@example.com',
            dashboard: 'express',
            identity: { country: 'us' },
            configuration: {
              merchant: { capabilities: { card_payments: { requested: true } } },
              recipient: {
                capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
              },
            },
            defaults: {
              responsibilities: { fees_collector: 'application', losses_collector: 'application' },
            },
            metadata: { siteId: 'sit_1' },
          },
        ],
        options: { idempotencyKey: 'payout_account_sit_1_none' },
      },
    ]);
  });

  it('always sends the contact email, which Stripe requires with the recipient configuration', async () => {
    await provider().createPayoutAccount({
      displayName: 'Site',
      contactEmail: 'owner@example.com',
      country: 'DE',
      metadata: {},
      idempotencyKey: 'payout_account_sit_2_none',
    });
    const params = stripeRecorder.calls[0]?.args[0] as Record<string, unknown>;
    expect(params['contact_email']).toBe('owner@example.com');
    expect(params['identity']).toEqual({ country: 'de' });
  });

  it('reports a request Stripe refuses with its message', async () => {
    stripeRecorder.callFailures.set('v2.core.accounts.create', [
      new FakeStripeError(
        'StripeInvalidRequestError',
        'Please review the responsibilities of managing losses for connected accounts.',
        { code: 'account_creation_liability_unacknowledged', statusCode: 400 },
      ),
    ]);
    await expect(
      provider().createPayoutAccount({
        displayName: 'Site',
        contactEmail: 'host@example.com',
        country: 'US',
        metadata: {},
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(
      new PaymentValidationError(
        'Please review the responsibilities of managing losses for connected accounts.',
      ),
    );
  });

  it('maps a key without Connect access to PaymentProviderPermissionError', async () => {
    stripeRecorder.callFailures.set('v2.core.accounts.create', [
      new FakeStripeError('StripePermissionError', 'The provided key does not have access', {
        statusCode: 403,
      }),
    ]);
    const err = await provider()
      .createPayoutAccount({
        displayName: 'Site',
        contactEmail: 'host@example.com',
        country: 'US',
        metadata: {},
        idempotencyKey: 'k',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentProviderPermissionError);
    expect((err as PaymentProviderPermissionError).permission).toBe('Connect: write');
  });
});

describe('Stripe payout accounts: createPayoutOnboardingLink', () => {
  it('creates an Accounts v2 onboarding link with the refresh and return URLs', async () => {
    stripeRecorder.seedPayoutAccount('acct_1');
    const link = await provider().createPayoutOnboardingLink({
      accountId: 'acct_1',
      refreshUrl: 'https://portal.example.com/payout-onboarding?token=t',
      returnUrl: 'https://portal.example.com/payout-onboarding/return?token=t',
    });

    expect(link.url).toMatch(/^https:\/\/connect\.stripe\.com\//);
    expect(link.expiresAt).toEqual(new Date(FAKE_LINK_EXPIRES_AT));
    expect(stripeRecorder.calls).toEqual([
      {
        call: 'v2.core.accountLinks.create',
        args: [
          {
            account: 'acct_1',
            use_case: {
              type: 'account_onboarding',
              account_onboarding: {
                refresh_url: 'https://portal.example.com/payout-onboarding?token=t',
                return_url: 'https://portal.example.com/payout-onboarding/return?token=t',
              },
            },
          },
        ],
      },
    ]);
  });

  it('reports an account the platform cannot access without echoing the key', async () => {
    const err = await provider()
      .createPayoutOnboardingLink({
        accountId: 'acct_unknown',
        refreshUrl: 'https://p/r',
        returnUrl: 'https://p/x',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentValidationError);
    expect((err as Error).message).toBe(
      'Stripe account acct_unknown does not exist or is not connected to this platform',
    );
  });
});

describe('Stripe payout accounts: getPayoutAccountStatus', () => {
  it('reads the account with v1 accounts.retrieve and maps it', async () => {
    stripeRecorder.seedPayoutAccount('acct_1');
    const status = await provider().getPayoutAccountStatus('acct_1');
    expect(status).toEqual({
      accountId: 'acct_1',
      state: 'active',
      capabilities: { card_payments: 'active', transfers: 'active' },
      detailsSubmitted: true,
      requirementsDue: [],
      disabledReason: null,
    });
    expect(stripeRecorder.calls).toEqual([{ call: 'accounts.retrieve', args: ['acct_1'] }]);
  });

  it('reports an unknown or foreign account as disabled (account_invalid)', async () => {
    const status = await provider().getPayoutAccountStatus('acct_unknown');
    expect(status).toEqual({
      accountId: 'acct_unknown',
      state: 'disabled',
      capabilities: { card_payments: 'unrequested', transfers: 'unrequested' },
      detailsSubmitted: false,
      requirementsDue: [],
      disabledReason: 'account_invalid',
    });
  });

  it('throws on other permission errors and outages', async () => {
    stripeRecorder.seedPayoutAccount('acct_1');
    stripeRecorder.callFailures.set('accounts.retrieve', [
      new FakeStripeError('StripeConnectionError', 'Network down', { statusCode: 500 }),
    ]);
    await expect(provider().getPayoutAccountStatus('acct_1')).rejects.toThrow('Network down');
  });
});

describe('payoutStatusFromAccount', () => {
  it('is active when card_payments and transfers are active', () => {
    expect(payoutStatusFromAccount(account()).state).toBe('active');
  });

  it('stays active while a future requirement is due', () => {
    const status = payoutStatusFromAccount(
      account({ requirements: { currently_due: ['individual.id_number'] } }),
    );
    expect(status.state).toBe('active');
    expect(status.requirementsDue).toEqual(['individual.id_number']);
  });

  it('is disabled when Stripe rejected the account', () => {
    const status = payoutStatusFromAccount(
      account({
        capabilities: { card_payments: 'inactive', transfers: 'inactive' },
        requirements: { disabled_reason: 'rejected.fraud' },
      }),
    );
    expect(status).toMatchObject({ state: 'disabled', disabledReason: 'rejected.fraud' });
  });

  it('is onboarding before the details are submitted, even with requirements due', () => {
    const status = payoutStatusFromAccount(
      account({
        details_submitted: false,
        capabilities: { card_payments: 'inactive', transfers: 'inactive' },
        requirements: {
          currently_due: ['business_type', 'external_account'],
          past_due: ['business_type'],
          disabled_reason: 'requirements.past_due',
        },
      }),
    );
    expect(status).toMatchObject({
      state: 'onboarding',
      detailsSubmitted: false,
      requirementsDue: ['business_type', 'external_account'],
      disabledReason: 'requirements.past_due',
    });
  });

  it('is action_required when details are submitted and something is due', () => {
    const status = payoutStatusFromAccount(
      account({
        capabilities: { card_payments: 'inactive', transfers: 'active' },
        requirements: { past_due: ['external_account'] },
      }),
    );
    expect(status.state).toBe('action_required');
  });

  it('is pending when details are submitted, nothing is due and a capability is not active yet', () => {
    const status = payoutStatusFromAccount(
      account({
        capabilities: { card_payments: 'pending', transfers: 'active' },
        requirements: { pending_verification: ['individual.verification.document'] },
      }),
    );
    expect(status.state).toBe('pending');
  });

  it('names an unrequested capability', () => {
    const status = payoutStatusFromAccount(account({ capabilities: { card_payments: 'active' } }));
    expect(status.capabilities).toEqual({ card_payments: 'active', transfers: 'unrequested' });
    expect(status.state).toBe('pending');
  });

  it('sorts, dedupes and caps the requirements at 20', () => {
    const due = Array.from({ length: 30 }, (_, i) => `field_${String(i).padStart(2, '0')}`);
    const status = payoutStatusFromAccount(
      account({
        details_submitted: false,
        capabilities: {},
        requirements: { currently_due: [...due].reverse(), past_due: due.slice(0, 5) },
      }),
    );
    expect(status.requirementsDue).toEqual(due.slice(0, 20));
  });
});
