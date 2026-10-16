// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { InvoicePaymentSettings } from '@evtivity/database';
import { invoicePaymentBlock } from '../invoice-payment-block.js';
import type { InvoicePaymentBlockInvoice } from '../invoice-payment-block.js';
import { INVOICE_LABELS } from '../invoice-labels.js';

const issuedAt = new Date('2026-10-01T09:00:00Z');
const dueAt = new Date('2026-10-31T09:00:00Z');

const openFleetInvoice: InvoicePaymentBlockInvoice = {
  invoiceNumber: 'INV-202610-0042',
  kind: 'invoice',
  status: 'issued',
  fleetId: 'flt_1',
  currency: 'EUR',
  totalCents: 11_900,
  issuedAt,
  dueAt,
  paidAt: null,
  paymentReference: null,
};

const payment: InvoicePaymentSettings = {
  accountHolder: 'Acme Charging GmbH',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  bankName: 'Commerzbank',
  epcQrEnabled: true,
};

const formatDate = (value: Date | null): string => value?.toISOString().slice(0, 10) ?? '-';

function block(
  invoice: Partial<InvoicePaymentBlockInvoice>,
  settings: Partial<InvoicePaymentSettings> = {},
  language: keyof typeof INVOICE_LABELS = 'en',
) {
  return invoicePaymentBlock({
    invoice: { ...openFleetInvoice, ...invoice },
    labels: INVOICE_LABELS[language],
    payment: { ...payment, ...settings },
    sellerName: 'Acme',
    formatDate,
  });
}

describe('invoicePaymentBlock', () => {
  it('asks for a transfer on an open invoice with the amount, due date and reference', () => {
    const result = block({});
    expect(result?.kind).toBe('transfer');
    expect(result?.text).toBe(
      'Please transfer €119.00 by 2026-10-31, quoting the payment reference INV-202610-0042.',
    );
    expect(result?.rows).toEqual([
      ['Account holder', 'Acme Charging GmbH'],
      ['IBAN', 'DE89 3704 0044 0532 0130 00'],
      ['BIC', 'COBADEFFXXX'],
      ['Bank', 'Commerzbank'],
      ['Payment reference', 'INV-202610-0042'],
    ]);
    expect(result?.qrPayload?.split('\n')).toEqual([
      'BCD',
      '002',
      '1',
      'SCT',
      'COBADEFFXXX',
      'Acme Charging GmbH',
      'DE89370400440532013000',
      'EUR119.00',
      '',
      '',
      'INV-202610-0042',
    ]);
  });

  it('writes the sentence and the amount in the invoice language', () => {
    expect(block({}, {}, 'de')?.text).toBe(
      'Bitte überweisen Sie 119,00 € bis zum 2026-10-31 unter Angabe des Verwendungszwecks INV-202610-0042.',
    );
  });

  it('uses the seller name without a holder and leaves out an unset BIC and bank', () => {
    const result = block({ dueAt: null }, { accountHolder: null, bic: null, bankName: null });
    expect(result?.text).toBe(
      'Please transfer €119.00, quoting the payment reference INV-202610-0042.',
    );
    expect(result?.rows.map(([label]) => label)).toEqual([
      'Account holder',
      'IBAN',
      'Payment reference',
    ]);
    expect(result?.rows[0]).toEqual(['Account holder', 'Acme']);
    expect(result?.qrPayload?.split('\n')[4]).toBe('');
  });

  it('prints no QR code outside EUR or when it is turned off', () => {
    expect(block({ currency: 'USD' })?.qrPayload).toBeNull();
    expect(block({ currency: 'USD' })?.kind).toBe('transfer');
    expect(block({}, { epcQrEnabled: false })?.qrPayload).toBeNull();
  });

  it('shows Paid instead of a transfer request on a paid invoice', () => {
    const paidAt = new Date('2026-10-05T09:00:00Z');
    const result = block({ status: 'paid', paidAt, paymentReference: 'TRX 991' });
    expect(result).toEqual({
      kind: 'paid',
      text: 'Paid on 2026-10-05. No payment is due.',
      rows: [['Payment reference', 'TRX 991']],
      qrPayload: null,
    });
  });

  it('says paid by card for a driver invoice paid when it was issued', () => {
    const result = block({ status: 'paid', fleetId: null, paidAt: issuedAt });
    expect(result?.kind).toBe('paid');
    expect(result?.text).toBe('Paid by card on 2026-10-01. No payment is due.');
    expect(result?.rows).toEqual([]);
  });

  it('says only paid for a driver invoice an operator marked paid later', () => {
    const paidAt = new Date('2026-10-09T09:00:00Z');
    expect(block({ status: 'paid', fleetId: null, paidAt })?.text).toBe(
      'Paid on 2026-10-09. No payment is due.',
    );
  });

  it('prints the refund or offset note on a credit note, without a QR code', () => {
    const result = block({ kind: 'credit_note', totalCents: -11_900, status: 'issued' });
    expect(result).toEqual({
      kind: 'creditNote',
      text: 'No payment is due. The amount is refunded or offset against open invoices.',
      rows: [],
      qrPayload: null,
    });
  });

  it('prints nothing without an IBAN', () => {
    expect(block({}, { iban: null })).toBeNull();
    expect(block({ kind: 'credit_note' }, { iban: null })).toBeNull();
    expect(block({ status: 'paid' }, { iban: null })).toBeNull();
  });

  it('prints nothing for a void, credited or draft invoice, or one with nothing to pay', () => {
    expect(block({ status: 'void' })).toBeNull();
    expect(block({ status: 'credited' })).toBeNull();
    expect(block({ status: 'draft' })).toBeNull();
    expect(block({ totalCents: 0 })).toBeNull();
  });
});
