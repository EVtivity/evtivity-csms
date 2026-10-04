// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  PaymentProviderPermissionError,
  WebhookExistsError,
  WebhookSignatureError,
} from '../errors.js';
import type { WebhookEndpointInfo } from '../types.js';

describe('WebhookSignatureError', () => {
  it('is a signature failure unless the caller says it is a credential failure', () => {
    const signature = new WebhookSignatureError('invalid', 'bad signature');
    expect(signature).toMatchObject({
      name: 'WebhookSignatureError',
      reason: 'invalid',
      kind: 'signature',
      message: 'bad signature',
    });
    const auth = new WebhookSignatureError('missing', 'no credentials', { kind: 'auth' });
    expect(auth).toMatchObject({ reason: 'missing', kind: 'auth' });
  });

  it('keeps the cause', () => {
    const cause = new Error('root');
    expect(new WebhookSignatureError('invalid', 'x', { cause }).cause).toBe(cause);
  });
});

describe('WebhookExistsError', () => {
  it('carries the endpoints that already exist', () => {
    const endpoints: WebhookEndpointInfo[] = [
      {
        id: 'we_1',
        url: 'https://api.example.com/v1/webhooks/payments/stripe',
        scope: 'platform',
        enabledEvents: ['charge.refunded'],
        apiVersion: '2026-09-30.endive',
        active: true,
      },
    ];
    const err = new WebhookExistsError('stripe', endpoints);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WebhookExistsError');
    expect(err.providerId).toBe('stripe');
    expect(err.endpoints).toEqual(endpoints);
    expect(err.message).toBe('An EVtivity webhook already exists for stripe');
  });
});

describe('PaymentProviderPermissionError', () => {
  it('names the permission the credential lacks', () => {
    const err = new PaymentProviderPermissionError('stripe', 'Webhook Endpoints: write');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PaymentProviderPermissionError');
    expect(err.providerId).toBe('stripe');
    expect(err.permission).toBe('Webhook Endpoints: write');
    expect(err.message).toBe(
      'The stripe credential lacks a required permission: Webhook Endpoints: write',
    );
  });
});
