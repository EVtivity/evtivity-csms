// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Invoice payment settings: the bank details printed in the "Payment
 * information" block of invoice PDFs (driver, fleet and member invoices), and
 * the switch for the EPC QR code (SEPA credit transfer, EPC069-12). Plain
 * settings, not secrets: they print on every invoice. An empty value is unset;
 * without an IBAN the block is left out. Browser-safe, so the CSMS imports it
 * via `@evtivity/lib/invoice-payment`.
 */

/** The account holder printed above the IBAN and named in the EPC QR code. */
export const COMPANY_BANK_ACCOUNT_HOLDER_KEY = 'company.bankAccountHolder';
/** The IBAN (ISO 13616), stored without spaces in upper case. */
export const COMPANY_IBAN_KEY = 'company.iban';
/** The BIC (ISO 9362), 8 or 11 characters, stored in upper case. */
export const COMPANY_BIC_KEY = 'company.bic';
/** The bank name printed under the BIC. */
export const COMPANY_BANK_NAME_KEY = 'company.bankName';
/** Whether EUR invoices with an open amount print the EPC QR code (default true). */
export const INVOICE_EPC_QR_ENABLED_KEY = 'invoice.epcQrEnabled';

/**
 * Longest value accepted for each bank detail, in characters. The holder
 * limit is the EPC beneficiary name limit; an IBAN has at most 34 characters.
 */
export const INVOICE_PAYMENT_MAX_LENGTHS = {
  [COMPANY_BANK_ACCOUNT_HOLDER_KEY]: 70,
  [COMPANY_IBAN_KEY]: 34,
  [COMPANY_BIC_KEY]: 11,
  [COMPANY_BANK_NAME_KEY]: 100,
} as const;

export type InvoicePaymentSettingKey = keyof typeof INVOICE_PAYMENT_MAX_LENGTHS;

export const INVOICE_PAYMENT_SETTING_KEYS = Object.keys(
  INVOICE_PAYMENT_MAX_LENGTHS,
) as InvoicePaymentSettingKey[];

export function isInvoicePaymentSettingKey(key: string): key is InvoicePaymentSettingKey {
  return Object.hasOwn(INVOICE_PAYMENT_MAX_LENGTHS, key);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const IBAN_FORMAT = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;
const BIC_FORMAT = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** The ISO 13616 check: the rearranged IBAN, letters as 10 to 35, is 1 mod 97. */
function ibanChecksumValid(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[0-9]/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/**
 * The IBAN as stored: spaces removed, upper case. Empty stays empty (unset).
 * Null when it is not a string, has the wrong format or length, or fails the
 * mod-97 checksum.
 */
export function normalizeIban(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (compact === '') return '';
  if (!IBAN_FORMAT.test(compact)) return null;
  return ibanChecksumValid(compact) ? compact : null;
}

/** The BIC as stored: spaces removed, upper case, 8 or 11 characters. Empty stays empty. */
export function normalizeBic(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (compact === '') return '';
  return BIC_FORMAT.test(compact) ? compact : null;
}

/**
 * The value as stored, or null when invalid: the IBAN and BIC normalized and
 * checked; the holder and bank name trimmed, one line, within their limit.
 */
export function normalizeInvoicePaymentSetting(
  key: InvoicePaymentSettingKey,
  value: unknown,
): string | null {
  if (key === COMPANY_IBAN_KEY) return normalizeIban(value);
  if (key === COMPANY_BIC_KEY) return normalizeBic(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (CONTROL_CHARACTERS.test(trimmed)) return null;
  if (trimmed.length > INVOICE_PAYMENT_MAX_LENGTHS[key]) return null;
  return trimmed;
}

/** An IBAN in groups of four for print, such as `DE89 3704 0044 0532 0130 00`. */
export function formatIban(iban: string): string {
  return iban.replace(/(.{4})(?=.)/g, '$1 ');
}
