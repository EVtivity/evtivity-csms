// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The provider refused the payment (card declined, insufficient funds, failed capture). */
export class PaymentDeclinedError extends Error {
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code?: string | null; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PaymentDeclinedError';
    this.code = options.code ?? null;
    this.retryable = options.retryable ?? false;
  }
}

/** The provider could not be reached or failed on its side (network, 5xx, rate limit). */
export class PaymentProviderUnavailableError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PaymentProviderUnavailableError';
  }
}

/** The provider is unknown, refused in this process, or has no credentials. */
export class PaymentProviderNotConfiguredError extends Error {
  readonly providerId: string;

  constructor(providerId: string, message?: string) {
    super(message ?? `Payment provider ${providerId} is not configured`);
    this.name = 'PaymentProviderNotConfiguredError';
    this.providerId = providerId;
  }
}

/** A method that does not belong to the customer it was presented for. */
export class PaymentMethodOwnershipError extends Error {
  constructor(message = 'Payment method does not belong to this customer') {
    super(message);
    this.name = 'PaymentMethodOwnershipError';
  }
}

/** Input the provider never accepts (an unknown test card, a malformed payload). */
export class PaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentValidationError';
  }
}

/** A call the provider does not support (see its capabilities). */
export class PaymentOperationNotSupportedError extends Error {
  constructor(providerId: string, operation: string) {
    super(`Payment provider ${providerId} does not support ${operation}`);
    this.name = 'PaymentOperationNotSupportedError';
  }
}

/** The provider has no webhook signing secret. */
export class WebhookNotConfiguredError extends Error {
  constructor(providerId: string) {
    super(`Webhook signing secret for ${providerId} is not configured`);
    this.name = 'WebhookNotConfiguredError';
  }
}

/** A webhook without a signature ('missing') or with a wrong one ('invalid'). */
export class WebhookSignatureError extends Error {
  readonly reason: 'missing' | 'invalid';

  constructor(reason: 'missing' | 'invalid', message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'WebhookSignatureError';
    this.reason = reason;
  }
}
