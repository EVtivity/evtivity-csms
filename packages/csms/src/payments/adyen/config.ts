// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ParseKeys, TFunction } from 'i18next';
import type { CardConfiguration, CoreConfiguration, ResultCode } from '@adyen/adyen-web';
import type { ClientConfig, ShopperBrowser } from '../types';

type CardFieldStyles = NonNullable<CardConfiguration['styles']>;
type AdyenEnvironment = NonNullable<CoreConfiguration['environment']>;

const ENVIRONMENTS: readonly AdyenEnvironment[] = [
  'test',
  'live',
  'live-us',
  'live-au',
  'live-apse',
  'live-in',
  'live-nea',
];

/** What AdyenCheckout needs from the provider's client config or setup session. */
export interface AdyenCheckoutConfig {
  clientKey: string;
  environment: AdyenEnvironment;
  /** Adyen Web refuses to start without it. */
  countryCode: string;
  amount?: { value: number; currency: string };
  paymentMethodsResponse?: CoreConfiguration['paymentMethodsResponse'];
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function isEnvironment(value: string): value is AdyenEnvironment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Reads the Adyen client config (`{ clientKey, environment, countryCode }`, plus
 * `currency` and `paymentMethodsResponse` in a setup session). Null when it is unusable:
 * Adyen Web refuses to start without a country (company.country unset).
 */
export function readAdyenConfig(
  config: ClientConfig,
  amount?: { value: number; currency: string },
): AdyenCheckoutConfig | null {
  const clientKey = stringField(config, 'clientKey');
  const environment = stringField(config, 'environment');
  const countryCode = stringField(config, 'countryCode');
  if (clientKey == null || environment == null || !isEnvironment(environment)) return null;
  if (countryCode == null) return null;
  const pmResponse = config['paymentMethodsResponse'];
  return {
    clientKey,
    environment,
    countryCode,
    ...(amount != null ? { amount } : {}),
    ...(pmResponse != null && typeof pmResponse === 'object'
      ? { paymentMethodsResponse: pmResponse }
      : {}),
  };
}

const LOCALES: Record<string, string> = {
  en: 'en-US',
  de: 'de-DE',
  es: 'es-ES',
  ko: 'ko-KR',
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
};

/** Adyen Web locale for an app language (Adyen fetches its texts for it). */
export function adyenLocale(language: string): string {
  return LOCALES[language] ?? LOCALES[language.split('-')[0] ?? ''] ?? 'en-US';
}

/**
 * The resultCode handed to `actions.resolve` with an action. Adyen Web runs the action
 * whatever the code; the API returns only the action, so the code follows its type.
 */
export function actionResultCode(action: unknown): ResultCode {
  const a = (action ?? {}) as { type?: unknown; subtype?: unknown };
  if (a.type === 'redirect') return 'RedirectShopper';
  if (a.type === 'threeDS2') {
    return a.subtype === 'fingerprint' ? 'IdentifyShopper' : 'ChallengeShopper';
  }
  return 'Pending';
}

/** Browser context for the API; the return URL is built by the server. */
export function shopperBrowser(info: unknown): ShopperBrowser {
  return { origin: window.location.origin, ...(info != null ? { info } : {}) };
}

/** Text colors of the card number, expiry and CVC iframes for the current theme. */
export function cardFieldStyles(): CardFieldStyles {
  const dark = document.documentElement.classList.contains('dark');
  return {
    base: { color: dark ? '#f8fafc' : '#020817', caretColor: dark ? '#f8fafc' : '#020817' },
    placeholder: { color: dark ? '#94a3b8' : '#64748b' },
    error: { color: dark ? '#ef4444' : '#dc2626' },
  };
}

const REFUSAL_KEYS: Record<string, ParseKeys> = {
  '3D Not Authenticated': 'paymentProviders.refused.authentication_failed',
  'Not enough balance': 'paymentProviders.refused.insufficient_funds',
};

/** Text for an Adyen refusalReason (Adyen's English reason, shown when it has no key). */
export function adyenRefusedMessage(reason: string, t: TFunction): string {
  const key = REFUSAL_KEYS[reason];
  if (key != null) return t(key);
  return t('paymentProviders.adyen.refused', { reason });
}
