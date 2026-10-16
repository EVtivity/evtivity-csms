// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  COMPANY_BANK_ACCOUNT_HOLDER_KEY,
  COMPANY_BANK_NAME_KEY,
  COMPANY_BIC_KEY,
  COMPANY_IBAN_KEY,
  INVOICE_PAYMENT_SETTING_KEYS,
  formatIban,
  isInvoicePaymentSettingKey,
  normalizeBic,
  normalizeIban,
  normalizeInvoicePaymentSetting,
} from '../invoice-payment.js';

describe('normalizeIban', () => {
  it('accepts valid IBANs and stores them without spaces in upper case', () => {
    expect(normalizeIban('DE89 3704 0044 0532 0130 00')).toBe('DE89370400440532013000');
    expect(normalizeIban(' gb82 west 1234 5698 7654 32 ')).toBe('GB82WEST12345698765432');
    expect(normalizeIban('NL91ABNA0417164300')).toBe('NL91ABNA0417164300');
  });

  it('keeps an empty value as unset', () => {
    expect(normalizeIban('')).toBe('');
    expect(normalizeIban('   ')).toBe('');
  });

  it('rejects a bad checksum', () => {
    expect(normalizeIban('DE89370400440532013001')).toBeNull();
    expect(normalizeIban('DE88370400440532013000')).toBeNull();
  });

  it('rejects a bad format', () => {
    expect(normalizeIban('DE89-3704-0044')).toBeNull();
    expect(normalizeIban('1234567890123456')).toBeNull();
    expect(normalizeIban('DE89')).toBeNull();
    expect(normalizeIban(`DE89${'1'.repeat(31)}`)).toBeNull();
    expect(normalizeIban(42)).toBeNull();
  });
});

describe('normalizeBic', () => {
  it('accepts 8 and 11 characters in upper case', () => {
    expect(normalizeBic('cobadeff')).toBe('COBADEFF');
    expect(normalizeBic('COBA DE FF XXX')).toBe('COBADEFFXXX');
    expect(normalizeBic('')).toBe('');
  });

  it('rejects other lengths and formats', () => {
    expect(normalizeBic('COBADEF')).toBeNull();
    expect(normalizeBic('COBADEFFXX')).toBeNull();
    expect(normalizeBic('COB1DEFF')).toBeNull();
    expect(normalizeBic('COBA1EFF')).toBeNull();
    expect(normalizeBic(null)).toBeNull();
  });
});

describe('normalizeInvoicePaymentSetting', () => {
  it('lists the four bank detail keys', () => {
    expect(INVOICE_PAYMENT_SETTING_KEYS).toEqual([
      COMPANY_BANK_ACCOUNT_HOLDER_KEY,
      COMPANY_IBAN_KEY,
      COMPANY_BIC_KEY,
      COMPANY_BANK_NAME_KEY,
    ]);
    expect(isInvoicePaymentSettingKey('company.iban')).toBe(true);
    expect(isInvoicePaymentSettingKey('invoice.epcQrEnabled')).toBe(false);
  });

  it('trims the holder and bank name and enforces one line within the limit', () => {
    expect(normalizeInvoicePaymentSetting(COMPANY_BANK_ACCOUNT_HOLDER_KEY, ' Acme GmbH ')).toBe(
      'Acme GmbH',
    );
    expect(normalizeInvoicePaymentSetting(COMPANY_BANK_ACCOUNT_HOLDER_KEY, 'x'.repeat(70))).toBe(
      'x'.repeat(70),
    );
    expect(
      normalizeInvoicePaymentSetting(COMPANY_BANK_ACCOUNT_HOLDER_KEY, 'x'.repeat(71)),
    ).toBeNull();
    expect(normalizeInvoicePaymentSetting(COMPANY_BANK_NAME_KEY, 'Bank\nName')).toBeNull();
    expect(normalizeInvoicePaymentSetting(COMPANY_BANK_NAME_KEY, 'x'.repeat(101))).toBeNull();
    expect(normalizeInvoicePaymentSetting(COMPANY_IBAN_KEY, 'de89370400440532013000')).toBe(
      'DE89370400440532013000',
    );
  });
});

describe('formatIban', () => {
  it('groups the IBAN in fours', () => {
    expect(formatIban('DE89370400440532013000')).toBe('DE89 3704 0044 0532 0130 00');
    expect(formatIban('NL91ABNA0417164300')).toBe('NL91 ABNA 0417 1643 00');
  });
});
