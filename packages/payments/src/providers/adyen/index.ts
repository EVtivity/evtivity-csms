// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import {
  PaymentDeclinedError,
  PaymentMethodOwnershipError,
  PaymentOperationNotSupportedError,
  PaymentProviderNotConfiguredError,
  PaymentProviderUnavailableError,
  PaymentValidationError,
  WebhookNotConfiguredError,
  WebhookSignatureError,
} from '../../errors.js';
import type { PaymentProviderFactory } from '../../registry.js';
import type { AdyenLiveRegion } from '../../settings.js';
import type {
  AdjustHoldInput,
  AuthorizeHoldInput,
  BrowserContext,
  CaptureInput,
  CaptureResult,
  ChargeResult,
  HoldResult,
  Idempotent,
  ImmediateChargeInput,
  MethodSetupSession,
  MethodSetupStep,
  ModificationResult,
  NormalizedPaymentEvent,
  PaymentProvider,
  PaymentProviderClientConfig,
  ProviderCapabilities,
  ProviderState,
  RefundInput,
  RefundResult,
  SavedMethodDetails,
  ShortfallInput,
  StartMethodSetupInput,
  WebhookAck,
} from '../../types.js';
import { ADYEN_CURRENCIES, fromAdyenAmount, toAdyenAmount } from './amounts.js';
import type { AdyenAmount } from './amounts.js';
import {
  ADYEN_LIVE_URL_PREFIX_PATTERN,
  AdyenCheckoutClient,
  adyenCheckoutBaseUrl,
} from './client.js';
import type { AdyenEnvironment } from './client.js';
import { isHexKey, isValidAdyenHmac, isValidBasicAuth } from './hmac.js';
import { normalizeAdyenItem, parseAdyenNotification } from './webhooks.js';

export const ADYEN_PROVIDER_ID = 'adyen';

/** Client SDK `environment` per live region; test is 'test'. */
const CLIENT_ENVIRONMENT: Record<AdyenLiveRegion, string> = {
  eu: 'live',
  us: 'live-us',
  au: 'live-au',
  nea: 'live-nea',
  in: 'live-in',
};

export function adyenCapabilities(authorisationAdjustment: boolean): ProviderCapabilities {
  return {
    savedMethods: true,
    manualCapture: true,
    partialCapture: true,
    refunds: true,
    partialRefunds: true,
    webhooks: true,
    // The mobile Drop-in arrives with P10e.
    nativeMobileSheet: false,
    // D-A1: adjust the hold where Adyen enabled it for the MCC, else a top-up charge.
    shortfall: authorisationAdjustment ? 'adjust_hold' : 'top_up',
    modificationResults: 'async',
    clientActions: true,
    // The Checkout API cannot read a payment's status back.
    stateLookup: false,
    // D-A2: no Adyen for Platforms split payments yet.
    marketplaceSplit: 'none',
    // D-A3: IDR blocked.
    currencies: ADYEN_CURRENCIES,
  };
}

export interface AdyenProviderOptions {
  apiKey: string;
  merchantAccount: string;
  clientKey: string;
  environment: AdyenEnvironment;
  liveUrlPrefix: string | null;
  liveRegion: AdyenLiveRegion;
  hmacKey: string | null;
  hmacKeyPrevious: string | null;
  webhookUsername: string | null;
  webhookPassword: string | null;
  authorisationAdjustment: boolean;
  /** Tests inject a fake Adyen server. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/** The fields of a /payments, /payments/details or /amountUpdates response the provider reads. */
interface AdyenPaymentResponse {
  pspReference?: string;
  resultCode?: string;
  status?: string;
  refusalReason?: string;
  refusalReasonCode?: string;
  action?: unknown;
  amount?: AdyenAmount;
  merchantReference?: string;
  adjustAuthorisationData?: string;
  paymentMethod?: { brand?: string; type?: string };
  additionalData?: Record<string, string | undefined>;
}

interface AdyenModificationResponse {
  pspReference?: string;
  status?: string;
}

interface AdyenStoredMethod {
  id?: string;
  brand?: string;
  lastFour?: string;
}

/** Card payload from the Adyen Web Card component (`state.data`). */
interface AdyenComponentData {
  paymentMethod?: unknown;
  browserInfo?: unknown;
}

function nonEmpty(value: string | undefined | null): string | null {
  return value != null && value !== '' ? value : null;
}

function declined(response: AdyenPaymentResponse): PaymentDeclinedError {
  const code = response.resultCode ?? 'Unknown';
  return new PaymentDeclinedError(response.refusalReason ?? `Adyen result ${code}`, {
    code: response.refusalReasonCode ?? code,
    // 'Error' is a processing error at Adyen or the issuer, not a refusal of the card.
    retryable: code === 'Error',
  });
}

function componentData(payload: unknown): AdyenComponentData {
  if (payload == null || typeof payload !== 'object') {
    throw new PaymentValidationError('An Adyen card payload is the Card component state.data');
  }
  const data = payload as AdyenComponentData;
  if (data.paymentMethod == null || typeof data.paymentMethod !== 'object') {
    throw new PaymentValidationError('The Adyen payload has no paymentMethod');
  }
  return data;
}

/**
 * The stored card plus the CVC the shopper entered in the stored-card
 * component. Adyen refuses a shopper-present stored-card payment without the
 * CVC ("Required field 'cvc' is not provided.") unless the account allows it.
 * Only the CVC is taken from the payload, and only for the same token.
 */
function storedCardWithCvc(methodId: string, data: AdyenComponentData): Record<string, string> {
  const pm = data.paymentMethod as Record<string, unknown>;
  const stored = pm['storedPaymentMethodId'];
  if (stored != null && stored !== methodId) {
    throw new PaymentValidationError('The Adyen payload is for another stored card');
  }
  const cvc = pm['encryptedSecurityCode'];
  if (typeof cvc !== 'string' || cvc === '') {
    throw new PaymentValidationError('The Adyen stored-card payload has no encryptedSecurityCode');
  }
  return { type: 'scheme', storedPaymentMethodId: methodId, encryptedSecurityCode: cvc };
}

function requireBrowser(browser: BrowserContext | undefined, call: string): BrowserContext {
  if (browser == null) {
    throw new PaymentValidationError(
      `Adyen ${call} with the shopper present needs the browser context`,
    );
  }
  return browser;
}

/** The return URL, origin and browser info Adyen needs to run 3DS with the shopper. */
function shopperPresent(
  browser: BrowserContext,
  data?: AdyenComponentData,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    channel: 'Web',
    origin: browser.origin,
    returnUrl: browser.returnUrl,
  };
  const info = browser.info ?? data?.browserInfo;
  if (info != null) fields['browserInfo'] = info;
  return fields;
}

/**
 * Adyen behind the PaymentProvider interface (plan B6), over the Checkout API
 * v72 Advanced flow with a thin fetch client (D-A4).
 *
 * - A customer is a `shopperReference` (no Adyen call, no PII); saved methods
 *   are tokens stored by a zero-value authorization.
 * - Holds are `PreAuth` with manual capture. A merchant-initiated charge on a
 *   saved card is `ContAuth` + `UnscheduledCardOnFile`; with the shopper
 *   present it is `Ecommerce` + `CardOnFile`, and 3DS comes back as an action.
 * - Capture, cancel, refund and an asynchronous adjustment return
 *   `{ state: 'pending', operationRef }` (the modification pspReference); the
 *   outcome arrives by webhook (CAPTURE, CANCELLATION, REFUND, ...).
 * - Every POST that moves money sends the caller's key as `Idempotency-Key`.
 * - No split payments: a payout account is refused (D-A2).
 */
export class AdyenPaymentProvider implements PaymentProvider {
  readonly id = ADYEN_PROVIDER_ID;
  readonly webhookPath = 'payments/adyen';
  readonly capabilities: ProviderCapabilities;

  private readonly client: AdyenCheckoutClient;
  private readonly merchantAccount: string;
  private readonly clientKey: string;
  private readonly environment: AdyenEnvironment;
  private readonly liveRegion: AdyenLiveRegion;
  private readonly hmacKeys: string[];
  private readonly webhookUsername: string | null;
  private readonly webhookPassword: string | null;
  private readonly authorisationAdjustment: boolean;

  constructor(options: AdyenProviderOptions) {
    this.client = new AdyenCheckoutClient({
      apiKey: options.apiKey,
      baseUrl: adyenCheckoutBaseUrl(options.environment, options.liveUrlPrefix),
      ...(options.fetch != null ? { fetch: options.fetch } : {}),
      ...(options.sleep != null ? { sleep: options.sleep } : {}),
      ...(options.maxRetries != null ? { maxRetries: options.maxRetries } : {}),
    });
    this.merchantAccount = options.merchantAccount;
    this.clientKey = options.clientKey;
    this.environment = options.environment;
    this.liveRegion = options.liveRegion;
    this.hmacKeys = [options.hmacKey, options.hmacKeyPrevious].filter(
      (k): k is string => k != null && k !== '',
    );
    this.webhookUsername = options.webhookUsername;
    this.webhookPassword = options.webhookPassword;
    this.authorisationAdjustment = options.authorisationAdjustment;
    this.capabilities = adyenCapabilities(options.authorisationAdjustment);
  }

  /** The Checkout API base URL in use (test or the live prefix URL). */
  get baseUrl(): string {
    return this.client.baseUrl;
  }

  clientConfig(): PaymentProviderClientConfig {
    return {
      provider: this.id,
      clientKey: this.clientKey,
      environment: this.environment === 'test' ? 'test' : CLIENT_ENVIRONMENT[this.liveRegion],
    };
  }

  /** A cheap authenticated call that checks the key, the merchant account and the endpoint. */
  async testConnection(): Promise<void> {
    await this.client.request({
      method: 'POST',
      path: '/paymentMethods',
      body: { merchantAccount: this.merchantAccount },
    });
  }

  /**
   * No Adyen call: the customer is a shopperReference derived from the
   * idempotency key (a domain id such as `customer_<driverId>`), hashed so it
   * carries no personal data and is the same on every retry.
   */
  createCustomer(
    input: { email: string; name: string } & Idempotent,
  ): Promise<{ customerId: string }> {
    const hash = crypto.createHash('sha256').update(input.idempotencyKey).digest('hex');
    return Promise.resolve({ customerId: `evt_${hash.slice(0, 32)}` });
  }

  /** A shopperReference needs no Adyen object, so it never goes stale. */
  isUnknownCustomerError(): boolean {
    return false;
  }

  /** The descriptor the Card component starts from (`/paymentMethods` for the shopper). */
  async startMethodSetup(input: StartMethodSetupInput): Promise<MethodSetupSession> {
    const amount = toAdyenAmount(0, input.currency);
    const body: Record<string, unknown> = {
      merchantAccount: this.merchantAccount,
      countryCode: input.countryCode,
      amount,
      shopperReference: input.customerId,
      allowedPaymentMethods: ['scheme'],
    };
    if (input.channel === 'web') body['channel'] = 'Web';
    const paymentMethodsResponse = await this.client.request<unknown>({
      method: 'POST',
      path: '/paymentMethods',
      body,
    });
    return {
      ...this.clientConfig(),
      customerId: input.customerId,
      countryCode: input.countryCode,
      currency: amount.currency,
      paymentMethodsResponse,
    };
  }

  /**
   * Stores the card with a zero-value authorization. payload is
   * `{ paymentMethod, browserInfo?, currency }`: the Card component's
   * `state.data` plus the currency of the setup session (zero amount, so the
   * client-sent currency moves no money).
   */
  async submitMethodSetup(
    input: { customerId: string; payload: unknown; browser?: BrowserContext } & Idempotent,
  ): Promise<MethodSetupStep> {
    const data = componentData(input.payload);
    const currency = (input.payload as { currency?: unknown }).currency;
    if (typeof currency !== 'string') {
      throw new PaymentValidationError('The Adyen method payload needs the setup currency');
    }
    const browser = requireBrowser(input.browser, 'method setup');
    const response = await this.client.request<AdyenPaymentResponse>({
      method: 'POST',
      path: '/payments',
      idempotencyKey: input.idempotencyKey,
      body: {
        merchantAccount: this.merchantAccount,
        reference: input.idempotencyKey,
        amount: toAdyenAmount(0, currency),
        paymentMethod: data.paymentMethod,
        shopperReference: input.customerId,
        storePaymentMethod: true,
        shopperInteraction: 'Ecommerce',
        recurringProcessingModel: 'UnscheduledCardOnFile',
        ...shopperPresent(browser, data),
      },
    });
    return this.methodSetupStep(response, input.customerId);
  }

  /** details is the component's `onAdditionalDetails` state.data after 3DS. */
  async continueMethodSetup(
    input: { customerId: string; details: unknown } & Idempotent,
  ): Promise<MethodSetupStep> {
    const response = await this.paymentDetails(input.details, input.idempotencyKey);
    return this.methodSetupStep(response, input.customerId);
  }

  /**
   * The card summary comes in the payment response only when "Card summary"
   * is selected under Customer Area > Developers > Additional data (a test
   * account returns none by default). Without it the stored-method listing
   * supplies the last four digits and brand.
   */
  private async methodSetupStep(
    response: AdyenPaymentResponse,
    customerId: string,
  ): Promise<MethodSetupStep> {
    if (response.action != null) {
      return { status: 'action_required', action: { provider: this.id, data: response.action } };
    }
    if (response.resultCode !== 'Authorised') {
      return {
        status: 'refused',
        reason: response.refusalReason ?? response.resultCode ?? 'Unknown',
      };
    }
    const data = response.additionalData ?? {};
    const methodId =
      nonEmpty(data['tokenization.storedPaymentMethodId']) ??
      nonEmpty(data['recurring.recurringDetailReference']);
    if (methodId == null) {
      throw new PaymentProviderNotConfiguredError(
        this.id,
        'Adyen returned no stored payment method id. Ask Adyen Support to return tokenization.storedPaymentMethodId in the payment response.',
      );
    }
    const owner =
      nonEmpty(data['tokenization.shopperReference']) ??
      nonEmpty(data['recurring.shopperReference']);
    if (owner != null && owner !== customerId) throw new PaymentMethodOwnershipError();
    const brand = nonEmpty(response.paymentMethod?.brand) ?? nonEmpty(data['paymentMethod']);
    const last4 = nonEmpty(data['cardSummary']);
    if (last4 != null) {
      return { status: 'saved', method: { methodId, customerId, brand, last4 } };
    }
    const stored = await this.verifyMethod({ methodId, customerId });
    return {
      status: 'saved',
      method: { methodId, customerId, brand: brand ?? stored.brand, last4: stored.last4 },
    };
  }

  /** Lists the shopper's tokens: a token of another shopper is never found (ownership). */
  async verifyMethod(input: { methodId: string; customerId: string }): Promise<SavedMethodDetails> {
    const response = await this.client.request<{ storedPaymentMethods?: AdyenStoredMethod[] }>({
      method: 'GET',
      path: '/storedPaymentMethods',
      query: { shopperReference: input.customerId, merchantAccount: this.merchantAccount },
    });
    const method = (response.storedPaymentMethods ?? []).find((m) => m.id === input.methodId);
    if (method == null) throw new PaymentMethodOwnershipError();
    return {
      methodId: input.methodId,
      customerId: input.customerId,
      brand: nonEmpty(method.brand),
      last4: nonEmpty(method.lastFour),
    };
  }

  async detachMethod(input: { customerId: string; methodId: string }): Promise<void> {
    await this.client.request({
      method: 'DELETE',
      path: `/storedPaymentMethods/${encodeURIComponent(input.methodId)}`,
      query: { shopperReference: input.customerId, merchantAccount: this.merchantAccount },
    });
  }

  /**
   * A `PreAuth` hold with manual capture (adjustable later; plan B6.1). An
   * Authorised result carries the `adjustAuthorisationData` blob, when Adyen
   * sends it, as providerState for a synchronous adjustment.
   */
  async authorizeHold(input: AuthorizeHoldInput): Promise<HoldResult> {
    this.refusePayoutAccount(input.payoutAccountId);
    const body: Record<string, unknown> = {
      merchantAccount: this.merchantAccount,
      reference: input.merchantReference,
      amount: toAdyenAmount(input.amountCents, input.currency),
      additionalData: { authorisationType: 'PreAuth', manualCapture: 'true' },
    };
    const method = input.method;
    if (method.kind === 'saved') {
      body['paymentMethod'] = { type: 'scheme', storedPaymentMethodId: method.methodId };
      body['shopperReference'] = method.customerId;
      if (input.initiator === 'merchant') {
        body['shopperInteraction'] = 'ContAuth';
        body['recurringProcessingModel'] = 'UnscheduledCardOnFile';
      } else {
        body['shopperInteraction'] = 'Ecommerce';
        body['recurringProcessingModel'] = 'CardOnFile';
        const data = method.payload != null ? componentData(method.payload) : undefined;
        if (data != null) {
          body['paymentMethod'] = storedCardWithCvc(method.methodId, data);
        }
        Object.assign(body, shopperPresent(requireBrowser(method.browser, 'holds'), data));
      }
    } else {
      const data = componentData(method.payload);
      body['paymentMethod'] = data.paymentMethod;
      body['shopperInteraction'] = 'Ecommerce';
      Object.assign(body, shopperPresent(requireBrowser(method.browser, 'holds'), data));
    }
    if (input.receiptEmail != null) body['shopperEmail'] = input.receiptEmail;
    if (input.metadata != null) body['metadata'] = input.metadata;

    const response = await this.client.request<AdyenPaymentResponse>({
      method: 'POST',
      path: '/payments',
      idempotencyKey: input.idempotencyKey,
      body,
    });
    return this.holdResult(response, input.initiator, input.amountCents);
  }

  /** details is the component's `onAdditionalDetails` state.data after 3DS. */
  async continueHold(
    input: { paymentId: string | null; details: unknown } & Idempotent,
  ): Promise<HoldResult> {
    const response = await this.paymentDetails(input.details, input.idempotencyKey);
    return this.holdResult(response, 'shopper', null);
  }

  private async paymentDetails(
    details: unknown,
    idempotencyKey: string,
  ): Promise<AdyenPaymentResponse> {
    if (details == null || typeof details !== 'object') {
      throw new PaymentValidationError('Adyen details are the component state.data');
    }
    return this.client.request<AdyenPaymentResponse>({
      method: 'POST',
      path: '/payments/details',
      idempotencyKey,
      body: details,
    });
  }

  private holdResult(
    response: AdyenPaymentResponse,
    initiator: 'merchant' | 'shopper',
    requestedCents: number | null,
  ): HoldResult {
    if (response.action != null) {
      // Nobody can authenticate a merchant-initiated charge.
      if (initiator === 'merchant') {
        throw new PaymentDeclinedError('Your card requires authentication.', {
          code: 'authentication_required',
        });
      }
      return {
        status: 'action_required',
        paymentId: nonEmpty(response.pspReference),
        action: { provider: this.id, data: response.action },
      };
    }
    if (response.resultCode !== 'Authorised') throw declined(response);
    const paymentId = nonEmpty(response.pspReference);
    if (paymentId == null) {
      throw new PaymentProviderUnavailableError(
        'Adyen authorized a payment without a pspReference',
      );
    }
    const authorizedCents = this.authorizedCents(response) ?? requestedCents;
    if (authorizedCents == null) {
      throw new PaymentProviderUnavailableError('Adyen authorized a payment without an amount');
    }
    const providerState = this.adjustState(response);
    return {
      status: 'authorized',
      paymentId,
      authorizedCents,
      ...(providerState != null ? { providerState } : {}),
    };
  }

  private authorizedCents(response: AdyenPaymentResponse): number | null {
    if (response.amount != null) return fromAdyenAmount(response.amount);
    const value = response.additionalData?.['authorisedAmountValue'];
    const currency = response.additionalData?.['authorisedAmountCurrency'];
    if (value == null || currency == null || !/^\d+$/.test(value)) return null;
    return fromAdyenAmount({ value: Number(value), currency });
  }

  private adjustState(response: AdyenPaymentResponse): ProviderState | null {
    const blob =
      nonEmpty(response.adjustAuthorisationData) ??
      nonEmpty(response.additionalData?.['adjustAuthorisationData']);
    return blob == null ? null : { adjustAuthorisationData: blob };
  }

  /**
   * `/amountUpdates` to the new total (not a delta), `industryUsage:
   * delayedCharge`. With the blob from the hold (or the last adjustment) the
   * answer is synchronous (`Authorised`); without it Adyen answers `received`
   * and confirms with AUTHORISATION_ADJUSTMENT. Only behind
   * `adyen.authorisationAdjustment` (D-A1); the caller tops up otherwise.
   */
  async adjustHold(
    input: AdjustHoldInput,
  ): Promise<ModificationResult<{ authorizedCents: number; providerState?: ProviderState }>> {
    if (!this.authorisationAdjustment) {
      throw new PaymentOperationNotSupportedError(
        this.id,
        'adjustHold (adyen.authorisationAdjustment is off)',
      );
    }
    const body: Record<string, unknown> = {
      merchantAccount: this.merchantAccount,
      amount: toAdyenAmount(input.newTotalCents, input.currency),
      reference: input.idempotencyKey,
      industryUsage: 'delayedCharge',
    };
    const blob = input.providerState?.['adjustAuthorisationData'];
    if (blob != null && blob !== '') body['adjustAuthorisationData'] = blob;
    const response = await this.client.request<AdyenPaymentResponse>({
      method: 'POST',
      path: `/payments/${encodeURIComponent(input.paymentId)}/amountUpdates`,
      idempotencyKey: input.idempotencyKey,
      body,
    });
    if (response.status === 'received') return this.pendingResult(response);
    if (response.status !== 'Authorised') {
      throw declined({ ...response, resultCode: response.status ?? 'Unknown' });
    }
    const providerState = this.adjustState(response);
    return {
      state: 'succeeded',
      authorizedCents:
        response.amount != null ? fromAdyenAmount(response.amount) : input.newTotalCents,
      ...(providerState != null ? { providerState } : {}),
    };
  }

  /** `/captures` answers `received`; CAPTURE or CAPTURE_FAILED confirms. A partial capture releases the rest. */
  async capture(input: CaptureInput): Promise<ModificationResult<CaptureResult>> {
    this.refusePayoutAccount(input.payoutAccountId);
    const response = await this.client.request<AdyenModificationResponse>({
      method: 'POST',
      path: `/payments/${encodeURIComponent(input.paymentId)}/captures`,
      idempotencyKey: input.idempotencyKey,
      body: {
        merchantAccount: this.merchantAccount,
        amount: toAdyenAmount(input.amountCents, input.currency),
        reference: input.merchantReference,
      },
    });
    return this.pendingResult(response);
  }

  /** A merchant-initiated charge of final minus captured on the saved method of the hold. */
  async chargeShortfall(input: ShortfallInput): Promise<ChargeResult> {
    if (input.method == null) {
      throw new PaymentValidationError(
        'An Adyen shortfall charge needs the saved method of the hold',
      );
    }
    const amountCents = input.finalCostCents - input.capturedCents;
    if (amountCents <= 0) throw new PaymentValidationError('No shortfall to charge');
    const paymentId = await this.chargeOffSession({
      customerId: input.method.customerId,
      methodId: input.method.methodId,
      amountCents,
      currency: input.currency,
      reference: input.idempotencyKey,
      idempotencyKey: input.idempotencyKey,
      metadata: { originalPaymentId: input.originalPaymentId },
    });
    return { paymentId, amountCents, applicationFeeCents: 0 };
  }

  /** An immediate merchant-initiated charge (reservation fees), captured without delay. */
  async chargeSavedMethod(input: ImmediateChargeInput): Promise<ChargeResult> {
    this.refusePayoutAccount(input.payoutAccountId);
    const paymentId = await this.chargeOffSession({
      customerId: input.customerId,
      methodId: input.methodId,
      amountCents: input.grossCents,
      currency: input.currency,
      reference: input.idempotencyKey,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    });
    return { paymentId, amountCents: input.grossCents, applicationFeeCents: 0 };
  }

  private async chargeOffSession(input: {
    customerId: string;
    methodId: string;
    amountCents: number;
    currency: string;
    reference: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<string> {
    const response = await this.client.request<AdyenPaymentResponse>({
      method: 'POST',
      path: '/payments',
      idempotencyKey: input.idempotencyKey,
      body: {
        merchantAccount: this.merchantAccount,
        reference: input.reference,
        amount: toAdyenAmount(input.amountCents, input.currency),
        paymentMethod: { type: 'scheme', storedPaymentMethodId: input.methodId },
        shopperReference: input.customerId,
        shopperInteraction: 'ContAuth',
        recurringProcessingModel: 'UnscheduledCardOnFile',
        // Overrides an account set to manual capture: this charge is final.
        captureDelayHours: 0,
        metadata: input.metadata,
      },
    });
    if (response.action != null) {
      throw new PaymentDeclinedError('Your card requires authentication.', {
        code: 'authentication_required',
      });
    }
    if (response.resultCode !== 'Authorised') throw declined(response);
    const paymentId = nonEmpty(response.pspReference);
    if (paymentId == null) {
      throw new PaymentProviderUnavailableError(
        'Adyen authorized a payment without a pspReference',
      );
    }
    return paymentId;
  }

  /**
   * `/payments/{id}/cancels`, or without a pspReference (a timed-out hold)
   * the standalone `/cancels` by merchant reference, which works up to 24 h
   * after authorization and confirms with TECHNICAL_CANCEL.
   */
  async cancelHold(
    input: { paymentId: string | null; merchantReference: string } & Idempotent,
  ): Promise<ModificationResult<object>> {
    const response =
      input.paymentId != null
        ? await this.client.request<AdyenModificationResponse>({
            method: 'POST',
            path: `/payments/${encodeURIComponent(input.paymentId)}/cancels`,
            idempotencyKey: input.idempotencyKey,
            body: { merchantAccount: this.merchantAccount, reference: input.merchantReference },
          })
        : await this.client.request<AdyenModificationResponse>({
            method: 'POST',
            path: '/cancels',
            idempotencyKey: input.idempotencyKey,
            body: {
              merchantAccount: this.merchantAccount,
              paymentReference: input.merchantReference,
              reference: input.idempotencyKey,
            },
          });
    return this.pendingResult(response);
  }

  /** `/refunds` answers `received`; REFUND (per-refund amount) or REFUND_FAILED confirms. */
  async refund(input: RefundInput): Promise<ModificationResult<RefundResult>> {
    // Adyen cannot read the captured amount back, so a full refund names it.
    if (input.amountCents == null) {
      throw new PaymentValidationError('An Adyen refund needs amountCents');
    }
    const response = await this.client.request<AdyenModificationResponse>({
      method: 'POST',
      path: `/payments/${encodeURIComponent(input.paymentId)}/refunds`,
      idempotencyKey: input.idempotencyKey,
      body: {
        merchantAccount: this.merchantAccount,
        amount: toAdyenAmount(input.amountCents, input.currency),
        reference: input.merchantReference,
      },
    });
    return this.pendingResult(response);
  }

  private pendingResult(response: AdyenModificationResponse): {
    state: 'pending';
    operationRef: string;
  } {
    const operationRef = nonEmpty(response.pspReference);
    if (response.status !== 'received' || operationRef == null) {
      throw new PaymentProviderUnavailableError(
        `Adyen did not accept the modification (status ${response.status ?? 'missing'})`,
      );
    }
    return { state: 'pending', operationRef };
  }

  private refusePayoutAccount(payoutAccountId: string | null): void {
    if (payoutAccountId != null) {
      throw new PaymentValidationError(
        'Adyen payments cannot pay out to a site account: split payments are not enabled',
      );
    }
  }

  /**
   * Checks Basic auth on the request and the HMAC of every item (current or
   * previous key), and that the webhook is for this environment and merchant
   * account (plan B6.5, D-A7). One bad item rejects the whole request, so
   * Adyen retries it. Without an HMAC key, username or password the webhook
   * is not configured.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): NormalizedPaymentEvent[] {
    if (
      this.hmacKeys.length === 0 ||
      !this.hmacKeys.every(isHexKey) ||
      this.webhookUsername == null ||
      this.webhookPassword == null
    ) {
      throw new WebhookNotConfiguredError(this.id);
    }
    const authorization = headers['authorization'];
    if (authorization == null || authorization === '') {
      throw new WebhookSignatureError('missing', 'Missing Basic auth');
    }
    if (!isValidBasicAuth(authorization, this.webhookUsername, this.webhookPassword)) {
      throw new WebhookSignatureError('invalid', 'Invalid Basic auth');
    }
    const notification = parseAdyenNotification(rawBody);
    if (notification == null) {
      throw new WebhookSignatureError('invalid', 'Not an Adyen notification');
    }
    const expectedLive = this.environment === 'live' ? 'true' : 'false';
    if (notification.live !== expectedLive) {
      throw new WebhookSignatureError('invalid', 'Adyen notification for the other environment');
    }
    for (const item of notification.items) {
      if (item.merchantAccountCode !== this.merchantAccount) {
        throw new WebhookSignatureError(
          'invalid',
          'Adyen notification for another merchant account',
        );
      }
      const signature = item.additionalData?.['hmacSignature'];
      if (signature == null || signature === '') {
        throw new WebhookSignatureError('missing', 'Missing Adyen HMAC signature');
      }
      if (!isValidAdyenHmac(item, signature, this.hmacKeys)) {
        throw new WebhookSignatureError('invalid', 'Invalid Adyen HMAC signature');
      }
    }
    return notification.items.map(normalizeAdyenItem);
  }

  /** Adyen expects a 2xx; `[accepted]` is its long-standing acknowledgement body. */
  webhookAck(): WebhookAck {
    return { status: 200, contentType: 'text/plain', body: '[accepted]' };
  }
}

/**
 * Built from the decrypted settings. Null without an API key, merchant
 * account or client key, or when live without a valid live URL prefix.
 */
export const adyenProviderFactory: PaymentProviderFactory = {
  id: ADYEN_PROVIDER_ID,
  create(settings) {
    const a = settings.adyen;
    if (a.apiKey == null || a.merchantAccount == null || a.clientKey == null) {
      return Promise.resolve(null);
    }
    if (
      a.environment === 'live' &&
      (a.liveUrlPrefix == null || !ADYEN_LIVE_URL_PREFIX_PATTERN.test(a.liveUrlPrefix))
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(
      new AdyenPaymentProvider({
        apiKey: a.apiKey,
        merchantAccount: a.merchantAccount,
        clientKey: a.clientKey,
        environment: a.environment,
        liveUrlPrefix: a.liveUrlPrefix,
        liveRegion: a.liveRegion,
        hmacKey: a.hmacKey,
        hmacKeyPrevious: a.hmacKeyPrevious,
        webhookUsername: a.webhookUsername,
        webhookPassword: a.webhookPassword,
        authorisationAdjustment: a.authorisationAdjustment,
      }),
    );
  },
};
