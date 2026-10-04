// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { partitionWebhookEndpoints } from '@evtivity/payments';

/** The path of a provider's webhook route, e.g. `/v1/webhooks/payments/stripe`. */
export function paymentWebhookPath(providerId: 'stripe' | 'adyen'): string {
  return `/v1/webhooks/payments/${providerId}`;
}

export type PaymentWebhookUrlCheck = { ok: true; url: string } | { ok: false; problem: string };

/**
 * Checks the webhook URL the operator sends when creating a provider webhook
 * (plan P3.5, owner decision O1 a): the CSMS shows the API URL plus the path
 * and lets the operator edit it for a tunnel. It must be an absolute https
 * URL whose path is exactly the provider's webhook path, without credentials,
 * query or fragment. Returns the normalized URL or the problem.
 */
export function checkPaymentWebhookUrl(
  raw: string,
  providerId: 'stripe' | 'adyen',
): PaymentWebhookUrlCheck {
  const path = paymentWebhookPath(providerId);
  if (!URL.canParse(raw)) return { ok: false, problem: 'Must be an absolute URL' };
  const url = new URL(raw);
  if (url.protocol !== 'https:') return { ok: false, problem: 'Must use https' };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, problem: 'Must not contain credentials' };
  }
  if (url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#')) {
    return { ok: false, problem: 'Must not contain a query or fragment' };
  }
  if (url.pathname !== path) return { ok: false, problem: `Path must be exactly ${path}` };
  return { ok: true, url: url.href };
}

/**
 * The provider's EVtivity webhooks as the setup routes return them: the ones
 * at this deployment's webhook URL (`endpoints`) and the ones of other
 * EVtivity deployments sharing the provider account (`otherEndpoints`).
 * Without a URL every EVtivity webhook is in `endpoints`.
 */
export function splitWebhookEndpoints<T extends { url: string }>(
  endpoints: T[],
  url: string | undefined,
): { endpoints: T[]; otherEndpoints: T[] } {
  if (url == null) return { endpoints, otherEndpoints: [] };
  const { matching, other } = partitionWebhookEndpoints(endpoints, url);
  return { endpoints: matching, otherEndpoints: other };
}
