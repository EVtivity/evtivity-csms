// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ChargeTax } from '@evtivity/lib';
import type { paymentStatusEnum } from '@evtivity/database';

/** Registry key. 'stripe' and 'simulated' are built in; plugins add more. */
export type PaymentProviderId = string;

/** A local `payment_records.status` value. */
export type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number];

export interface ProviderCapabilities {
  /** Customers and off-session charges on saved methods. */
  savedMethods: boolean;
  /** Pre-authorization holds captured later. */
  manualCapture: boolean;
  partialCapture: boolean;
  refunds: boolean;
  partialRefunds: boolean;
  webhooks: boolean;
  nativeMobileSheet: boolean;
  /** How a final cost above the hold is charged: a second charge, or raising the hold. */
  shortfall: 'none' | 'top_up' | 'adjust_hold';
  /** Whether capture, cancel, refund and adjust report their outcome now or by webhook. */
  modificationResults: 'sync' | 'async';
  /** 3DS or redirect round trip on calls where the shopper is present. */
  clientActions: boolean;
  /** getPaymentState is available. */
  stateLookup: boolean;
  marketplaceSplit: 'none' | 'destination_charge' | 'split_instructions';
  currencies: readonly string[] | 'all';
  /** Site host payout account onboarding: a provider-hosted link, or none. */
  payoutOnboarding: 'hosted_link' | 'none';
  /** listWebhooks and registerWebhook are available. */
  webhookRegistration: boolean;
}

/** Public, browser-safe config returned to the portal, CSMS and mobile app. */
export type PaymentProviderClientConfig =
  | { provider: 'stripe'; publishableKey: string }
  | { provider: string; [key: string]: unknown };

/** Every mutating call takes an idempotency key derived from a domain id (P7). */
export interface Idempotent {
  idempotencyKey: string;
}

/** Opaque per-provider state persisted on the payment record. */
export type ProviderState = Record<string, string>;

/** Opaque client step (3DS action, simulated challenge) the frontend module interprets. */
export interface ClientAction {
  provider: PaymentProviderId;
  data: unknown;
}

export type ModificationResult<T extends object> =
  | ({ state: 'succeeded' } & T)
  | { state: 'pending'; operationRef: string };

/**
 * Where the shopper is during a shopper-present call (3D Secure). A web page
 * (portal, dashboard) sends its origin; the mobile app sends its platform and
 * the return URL its native SDK registered (plan P10 Part E).
 */
export type BrowserContext = WebBrowserContext | AppBrowserContext;

/** A browser page. `channel` defaults to web. */
export interface WebBrowserContext {
  channel?: 'web';
  origin: string;
  returnUrl: string;
  info?: unknown;
}

/** The native mobile app. */
export interface AppBrowserContext {
  channel: 'ios' | 'android';
  returnUrl: string;
  info?: unknown;
}

export type PaymentMethodInput =
  | {
      kind: 'saved';
      customerId: string;
      methodId: string;
      /** Shopper-present use of a saved method (Adyen needs it for 3DS; Stripe ignores it). */
      browser?: BrowserContext;
      /**
       * Shopper-present only: the stored-card component's `state.data`. Adyen
       * takes the CVC from it (`paymentMethod.encryptedSecurityCode`), which a
       * stored-card payment with the shopper present needs unless Adyen allows
       * it without CVC. Stripe ignores it.
       */
      payload?: unknown;
    }
  | { kind: 'one_time'; payload: unknown; browser?: BrowserContext };

export interface AuthorizeHoldInput extends Idempotent {
  method: PaymentMethodInput;
  /** 'merchant': off-session (OCPP gate). 'shopper': the driver is present. */
  initiator: 'merchant' | 'shopper';
  /** `sess_<sessionId>` or `guest_<token>`. */
  merchantReference: string;
  amountCents: number;
  currency: string;
  /** Hold-time payout destination (Stripe: connected account). */
  payoutAccountId: string | null;
  receiptEmail?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export type HoldResult =
  | {
      status: 'authorized';
      paymentId: string;
      authorizedCents: number;
      providerState?: ProviderState;
    }
  | {
      status: 'action_required';
      paymentId: string | null;
      action: ClientAction;
      providerState?: ProviderState;
    };

export interface CaptureInput extends Idempotent {
  paymentId: string;
  /** At most the held amount; the caller caps it. */
  amountCents: number;
  currency: string;
  merchantReference: string;
  /** Hold-time destination from the record. Stripe reads it from the intent instead. */
  payoutAccountId: string | null;
  feeTax: ChargeTax;
  platformFeePercent: number;
}

export interface CaptureResult {
  capturedCents: number;
  applicationFeeCents: number;
}

export interface ShortfallInput extends Idempotent {
  originalPaymentId: string;
  /**
   * The saved method of the original payment. Stripe reads it from the
   * original intent; Adyen cannot read a payment back, so it needs it here.
   */
  method?: { customerId: string; methodId: string };
  capturedCents: number;
  finalCostCents: number;
  currency: string;
  feeTax: ChargeTax;
  platformFeePercent: number;
  description: string;
}

export interface ImmediateChargeInput extends Idempotent {
  customerId: string;
  methodId: string;
  grossCents: number;
  currency: string;
  feeTaxRate: number;
  platformFeePercent: number;
  payoutAccountId: string | null;
  description: string;
  metadata: Record<string, string>;
}

export interface ChargeResult {
  paymentId: string;
  amountCents: number;
  applicationFeeCents: number;
}

export interface RefundInput extends Idempotent {
  paymentId: string;
  /** Omitted: refund everything captured. */
  amountCents?: number;
  currency: string;
  merchantReference: string;
}

export interface RefundResult {
  refundId: string;
  amountCents: number;
}

export interface AdjustHoldInput extends Idempotent {
  paymentId: string;
  newTotalCents: number;
  currency: string;
  providerState?: ProviderState;
}

export type MethodSetupChannel = 'web' | 'native';

export interface StartMethodSetupInput {
  customerId: string;
  channel: MethodSetupChannel;
  currency: string;
  countryCode: string;
  /** Stripe API version pinned by the native SDK (native channel only). */
  nativeSdkVersion?: string;
}

export type MethodSetupSession =
  | {
      provider: 'stripe';
      clientSecret: string;
      customerId: string;
      publishableKey: string;
      /** Native channel only. */
      ephemeralKey?: string;
    }
  | { provider: string; [key: string]: unknown };

export interface SavedMethodDetails {
  methodId: string;
  customerId: string;
  brand: string | null;
  last4: string | null;
}

export type MethodSetupStep =
  | { status: 'saved'; method: SavedMethodDetails }
  | { status: 'action_required'; action: ClientAction }
  | { status: 'refused'; reason: string };

interface PaymentEventBase {
  eventId: string;
  paymentId: string;
  /** Provider reference of the modification the event confirms (async providers). */
  operationRef?: string;
  occurredAt: Date;
  /** The provider's own event type (Stripe `charge.refunded`), recorded with the event id. */
  providerType?: string;
}

export type NormalizedPaymentEvent =
  | (PaymentEventBase & {
      type: 'payment.authorized';
      amountCents: number;
      merchantReference: string;
      method?: SavedMethodDetails;
    })
  | (PaymentEventBase & { type: 'payment.failed'; reason: string | null })
  | (PaymentEventBase & { type: 'payment.captured'; amountCents: number })
  | (PaymentEventBase & { type: 'payment.capture_failed'; reason: string | null })
  | (PaymentEventBase & {
      type: 'payment.cancelled';
      /** The authorisation expired at the provider (Adyen EXPIRE), not a cancel request. */
      expired?: boolean;
    })
  | (PaymentEventBase & { type: 'payment.cancel_failed'; reason: string | null })
  | (PaymentEventBase & { type: 'payment.adjusted'; authorizedCents: number; success: boolean })
  | (PaymentEventBase & {
      type: 'payment.refunded';
      /** Null when the provider reports a cumulative total only (Stripe charge.refunded). */
      refundId: string | null;
      /** This refund's amount, or null when only a cumulative total is known. */
      amountCents: number | null;
      /** Total refunded on the payment so far, when the provider sends it (Stripe). */
      cumulativeRefundedCents: number | null;
      /** Amount captured on the payment, when the provider sends it (Stripe). */
      capturedCents: number | null;
    })
  | (PaymentEventBase & {
      type: 'payment.refund_failed';
      refundId: string;
      amountCents: number;
      reason: string | null;
    })
  | (PaymentEventBase & { type: 'payment.disputed'; disputeId: string; reason: string | null })
  | {
      eventId: string;
      type: 'payout_account.updated';
      /** The connected account the event is about. Its state is read back from the provider. */
      accountId: string;
      occurredAt: Date;
      providerType?: string;
    }
  | { eventId: string; type: 'ignored'; providerType: string; occurredAt: Date };

export interface ProviderPaymentState {
  providerStatus: string;
  /** Local statuses consistent with the provider status, or null when it has no mapping. */
  acceptableLocalStatuses: ReadonlySet<PaymentStatus> | null;
  capturedCents: number | null;
}

export interface WebhookAck {
  status: number;
  contentType: string;
  body: string;
}

export interface WebhookRegistrationInput {
  /** Absolute https URL ending in /v1/webhooks/<webhookPath>. */
  url: string;
  /**
   * Replace the webhooks that already exist at this URL (same origin and
   * path). Webhooks of other EVtivity deployments on the same account, at
   * other URLs, are never changed.
   */
  replace: boolean;
}

export interface WebhookEndpointInfo {
  id: string;
  url: string;
  /** 'platform' or 'connect' (Stripe); 'standard' (Adyen). */
  scope: string;
  enabledEvents: string[];
  apiVersion: string | null;
  active: boolean;
}

export interface WebhookRegistration {
  endpoints: WebhookEndpointInfo[];
  /**
   * Settings the caller stores before reporting success. `secret` entries are
   * `*Enc` keys and are encrypted by the caller; values are plaintext here and
   * are never logged.
   */
  settings: Array<{ key: string; value: string | boolean; secret: boolean }>;
  /** Run after the settings are stored: turns the webhook on (Adyen). */
  activate?: () => Promise<void>;
}

export type PayoutAccountState =
  | 'onboarding'
  | 'action_required'
  | 'pending'
  | 'active'
  | 'disabled';

export interface PayoutAccountStatus {
  accountId: string;
  state: PayoutAccountState;
  capabilities: Record<string, 'active' | 'inactive' | 'pending' | 'unrequested'>;
  detailsSubmitted: boolean;
  requirementsDue: string[];
  disabledReason: string | null;
}

export interface CreatePayoutAccountInput extends Idempotent {
  displayName: string;
  /**
   * The site host's contact email. Required: Stripe refuses an Accounts v2
   * account with the recipient configuration and no contact email.
   */
  contactEmail: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  metadata: Record<string, string>;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  readonly capabilities: ProviderCapabilities;
  /** Inbound path under /v1/webhooks/ (Stripe: 'payments/stripe'). */
  readonly webhookPath: string;
  clientConfig(): PaymentProviderClientConfig;
  testConnection(): Promise<void>;

  // Customers and saved methods
  createCustomer(
    input: { email: string; name: string } & Idempotent,
  ): Promise<{ customerId: string }>;
  /** Stale customer recovery: true when the provider does not know the customer. */
  isUnknownCustomerError(err: unknown): boolean;
  startMethodSetup(input: StartMethodSetupInput): Promise<MethodSetupSession>;
  /** Server-side step after the client form. Stripe: verify the confirmed SetupIntent's method. */
  submitMethodSetup(
    input: { customerId: string; payload: unknown; browser?: BrowserContext } & Idempotent,
  ): Promise<MethodSetupStep>;
  continueMethodSetup(
    input: { customerId: string; details: unknown } & Idempotent,
  ): Promise<MethodSetupStep>;
  /** Reads the method server-side and checks it belongs to customerId (never client-asserted). */
  verifyMethod(input: { methodId: string; customerId: string }): Promise<SavedMethodDetails>;
  detachMethod(input: { customerId: string; methodId: string }): Promise<void>;

  // Money movement. Declines throw PaymentDeclinedError.
  authorizeHold(input: AuthorizeHoldInput): Promise<HoldResult>;
  continueHold(
    input: { paymentId: string | null; details: unknown } & Idempotent,
  ): Promise<HoldResult>;
  /** Required when capabilities.shortfall is 'adjust_hold'. */
  adjustHold?(
    input: AdjustHoldInput,
  ): Promise<ModificationResult<{ authorizedCents: number; providerState?: ProviderState }>>;
  capture(input: CaptureInput): Promise<ModificationResult<CaptureResult>>;
  chargeShortfall(input: ShortfallInput): Promise<ChargeResult>;
  /**
   * Smallest amount one new charge can take in `currency` (ISO 4217, minor
   * units), or null when the provider sets none or it is not known for that
   * currency. A top-up below it can never be collected, so it is not tried.
   */
  minimumChargeCents?(currency: string): number | null;
  chargeSavedMethod(input: ImmediateChargeInput): Promise<ChargeResult>;
  cancelHold(
    input: { paymentId: string | null; merchantReference: string } & Idempotent,
  ): Promise<ModificationResult<object>>;
  refund(input: RefundInput): Promise<ModificationResult<RefundResult>>;

  // Inbound and reconciliation
  /** Throws WebhookNotConfiguredError or WebhookSignatureError. */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): NormalizedPaymentEvent[];
  webhookAck(): WebhookAck;
  /** Required when capabilities.stateLookup. */
  getPaymentState?(paymentId: string): Promise<ProviderPaymentState>;

  // Webhook registration
  /**
   * Required when capabilities.webhookRegistration. Lists the EVtivity
   * endpoints on the account, of every deployment that shares it; split them
   * by URL with `partitionWebhookEndpoints`.
   */
  listWebhooks?(): Promise<WebhookEndpointInfo[]>;
  /**
   * Required when capabilities.webhookRegistration. Acts only on the
   * webhooks at `input.url`. Throws WebhookExistsError when replace is false
   * and one exists there.
   */
  registerWebhook?(input: WebhookRegistrationInput): Promise<WebhookRegistration>;

  // Site host payout accounts
  /** Required when capabilities.payoutOnboarding is 'hosted_link'. */
  createPayoutAccount?(input: CreatePayoutAccountInput): Promise<{ accountId: string }>;
  /** Required when capabilities.payoutOnboarding is 'hosted_link'. */
  createPayoutOnboardingLink?(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: Date }>;
  /** Required when capabilities.payoutOnboarding is 'hosted_link'. */
  getPayoutAccountStatus?(accountId: string): Promise<PayoutAccountStatus>;
}
