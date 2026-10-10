// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  COMPANY_INVOICE_EMAIL_KEY,
  COMPANY_INVOICE_PHONE_KEY,
  COMPANY_REGISTRATION_NUMBER_KEY,
  COMPANY_TAX_ID_KEY,
  COMPANY_TAX_ID_LABEL_KEY,
  INVOICE_SELLER_MAX_LENGTHS,
  INVOICE_SELLER_SETTING_KEYS,
  isInvoiceSellerSettingKey,
  normalizeInvoiceSellerSetting,
} from '../invoice-seller.js';

describe('invoice seller settings', () => {
  it('lists the five seller keys', () => {
    expect(INVOICE_SELLER_SETTING_KEYS).toEqual([
      COMPANY_TAX_ID_KEY,
      COMPANY_TAX_ID_LABEL_KEY,
      COMPANY_REGISTRATION_NUMBER_KEY,
      COMPANY_INVOICE_EMAIL_KEY,
      COMPANY_INVOICE_PHONE_KEY,
    ]);
    expect(isInvoiceSellerSettingKey('company.taxId')).toBe(true);
    expect(isInvoiceSellerSettingKey('company.name')).toBe(false);
    expect(isInvoiceSellerSettingKey('toString')).toBe(false);
  });

  it('trims values and keeps empty ones', () => {
    expect(normalizeInvoiceSellerSetting(COMPANY_TAX_ID_KEY, '  DE123456789 ')).toBe('DE123456789');
    expect(normalizeInvoiceSellerSetting(COMPANY_TAX_ID_LABEL_KEY, '')).toBe('');
    expect(normalizeInvoiceSellerSetting(COMPANY_INVOICE_EMAIL_KEY, '  ')).toBe('');
    expect(normalizeInvoiceSellerSetting(COMPANY_REGISTRATION_NUMBER_KEY, 'HRB 12345')).toBe(
      'HRB 12345',
    );
    expect(normalizeInvoiceSellerSetting(COMPANY_TAX_ID_LABEL_KEY, '사업자등록번호')).toBe(
      '사업자등록번호',
    );
  });

  it('accepts a value at the length limit and rejects one over it', () => {
    for (const key of INVOICE_SELLER_SETTING_KEYS) {
      if (key === COMPANY_INVOICE_EMAIL_KEY) continue;
      const max = INVOICE_SELLER_MAX_LENGTHS[key];
      expect(normalizeInvoiceSellerSetting(key, 'x'.repeat(max))).toBe('x'.repeat(max));
      expect(normalizeInvoiceSellerSetting(key, 'x'.repeat(max + 1))).toBeNull();
    }
  });

  it('rejects line breaks, control characters and non-strings', () => {
    expect(normalizeInvoiceSellerSetting(COMPANY_TAX_ID_KEY, 'DE1\nDE2')).toBeNull();
    expect(normalizeInvoiceSellerSetting(COMPANY_INVOICE_PHONE_KEY, '+49\t30')).toBeNull();
    expect(normalizeInvoiceSellerSetting(COMPANY_TAX_ID_KEY, 42)).toBeNull();
    expect(normalizeInvoiceSellerSetting(COMPANY_TAX_ID_KEY, null)).toBeNull();
  });

  it('checks the invoice email format', () => {
    expect(normalizeInvoiceSellerSetting(COMPANY_INVOICE_EMAIL_KEY, 'billing@acme.example')).toBe(
      'billing@acme.example',
    );
    expect(normalizeInvoiceSellerSetting(COMPANY_INVOICE_EMAIL_KEY, 'billing')).toBeNull();
    expect(normalizeInvoiceSellerSetting(COMPANY_INVOICE_EMAIL_KEY, 'a b@acme.example')).toBeNull();
  });
});
