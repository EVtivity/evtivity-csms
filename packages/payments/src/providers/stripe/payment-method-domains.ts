// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type Stripe from 'stripe';
import type { PaymentMethodDomainStatus, WalletDomainStatus } from '../../types.js';
import { request } from './webhook-endpoints.js';

type PaymentMethodDomainsClient = Pick<Stripe, 'paymentMethodDomains'>;

const READ_PERMISSION = 'Payment Method Domains: read';
const WRITE_PERMISSION = 'Payment Method Domains: write';

function wallet(
  method: Stripe.PaymentMethodDomain.ApplePay | Stripe.PaymentMethodDomain.GooglePay,
): WalletDomainStatus {
  return {
    status: method.status === 'active' ? 'active' : 'inactive',
    errorMessage: method.status_details?.error_message ?? null,
  };
}

function status(domain: Stripe.PaymentMethodDomain): PaymentMethodDomainStatus {
  return {
    id: domain.id,
    domain: domain.domain_name,
    enabled: domain.enabled,
    applePay: wallet(domain.apple_pay),
    googlePay: wallet(domain.google_pay),
  };
}

async function find(
  stripe: PaymentMethodDomainsClient,
  domain: string,
): Promise<Stripe.PaymentMethodDomain | null> {
  const page = await request(READ_PERMISSION, () =>
    stripe.paymentMethodDomains.list({ domain_name: domain, limit: 1 }),
  );
  return page.data[0] ?? null;
}

/** The platform account's registration of `domain`, null when it is not registered. */
export async function getStripePaymentMethodDomain(
  stripe: PaymentMethodDomainsClient,
  domain: string,
): Promise<PaymentMethodDomainStatus | null> {
  const found = await find(stripe, domain);
  return found == null ? null : status(found);
}

/**
 * Registers `domain` on the platform account, enables a disabled registration,
 * or has Stripe check an enabled one again. Only the platform: Stripe asks for
 * a registration per connected account for direct charges, and EVtivity's
 * payout holds are destination charges (on_behalf_of).
 */
export async function registerStripePaymentMethodDomain(
  stripe: PaymentMethodDomainsClient,
  domain: string,
): Promise<PaymentMethodDomainStatus> {
  const existing = await find(stripe, domain);
  if (existing == null) {
    return status(
      await request(WRITE_PERMISSION, () =>
        stripe.paymentMethodDomains.create({ domain_name: domain, enabled: true }),
      ),
    );
  }
  if (!existing.enabled) {
    return status(
      await request(WRITE_PERMISSION, () =>
        stripe.paymentMethodDomains.update(existing.id, { enabled: true }),
      ),
    );
  }
  return status(
    await request(WRITE_PERMISSION, () => stripe.paymentMethodDomains.validate(existing.id)),
  );
}
