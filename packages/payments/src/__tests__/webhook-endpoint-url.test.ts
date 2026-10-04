// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { isSameWebhookUrl, partitionWebhookEndpoints } from '../webhook-endpoint-url.js';

const URL_A = 'https://csms.example.com/v1/webhooks/payments/stripe';

describe('isSameWebhookUrl', () => {
  it('matches the same origin and path', () => {
    expect(isSameWebhookUrl(URL_A, URL_A)).toBe(true);
    expect(
      isSameWebhookUrl('https://CSMS.example.com:443/v1/webhooks/payments/stripe', URL_A),
    ).toBe(true);
    expect(isSameWebhookUrl(`${URL_A}?x=1#y`, URL_A)).toBe(true);
  });

  it('does not match another host, port, scheme or path', () => {
    expect(isSameWebhookUrl('https://dev.example.com/v1/webhooks/payments/stripe', URL_A)).toBe(
      false,
    );
    expect(
      isSameWebhookUrl('https://csms.example.com:8443/v1/webhooks/payments/stripe', URL_A),
    ).toBe(false);
    expect(isSameWebhookUrl('http://csms.example.com/v1/webhooks/payments/stripe', URL_A)).toBe(
      false,
    );
    expect(isSameWebhookUrl('https://csms.example.com/v1/webhooks/payments/adyen', URL_A)).toBe(
      false,
    );
  });

  it('never matches a URL that does not parse', () => {
    expect(isSameWebhookUrl('not a url', 'not a url')).toBe(false);
    expect(isSameWebhookUrl('x', URL_A)).toBe(false);
  });
});

describe('partitionWebhookEndpoints', () => {
  it('splits the endpoints at the URL from the others, keeping their order', () => {
    const endpoints = [
      { id: '1', url: 'https://dev.example.com/v1/webhooks/payments/stripe' },
      { id: '2', url: URL_A },
      { id: '3', url: 'garbage' },
      { id: '4', url: URL_A },
    ];
    const { matching, other } = partitionWebhookEndpoints(endpoints, URL_A);
    expect(matching.map((e) => e.id)).toEqual(['2', '4']);
    expect(other.map((e) => e.id)).toEqual(['1', '3']);
  });
});
