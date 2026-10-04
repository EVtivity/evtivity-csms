// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  checkPaymentWebhookLookupUrl,
  checkPaymentWebhookUrl,
  paymentWebhookPath,
} from '../lib/payment-webhook-url.js';

describe('checkPaymentWebhookUrl', () => {
  it('builds the provider path', () => {
    expect(paymentWebhookPath('stripe')).toBe('/v1/webhooks/payments/stripe');
    expect(paymentWebhookPath('adyen')).toBe('/v1/webhooks/payments/adyen');
  });

  it('accepts an https URL with the exact path and normalizes it', () => {
    expect(
      checkPaymentWebhookUrl('https://API.Example.com/v1/webhooks/payments/adyen', 'adyen'),
    ).toEqual({ ok: true, url: 'https://api.example.com/v1/webhooks/payments/adyen' });
    expect(
      checkPaymentWebhookUrl(
        'https://abc.trycloudflare.com:8443/v1/webhooks/payments/stripe',
        'stripe',
      ),
    ).toEqual({ ok: true, url: 'https://abc.trycloudflare.com:8443/v1/webhooks/payments/stripe' });
  });

  it.each([
    ['not a url', 'Must be an absolute URL'],
    ['/v1/webhooks/payments/stripe', 'Must be an absolute URL'],
    ['http://api.example.com/v1/webhooks/payments/stripe', 'Must use https'],
    ['https://u:p@api.example.com/v1/webhooks/payments/stripe', 'Must not contain credentials'],
    [
      'https://api.example.com/v1/webhooks/payments/stripe?',
      'Must not contain a query or fragment',
    ],
    [
      'https://api.example.com/v1/webhooks/payments/stripe#x',
      'Must not contain a query or fragment',
    ],
    [
      'https://api.example.com/v1/webhooks/stripe',
      'Path must be exactly /v1/webhooks/payments/stripe',
    ],
    [
      'https://api.example.com/v1/webhooks/payments/adyen',
      'Path must be exactly /v1/webhooks/payments/stripe',
    ],
  ])('refuses %s', (raw, problem) => {
    expect(checkPaymentWebhookUrl(raw, 'stripe')).toEqual({ ok: false, problem });
  });
});

describe('checkPaymentWebhookLookupUrl', () => {
  it('accepts http and https URLs with the exact path', () => {
    expect(
      checkPaymentWebhookLookupUrl('http://localhost:7100/v1/webhooks/payments/stripe', 'stripe'),
    ).toEqual({ ok: true, url: 'http://localhost:7100/v1/webhooks/payments/stripe' });
    expect(
      checkPaymentWebhookLookupUrl('https://api.example.com/v1/webhooks/payments/adyen', 'adyen'),
    ).toEqual({ ok: true, url: 'https://api.example.com/v1/webhooks/payments/adyen' });
  });

  it.each([
    ['ftp://api.example.com/v1/webhooks/payments/stripe', 'Must use http or https'],
    ['http://u:p@localhost/v1/webhooks/payments/stripe', 'Must not contain credentials'],
    ['http://localhost/v1/webhooks/payments/stripe?x=1', 'Must not contain a query or fragment'],
    [
      'http://localhost/v1/webhooks/payments/adyen',
      'Path must be exactly /v1/webhooks/payments/stripe',
    ],
  ])('refuses %s', (raw, problem) => {
    expect(checkPaymentWebhookLookupUrl(raw, 'stripe')).toEqual({ ok: false, problem });
  });
});
