// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type Stripe from 'stripe';
import { PaymentProviderPermissionError, PaymentValidationError } from '../../errors.js';
import type {
  CreatePayoutAccountInput,
  PayoutAccountState,
  PayoutAccountStatus,
} from '../../types.js';

/**
 * Site host payout accounts on Stripe Connect (plan P3.5 Part C, spike C1).
 * Accounts are created with Accounts v2 for destination charges (Express
 * dashboard, the platform collects fees and carries losses), onboarded with
 * a v2 Account Link (Stripe-hosted, single use, 300 seconds), and read with
 * v1 `accounts.retrieve`, which reports `card_payments` and `transfers` for
 * v2 accounts and for v1 accounts an operator pastes.
 */

const PROVIDER_ID = 'stripe';

/** Most requirement names kept with a status (the CSMS shows the count and a list). */
const MAX_REQUIREMENTS = 20;

/** The capabilities a destination charge needs, under their v1 names. */
const REQUIRED_CAPABILITIES = ['card_payments', 'transfers'] as const;

type PayoutClient = Pick<Stripe, 'accounts'> & {
  v2: { core: Pick<Stripe['v2']['core'], 'accounts' | 'accountLinks'> };
};

function isAccountInvalid(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'account_invalid';
}

/**
 * An account the platform cannot reach becomes PaymentValidationError with
 * a message of our own (Stripe's names a masked key), any other permission
 * error PaymentProviderPermissionError, a request Stripe refuses (for
 * example the loss responsibilities not acknowledged on the platform
 * profile) PaymentValidationError with Stripe's message. Anything else is
 * rethrown for the provider's error translation.
 */
function translate(err: unknown, accountId: string | null, permission: string): unknown {
  const type = (err as { type?: unknown } | null)?.type;
  if (accountId != null && isAccountInvalid(err)) {
    return new PaymentValidationError(
      `Stripe account ${accountId} does not exist or is not connected to this platform`,
    );
  }
  if (type === 'StripePermissionError') {
    return new PaymentProviderPermissionError(PROVIDER_ID, permission, { cause: err });
  }
  if (type === 'StripeInvalidRequestError' && err instanceof Error) {
    return new PaymentValidationError(err.message);
  }
  return err;
}

async function request<T>(
  accountId: string | null,
  permission: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw translate(err, accountId, permission);
  }
}

export async function createStripePayoutAccount(
  stripe: PayoutClient,
  input: CreatePayoutAccountInput,
): Promise<{ accountId: string }> {
  const params: Stripe.V2.Core.AccountCreateParams = {
    display_name: input.displayName,
    contact_email: input.contactEmail,
    dashboard: 'express',
    identity: { country: input.country.toLowerCase() },
    configuration: {
      merchant: { capabilities: { card_payments: { requested: true } } },
      recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
    },
    defaults: {
      responsibilities: { fees_collector: 'application', losses_collector: 'application' },
    },
    metadata: input.metadata,
  };
  const account = await request(null, 'Connect: write', () =>
    stripe.v2.core.accounts.create(params, { idempotencyKey: input.idempotencyKey }),
  );
  return { accountId: account.id };
}

export async function createStripeOnboardingLink(
  stripe: PayoutClient,
  input: { accountId: string; refreshUrl: string; returnUrl: string },
): Promise<{ url: string; expiresAt: Date }> {
  const link = await request(input.accountId, 'Connect: write', () =>
    stripe.v2.core.accountLinks.create({
      account: input.accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: { refresh_url: input.refreshUrl, return_url: input.returnUrl },
      },
    }),
  );
  return { url: link.url, expiresAt: new Date(link.expires_at) };
}

function capabilityState(value: unknown): PayoutAccountStatus['capabilities'][string] {
  return value === 'active' || value === 'inactive' || value === 'pending' ? value : 'unrequested';
}

/**
 * The state of a v1 account read, in order: `disabled` when Stripe rejected
 * it, `active` when both capabilities are active (a future requirement does
 * not stop payments), `onboarding` until the details are submitted,
 * `action_required` while anything is due, else `pending` (Stripe is
 * verifying).
 */
export function payoutStatusFromAccount(account: Stripe.Account): PayoutAccountStatus {
  const capabilities: PayoutAccountStatus['capabilities'] = {};
  const stripeCapabilities = (account.capabilities ?? {}) as Record<string, unknown>;
  for (const name of REQUIRED_CAPABILITIES) {
    capabilities[name] = capabilityState(stripeCapabilities[name]);
  }
  const requirements = account.requirements;
  const requirementsDue = [
    ...new Set([...(requirements?.currently_due ?? []), ...(requirements?.past_due ?? [])]),
  ]
    .sort()
    .slice(0, MAX_REQUIREMENTS);
  const disabledReason = requirements?.disabled_reason ?? null;
  const detailsSubmitted = account.details_submitted;

  let state: PayoutAccountState;
  if (disabledReason?.startsWith('rejected') === true) state = 'disabled';
  else if (REQUIRED_CAPABILITIES.every((name) => capabilities[name] === 'active')) state = 'active';
  else if (!detailsSubmitted) state = 'onboarding';
  else if (requirementsDue.length > 0) state = 'action_required';
  else state = 'pending';

  return {
    accountId: account.id,
    state,
    capabilities,
    detailsSubmitted,
    requirementsDue,
    disabledReason,
  };
}

/**
 * The account's payout status. An account the platform cannot access (a
 * mistyped id, an account of another platform, a deleted one) is `disabled`
 * with the reason `account_invalid`, so it is stored and not read again on
 * every hold.
 */
export async function getStripePayoutAccountStatus(
  stripe: PayoutClient,
  accountId: string,
): Promise<PayoutAccountStatus> {
  let account: Stripe.Account;
  try {
    account = await stripe.accounts.retrieve(accountId);
  } catch (err) {
    if (isAccountInvalid(err)) {
      return {
        accountId,
        state: 'disabled',
        capabilities: { card_payments: 'unrequested', transfers: 'unrequested' },
        detailsSubmitted: false,
        requirementsDue: [],
        disabledReason: 'account_invalid',
      };
    }
    throw translate(err, null, 'Connect: read');
  }
  return payoutStatusFromAccount(account);
}
