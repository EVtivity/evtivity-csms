// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Payout onboarding contract test of StripePaymentProvider against real
// Stripe test mode (plan P3.5 Part F, task F1). Runs only when
// STRIPE_TEST_SECRET_KEY holds a test-mode key and
// STRIPE_TEST_CONNECTED_ACCOUNT an onboarded connected account (acct_) of
// that platform; skipped otherwise (CI has neither). The platform must have
// acknowledged the loss responsibilities on its Connect platform profile,
// or Stripe refuses the account create (C1 results).
//
// The test creates one Accounts v2 account and deletes it at the end. The
// existing connected account is only read. Never log or commit the key, an
// account id or an onboarding link.

import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';

vi.mock('@evtivity/database', () => ({ db: {}, settings: {}, sitePaymentConfigs: {} }));

import { StripePaymentProvider } from '../providers/stripe/index.js';

const secretKey = process.env['STRIPE_TEST_SECRET_KEY'] ?? '';
const connectedAccount = process.env['STRIPE_TEST_CONNECTED_ACCOUNT'] ?? '';
const enabled = /^(sk|rk)_test_/.test(secretKey) && /^acct_/.test(connectedAccount);

const METADATA_PURPOSE = 'evtivity-p3.5-payout-live-test';

describe.skipIf(!enabled)('Stripe payout onboarding against Stripe test mode', () => {
  const run = crypto.randomBytes(6).toString('hex');
  let client: Stripe;
  let provider: StripePaymentProvider;
  let accountId: string | null = null;

  beforeAll(() => {
    client = new Stripe(secretKey, { maxNetworkRetries: 3 });
    provider = new StripePaymentProvider({
      client,
      publishableKey: 'pk_test_unused',
      webhookSecret: null,
      connectWebhookSecret: null,
    });
  });

  afterAll(async () => {
    if (accountId == null) return;
    const deleted = await client.accounts.del(accountId);
    expect(deleted.deleted).toBe(true);
  }, 60_000);

  it('creates an account, mints an onboarding link and reads it as onboarding', async () => {
    const input = {
      displayName: `EVtivity payout live test ${run}`,
      contactEmail: 'payout-live-test@example.com',
      country: 'US',
      metadata: { purpose: METADATA_PURPOSE, run },
      idempotencyKey: `payout_account_live_${run}`,
    };
    const created = await provider.createPayoutAccount(input);
    accountId = created.accountId;
    expect(created.accountId).toMatch(/^acct_/);

    // A retry with the same idempotency key returns the same account.
    const retried = await provider.createPayoutAccount(input);
    expect(retried.accountId).toBe(created.accountId);

    // The account Stripe holds: Express dashboard, the platform collects
    // fees and carries losses, both capabilities requested.
    const v2 = await client.v2.core.accounts.retrieve(created.accountId, {
      include: ['configuration.merchant', 'configuration.recipient', 'defaults'],
    });
    expect(v2).toMatchObject({
      contact_email: input.contactEmail,
      dashboard: 'express',
      metadata: { purpose: METADATA_PURPOSE, run },
      defaults: {
        responsibilities: { fees_collector: 'application', losses_collector: 'application' },
      },
    });
    expect(v2.configuration?.merchant?.capabilities?.card_payments).toBeDefined();
    expect(
      v2.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers,
    ).toBeDefined();

    const before = Date.now();
    const link = await provider.createPayoutOnboardingLink({
      accountId: created.accountId,
      refreshUrl: `https://portal.example.com/payout-onboarding?token=live-test-${run}`,
      returnUrl: `https://portal.example.com/payout-onboarding/return?token=live-test-${run}`,
    });
    expect(new URL(link.url).protocol).toBe('https:');
    expect(link.expiresAt.getTime()).toBeGreaterThan(before);
    // Stripe-hosted links live for minutes, not days.
    expect(link.expiresAt.getTime() - before).toBeLessThan(60 * 60 * 1000);

    const status = await provider.getPayoutAccountStatus(created.accountId);
    expect(status).toMatchObject({
      accountId: created.accountId,
      state: 'onboarding',
      detailsSubmitted: false,
    });
    expect(status.capabilities['card_payments']).not.toBe('active');
    expect(status.capabilities['transfers']).not.toBe('active');
    expect(status.requirementsDue.length).toBeGreaterThan(0);
    expect(status.requirementsDue).toEqual([...status.requirementsDue].sort());
  }, 120_000);

  it('reads the onboarded connected account as active', async () => {
    const status = await provider.getPayoutAccountStatus(connectedAccount);
    expect(status).toMatchObject({
      accountId: connectedAccount,
      state: 'active',
      capabilities: { card_payments: 'active', transfers: 'active' },
      detailsSubmitted: true,
    });
  }, 60_000);

  it('reads an account the platform cannot access as disabled', async () => {
    const unknown = `acct_1EVtivity${run}`;
    const status = await provider.getPayoutAccountStatus(unknown);
    expect(status).toMatchObject({
      accountId: unknown,
      state: 'disabled',
      disabledReason: 'account_invalid',
    });
  }, 60_000);
});
