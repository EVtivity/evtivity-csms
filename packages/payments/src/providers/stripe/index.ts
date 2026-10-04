// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Stripe from 'stripe';
import { platformFeeCents } from '@evtivity/lib';
import { captureHoldWithFee, chargeShortfallTopUp } from './charges.js';
import { stripeMinimumChargeCents } from './minimum-charge.js';
import type { StripeChargeClient } from './charges.js';
import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  PaymentOperationNotSupportedError,
  PaymentProviderUnavailableError,
  PaymentValidationError,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '../../errors.js';
import type { PaymentProviderFactory } from '../../registry.js';
import type {
  AuthorizeHoldInput,
  CaptureInput,
  CaptureResult,
  ChargeResult,
  CreatePayoutAccountInput,
  HoldResult,
  Idempotent,
  ImmediateChargeInput,
  MethodSetupSession,
  MethodSetupStep,
  ModificationResult,
  NormalizedPaymentEvent,
  PaymentProvider,
  PayoutAccountStatus,
  PaymentProviderClientConfig,
  ProviderCapabilities,
  ProviderPaymentState,
  RefundInput,
  RefundResult,
  SavedMethodDetails,
  ShortfallInput,
  StartMethodSetupInput,
  WebhookAck,
  WebhookEndpointInfo,
  WebhookRegistration,
  WebhookRegistrationInput,
} from '../../types.js';
import { acceptableLocalStatuses } from './status-map.js';
import { normalizeStripeEvent } from './webhooks.js';
import {
  listEvtivityWebhookEndpoints,
  registerStripeWebhookEndpoints,
} from './webhook-endpoints.js';
import {
  createStripeOnboardingLink,
  createStripePayoutAccount,
  getStripePayoutAccountStatus,
} from './payout-accounts.js';

export const STRIPE_PROVIDER_ID = 'stripe';

export const STRIPE_CAPABILITIES: ProviderCapabilities = {
  savedMethods: true,
  manualCapture: true,
  partialCapture: true,
  refunds: true,
  partialRefunds: true,
  webhooks: true,
  nativeMobileSheet: true,
  shortfall: 'top_up',
  modificationResults: 'sync',
  clientActions: true,
  stateLookup: true,
  marketplaceSplit: 'destination_charge',
  currencies: 'all',
  payoutOnboarding: 'hosted_link',
  webhookRegistration: true,
};

export interface StripeProviderOptions {
  client: Stripe;
  publishableKey: string;
  /** `stripe.webhookSecretEnc`, decrypted: the platform endpoint. Null until set. */
  webhookSecret: string | null;
  /** `stripe.connectWebhookSecretEnc`, decrypted: the Connect endpoint. Null until set. */
  connectWebhookSecret: string | null;
}

/** Stripe error types that mean Stripe or the network failed, not the card. */
const UNAVAILABLE_TYPES = new Set([
  'StripeConnectionError',
  'StripeAPIError',
  'StripeRateLimitError',
]);

function refId(ref: string | { id: string } | null | undefined): string | null {
  if (ref == null) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

/**
 * Card errors become PaymentDeclinedError and outages
 * PaymentProviderUnavailableError, both keeping Stripe's message (callers
 * store it as the failure reason). Anything else is rethrown as is.
 */
function translateError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const type = (err as { type?: unknown }).type;
  if (type === 'StripeCardError') {
    const e = err as { code?: string; decline_code?: string };
    return new PaymentDeclinedError(err.message, {
      code: e.decline_code ?? e.code ?? null,
      cause: err,
    });
  }
  if (typeof type === 'string' && UNAVAILABLE_TYPES.has(type)) {
    return new PaymentProviderUnavailableError(err.message, { cause: err });
  }
  return err;
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw translateError(err);
  }
}

function destination(
  params: { on_behalf_of?: string; transfer_data?: { destination: string } },
  accountId: string | null,
): void {
  if (accountId == null) return;
  params.on_behalf_of = accountId;
  params.transfer_data = { destination: accountId };
}

/**
 * Stripe behind the PaymentProvider interface. Every call sends the same
 * Stripe request as the code it replaced (the API `stripe.service.ts`, the
 * OCPP gate and capture, the guest start; pinned by the golden records):
 * manual-capture holds, a destination charge for a site with a connected
 * account, the platform fee set at capture and read from the intent's
 * destination, and Connect reversal flags on refunds. Results are synchronous.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly id = STRIPE_PROVIDER_ID;
  readonly capabilities = STRIPE_CAPABILITIES;
  readonly webhookPath = 'payments/stripe';

  private readonly stripe: Stripe;
  private readonly publishableKey: string;
  private readonly webhookSecrets: string[];

  constructor(options: StripeProviderOptions) {
    this.stripe = options.client;
    this.publishableKey = options.publishableKey;
    // Platform first: most events come from the platform endpoint.
    this.webhookSecrets = [options.webhookSecret, options.connectWebhookSecret].filter(
      (secret): secret is string => secret != null && secret !== '',
    );
  }

  clientConfig(): PaymentProviderClientConfig {
    return { provider: 'stripe', publishableKey: this.publishableKey };
  }

  async testConnection(): Promise<void> {
    await call(() => this.stripe.balance.retrieve());
  }

  async createCustomer(
    input: { email: string; name: string } & Idempotent,
  ): Promise<{ customerId: string }> {
    const customer = await call(() =>
      this.stripe.customers.create(
        { email: input.email, name: input.name },
        { idempotencyKey: input.idempotencyKey },
      ),
    );
    return { customerId: customer.id };
  }

  isUnknownCustomerError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /no such customer/i.test(message) || /resource_missing/i.test(message);
  }

  async startMethodSetup(input: StartMethodSetupInput): Promise<MethodSetupSession> {
    if (input.channel === 'native' && input.nativeSdkVersion == null) {
      throw new PaymentValidationError('The native channel needs the SDK Stripe API version');
    }
    const setupIntent = await call(() =>
      this.stripe.setupIntents.create({
        customer: input.customerId,
        allowed_payment_method_types: ['card'],
      }),
    );
    if (setupIntent.client_secret == null || setupIntent.client_secret === '') {
      throw new PaymentProviderUnavailableError(
        'Stripe returned a SetupIntent without a client secret',
      );
    }
    const session: MethodSetupSession = {
      provider: 'stripe',
      clientSecret: setupIntent.client_secret,
      customerId: input.customerId,
      publishableKey: this.publishableKey,
    };
    if (input.channel === 'native' && input.nativeSdkVersion != null) {
      // Short-lived key the native PaymentSheet uses to manage the customer's
      // cards; the API version must match the one the mobile SDK pins.
      const apiVersion = input.nativeSdkVersion;
      const key = await call(() =>
        this.stripe.ephemeralKeys.create({ customer: input.customerId }, { apiVersion }),
      );
      session.ephemeralKey = key.secret ?? '';
    }
    return session;
  }

  /** The client confirmed the SetupIntent with Stripe.js; payload is `{ paymentMethodId }`. */
  async submitMethodSetup(
    input: { customerId: string; payload: unknown } & Idempotent,
  ): Promise<MethodSetupStep> {
    const payload = input.payload as { paymentMethodId?: unknown } | null;
    const methodId = payload?.paymentMethodId;
    if (typeof methodId !== 'string' || methodId === '') {
      throw new PaymentValidationError('paymentMethodId is required');
    }
    const method = await this.verifyMethod({ methodId, customerId: input.customerId });
    return { status: 'saved', method };
  }

  continueMethodSetup(): Promise<MethodSetupStep> {
    // Stripe.js runs 3DS for a SetupIntent on the client.
    return Promise.reject(new PaymentOperationNotSupportedError(this.id, 'continueMethodSetup'));
  }

  async verifyMethod(input: { methodId: string; customerId: string }): Promise<SavedMethodDetails> {
    const pm = await call(() => this.stripe.paymentMethods.retrieve(input.methodId));
    if (refId(pm.customer) !== input.customerId) throw new PaymentMethodOwnershipError();
    return {
      methodId: pm.id,
      customerId: input.customerId,
      brand: pm.card?.brand ?? null,
      last4: pm.card?.last4 ?? null,
    };
  }

  async detachMethod(input: { customerId: string; methodId: string }): Promise<void> {
    await call(() => this.stripe.paymentMethods.detach(input.methodId));
  }

  /**
   * A saved card is charged off session when the merchant initiates
   * (`off_session: true`), as the portal start and the OCPP gate do today.
   * With the shopper present, and for a one-time method (guest checkout,
   * payload = Stripe PaymentMethod id), it uses automatic payment methods
   * without redirects: Stripe otherwise asks for a return_url when the
   * account enables redirect methods, and a 3DS step comes back as an action.
   */
  async authorizeHold(input: AuthorizeHoldInput): Promise<HoldResult> {
    const params: Stripe.PaymentIntentCreateParams = {
      amount: input.amountCents,
      currency: input.currency.toLowerCase(),
      capture_method: 'manual',
      confirm: true,
    };
    if (input.method.kind === 'saved') {
      params.customer = input.method.customerId;
      params.payment_method = input.method.methodId;
      if (input.initiator === 'merchant') {
        params.off_session = true;
      } else {
        params.automatic_payment_methods = { enabled: true, allow_redirects: 'never' };
      }
    } else {
      if (typeof input.method.payload !== 'string' || input.method.payload === '') {
        throw new PaymentValidationError('A one-time Stripe method is a PaymentMethod id');
      }
      params.payment_method = input.method.payload;
      params.automatic_payment_methods = { enabled: true, allow_redirects: 'never' };
    }
    if (input.receiptEmail != null) params.receipt_email = input.receiptEmail;
    if (input.description != null) params.description = input.description;
    if (input.metadata != null) params.metadata = input.metadata;
    // A destination charge. The platform fee is set at capture, on the net
    // amount actually charged.
    destination(params, input.payoutAccountId);

    const intent = await call(() =>
      this.stripe.paymentIntents.create(params, { idempotencyKey: input.idempotencyKey }),
    );
    return this.holdResult(intent);
  }

  /** Called after the client finished Stripe.js handleNextAction for the intent. */
  async continueHold(
    input: { paymentId: string | null; details: unknown } & Idempotent,
  ): Promise<HoldResult> {
    if (input.paymentId == null) throw new PaymentValidationError('paymentId is required');
    const paymentId = input.paymentId;
    const intent = await call(() => this.stripe.paymentIntents.retrieve(paymentId));
    return this.holdResult(intent);
  }

  private holdResult(intent: Stripe.PaymentIntent): HoldResult {
    if (intent.status === 'requires_action') {
      return {
        status: 'action_required',
        paymentId: intent.id,
        action: { provider: this.id, data: { clientSecret: intent.client_secret } },
      };
    }
    if (intent.status === 'requires_payment_method' || intent.status === 'canceled') {
      throw new PaymentDeclinedError(
        intent.last_payment_error?.message ?? `PaymentIntent ${intent.status}`,
        {
          code: intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? null,
        },
      );
    }
    return {
      status: 'authorized',
      paymentId: intent.id,
      authorizedCents: intent.amount_capturable > 0 ? intent.amount_capturable : intent.amount,
    };
  }

  /** captureHoldWithFee: the fee applies only when the intent has a destination. */
  async capture(input: CaptureInput): Promise<ModificationResult<CaptureResult>> {
    const { applicationFeeCents } = await call(() =>
      captureHoldWithFee(this.stripe as unknown as StripeChargeClient, {
        intentId: input.paymentId,
        amountCents: input.amountCents,
        taxRate: input.feeTax,
        platformFeePercent: input.platformFeePercent,
        idempotencyKey: input.idempotencyKey,
      }),
    );
    return { state: 'succeeded', capturedCents: input.amountCents, applicationFeeCents };
  }

  /** Stripe refuses a charge below its per-currency minimum (amount_too_small). */
  minimumChargeCents(currency: string): number | null {
    return stripeMinimumChargeCents(currency);
  }

  /** chargeShortfallTopUp: final minus captured on the original card and destination. */
  async chargeShortfall(input: ShortfallInput): Promise<ChargeResult> {
    const topUp = await call(() =>
      chargeShortfallTopUp(this.stripe as unknown as StripeChargeClient, {
        originalIntentId: input.originalPaymentId,
        capturedCents: input.capturedCents,
        finalCostCents: input.finalCostCents,
        currency: input.currency,
        taxRate: input.feeTax,
        platformFeePercent: input.platformFeePercent,
        description: input.description,
        idempotencyKey: input.idempotencyKey,
      }),
    );
    return {
      paymentId: topUp.id,
      amountCents: topUp.amountCents,
      applicationFeeCents: topUp.applicationFeeCents,
    };
  }

  /** An immediate off-session charge (reservation fees) with the fee on its net amount. */
  async chargeSavedMethod(input: ImmediateChargeInput): Promise<ChargeResult> {
    const params: Stripe.PaymentIntentCreateParams = {
      amount: input.grossCents,
      currency: input.currency.toLowerCase(),
      customer: input.customerId,
      payment_method: input.methodId,
      confirm: true,
      off_session: true,
      description: input.description,
      metadata: input.metadata,
    };
    let applicationFeeCents = 0;
    if (input.payoutAccountId != null) {
      destination(params, input.payoutAccountId);
      applicationFeeCents = platformFeeCents(
        input.grossCents,
        input.feeTaxRate,
        input.platformFeePercent,
      );
      if (applicationFeeCents > 0) params.application_fee_amount = applicationFeeCents;
    }
    const intent = await call(() =>
      this.stripe.paymentIntents.create(params, { idempotencyKey: input.idempotencyKey }),
    );
    if (intent.status === 'requires_action' || intent.status === 'requires_payment_method') {
      throw new PaymentDeclinedError(
        intent.last_payment_error?.message ?? `PaymentIntent ${intent.status}`,
        {
          code: intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? null,
        },
      );
    }
    return { paymentId: intent.id, amountCents: input.grossCents, applicationFeeCents };
  }

  async cancelHold(
    input: { paymentId: string | null; merchantReference: string } & Idempotent,
  ): Promise<ModificationResult<object>> {
    // Stripe cannot cancel by merchant reference: without an intent id there is no hold.
    if (input.paymentId == null) throw new PaymentValidationError('paymentId is required');
    const paymentId = input.paymentId;
    await call(() =>
      this.stripe.paymentIntents.cancel(paymentId, {}, { idempotencyKey: input.idempotencyKey }),
    );
    return { state: 'succeeded' };
  }

  /**
   * A refund on a destination charge reverses the transfer and refunds the
   * application fee (Stripe prorates both on a partial refund), so the
   * platform does not carry the connected account's share. The caller's
   * idempotency key is used as is (`refundKey` in `idempotency-keys.ts`).
   */
  async refund(input: RefundInput): Promise<ModificationResult<RefundResult>> {
    const intent = await call(() => this.stripe.paymentIntents.retrieve(input.paymentId));
    const params: Stripe.RefundCreateParams = { payment_intent: input.paymentId };
    if (input.amountCents != null) params.amount = input.amountCents;
    if (intent.transfer_data?.destination != null) params.reverse_transfer = true;
    if ((intent.application_fee_amount ?? 0) > 0) params.refund_application_fee = true;
    const refund = await call(() =>
      this.stripe.refunds.create(params, { idempotencyKey: input.idempotencyKey }),
    );
    return { state: 'succeeded', refundId: refund.id, amountCents: refund.amount };
  }

  /**
   * Events of the platform endpoint are signed with `stripe.webhookSecretEnc`
   * and those of the Connect endpoint with `stripe.connectWebhookSecretEnc`;
   * both arrive at the same route, so the signature is checked against each
   * secret. When none matches, the first failure is reported.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): NormalizedPaymentEvent[] {
    if (this.webhookSecrets.length === 0) throw new WebhookNotConfiguredError(this.id);
    const signature = headers['stripe-signature'];
    if (signature == null || signature === '') {
      throw new WebhookSignatureError('missing', 'Missing stripe-signature header');
    }
    let firstError: unknown = null;
    for (const secret of this.webhookSecrets) {
      let event: Stripe.Event;
      try {
        event = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
      } catch (err) {
        firstError ??= err;
        // Only a signature mismatch is worth the next secret; a malformed
        // header or body fails the same way with every secret.
        if ((err as { type?: unknown }).type === 'StripeSignatureVerificationError') continue;
        break;
      }
      return [normalizeStripeEvent(event)];
    }
    throw new WebhookSignatureError(
      'invalid',
      firstError instanceof Error ? firstError.message : 'Invalid signature',
      { cause: firstError },
    );
  }

  webhookAck(): WebhookAck {
    return { status: 200, contentType: 'application/json', body: '{"received":true}' };
  }

  /** The webhook endpoints EVtivity created in this Stripe account. */
  async listWebhooks(): Promise<WebhookEndpointInfo[]> {
    return call(() => listEvtivityWebhookEndpoints(this.stripe));
  }

  /** Creates (or with `replace`, replaces) the platform and Connect endpoints. */
  async registerWebhook(input: WebhookRegistrationInput): Promise<WebhookRegistration> {
    return call(() => registerStripeWebhookEndpoints(this.stripe, input));
  }

  /** A site host's connected account (Accounts v2, destination charges). */
  async createPayoutAccount(input: CreatePayoutAccountInput): Promise<{ accountId: string }> {
    return call(() => createStripePayoutAccount(this.stripe, input));
  }

  /** A Stripe-hosted onboarding link (single use, expires after minutes; never emailed). */
  async createPayoutOnboardingLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: Date }> {
    return call(() => createStripeOnboardingLink(this.stripe, input));
  }

  async getPayoutAccountStatus(accountId: string): Promise<PayoutAccountStatus> {
    return call(() => getStripePayoutAccountStatus(this.stripe, accountId));
  }

  async getPaymentState(paymentId: string): Promise<ProviderPaymentState> {
    const intent = await call(() => this.stripe.paymentIntents.retrieve(paymentId));
    return {
      providerStatus: intent.status,
      acceptableLocalStatuses: acceptableLocalStatuses(intent.status),
      // amount_received does not drop on refunds, so it compares to captured_amount_cents.
      capturedCents: intent.amount_received,
    };
  }
}

/**
 * Built from the decrypted settings. Null without a secret or publishable key
 * (payments not configured), as getStripeConfig treats it today. Retries 429s
 * and network errors 3 times with backoff, like every Stripe client in the repo.
 */
export const stripeProviderFactory: PaymentProviderFactory = {
  id: STRIPE_PROVIDER_ID,
  create(settings) {
    const { secretKey, publishableKey, webhookSecret, connectWebhookSecret } = settings.stripe;
    if (secretKey == null || publishableKey == null) return Promise.resolve(null);
    return Promise.resolve(
      new StripePaymentProvider({
        client: new Stripe(secretKey, { maxNetworkRetries: 3 }),
        publishableKey,
        webhookSecret,
        connectWebhookSecret,
      }),
    );
  },
};
