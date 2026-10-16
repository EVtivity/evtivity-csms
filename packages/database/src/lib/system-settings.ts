// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, inArray } from 'drizzle-orm';
import {
  COMPANY_BANK_ACCOUNT_HOLDER_KEY,
  COMPANY_BANK_NAME_KEY,
  COMPANY_BIC_KEY,
  COMPANY_IBAN_KEY,
  INVOICE_EPC_QR_ENABLED_KEY,
  createLogger,
  DEFAULT_CURRENCY,
  DEFAULT_PRICE_DISPLAY,
  DEFAULT_TIMEZONE,
  DEFAULT_TAX_BASIS,
  isPriceDisplay,
  isSupportedCurrency,
  isTaxBasis,
  normalizeInvoicePaymentSetting,
  type PriceDisplay,
  type TaxBasis,
} from '@evtivity/lib';
import { db } from '../config.js';
import { settings } from '../schema/settings.js';

const logger = createLogger('system-settings');

const TTL_MS = 60_000;

let cachedTimezone: string | undefined;
let cachedAt = 0;

let cachedCurrency: string | undefined;
let cachedCurrencyAt = 0;

let cachedPriceDisplay: PriceDisplay | undefined;
let cachedPriceDisplayAt = 0;

let cachedTaxBasis: TaxBasis | undefined;
let cachedTaxBasisAt = 0;

let cachedCountry: string | null | undefined;
let cachedCountryAt = 0;

let cachedInvoicePayment: InvoicePaymentSettings | undefined;
let cachedInvoicePaymentAt = 0;

/**
 * Cached reader for the `system.timezone` setting. Used by dashboard
 * endpoints that aggregate sessions by day in the operator's local
 * time. Falls back to America/New_York when unset or on error.
 */
export async function getSystemTimezone(): Promise<string> {
  const now = Date.now();
  if (cachedTimezone !== undefined && now - cachedAt < TTL_MS) {
    return cachedTimezone;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'system.timezone'));

    cachedTimezone = typeof row?.value === 'string' ? row.value : DEFAULT_TIMEZONE;
    cachedAt = now;
    return cachedTimezone;
  } catch (err) {
    logger.warn(
      { err, key: 'system.timezone' },
      'getSystemTimezone failed, using the cached value or default',
    );
    return cachedTimezone ?? DEFAULT_TIMEZONE;
  }
}

/**
 * Cached reader for the `company.currency` setting: the one currency the
 * platform bills and reports in. Falls back to DEFAULT_CURRENCY when the
 * setting is unset or not a supported two-decimal currency, and on error.
 */
export async function getCompanyCurrency(): Promise<string> {
  const now = Date.now();
  if (cachedCurrency !== undefined && now - cachedCurrencyAt < TTL_MS) {
    return cachedCurrency;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'company.currency'));

    const code = typeof row?.value === 'string' ? row.value.toUpperCase() : null;
    cachedCurrency = isSupportedCurrency(code) ? code : DEFAULT_CURRENCY;
    cachedCurrencyAt = now;
    return cachedCurrency;
  } catch (err) {
    logger.warn(
      { err, key: 'company.currency' },
      'getCompanyCurrency failed, using the cached value or default',
    );
    return cachedCurrency ?? DEFAULT_CURRENCY;
  }
}

/**
 * Cached reader for the `company.priceDisplay` setting: whether drivers see
 * prices including ('gross') or excluding ('net') tax unless they choose
 * otherwise. Falls back to DEFAULT_PRICE_DISPLAY when unset or invalid, and on
 * error.
 */
export async function getCompanyPriceDisplay(): Promise<PriceDisplay> {
  const now = Date.now();
  if (cachedPriceDisplay !== undefined && now - cachedPriceDisplayAt < TTL_MS) {
    return cachedPriceDisplay;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'company.priceDisplay'));

    cachedPriceDisplay = isPriceDisplay(row?.value) ? row.value : DEFAULT_PRICE_DISPLAY;
    cachedPriceDisplayAt = now;
    return cachedPriceDisplay;
  } catch (err) {
    logger.warn(
      { err, key: 'company.priceDisplay' },
      'getCompanyPriceDisplay failed, using the cached value or default',
    );
    return cachedPriceDisplay ?? DEFAULT_PRICE_DISPLAY;
  }
}

/**
 * Cached reader for the `company.taxBasis` setting: whether tariff prices are
 * entered excluding ('net') or including ('gross') tax. A session stamps it
 * with its tariff snapshot and is priced in it. Falls back to
 * DEFAULT_TAX_BASIS when unset or invalid, and on error.
 */
export async function getCompanyTaxBasis(): Promise<TaxBasis> {
  const now = Date.now();
  if (cachedTaxBasis !== undefined && now - cachedTaxBasisAt < TTL_MS) {
    return cachedTaxBasis;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'company.taxBasis'));

    cachedTaxBasis = isTaxBasis(row?.value) ? row.value : DEFAULT_TAX_BASIS;
    cachedTaxBasisAt = now;
    return cachedTaxBasis;
  } catch (err) {
    logger.warn(
      { err, key: 'company.taxBasis' },
      'getCompanyTaxBasis failed, using the cached value or default',
    );
    return cachedTaxBasis ?? DEFAULT_TAX_BASIS;
  }
}

/**
 * Cached reader for the `company.country` setting (ISO 3166-1 alpha-2, such
 * as `US`), the country payment providers use for the methods they offer.
 * Null when unset or not a two-letter code, and on error without a cached value.
 */
export async function getCompanyCountry(): Promise<string | null> {
  const now = Date.now();
  if (cachedCountry !== undefined && now - cachedCountryAt < TTL_MS) {
    return cachedCountry;
  }

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'company.country'));

    const code = typeof row?.value === 'string' ? row.value.trim().toUpperCase() : '';
    cachedCountry = /^[A-Z]{2}$/.test(code) ? code : null;
    cachedCountryAt = now;
    return cachedCountry;
  } catch (err) {
    logger.warn(
      { err, key: 'company.country' },
      'getCompanyCountry failed, using the cached value or default',
    );
    return cachedCountry ?? null;
  }
}

/** The bank details printed in the invoice PDF payment block. Unset values are null. */
export interface InvoicePaymentSettings {
  accountHolder: string | null;
  iban: string | null;
  bic: string | null;
  bankName: string | null;
  /** Print the EPC QR code on open EUR invoices (`invoice.epcQrEnabled`, default true). */
  epcQrEnabled: boolean;
}

const INVOICE_PAYMENT_KEYS = [
  COMPANY_BANK_ACCOUNT_HOLDER_KEY,
  COMPANY_IBAN_KEY,
  COMPANY_BIC_KEY,
  COMPANY_BANK_NAME_KEY,
  INVOICE_EPC_QR_ENABLED_KEY,
];

/** The bank details from the settings rows (key to value); invalid or empty values are null. */
export function readInvoicePaymentSettings(
  values: Record<string, unknown>,
): InvoicePaymentSettings {
  const text = (
    key:
      | typeof COMPANY_BANK_ACCOUNT_HOLDER_KEY
      | typeof COMPANY_IBAN_KEY
      | typeof COMPANY_BIC_KEY
      | typeof COMPANY_BANK_NAME_KEY,
  ): string | null => {
    const value = normalizeInvoicePaymentSetting(key, values[key] ?? '');
    return value != null && value !== '' ? value : null;
  };
  return {
    accountHolder: text(COMPANY_BANK_ACCOUNT_HOLDER_KEY),
    iban: text(COMPANY_IBAN_KEY),
    bic: text(COMPANY_BIC_KEY),
    bankName: text(COMPANY_BANK_NAME_KEY),
    epcQrEnabled: values[INVOICE_EPC_QR_ENABLED_KEY] !== false,
  };
}

const NO_INVOICE_PAYMENT: InvoicePaymentSettings = {
  accountHolder: null,
  iban: null,
  bic: null,
  bankName: null,
  epcQrEnabled: true,
};

/**
 * Cached reader (60 s) for the invoice payment settings: `company.bankAccountHolder`,
 * `company.iban`, `company.bic`, `company.bankName` and `invoice.epcQrEnabled`.
 * On error: the cached value, else no bank details (the PDF leaves the block out).
 */
export async function getInvoicePaymentSettings(): Promise<InvoicePaymentSettings> {
  const now = Date.now();
  if (cachedInvoicePayment !== undefined && now - cachedInvoicePaymentAt < TTL_MS) {
    return cachedInvoicePayment;
  }

  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, INVOICE_PAYMENT_KEYS));
    const values: Record<string, unknown> = {};
    for (const row of rows) values[row.key] = row.value;
    cachedInvoicePayment = readInvoicePaymentSettings(values);
    cachedInvoicePaymentAt = now;
    return cachedInvoicePayment;
  } catch (err) {
    logger.warn(
      { err, keys: INVOICE_PAYMENT_KEYS },
      'getInvoicePaymentSettings failed, using the cached value or none',
    );
    return cachedInvoicePayment ?? NO_INVOICE_PAYMENT;
  }
}

export function clearSystemSettingsCache(): void {
  cachedInvoicePayment = undefined;
  cachedInvoicePaymentAt = 0;
  cachedTimezone = undefined;
  cachedAt = 0;
  cachedCurrency = undefined;
  cachedCurrencyAt = 0;
  cachedPriceDisplay = undefined;
  cachedPriceDisplayAt = 0;
  cachedTaxBasis = undefined;
  cachedTaxBasisAt = 0;
  cachedCountry = undefined;
  cachedCountryAt = 0;
}
