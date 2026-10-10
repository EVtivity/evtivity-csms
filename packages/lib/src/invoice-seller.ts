// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Invoice seller settings: the details printed in the "From" block of every
 * invoice and credit note PDF (driver and fleet invoices) next to
 * `company.name` and the company address (`company.street`, `company.city`,
 * `company.zip`, `company.state`, `company.country`). Every field is optional:
 * an empty value is left out of the PDF. Browser-safe, so the CSMS imports it
 * via `@evtivity/lib/invoice-seller`.
 */

/** The seller's tax or VAT number. */
export const COMPANY_TAX_ID_KEY = 'company.taxId';
/** The label printed before the tax ID. Empty: the localized "Tax ID" label. */
export const COMPANY_TAX_ID_LABEL_KEY = 'company.taxIdLabel';
/** The company registration number (trade register entry). */
export const COMPANY_REGISTRATION_NUMBER_KEY = 'company.registrationNumber';
/** The contact email printed on invoices. */
export const COMPANY_INVOICE_EMAIL_KEY = 'company.invoiceEmail';
/** The contact phone printed on invoices. */
export const COMPANY_INVOICE_PHONE_KEY = 'company.invoicePhone';

/** Longest value accepted for each seller setting, in characters. */
export const INVOICE_SELLER_MAX_LENGTHS = {
  [COMPANY_TAX_ID_KEY]: 64,
  [COMPANY_TAX_ID_LABEL_KEY]: 40,
  [COMPANY_REGISTRATION_NUMBER_KEY]: 100,
  [COMPANY_INVOICE_EMAIL_KEY]: 254,
  [COMPANY_INVOICE_PHONE_KEY]: 40,
} as const;

export type InvoiceSellerSettingKey = keyof typeof INVOICE_SELLER_MAX_LENGTHS;

export const INVOICE_SELLER_SETTING_KEYS = Object.keys(
  INVOICE_SELLER_MAX_LENGTHS,
) as InvoiceSellerSettingKey[];

export function isInvoiceSellerSettingKey(key: string): key is InvoiceSellerSettingKey {
  return Object.hasOwn(INVOICE_SELLER_MAX_LENGTHS, key);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/**
 * The value as stored: trimmed, one line. Returns null when it is not a
 * string, holds a line break or another control character, is longer than
 * the key's limit, or (invoice email) is not empty and not an email address.
 */
export function normalizeInvoiceSellerSetting(
  key: InvoiceSellerSettingKey,
  value: unknown,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (CONTROL_CHARACTERS.test(trimmed)) return null;
  if (trimmed.length > INVOICE_SELLER_MAX_LENGTHS[key]) return null;
  if (key === COMPANY_INVOICE_EMAIL_KEY && trimmed !== '' && !EMAIL_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}
