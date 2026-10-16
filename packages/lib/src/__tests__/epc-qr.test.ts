// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { buildEpcQrPayload } from '../epc-qr.js';
import type { EpcQrInput } from '../epc-qr.js';

const input: EpcQrInput = {
  name: 'Acme Charging GmbH',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  amountCents: 12_345,
  currency: 'EUR',
  remittance: 'INV-202610-0042',
};

describe('buildEpcQrPayload', () => {
  it('writes the EPC069-12 version 002 lines', () => {
    expect(buildEpcQrPayload(input)).toBe(
      [
        'BCD',
        '002',
        '1',
        'SCT',
        'COBADEFFXXX',
        'Acme Charging GmbH',
        'DE89370400440532013000',
        'EUR123.45',
        '',
        '',
        'INV-202610-0042',
      ].join('\n'),
    );
  });

  it('leaves the BIC line empty without a BIC and normalizes the IBAN', () => {
    const lines = buildEpcQrPayload({
      ...input,
      bic: null,
      iban: 'de89 3704 0044 0532 0130 00',
    })?.split('\n');
    expect(lines?.[4]).toBe('');
    expect(lines?.[6]).toBe('DE89370400440532013000');
  });

  it('formats the amount with two decimals', () => {
    expect(buildEpcQrPayload({ ...input, amountCents: 1 })?.split('\n')[7]).toBe('EUR0.01');
    expect(buildEpcQrPayload({ ...input, amountCents: 1000 })?.split('\n')[7]).toBe('EUR10.00');
    expect(buildEpcQrPayload({ ...input, amountCents: 99_999_999_999 })?.split('\n')[7]).toBe(
      'EUR999999999.99',
    );
  });

  it('cuts the name to 70 and the remittance to 140 characters', () => {
    const lines = buildEpcQrPayload({
      ...input,
      name: 'N'.repeat(80),
      remittance: 'R'.repeat(150),
    })?.split('\n');
    expect(lines?.[5]).toBe('N'.repeat(70));
    expect(lines?.[10]).toBe('R'.repeat(140));
  });

  it('returns null for another currency, an amount out of range, or no IBAN', () => {
    expect(buildEpcQrPayload({ ...input, currency: 'USD' })).toBeNull();
    expect(buildEpcQrPayload({ ...input, amountCents: 0 })).toBeNull();
    expect(buildEpcQrPayload({ ...input, amountCents: -500 })).toBeNull();
    expect(buildEpcQrPayload({ ...input, amountCents: 100_000_000_000 })).toBeNull();
    expect(buildEpcQrPayload({ ...input, amountCents: 1.5 })).toBeNull();
    expect(buildEpcQrPayload({ ...input, iban: '' })).toBeNull();
    expect(buildEpcQrPayload({ ...input, name: ' ' })).toBeNull();
  });

  it('accepts a lowercase eur code', () => {
    expect(buildEpcQrPayload({ ...input, currency: 'eur' })).not.toBeNull();
  });
});
